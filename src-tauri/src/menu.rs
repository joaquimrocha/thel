//! Native application menu (macOS). On macOS the window is a normal native
//! window (traffic lights, native frame), so the actions that live in the custom
//! in-app title bar on Linux -- switching profiles, new/manage profiles, settings
//! -- move to the system menu bar here. The profile list is dynamic, so the
//! frontend pushes it in via `update_app_menu` whenever profiles change, and this
//! rebuilds and re-sets the menu. Selections are turned into a `menu-action`
//! event the focused window's frontend handles, reusing the same store actions
//! the Linux title-bar buttons call.

use serde::{Deserialize, Serialize};

/// One profile as the frontend knows it, for building the Profiles submenu.
/// Off macOS it only ever crosses the `update_app_menu` boundary and is dropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Deserialize)]
pub struct ProfileItem {
    pub id: String,
    pub name: String,
}

/// What a menu selection asks the frontend to do. `action` mirrors the in-app
/// intent ("settings", "new-profile", "manage-profiles", "switch-profile"); `id`
/// carries the profile id for a switch. Only ever built on macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuAction {
    action: String,
    id: Option<String>,
}

#[cfg(target_os = "macos")]
pub fn build_and_set(
    app: &tauri::AppHandle,
    profiles: &[ProfileItem],
    current: &str,
) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadata, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder,
    };

    // App menu (the bold "thel" menu): About, Settings (Cmd+,), and the standard
    // hide/quit block so the app behaves like any other Mac app.
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("Cmd+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "thel")
        .about(Some(AboutMetadata {
            name: Some("thel".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            ..Default::default()
        }))
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // Edit menu, so copy/paste and friends are reachable from the bar (and get
    // their standard accelerators) now that there's no in-app chrome for them.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // Profiles: a checkable list (current one ticked) plus new/manage, mirroring
    // the in-app profile menu on Linux.
    let mut profiles_menu = SubmenuBuilder::new(app, "Profiles");
    for p in profiles {
        let item = CheckMenuItemBuilder::with_id(format!("profile:{}", p.id), &p.name)
            .checked(p.id == current)
            .build(app)?;
        profiles_menu = profiles_menu.item(&item);
    }
    let profiles_menu = profiles_menu
        .separator()
        .item(&MenuItemBuilder::with_id("new-profile", "New Profile…").build(app)?)
        .item(&MenuItemBuilder::with_id("manage-profiles", "Manage Profiles…").build(app)?)
        .build()?;

    // Window menu: native min/zoom/fullscreen/close, replacing the custom controls.
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &profiles_menu, &edit, &window])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Translate a menu selection into a `menu-action` event for the focused window's
/// frontend. Unknown ids (the predefined items handle themselves) are ignored.
#[cfg(target_os = "macos")]
pub fn handle_event(app: &tauri::AppHandle, id: &str) {
    use tauri::{Emitter, Manager};

    let action = if let Some(pid) = id.strip_prefix("profile:") {
        MenuAction {
            action: "switch-profile".into(),
            id: Some(pid.to_string()),
        }
    } else if matches!(id, "settings" | "new-profile" | "manage-profiles") {
        MenuAction {
            action: id.to_string(),
            id: None,
        }
    } else {
        return;
    };

    // Target the focused window so an action lands in the profile the user is
    // looking at, falling back to main if none reports focus.
    let target = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    if let Some(w) = target {
        let _ = w.emit("menu-action", &action);
    }
}
