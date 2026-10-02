//! System tray icon: resident while the app runs, so a hidden main window
//! (close-to-tray) is always one click away. Left click shows the window;
//! the context menu offers open/quit in the user's language.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::{request_app_exit, show_main_window};

/// Managed handles so `update_labels` can retext the menu items in place
/// when the frontend reports a locale change.
pub struct TrayState {
    open_item: MenuItem<tauri::Wry>,
    quit_item: MenuItem<tauri::Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // A missing bundled icon must not abort startup: warn and run tray-less
    // instead of panicking inside `setup`. `update_labels` tolerates the
    // missing TrayState, so nothing else needs to change.
    let Some(icon) = app.default_window_icon() else {
        eprintln!("警告：未找到打包的应用图标，托盘将不可用（其余功能不受影响）");
        return Ok(());
    };
    let icon = icon.clone();
    let open_item =
        MenuItem::with_id(app, "tray-open", "打开 MediaTool", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("MediaTool")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_main_window(app),
            "tray-quit" => request_app_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayState { open_item, quit_item });
    Ok(())
}

/// Retext the tray menu (frontend passes labels for the active locale).
pub fn update_labels(app: &AppHandle, open: String, quit: String) {
    if let Some(state) = app.try_state::<TrayState>() {
        let _ = state.open_item.set_text(open);
        let _ = state.quit_item.set_text(quit);
    }
}
