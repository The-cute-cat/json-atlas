use serde::Serialize;
use std::{ffi::OsString, fs::File, io::Read, path::Path};

pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

pub fn save_document(path: &str, text: &str, expected: &str) -> Result<(), String> {
    use std::io::Write;
    if text.len() as u64 > MAX_FILE_BYTES || expected.len() as u64 > MAX_FILE_BYTES {
        return Err("文件超过 256 MiB，无法保存".into());
    }
    validate_local_path(path)?;
    let path = std::fs::canonicalize(path).map_err(|e| format!("无法保存文件：{e}"))?;
    validate_local_path(&path.to_string_lossy())?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1 | 4); // Permit reads/replacement, but no concurrent writer.
    }
    let mut original = options
        .open(&path)
        .map_err(|e| format!("无法保存文件：{e}"))?;
    let meta = original.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.permissions().readonly() {
        return Err("文件为只读或不是普通文件，无法保存".into());
    }
    let changed = "文件已被其他程序修改，请重新打开或另存为，避免覆盖外部修改";
    if meta.len() != expected.len() as u64 {
        return Err(changed.into());
    }
    let mut buffer = [0u8; 64 * 1024];
    for chunk in expected.as_bytes().chunks(buffer.len()) {
        original
            .read_exact(&mut buffer[..chunk.len()])
            .map_err(|e| format!("无法核对原文件：{e}"))?;
        if &buffer[..chunk.len()] != chunk {
            return Err(changed.into());
        }
    }
    if original.read(&mut buffer[..1]).map_err(|e| e.to_string())? != 0 {
        return Err(changed.into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = path.with_file_name(format!(
        ".json-atlas-save-{}-{stamp}.tmp",
        std::process::id()
    ));
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| format!("无法创建保存临时文件：{e}"))?;
    let result = (|| {
        output
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn ReplaceFileW(
                    replaced: *const u16,
                    replacement: *const u16,
                    backup: *const u16,
                    flags: u32,
                    exclude: *mut std::ffi::c_void,
                    reserved: *mut std::ffi::c_void,
                ) -> i32;
            }
            let destination: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let replacement: Vec<_> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                ReplaceFileW(
                    destination.as_ptr(),
                    replacement.as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(format!("保存失败：{}", std::io::Error::last_os_error()));
            }
        }
        #[cfg(not(windows))]
        {
            std::fs::set_permissions(&temporary, meta.permissions()).map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

// Check before canonicalize()/metadata(): resolving a UNC path can itself contact SMB.
pub fn validate_local_path(path: &str) -> Result<(), String> {
    let normalized = path.replace('/', "\\");
    let plain = normalized.strip_prefix(r"\\?\").unwrap_or(&normalized);
    if normalized.starts_with(r"\\") && !normalized.starts_with(r"\\?\")
        || normalized.starts_with(r"\\?\")
            && !(plain
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
                && plain.as_bytes().get(1) == Some(&b':')
                && plain.as_bytes().get(2) == Some(&b'\\'))
        || plain.to_ascii_uppercase().starts_with("UNC\\")
        || plain.starts_with(r"\??\")
    {
        return Err("为避免意外访问网络，仅支持本地磁盘文件".into());
    }
    #[cfg(windows)]
    if plain.as_bytes().get(1) == Some(&b':') {
        // Mapped network drives do not have a UNC prefix.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let root: Vec<u16> = format!("{}\\", &plain[..2])
            .encode_utf16()
            .chain(Some(0))
            .collect();
        if unsafe { GetDriveTypeW(root.as_ptr()) } == 4 {
            return Err("为避免意外访问网络，不支持映射的网络磁盘".into());
        }
    }
    Ok(())
}

pub fn copy_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = leaf
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"|?*".contains(*c))
        .take(180)
        .collect();
    let clean = clean.trim().trim_matches('.').trim();
    // Windows 的设备名匹配会忽略扩展名前的尾部空格，"CON .json" 仍等价于 CON。
    let stem = clean
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if clean.is_empty()
        || [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
    {
        "document-edited.json".into()
    } else {
        clean.into()
    }
}

#[derive(Serialize, Debug)]
pub struct Document {
    path: String,
    name: String,
    size: u64,
    text: String,
}

pub fn argument_paths(
    args: impl IntoIterator<Item = impl Into<OsString>>,
    cwd: &Path,
) -> Vec<String> {
    let mut positional = false;
    args.into_iter()
        .filter_map(|arg| {
            let arg: OsString = arg.into();
            if !positional && arg == "--" {
                positional = true;
                return None;
            }
            if !positional && arg.to_string_lossy().starts_with('-') {
                return None;
            }
            let path = cwd.join(arg);
            Some(path.to_string_lossy().into_owned())
        })
        .collect()
}

// canonicalize() 在 Windows 上返回 \\?\ 逐字路径。它能正常读写，但会出现在
// 界面提示与本地存储里，所以对外只使用去掉前缀的常见写法。
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    }
}

pub fn read_document(path: &str) -> Result<Document, String> {
    validate_local_path(path)?;
    let path = std::fs::canonicalize(path).map_err(|e| format!("无法打开文件：{e}"))?;
    validate_local_path(&path.to_string_lossy())?;
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("请选择文件，不能打开目录".into());
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !["json", "jsonl", "ndjson", "jsonlines", "txt"].contains(&extension.as_str()) {
        return Err("只支持 JSON / JSONL / NDJSON / JSONLines / TXT 文件".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("当前版本支持最大 256 MiB 的文件".into());
    }
    let file = File::open(&path).map_err(|e| e.to_string())?;
    // Bound the read even if another process grows the file after metadata().
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("文件读取期间超过 256 MiB".into());
    }
    let size = bytes.len() as u64;
    let text = String::from_utf8(bytes).map_err(|e| format!("文件不是有效 UTF-8：{e}"))?;
    Ok(Document {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: display_path(&path),
        size,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_replaces_complete_content_and_rejects_external_changes() {
        let directory = std::env::temp_dir().join(format!(
            "json-atlas-save-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("sample.json");
        std::fs::write(&path, "{\"old\":1}").unwrap();
        save_document(path.to_str().unwrap(), "{\"new\":2}", "{\"old\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"new\":2}");
        assert!(save_document(path.to_str().unwrap(), "{}", "{\"old\":1}")
            .unwrap_err()
            .contains("其他程序"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"new\":2}");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        save_document(path.to_str().unwrap(), "{}", "{\"new\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn suggested_copy_names_are_basenames_and_arguments_skip_options() {
        assert_eq!(copy_name(r"C:\private\sample.json"), "sample.json");
        assert_eq!(copy_name("../../CON.json"), "document-edited.json");
        assert_eq!(copy_name("CON .json"), "document-edited.json");
        assert_eq!(copy_name("lpt9 .txt"), "document-edited.json");
        assert_eq!(copy_name("CONSOLE .json"), "CONSOLE .json");
        assert_eq!(copy_name("bad\nname?.json"), "badname.json");
        let paths = argument_paths(["--help", "--", "-sample.json"], Path::new("C:\\data"));
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("-sample.json"));
    }

    #[test]
    fn network_and_device_paths_are_rejected_without_accessing_them() {
        for path in [
            r"\\server\share\a.json",
            "//server/share/a.json",
            r"\\?\UNC\server\share\a.json",
            r"\\.\pipe\a",
            r"\??\UNC\server\a",
        ] {
            assert!(validate_local_path(path).is_err(), "{path}");
        }
        assert!(validate_local_path(r"C:\data\sample.json").is_ok());
        assert!(validate_local_path(r"\\?\C:\data\sample.json").is_ok());
    }

    #[test]
    fn arguments_preserve_spaces_unicode_and_resolve_relative_paths() {
        let cwd = Path::new("C:\\数据目录");
        let paths = argument_paths(["--", "样本 文件.JSON", "D:\\其他\\样本.json"], cwd);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0], cwd.join("样本 文件.JSON").to_string_lossy());
        assert_eq!(paths[1], "D:\\其他\\样本.json");
    }

    #[test]
    fn reads_canonical_path_and_rejects_other_file_types() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/sample.json");
        let doc = read_document(path.to_str().unwrap()).unwrap();
        assert_eq!(doc.name, "sample.json");
        assert!(doc.text.contains("JSON Atlas"));
        assert_eq!(doc.size, doc.text.len() as u64);
        assert!(!doc.path.starts_with(r"\\?\"));
        let unsupported = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert!(read_document(unsupported.to_str().unwrap()).is_err());
        assert!(read_document("missing.json").is_err());
    }

    #[test]
    fn displayed_paths_drop_the_windows_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\D:\数据 目录\样本.json")),
            r"D:\数据 目录\样本.json"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\a.json")),
            r"\\server\share\a.json"
        );
        assert_eq!(
            display_path(Path::new(r"D:\plain\a.json")),
            r"D:\plain\a.json"
        );
    }

    #[test]
    fn directories_are_rejected_before_the_extension_check() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let error = read_document(dir.to_str().unwrap()).unwrap_err();
        assert!(error.contains("目录"), "{error}");
    }
}
