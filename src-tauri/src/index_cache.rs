use super::{err, jsonl::LineIndex, sidecar, Indexed, KeyState, Result};
use crate::native_error::NativeError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};

// Bump this when the layout of an index or its sidecars changes.
const FORMAT: u32 = 1;
static MANIFEST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn file(file: &File) -> Result<Self> {
        let info = file.metadata().map_err(err)?;
        Ok(Self {
            size: info.len(),
            modified: info.modified().ok(),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct IndexFiles {
    index: u64,
    children: Option<u64>,
    branches: Option<u64>,
    keys: Option<u64>,
    branch_count: u64,
    key_state: KeyState,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: u32,
    generation: String,
    stamp: Stamp,
    hash: [u8; 32],
    files: IndexFiles,
    counts: [u64; 3],
    jsonl: bool,
    long: Option<IndexFiles>,
}

struct Entry(PathBuf);

impl Entry {
    fn manifest(&self) -> PathBuf {
        self.0.join("current.json")
    }
    fn index(&self, generation: &str) -> PathBuf {
        self.0.join(generation).with_extension("idx")
    }
    fn read(&self) -> Option<Manifest> {
        // Manifest size stays small even for very large sources.
        let data = File::open(self.manifest()).ok()?;
        let manifest: Manifest = serde_json::from_reader(data.take(16 * 1024)).ok()?;
        (manifest.format == FORMAT && valid_generation(&manifest.generation)).then_some(manifest)
    }
    fn discard(&self, generation: &str) -> bool {
        let _guard = MANIFEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self
            .read()
            .is_some_and(|manifest| manifest.generation == generation)
        {
            return fs::remove_file(self.manifest()).is_ok();
        }
        false
    }
    fn lease(&self, generation: &str) -> Result<File> {
        let _guard = MANIFEST_LOCK.lock().map_err(err)?;
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.0.join(generation).with_extension("lease"))
            .map_err(err)?;
        lease.lock_shared().map_err(err)?;
        Ok(lease)
    }
    fn clean_abandoned(&self) {
        let _guard = MANIFEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = self.read().map(|manifest| manifest.generation);
        let Ok(entries) = self.0.read_dir() else {
            return;
        };
        for file in entries.flatten() {
            let path = file.path();
            if path.extension().and_then(|value| value.to_str()) != Some("lease") {
                continue;
            }
            let Some(key) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if !valid_generation(key) || current.as_deref() == Some(key) {
                continue;
            }
            let Ok(lease) = OpenOptions::new().read(true).write(true).open(&path) else {
                continue;
            };
            if lease.try_lock().is_err() {
                continue;
            }
            remove_index_files(&self.index(key));
            let _ = fs::remove_file(path.with_extension("tmp"));
            let _ = fs::remove_file(&path);
        }
    }
}

fn valid_generation(key: &str) -> bool {
    !key.is_empty()
        && key.len() < 160
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(super) struct Session {
    entry: Entry,
    generation: String,
    expected: Option<[u8; 32]>,
    confirmed: bool,
    cancel: Arc<AtomicBool>,
    lease: Option<File>,
}

impl Session {
    pub(super) fn retained(&self) -> bool {
        self.entry
            .read()
            .is_some_and(|manifest| manifest.generation == self.generation)
    }
    pub(super) fn keep_files(&mut self) -> bool {
        let _guard = MANIFEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.retained() {
            return true;
        }
        self.lease.take();
        let path = self.entry.0.join(&self.generation).with_extension("lease");
        let Ok(lease) = OpenOptions::new().read(true).write(true).open(path) else {
            return true;
        };
        if lease.try_lock().is_err() {
            return true;
        }
        self.lease = Some(lease);
        false
    }
}

fn hash_file(path: &Path, stamp: &Stamp, cancel: &AtomicBool) -> Result<[u8; 32]> {
    let mut file = File::open(path).map_err(err)?;
    if &Stamp::file(&file)? != stamp {
        return Err(NativeError::localized(
            "The file has changed",
            "文件已发生变化",
        ));
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let mut bytes = 0;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(NativeError::localized("Cancelled", "已取消"));
        }
        let n = file.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        digest.update(&buffer[..n]);
    }
    if bytes != stamp.size
        || &Stamp::file(&file)? != stamp
        || &Stamp::file(&File::open(path).map_err(err)?)? != stamp
    {
        return Err(NativeError::localized(
            "The file has changed",
            "文件已发生变化",
        ));
    }
    Ok(digest.finalize().into())
}

fn open_part(path: &Path, len: u64) -> Result<File> {
    let file = File::open(path).map_err(err)?;
    if file.metadata().map_err(err)?.len() != len {
        return Err(NativeError::localized(
            "The disk index is incomplete",
            "磁盘索引不完整",
        ));
    }
    Ok(file)
}

impl IndexFiles {
    fn collect(doc: &Indexed, sync: &mut Vec<File>) -> Result<Self> {
        let mut size = |file: &File| {
            sync.push(file.try_clone().map_err(err)?);
            file.metadata().map(|value| value.len()).map_err(err)
        };
        Ok(Self {
            index: size(
                doc.index
                    .as_ref()
                    .ok_or_else(|| NativeError::localized("The index is closed", "索引已关闭"))?,
            )?,
            children: doc.children.as_ref().map(&mut size).transpose()?,
            branches: doc.branches.as_ref().map(&mut size).transpose()?,
            keys: doc.keys.as_ref().map(&mut size).transpose()?,
            branch_count: doc.branch_count,
            key_state: doc.key_state.clone(),
        })
    }

    fn restore(&self, path: &str, index: PathBuf) -> Result<Indexed> {
        let source = File::open(path).map_err(err)?;
        let file = open_part(&index, self.index)?;
        let mut doc = Indexed::from_files(path, index, source, file)?;
        // Preserve the published generation until its owner has accepted it.
        doc.owned = false;
        doc.children = self
            .children
            .map(|n| open_part(&doc.children_path, n))
            .transpose()?;
        doc.branches = self
            .branches
            .map(|n| open_part(&doc.branches_path, n))
            .transpose()?;
        doc.keys = self
            .keys
            .map(|n| open_part(&doc.keys_path, n))
            .transpose()?;
        doc.branch_count = self.branch_count;
        doc.key_state = self.key_state.clone();
        Ok(doc)
    }
}

fn remove_index_files(index: &Path) {
    for base in [index.to_path_buf(), index.with_extension("nodes")] {
        for suffix in [
            "",
            ".children",
            ".branches",
            ".keys",
            ".keysort-a",
            ".keysort-b",
        ] {
            let _ = fs::remove_file(sidecar(&base, suffix));
        }
    }
}

fn restore(path: &str, index: PathBuf, stamp: &Stamp, manifest: &Manifest) -> Result<Indexed> {
    let mut doc = manifest.files.restore(path, index)?;
    if Stamp::file(&doc.source)? != *stamp {
        return Err(NativeError::localized(
            "The file has changed",
            "文件已发生变化",
        ));
    }
    if manifest.jsonl {
        let long = manifest
            .long
            .as_ref()
            .map(|files| files.restore(path, doc.index_path.with_extension("nodes")))
            .transpose()?;
        [doc.records, doc.bad, doc.comments] = manifest.counts;
        doc.kind = "jsonl".into();
        let offsets = File::open(&doc.index_path).map_err(err)?;
        doc.jsonl = Some(Box::new(LineIndex::restore(
            &doc.source_path,
            offsets,
            stamp.size,
            manifest.counts,
            long,
        )?));
    }
    Ok(doc)
}

pub(crate) struct Options {
    pub wrap: bool,
    pub strict: bool,
    pub reuse: bool,
}

pub(crate) fn open(
    path: &str,
    dir: &Path,
    generation: &str,
    cancel: &AtomicBool,
    progress: &dyn Fn(u64),
    options: Options,
) -> Result<(Indexed, serde_json::Value)> {
    let Options {
        wrap,
        strict,
        reuse,
    } = options;
    let entry = if reuse {
        fs::canonicalize(path).ok().and_then(|canonical| {
            let key = format!(
                "{:x}",
                Sha256::digest(canonical.as_os_str().as_encoded_bytes())
            );
            let dir = dir.join("reopen-v1").join(key);
            fs::create_dir_all(&dir).ok().map(|_| Entry(dir))
        })
    } else {
        None
    };
    if let Some(entry) = entry.as_ref() {
        entry.clean_abandoned();
        if let Some(manifest) = entry.read() {
            let stamp = Stamp::file(&File::open(path).map_err(err)?)?;
            let index = entry.index(&manifest.generation);
            // Size mismatches never need a hash. Known metadata changes require
            // confirmation before exposing byte offsets from an older version.
            let matched = stamp.size == manifest.stamp.size;
            let confirm = matched && (stamp.modified.is_none() || stamp != manifest.stamp);
            let eligible = matched
                && (!confirm
                    || hash_file(Path::new(path), &stamp, cancel)
                        .is_ok_and(|hash| hash == manifest.hash));
            if cancel.load(Ordering::Acquire) {
                return Err(NativeError::localized("Cancelled", "已取消"));
            }
            if let Some(lease) = eligible
                .then(|| entry.lease(&manifest.generation).ok())
                .flatten()
            {
                if let Ok(mut doc) = restore(path, index.clone(), &stamp, &manifest) {
                    if let Ok(info) = doc.info(wrap, strict) {
                        doc.cache = Some(Session {
                            entry: Entry(entry.0.clone()),
                            generation: manifest.generation,
                            expected: Some(manifest.hash),
                            confirmed: confirm,
                            cancel: Arc::new(AtomicBool::new(false)),
                            lease: Some(lease),
                        });
                        doc.owned = true;
                        if let Some(long) = doc.jsonl.as_mut().and_then(|lines| lines.long.as_mut())
                        {
                            long.owned = true;
                        }
                        return Ok((doc, info));
                    }
                }
            }
            if entry.discard(&manifest.generation) {
                entry.clean_abandoned();
            }
        }
    }
    let session = entry.and_then(|entry| {
        let lease = entry.lease(generation).ok()?;
        Some(Session {
            entry,
            generation: generation.to_owned(),
            expected: None,
            confirmed: false,
            cancel: Arc::new(AtomicBool::new(false)),
            lease: Some(lease),
        })
    });
    let index = session.as_ref().map_or_else(
        || dir.join(format!("{generation}.idx")),
        |s| s.entry.index(generation),
    );
    let mut doc = Indexed::open(path, index, cancel, progress)?;
    let info = doc.info(wrap, strict)?;
    doc.cache = session;
    Ok((doc, info))
}

pub(crate) fn cancel(doc: &Indexed, forget: bool) {
    if let Some(session) = doc.cache.as_ref() {
        session.cancel.store(true, Ordering::Release);
        if forget {
            session.entry.discard(&session.generation);
        }
    }
}

pub(crate) fn verify(doc: &Mutex<Indexed>) -> Result<bool> {
    // Keep the document lock available for pagination and search while hashing.
    let (path, mut manifest, expected, confirmed, cancel, sync) = {
        let doc = doc.lock().map_err(err)?;
        let Some(session) = doc.cache.as_ref() else {
            return Ok(true);
        };
        let mut sync = Vec::new();
        let manifest = Manifest {
            format: FORMAT,
            generation: session.generation.clone(),
            stamp: Stamp {
                size: doc.size,
                modified: doc.modified,
            },
            hash: [0; 32],
            files: IndexFiles::collect(&doc, &mut sync)?,
            counts: [doc.records, doc.bad, doc.comments],
            jsonl: doc.jsonl.is_some(),
            long: doc
                .jsonl
                .as_ref()
                .and_then(|lines| lines.long.as_ref())
                .map(|long| IndexFiles::collect(long, &mut sync))
                .transpose()?,
        };
        (
            doc.source_path.clone(),
            manifest,
            session.expected,
            session.confirmed,
            session.cancel.clone(),
            sync,
        )
    };
    let hash = if confirmed {
        Ok(expected.unwrap())
    } else {
        hash_file(&path, &manifest.stamp, &cancel)
    };
    if cancel.load(Ordering::Acquire) {
        return Ok(true);
    }
    let valid = expected.is_none() || hash.as_ref().is_ok_and(|hash| Some(*hash) == expected);
    if !valid {
        let mut doc = doc.lock().map_err(err)?;
        if cancel.load(Ordering::Acquire) {
            return Ok(true);
        }
        if let Some(session) = doc.cache.as_ref() {
            session.entry.discard(&manifest.generation);
        }
        doc.invalidated = true;
        return Ok(false);
    }

    // An already published, unchanged index requires no additional cache writes.
    if expected.is_some() && !confirmed {
        return Ok(true);
    }
    manifest.hash = hash?;
    if expected.is_none() {
        for file in sync {
            if cancel.load(Ordering::Acquire) {
                return Ok(true);
            }
            file.sync_all().map_err(err)?;
        }
    }
    let doc = doc.lock().map_err(err)?;
    if cancel.load(Ordering::Acquire) {
        return Ok(true);
    }
    doc.check()?;
    if Stamp::file(&File::open(&path).map_err(err)?)? != manifest.stamp {
        return Err(NativeError::localized(
            "The file has changed",
            "文件已发生变化",
        ));
    }
    let session = doc
        .cache
        .as_ref()
        .ok_or_else(|| NativeError::localized("The index is closed", "索引已关闭"))?;
    let _guard = MANIFEST_LOCK.lock().map_err(err)?;
    if confirmed && !session.retained() {
        return Ok(true);
    }
    let temporary = session.entry.0.join(format!("{}.tmp", session.generation));
    let publish = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(err)?;
        file.write_all(&serde_json::to_vec(&manifest).map_err(err)?)
            .map_err(err)?;
        file.sync_all().map_err(err)?;
        drop(file);
        fs::rename(&temporary, session.entry.manifest()).map_err(err)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    publish.map(|()| true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    struct Fixture {
        dir: PathBuf,
        path: PathBuf,
    }

    impl Fixture {
        fn new(extension: &str, contents: &str) -> Self {
            static SERIAL: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "atlas-cache-test-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            let path = dir.join("source").with_extension(extension);
            fs::write(&path, contents).unwrap();
            Self { dir, path }
        }

        fn open(&self, generation: &str, reuse: bool) -> (Indexed, usize) {
            let scanned = std::cell::Cell::new(0);
            let (doc, _) = open(
                self.path.to_str().unwrap(),
                &self.dir,
                generation,
                &AtomicBool::new(false),
                &|_| scanned.set(scanned.get() + 1),
                Options {
                    wrap: true,
                    strict: false,
                    reuse,
                },
            )
            .unwrap();
            (doc, scanned.get())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn published_wide_json_and_long_jsonl_indexes_reopen_without_scanning() {
        let fields = (0..200)
            .map(|i| format!(r#""key{i}":{i}"#))
            .collect::<Vec<_>>()
            .join(",");
        let ordinary = format!("{{{fields}}}");
        let long = format!(
            "{{{fields},\"large\":\"{}\"}}\n{{\"last\":true}}\n",
            "a".repeat(1024 * 1024)
        );
        for (extension, text, prefix) in [
            ("json", ordinary.as_str(), vec![]),
            ("jsonl", long.as_str(), vec![json!(0)]),
        ] {
            let fixture = Fixture::new(extension, text);
            let (doc, scanned) = fixture.open("first", true);
            assert!(scanned > 0);
            let saved = doc.index_path.clone();
            assert!(verify(&Mutex::new(doc)).unwrap());
            assert!(saved.is_file());
            let (mut reopened, scanned) = fixture.open("second", true);
            assert_eq!(scanned, 0);
            assert_eq!(reopened.index_path, saved);
            let page = reopened
                .page(&prefix, 0, Some(&json!("key199")), 10, false, true)
                .unwrap();
            assert!(page["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["value"] == 199));
            assert!(reopened.search_copy().is_ok());
            cancel(&reopened, true);
            drop(reopened);
            assert!(!saved.exists());
        }
    }

    #[test]
    fn hash_validation_handles_timestamp_only_changes_and_same_stamp_content_changes() {
        let fixture = Fixture::new("json", "[1]");
        let (doc, _) = fixture.open("first", true);
        let saved = doc.index_path.clone();
        let modified = doc.modified.unwrap();
        assert!(verify(&Mutex::new(doc)).unwrap());

        let file = OpenOptions::new().write(true).open(&fixture.path).unwrap();
        let new_time = modified + std::time::Duration::from_secs(5);
        file.set_modified(new_time).unwrap();
        drop(file);
        let (doc, scanned) = fixture.open("timestamp-only", true);
        assert_eq!(scanned, 0);
        assert!(verify(&Mutex::new(doc)).unwrap());
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&fixture.path)
            .unwrap();
        file.write_all(b"[2]").unwrap();
        file.set_modified(new_time).unwrap();
        drop(file);
        let (doc, scanned) = fixture.open("provisional", true);
        assert_eq!(scanned, 0);
        let doc = Mutex::new(doc);
        assert!(!verify(&doc).unwrap());
        assert!(doc.lock().unwrap().check().is_err());
        drop(doc);
        assert!(!saved.exists());
        let (doc, scanned) = fixture.open("changed", true);
        assert!(scanned > 0);
        assert!(verify(&Mutex::new(doc)).unwrap());

        fs::write(&fixture.path, "[200]").unwrap();
        let (doc, scanned) = fixture.open("different-size", true);
        assert!(scanned > 0);
        assert!(verify(&Mutex::new(doc)).unwrap());
        let (doc, scanned) = fixture.open("always", false);
        assert!(scanned > 0);
        assert!(doc.cache.is_none());
    }

    #[test]
    fn incomplete_and_damaged_generations_are_rebuilt() {
        let fixture = Fixture::new("json", "[1,2,3]");
        let (mut doc, _) = fixture.open("interrupted", true);
        // Leave the index on disk with no published hash, as with forced exit.
        let abandoned = doc.index_path.clone();
        doc.cache.take();
        doc.owned = false;
        drop(doc);
        let (doc, scanned) = fixture.open("replacement", true);
        assert!(scanned > 0);
        assert!(!abandoned.exists());
        let saved = doc.index_path.clone();
        assert!(verify(&Mutex::new(doc)).unwrap());
        File::create(saved).unwrap();
        let (_, scanned) = fixture.open("damaged", true);
        assert!(scanned > 0);
    }
}
