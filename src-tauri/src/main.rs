#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod documents;
mod indexed;
mod window;

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
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("无效的文档标识".into());
    }
    let args = args.unwrap_or_else(|| json!({}));
    if op == "stat" {
        let path = path.ok_or("缺少文件路径")?;
        return tauri::async_runtime::spawn_blocking(move || indexed::stat(&path))
            .await
            .map_err(|e| e.to_string())?;
    }
    if op == "cancel" || op == "close" {
        if let Some(cancel) = state.jobs.lock().map_err(|e| e.to_string())?.get(&id) {
            cancel.store(true, Ordering::Relaxed);
        }
        state.close_session(&id)?;
        return Ok(json!(null));
    }
    if op == "searchCancel" {
        state.cancel_search(&id, args["searchId"].as_str().ok_or("缺少搜索标识")?)?;
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
            return Err("已取消".into());
        }
        return result;
    }
    if op == "open" {
        let path = path.ok_or("缺少文件路径")?;
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
                return Err("文档标识已存在".into());
            }
            jobs.insert(id.clone(), cancel.clone());
        }
        let id_for_job = id.clone();
        let emitter = app.clone();
        let job_cancel = cancel.clone();
        let wrap = args["wrap"].as_bool().unwrap_or(true);
        let strict = args["strict"].as_bool().unwrap_or(false);
        let result = tauri::async_runtime::spawn_blocking(move || {
            indexed::stat(&path)?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let mut doc = indexed::Indexed::open(
                &path,
                dir.join(format!("{}-{stamp}-{id_for_job}.idx", std::process::id())),
                &job_cancel,
                &|bytes| {
                    let _ = emitter.emit("index-progress", json!({"id":id_for_job,"bytes":bytes}));
                },
            )?;
            let info = doc.info(wrap, strict)?;
            Ok::<_, String>((doc, info))
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        let mut jobs = state.jobs.lock().map_err(|e| e.to_string())?;
        jobs.remove(&id);
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
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
        .ok_or("索引已关闭，请重新打开文件")?;
    tauri::async_runtime::spawn_blocking(move || {
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
            _ => Err("未知索引操作".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default)]
struct OpenRequests(Mutex<Vec<String>>);

#[tauri::command]
fn take_open_requests(state: tauri::State<OpenRequests>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}

#[tauri::command]
async fn read_document(path: String) -> Result<documents::Document, String> {
    tauri::async_runtime::spawn_blocking(move || documents::read_document(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn select_documents(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
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
                    .map_err(|e| e.to_string())
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

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let initial = documents::argument_paths(std::env::args_os().skip(1), &cwd);
    tauri::Builder::default()
        .manage(OpenRequests(Mutex::new(initial)))
        .manage(indexed::IndexState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths =
                documents::argument_paths(args.into_iter().skip(1), std::path::Path::new(&cwd));
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
        }))
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
            set_document_title
        ])
        .run(tauri::generate_context!())
        .expect("failed to run JSON Atlas");
}
