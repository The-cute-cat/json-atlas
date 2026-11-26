#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod documents;
mod indexed;
mod installer_cleanup;
mod menu_theme;
mod native_error;
mod window;

use native_error::NativeError;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[tauri::command]
async fn indexed_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, indexed::IndexState>,
    op: String,
    id: String,
    path: Option<String>,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, NativeError> {
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(NativeError::localized(
            "Invalid document ID",
            "无效的文档标识",
        ));
    }
    let args = args.unwrap_or_else(|| json!({}));
    if op == "stat" {
        let path =
            path.ok_or_else(|| NativeError::localized("Missing file path", "缺少文件路径"))?;
        return tauri::async_runtime::spawn_blocking(move || indexed::stat(&path))
            .await
            .map_err(|e| e.to_string())?;
    }
    if op == "cancel" || op == "close" {
        let mut jobs = state.jobs.lock().map_err(|e| e.to_string())?;
        if let Some(cancel) = jobs.remove(&id) {
            cancel.store(true, Ordering::Relaxed);
        }
        state.close_session(&id, args["forget"].as_bool().unwrap_or(false))?;
        return Ok(json!(null));
    }
    if op == "searchCancel" {
        state.cancel_search(
            &id,
            args["searchId"]
                .as_str()
                .ok_or_else(|| NativeError::localized("Missing search ID", "缺少搜索标识"))?,
        )?;
        return Ok(json!(null));
    }
    if op == "search" {
        let options: indexed::native_search::Options =
            serde_json::from_value(args).map_err(|e| e.to_string())?;
        let lease = state.begin_search(&id, &options.search_id)?;
        let original = lease.doc.clone();
        let cancel = lease.cancel.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut snapshot = original.lock().map_err(|e| e.to_string())?.search_copy()?;
            let result = snapshot.native_search(&options, &cancel);
            drop(snapshot);
            drop(original);
            result
        })
        .await
        .map_err(|e| e.to_string())?;
        if lease.cancel.load(Ordering::Relaxed) {
            return Err(NativeError::localized("Cancelled", "已取消"));
        }
        return result;
    }
    if op == "open" {
        let path =
            path.ok_or_else(|| NativeError::localized("Missing file path", "缺少文件路径"))?;
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("indexes");
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = state.jobs.lock().map_err(|e| e.to_string())?;
            if jobs.contains_key(&id)
                || state
                    .sessions
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains_key(&id)
            {
                return Err(NativeError::localized(
                    "The document ID is already in use",
                    "文档标识已存在",
                ));
            }
            jobs.insert(id.clone(), cancel.clone());
        }
        let id_for_job = id.clone();
        let emitter = app.clone();
        let job_cancel = cancel.clone();
        let wrap = args["wrap"].as_bool().unwrap_or(true);
        let strict = args["strict"].as_bool().unwrap_or(false);
        let reuse = args["reuse"].as_bool().unwrap_or(true);
        let result = tauri::async_runtime::spawn_blocking(move || {
            use std::{
                cell::Cell,
                time::{Duration, Instant},
            };
            indexed::stat(&path)?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let last_progress = Cell::new(None);
            let total_bytes = std::fs::metadata(&path).ok().map(|metadata| metadata.len());
            indexed::cache::open(
                &path,
                &dir,
                &format!("{}-{stamp}-{id_for_job}", std::process::id()),
                &job_cancel,
                &|bytes| {
                    let now = Instant::now();
                    if total_bytes != Some(bytes)
                        && last_progress.get().is_some_and(|last| {
                            now.duration_since(last) < Duration::from_millis(125)
                        })
                    {
                        return;
                    }
                    last_progress.set(Some(now));
                    let _ = emitter.emit("index-progress", json!({"id":id_for_job,"bytes":bytes}));
                },
                indexed::cache::Options {
                    wrap,
                    strict,
                    reuse,
                },
            )
        })
        .await
        .map_err(NativeError::from_display)
        .and_then(|r| r);
        let mut jobs = state.jobs.lock().map_err(|e| e.to_string())?;
        if !jobs.get(&id).is_some_and(|job| Arc::ptr_eq(job, &cancel)) {
            return Err(NativeError::localized("Cancelled", "已取消"));
        }
        jobs.remove(&id);
        let (doc, info) = result?;
        state
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, Arc::new(Mutex::new(doc)));
        return Ok(info);
    }
    let doc = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            NativeError::localized(
                "The index is closed. Reopen the file",
                "索引已关闭，请重新打开文件",
            )
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        if op == "verify" {
            return indexed::cache::verify(&doc).map(|valid| json!(valid));
        }
        let mut doc = doc.lock().map_err(|e| e.to_string())?;
        let wrap = args["wrap"].as_bool().unwrap_or(true);
        let path = args["path"].as_array().cloned().unwrap_or_default();
        match op.as_str() {
            "check" => doc.check().map(|_| json!(null)),
            "info" => doc.info(wrap, args["strict"].as_bool().unwrap_or(false)),
            "searchPages" => {
                let paths: Vec<Vec<serde_json::Value>> =
                    serde_json::from_value(args["paths"].clone()).map_err(|e| e.to_string())?;
                doc.search_pages(&paths, wrap)
            }
            "page" => doc.page(
                &path,
                args["offset"].as_u64().unwrap_or(0),
                args.get("key"),
                args["limit"].as_u64().unwrap_or(100),
                args["firstArrayOnly"].as_bool().unwrap_or(false),
                wrap,
            ),
            "text" => doc.text(&path, wrap).map(|s| json!(s)),
            _ => Err(NativeError::localized(
                "Unknown index operation",
                "未知索引操作",
            )),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default)]
struct OpenRequests(Mutex<Vec<String>>);

fn enqueue_open_requests(app: &tauri::AppHandle, paths: Vec<String>) {
    app.state::<OpenRequests>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend(paths);
    let _ = app.emit("open-files-pending", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn take_open_requests(state: tauri::State<OpenRequests>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}

#[tauri::command]
async fn read_document(path: String, max_bytes: u64) -> Result<tauri::ipc::Response, NativeError> {
    tauri::async_runtime::spawn_blocking(move || documents::read_document(&path, max_bytes))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn save_document(
    path: String,
    text: String,
    expected_text: String,
) -> Result<(), NativeError> {
    tauri::async_runtime::spawn_blocking(move || {
        documents::save_document(&path, &text, &expected_text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_document_copy(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    text: String,
    original_path: Option<String>,
    protected_paths: Vec<String>,
) -> Result<Option<String>, NativeError> {
    use tauri_plugin_dialog::DialogExt;
    if text.len() as u64 > documents::MAX_FILE_BYTES {
        return Err(NativeError::localized(
            "Cannot save a working copy larger than 256 MiB",
            "工作副本超过 256 MiB，无法保存",
        ));
    }
    let name = documents::copy_name(&name);
    tauri::async_runtime::spawn_blocking(move || {
        let file = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&name)
            .add_filter("JSON / JSONL", &["json", "jsonl", "ndjson", "jsonlines"])
            .blocking_save_file();
        let Some(file) = file else { return Ok(None) };
        let path = file.into_path().map_err(|e| e.to_string())?;
        documents::validate_local_path(&path.to_string_lossy())?;
        if let Some(original) = original_path {
            if let (Ok(original), Ok(destination)) = (
                std::fs::canonicalize(original),
                std::fs::canonicalize(&path),
            ) {
                if original == destination {
                    return Err(NativeError::localized("Choose a different file name for the working copy to preserve the original", "请为工作副本选择不同的文件名，原文件不会被覆盖"));
                }
            }
        }
        if let Ok(destination) = std::fs::canonicalize(&path) {
            for open in protected_paths {
                if std::fs::canonicalize(open).is_ok_and(|open| open == destination) {
                    return Err(NativeError::localized("A document is open at this location. Choose a different destination", "该位置已有打开的文档，请选择其他位置，避免覆盖工作区文件"));
                }
            }
        }
        documents::save_document_copy(&path.to_string_lossy(), &text)?;
        // Return the actual saved location so a temporary document can become
        // a regular document without reopening and discarding its edit history.
        let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        Ok(Some(documents::display_path(&canonical)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn select_documents(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, NativeError> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter(
                "JSON / JSONL",
                &["json", "jsonl", "ndjson", "jsonlines", "txt"],
            )
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(NativeError::from_display)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_document_title(window: tauri::WebviewWindow, name: Option<String>) -> Result<(), String> {
    let title = name
        .map(|name| format!("{name} — JSON Atlas"))
        .unwrap_or_else(|| "JSON Atlas".into());
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_release_page() -> Result<(), NativeError> {
    const URL: &str = "https://github.com/The-cute-cat/json-atlas/releases/latest";
    #[cfg(windows)]
    {
        use std::ptr::null;
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(
                hwnd: *mut std::ffi::c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show: i32,
            ) -> isize;
        }
        let url: Vec<u16> = URL.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                null(),
                url.as_ptr(),
                null(),
                null(),
                1,
            )
        };
        if result <= 32 {
            return Err(NativeError::localized(
                format!("Could not open the releases page ({result})"),
                format!("无法打开发布页（{result}）"),
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "xdg-open"
        };
        let status = std::process::Command::new(program)
            .arg(URL)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(NativeError::localized(
                format!("Could not open the releases page ({status})"),
                format!("无法打开发布页（{status}）"),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn restart_application(app: tauri::AppHandle) {
    app.request_restart();
}

fn main() {
    if let Some(code) = installer_cleanup::run() {
        std::process::exit(code);
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let initial = documents::argument_paths(std::env::args_os().skip(1), &cwd);
    let builder = tauri::Builder::default()
        .manage(OpenRequests(Mutex::new(initial)))
        .manage(indexed::IndexState::default());
    // Finder delivers open events to the running application through Launch Services.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let paths = documents::argument_paths(args.into_iter().skip(1), std::path::Path::new(&cwd));
        enqueue_open_requests(app, paths);
    }));
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            window::create(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_open_requests,
            read_document,
            indexed_document,
            select_documents,
            save_document_copy,
            save_document,
            window::sync_document_menu,
            window::use_english_menu,
            menu_theme::sync_menu_theme,
            set_document_title,
            restart_application,
            open_release_page
        ])
        .build(tauri::generate_context!())
        .expect("failed to build JSON Atlas");
    #[cfg(not(target_os = "macos"))]
    app.run(|_, _| {});
    #[cfg(target_os = "macos")]
    app.run(|app, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = documents::file_url_paths(urls);
            if !paths.is_empty() {
                enqueue_open_requests(app, paths);
            }
        }
    });
}
