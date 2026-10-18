//! Bounded external sorting for wide-object (decoded-key hash, ordinal) pairs.
//! Scratch runs are fixed-size; merge fan-in and memory do not grow with input.
use super::{err, read_word, sidecar, write_word, Result};
use std::{
    cmp::Reverse,
    collections::{hash_map::RandomState, BinaryHeap},
    fs::{File, OpenOptions},
    hash::BuildHasher,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const RUN: u64 = 4096;
const FAN_IN: u64 = 32;

pub(super) struct KeyReader {
    reader: BufReader<File>,
    pos: u64,
    bytes: Vec<u8>,
}
impl KeyReader {
    pub fn new(path: &Path) -> Result<Self> {
        Ok(Self {
            reader: BufReader::with_capacity(256 * 1024, File::open(path).map_err(err)?),
            pos: 0,
            bytes: Vec::new(),
        })
    }
    pub fn hash(&mut self, start: u64, end: u64, state: &RandomState) -> Result<u64> {
        let len = end
            .checked_sub(start)
            .filter(|n| *n <= 64 * 1024)
            .ok_or("字段名索引无效")?;
        if start >= self.pos && start - self.pos <= self.reader.buffer().len() as u64 {
            self.reader.consume((start - self.pos) as usize);
        } else {
            self.reader.seek(SeekFrom::Start(start)).map_err(err)?;
        }
        self.bytes.resize(len as usize, 0);
        self.reader.read_exact(&mut self.bytes).map_err(err)?;
        self.pos = end;
        let key: String = serde_json::from_slice(&self.bytes).map_err(err)?;
        Ok(state.hash_one(key.as_str()))
    }
}

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err("已取消".into())
    } else {
        Ok(())
    }
}

struct Scratch {
    file: Option<File>,
    path: PathBuf,
}
impl Scratch {
    fn new(path: PathBuf) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(err)?;
        Ok(Self {
            file: Some(file),
            path,
        })
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(super) struct Builder {
    pairs: Vec<(u64, u64)>,
    count: u64,
    scratch: Option<Scratch>,
    base: PathBuf,
}
impl Builder {
    pub fn new(base: &Path) -> Self {
        Self {
            pairs: Vec::with_capacity(RUN as usize),
            count: 0,
            scratch: None,
            base: base.to_path_buf(),
        }
    }
    pub fn push(&mut self, hash: u64, ordinal: u64, cancel: &AtomicBool) -> Result<()> {
        self.pairs.push((hash, ordinal));
        self.count += 1;
        if self.pairs.len() == RUN as usize {
            self.spill(cancel)?;
        }
        Ok(())
    }
    fn spill(&mut self, cancel: &AtomicBool) -> Result<()> {
        check(cancel)?;
        self.pairs.sort_unstable();
        if self.scratch.is_none() {
            self.scratch = Some(Scratch::new(sidecar(&self.base, ".keysort-a"))?);
        }
        let file = self.scratch.as_mut().unwrap().file.as_mut().unwrap();
        let mut bytes = Vec::with_capacity(self.pairs.len() * 16);
        for &(hash, ordinal) in &self.pairs {
            bytes.extend_from_slice(&hash.to_le_bytes());
            bytes.extend_from_slice(&ordinal.to_le_bytes());
        }
        file.write_all(&bytes).map_err(err)?;
        self.pairs.clear();
        Ok(())
    }
    pub fn finish(mut self, target: &mut File, width: usize, cancel: &AtomicBool) -> Result<u64> {
        check(cancel)?;
        let offset = target.seek(SeekFrom::End(0)).map_err(err)?;
        if self.scratch.is_none() {
            self.pairs.sort_unstable();
            let mut writer = BufWriter::new(target);
            for (hash, ordinal) in self.pairs {
                write_pair(&mut writer, hash, ordinal, width)?;
            }
            writer.flush().map_err(err)?;
            check(cancel)?;
            return Ok(offset + 1);
        }
        if !self.pairs.is_empty() {
            self.spill(cancel)?;
        }
        let mut input = self.scratch.take().unwrap();
        let mut span = RUN;
        if span < self.count {
            let mut output = Scratch::new(sidecar(&self.base, ".keysort-b"))?;
            while span < self.count {
                merge(
                    &input.path,
                    output.file.as_mut().unwrap(),
                    self.count,
                    span,
                    cancel,
                )?;
                std::mem::swap(&mut input, &mut output);
                span = span.saturating_mul(FAN_IN);
            }
        }
        let mut reader = BufReader::new(File::open(&input.path).map_err(err)?);
        let mut writer = BufWriter::with_capacity(256 * 1024, target);
        for i in 0..self.count {
            if i % RUN == 0 {
                check(cancel)?;
            }
            let (hash, ordinal) = read_pair(&mut reader)?;
            write_pair(&mut writer, hash, ordinal, width)?;
        }
        writer.flush().map_err(err)?;
        check(cancel)?;
        Ok(offset + 1)
    }
}

fn write_pair(writer: &mut impl Write, hash: u64, ordinal: u64, width: usize) -> Result<()> {
    let mut bytes = [0; 16];
    bytes[..8].copy_from_slice(&hash.to_le_bytes());
    write_word(&mut bytes[8..8 + width], ordinal)?;
    writer.write_all(&bytes[..8 + width]).map_err(err)
}
fn read_pair(reader: &mut impl Read) -> Result<(u64, u64)> {
    let mut bytes = [0; 16];
    reader.read_exact(&mut bytes).map_err(err)?;
    Ok((read_word(&bytes[..8]), read_word(&bytes[8..])))
}
struct RunReader {
    reader: BufReader<File>,
    left: u64,
}
impl RunReader {
    fn next(&mut self) -> Result<Option<(u64, u64)>> {
        if self.left == 0 {
            return Ok(None);
        }
        self.left -= 1;
        read_pair(&mut self.reader).map(Some)
    }
}
fn merge(path: &Path, target: &mut File, count: u64, span: u64, cancel: &AtomicBool) -> Result<()> {
    target.set_len(0).map_err(err)?;
    target.rewind().map_err(err)?;
    let mut writer = BufWriter::with_capacity(256 * 1024, target);
    let group = span.saturating_mul(FAN_IN);
    let mut start = 0;
    while start < count {
        check(cancel)?;
        let mut readers = Vec::with_capacity(FAN_IN as usize);
        let mut heap = BinaryHeap::new();
        for run in 0..FAN_IN {
            let offset = start.saturating_add(run.saturating_mul(span));
            if offset >= count {
                break;
            }
            let mut file = File::open(path).map_err(err)?;
            file.seek(SeekFrom::Start(offset * 16)).map_err(err)?;
            let mut reader = RunReader {
                reader: BufReader::new(file),
                left: span.min(count - offset),
            };
            if let Some((hash, ordinal)) = reader.next()? {
                heap.push(Reverse((hash, ordinal, readers.len())));
            }
            readers.push(reader);
        }
        let mut written = 0;
        while let Some(Reverse((hash, ordinal, run))) = heap.pop() {
            if written % RUN == 0 {
                check(cancel)?;
            }
            write_pair(&mut writer, hash, ordinal, 8)?;
            written += 1;
            if let Some((hash, ordinal)) = readers[run].next()? {
                heap.push(Reverse((hash, ordinal, run)));
            }
        }
        start = start.saturating_add(group);
    }
    writer.flush().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn paths() -> (PathBuf, PathBuf) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("atlas-key-sort-{}-{stamp}", std::process::id()));
        (base.clone(), sidecar(&base, ".out"))
    }
    #[test]
    fn multi_pass_merge_matches_in_memory_sort_for_both_widths() {
        for width in [4, 8] {
            let (base, path) = paths();
            let cancel = AtomicBool::new(false);
            let mut expected = Vec::new();
            let mut builder = Builder::new(&base);
            for ordinal in 0..RUN * FAN_IN + 19 {
                let hash = ordinal.wrapping_mul(6364136223846793005) % 97;
                builder.push(hash, ordinal, &cancel).unwrap();
                expected.push((hash, ordinal));
                assert!(builder.pairs.len() < RUN as usize);
            }
            expected.sort_unstable();
            let mut target = File::create(&path).unwrap();
            assert_eq!(builder.finish(&mut target, width, &cancel).unwrap(), 1);
            drop(target);
            assert!(!sidecar(&base, ".keysort-a").exists());
            assert!(!sidecar(&base, ".keysort-b").exists());
            assert_eq!(
                path.metadata().unwrap().len(),
                expected.len() as u64 * (8 + width) as u64
            );
            let mut reader = BufReader::new(File::open(&path).unwrap());
            for pair in expected {
                let mut bytes = [0; 16];
                reader.read_exact(&mut bytes[..8 + width]).unwrap();
                assert_eq!(
                    (read_word(&bytes[..8]), read_word(&bytes[8..8 + width])),
                    pair
                );
            }
            drop(reader);
            std::fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn cancellation_and_write_failures_clean_owned_scratch_files() {
        for cancelled in [true, false] {
            let (base, path) = paths();
            let cancel = AtomicBool::new(false);
            let mut builder = Builder::new(&base);
            for i in 0..RUN + 1 {
                builder.push(RUN - i.min(RUN), i, &cancel).unwrap();
            }
            std::fs::write(&path, []).unwrap();
            let mut target = if cancelled {
                OpenOptions::new().write(true).open(&path).unwrap()
            } else {
                File::open(&path).unwrap()
            };
            cancel.store(cancelled, Ordering::Relaxed);
            assert!(builder.finish(&mut target, 4, &cancel).is_err());
            drop(target);
            assert!(!sidecar(&base, ".keysort-a").exists());
            assert!(!sidecar(&base, ".keysort-b").exists());
            std::fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn preexisting_scratch_file_is_preserved_on_error() {
        let (base, _) = paths();
        let scratch = sidecar(&base, ".keysort-a");
        std::fs::write(&scratch, b"existing").unwrap();
        let mut builder = Builder::new(&base);
        for i in 0..RUN - 1 {
            builder.push(i, i, &AtomicBool::new(false)).unwrap();
        }
        assert!(builder.push(RUN, RUN, &AtomicBool::new(false)).is_err());
        drop(builder);
        assert_eq!(std::fs::read(&scratch).unwrap(), b"existing");
        std::fs::remove_file(scratch).unwrap();
    }
}
