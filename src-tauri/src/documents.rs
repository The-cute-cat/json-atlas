use serde::Serialize;
use std::{ffi::OsString, fs::File, io::Read, path::Path};

const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

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
    args.into_iter()
        .filter_map(|arg| {
            let arg: OsString = arg.into();
            if arg == "--" {
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
    let path = std::fs::canonicalize(path).map_err(|e| format!("无法打开文件：{e}"))?;
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
