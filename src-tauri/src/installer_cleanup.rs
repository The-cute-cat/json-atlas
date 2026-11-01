//! Narrow MSI uninstall entry point, handled before WebView/single-instance startup.
use std::path::{Path, PathBuf};

const APP_ID: &str = "io.hopecat.jsonatlas";

fn data_directory(base: &Path) -> Result<PathBuf, String> {
    if !base.is_absolute() || base.parent().is_none() {
        return Err("无法确定当前用户的应用数据目录".into());
    }
    Ok(base.join(APP_ID))
}

fn remove_data(path: &Path) -> Result<(), String> {
    // Do not traverse a redirected app directory or delete arbitrary locations.
    if path.file_name() != Some(std::ffi::OsStr::new(APP_ID)) {
        return Err("拒绝清理非应用目录".into());
    }
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
        Ok(metadata) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("应用数据目录是链接，未执行清理".into());
                }
            }
            if !metadata.is_dir() || metadata.is_symlink() {
                return Err("应用数据目录不是普通目录".into());
            }
        }
    }
    std::fs::remove_dir_all(path).map_err(|e| format!("无法清理 {}：{e}", path.display()))
}

pub fn run() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--msi-cleanup")) {
        return None;
    }
    let mode = args.next();
    if args.next().is_some() {
        return Some(1);
    }
    let mode = mode.as_deref().and_then(|v| v.to_str()).unwrap_or("");
    if mode != "clear" {
        return Some(1);
    }
    let result = (|| {
        // Resolve both before removing anything; never enumerate other users.
        let paths = ["LOCALAPPDATA", "APPDATA"]
            .into_iter()
            .map(|key| {
                let base = std::env::var_os(key).ok_or_else(|| format!("缺少 {key}"))?;
                data_directory(Path::new(&base))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for path in paths {
            remove_data(&path)?;
        }
        Ok::<_, String>(())
    })();
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_only_removes_the_scoped_app_directory() {
        let base = std::env::temp_dir().join(format!("atlas-cleanup-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let app = data_directory(&base).unwrap();
        std::fs::create_dir_all(app.join("EBWebView")).unwrap();
        std::fs::write(app.join("EBWebView/cache"), "test").unwrap();
        let original = base.join("document.json");
        std::fs::write(&original, "{}").unwrap();
        assert!(remove_data(&base).is_err());
        assert!(data_directory(Path::new("relative")).is_err());
        remove_data(&app).unwrap();
        remove_data(&app).unwrap();
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "{}");
        std::fs::remove_dir_all(base).unwrap();
    }
}
