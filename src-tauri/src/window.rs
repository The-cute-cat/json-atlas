use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter,
};

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
    let open = MenuItem::with_id(app, "open", "打开文件(&O)…", true, Some("Ctrl+O"))?;
    let close = MenuItem::with_id(app, "close", "关闭当前文件(&W)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出(&X)", true, Some("Alt+F4"))?;
    let separator = PredefinedMenuItem::separator(app)?;
    let save = MenuItem::with_id(app, "save-copy", "另存为…", false, None::<&str>)?;
    let file = Submenu::with_items(
        app,
        "文件(&F)",
        true,
        &[&open, &close, &save, &separator, &quit],
    )?;
    let edit_mode = MenuItem::with_id(app, "edit-mode", "编辑模式", false, None::<&str>)?;
    let undo = MenuItem::with_id(app, "undo-edit", "撤销修改", false, None::<&str>)?;
    let format = MenuItem::with_id(app, "format-json", "格式化文档", false, None::<&str>)?;
    let edit = Submenu::with_items(app, "编辑(&E)", true, &[&edit_mode, &undo, &format])?;
    let reset = MenuItem::with_id(app, "reset", "重置视图(&R)", true, None::<&str>)?;
    let find = MenuItem::with_id(app, "find", "查找(&F)…", true, Some("CmdOrCtrl+F"))?;
    let settings = MenuItem::with_id(app, "settings", "设置(&S)…", true, None::<&str>)?;
    let switch_view = MenuItem::with_id(app, "switch-view", "IDE 视图", false, None::<&str>)?;
    let view = Submenu::with_items(
        app,
        "查看(&V)",
        true,
        &[&switch_view, &find, &reset, &settings],
    )?;
    let about = MenuItem::with_id(app, "about", "关于 JSON Atlas(&A)", true, None::<&str>)?;
    let help = Submenu::with_items(app, "帮助(&H)", true, &[&about])?;
    let menu = Menu::with_items(app, &[&file, &edit, &view, &help])?;
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .menu(menu)
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
}

#[tauri::command]
pub fn sync_document_menu(
    window: tauri::WebviewWindow,
    items: Vec<DocumentMenuItem>,
) -> Result<(), String> {
    let Some(menu) = window.menu() else {
        return Ok(());
    };
    for submenu in menu.items().map_err(|e| e.to_string())? {
        let Some(submenu) = submenu.as_submenu() else {
            continue;
        };
        for state in &items {
            if ![
                "save-copy",
                "edit-mode",
                "undo-edit",
                "switch-view",
                "format-json",
            ]
            .contains(&state.id.as_str())
            {
                continue;
            }
            if let Some(item) = submenu
                .get(&state.id)
                .and_then(|item| item.as_menuitem().cloned())
            {
                item.set_text(&state.text).map_err(|e| e.to_string())?;
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
