use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

fn allowed_navigation(url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let bundled = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (["http", "https"].contains(&url.scheme())
                && url.host_str() == Some("tauri.localhost")));
    bundled || dev.is_some_and(|dev| url.origin() == dev.origin())
}

// Work area coordinates are physical; window configuration uses logical pixels.
fn geometry(x: i32, y: i32, width: u32, height: u32, scale: f64) -> (f64, f64, f64, f64) {
    let width = width as f64 / scale;
    let height = height as f64 / scale;
    (
        x as f64 / scale + width * 0.125,
        y as f64 / scale + height * 0.125,
        width * 0.75,
        height * 0.75,
    )
}

fn menu_title(title: &'static str, windows_title: &'static str) -> &'static str {
    if cfg!(target_os = "macos") {
        title
    } else {
        windows_title
    }
}

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let mut config = app.config().app.windows[0].clone();
    if let Some(monitor) = app.primary_monitor()? {
        let area = monitor.work_area();
        let (x, y, width, height) = geometry(
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
            monitor.scale_factor(),
        );
        config.x = Some(x);
        config.y = Some(y);
        config.width = width;
        config.height = height;
        config.min_width = Some(640.0_f64.min(width));
        config.min_height = Some(480.0_f64.min(height));
        config.center = false;
    }
    config.visible = false;
    let open = MenuItem::with_id(
        app,
        "open",
        menu_title("打开文件…", "打开文件(&O)…"),
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let close = MenuItem::with_id(
        app,
        "close",
        menu_title("关闭当前文件", "关闭当前文件(&W)"),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        menu_title("退出 JSON Atlas", "退出(&X)"),
        true,
        Some(if cfg!(target_os = "macos") {
            "Cmd+Q"
        } else {
            "Alt+F4"
        }),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let save = MenuItem::with_id(
        app,
        "save-copy",
        "另存为…",
        false,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let save_original = MenuItem::with_id(
        app,
        "save",
        menu_title("保存", "保存(&S)"),
        false,
        Some("CmdOrCtrl+S"),
    )?;
    let file_items: &[&dyn tauri::menu::IsMenuItem<_>] = if cfg!(target_os = "macos") {
        &[&open, &close, &save_original, &save]
    } else {
        &[&open, &close, &save_original, &save, &separator, &quit]
    };
    let file = Submenu::with_items(app, menu_title("文件", "文件(&F)"), true, file_items)?;
    let edit_mode = MenuItem::with_id(app, "edit-mode", "编辑模式", false, None::<&str>)?;
    let undo = MenuItem::with_id(app, "undo-edit", "撤销修改", false, None::<&str>)?;
    let format = MenuItem::with_id(app, "format-json", "格式化文档", false, None::<&str>)?;
    #[cfg(target_os = "macos")]
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &undo,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            // Copy and Undo have document-specific meanings. Leave ⌘C/⌘Z to the
            // WebView's focus-aware handler; predefined items would claim those keys.
            &MenuItem::with_id(
                app,
                "copy-node",
                menu_label("复制选中节点内容", Some("⌘+C")),
                false,
                None::<&str>,
            )?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &PredefinedMenuItem::separator(app)?,
            &edit_mode,
            &format,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    let edit = Submenu::with_items(app, "编辑(&E)", true, &[&edit_mode, &undo, &format])?;
    let reset = MenuItem::with_id(
        app,
        "reset",
        menu_title("重置视图", "重置视图(&R)"),
        true,
        None::<&str>,
    )?;
    let find = MenuItem::with_id(
        app,
        "find",
        menu_title("查找…", "查找(&F)…"),
        true,
        Some("CmdOrCtrl+F"),
    )?;
    let settings = MenuItem::with_id(
        app,
        "settings",
        menu_title("设置…", "设置(&S)…"),
        true,
        None::<&str>,
    )?;
    let switch_view = MenuItem::with_id(app, "switch-view", "IDE 视图", false, None::<&str>)?;
    let view = Submenu::with_items(
        app,
        menu_title("查看", "查看(&V)"),
        true,
        &[&switch_view, &find, &reset, &settings],
    )?;
    let about = MenuItem::with_id(
        app,
        "about",
        menu_title("关于 JSON Atlas", "关于 JSON Atlas(&A)"),
        true,
        None::<&str>,
    )?;
    #[cfg(not(target_os = "macos"))]
    let help = Submenu::with_items(app, "帮助(&H)", true, &[&about])?;
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "JSON Atlas",
            true,
            &[
                &about,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, Some("服务"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some("隐藏 JSON Atlas"))?,
                &PredefinedMenuItem::hide_others(app, Some("隐藏其他应用"))?,
                &PredefinedMenuItem::separator(app)?,
                // Keep the custom Quit item so ⌘Q still goes through the unsaved-edit guard.
                &quit,
            ],
        )?;
        app.set_menu(Menu::with_items(app, &[&app_menu, &file, &edit, &view])?)?;
    }
    let dev_url = if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    #[cfg(not(target_os = "macos"))]
    let builder = builder.menu(Menu::with_items(app, &[&file, &edit, &view, &help])?);
    builder
        .on_navigation(move |url| allowed_navigation(url, dev_url.as_ref()))
        .on_menu_event(|window, event| {
            if event.id().as_ref() == "quit" {
                let _ = window.close();
            } else {
                let _ = window.emit("desktop-action", event.id().as_ref());
            }
        })
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = window.show();
            }
        })
        .build()?;
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct DocumentMenuItem {
    id: String,
    text: String,
    enabled: bool,
    shortcut: Option<String>,
}

// Display-only hints keep shortcuts in the WebView's focus/IME-aware handler.
// Native accelerators for undo or Ctrl+Alt combinations would intercept input
// before that handler can protect text fields, dialogs and AltGr layouts.
fn menu_label(text: &str, shortcut: Option<&str>) -> String {
    match shortcut {
        #[cfg(windows)]
        Some(keys) => format!("{text}\t{keys}"),
        #[cfg(not(windows))]
        Some(keys) => format!("{text}    {keys}"),
        None => text.to_owned(),
    }
}

#[tauri::command]
pub fn sync_document_menu(
    window: tauri::WebviewWindow,
    items: Vec<DocumentMenuItem>,
) -> Result<(), String> {
    let Some(menu) = window.menu().or_else(|| window.app_handle().menu()) else {
        return Ok(());
    };
    for submenu in menu.items().map_err(|e| e.to_string())? {
        let Some(submenu) = submenu.as_submenu() else {
            continue;
        };
        for state in &items {
            if ![
                "save-copy",
                "save",
                "edit-mode",
                "undo-edit",
                "copy-node",
                "switch-view",
                "format-json",
                "close",
                "reset",
                "settings",
                "about",
            ]
            .contains(&state.id.as_str())
            {
                continue;
            }
            if let Some(item) = submenu
                .get(&state.id)
                .and_then(|item| item.as_menuitem().cloned())
            {
                item.set_text(menu_label(&state.text, state.shortcut.as_deref()))
                    .map_err(|e| e.to_string())?;
                item.set_enabled(state.enabled).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::geometry;
    #[test]
    fn navigation_only_allows_app_and_exact_development_origin() {
        use super::allowed_navigation;
        let dev = tauri::Url::parse("http://127.0.0.1:1420").unwrap();
        for text in ["tauri://localhost/index.html", "http://tauri.localhost/"] {
            assert!(allowed_navigation(&tauri::Url::parse(text).unwrap(), None));
        }
        assert!(allowed_navigation(&dev, Some(&dev)));
        assert!(!allowed_navigation(&dev, None));
        for text in [
            "https://example.com/",
            "http://127.0.0.1:1421/",
            "http://tauri.localhost.evil/",
            "http://user@tauri.localhost/",
        ] {
            assert!(!allowed_navigation(
                &tauri::Url::parse(text).unwrap(),
                Some(&dev)
            ));
        }
    }
    #[test]
    fn small_screen_keeps_seventy_five_percent() {
        assert_eq!(geometry(0, 0, 800, 560, 1.0), (100.0, 70.0, 600.0, 420.0));
    }
    #[test]
    fn large_screen_grows() {
        assert_eq!(
            geometry(0, 0, 3840, 2080, 1.0),
            (480.0, 260.0, 2880.0, 1560.0)
        );
    }
    #[test]
    fn dpi_and_work_area_offset_are_converted() {
        assert_eq!(
            geometry(-1920, 40, 1920, 1040, 2.0),
            (-840.0, 85.0, 720.0, 390.0)
        );
    }
}
