#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod documents;
mod window;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

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
            select_documents,
            set_document_title
        ])
        .run(tauri::generate_context!())
        .expect("failed to run JSON Atlas");
}
