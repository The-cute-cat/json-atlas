use serde::Serialize;
use std::{ffi::OsString, fs::File, io::Read, path::Path};

const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Serialize)]
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

pub fn read_document(path: &str) -> Result<Document, String> {
    let path = std::fs::canonicalize(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !["json", "jsonl", "ndjson", "jsonlines", "txt"].contains(&extension.as_str()) {
        return Err("只支持 JSON / JSONL / NDJSON / JSONLines / TXT 文件".into());
    }
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("请选择文件，不能打开目录".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("当前版本支持最大 256 MiB 的文件".into());
    }
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
        path: path.to_string_lossy().into_owned(),
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
        let unsupported = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert!(read_document(unsupported.to_str().unwrap()).is_err());
        assert!(read_document("missing.json").is_err());
    }
}
