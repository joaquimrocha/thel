#[cfg(unix)]
mod daemon;
mod git;
mod pty;

use pty::{CreateOpts, SessionManager, TermMsg, TermStatus};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

/// Bring a window to the foreground (e.g. when a notification is clicked).
#[cfg(target_os = "linux")]
fn focus_window(app: &tauri::AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Emitted to a window when its notification banner is clicked, so the frontend
/// can switch to the terminal the notification was about.
#[cfg(target_os = "linux")]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifTarget {
    session_id: String,
    terminal_id: String,
}

#[tauri::command]
fn create_session(
    state: State<SessionManager>,
    opts: CreateOpts,
    on_data: Channel<TermMsg>,
) -> Result<(), String> {
    state.create(opts, on_data)
}

#[tauri::command]
fn write_session(state: State<SessionManager>, id: String, data: String) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
fn resize_session(
    state: State<SessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
fn close_session(state: State<SessionManager>, id: String) -> Result<(), String> {
    state.close(&id)
}

/// Busy/exit status for every live terminal in one call, so the busy poller
/// hits the backend once per tick instead of once per terminal.
#[tauri::command]
fn terminal_statuses(state: State<SessionManager>) -> std::collections::HashMap<String, TermStatus> {
    state.all_statuses()
}

#[tauri::command]
fn terminal_status(state: State<SessionManager>, id: String) -> TermStatus {
    state.status(&id)
}

/// Permanently destroy a terminal (the user closed the tab).
#[tauri::command]
fn kill_terminal_window(state: State<SessionManager>, session_id: String, id: String) {
    state.kill_window(&session_id, &id);
}

/// Probe the running session daemon at startup: "ok", "skew" (an incompatible
/// version is still running), or "none".
#[tauri::command]
fn check_daemon() -> &'static str {
    #[cfg(unix)]
    {
        daemon::check()
    }
    #[cfg(not(unix))]
    {
        "none"
    }
}

/// Kill an incompatible daemon so the current build can start a fresh one. Ends
/// any sessions the old daemon was hosting (the GUI warns first).
#[tauri::command]
fn restart_daemon() -> Result<(), String> {
    #[cfg(unix)]
    {
        daemon::restart()
    }
    #[cfg(not(unix))]
    {
        Ok(())
    }
}

#[tauri::command]
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[tauri::command]
fn home_dir() -> Option<String> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var(key).ok()
}

/// Whether the path exists and is a directory. Used to validate a typed folder
/// before anchoring a session to it.
#[tauri::command]
fn dir_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Directory-name completions for a partial path, like a shell's Tab. Splits the
/// input at the final separator and returns the full paths of subdirectories of
/// the parent whose name starts with the trailing segment. Directories only;
/// hidden entries are shown only when the segment itself begins with '.'.
#[tauri::command]
fn complete_dir(input: String) -> Vec<String> {
    let Some(i) = input.rfind(|c| c == '/' || c == '\\') else {
        return Vec::new();
    };
    let dir = &input[..=i]; // keeps the trailing separator
    let prefix = &input[i + 1..];
    let base = if dir.is_empty() { "/" } else { dir };
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    let want_hidden = prefix.starts_with('.');
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.starts_with(prefix) && (want_hidden || !name.starts_with('.')))
        .map(|name| format!("{dir}{name}"))
        .collect();
    out.sort();
    // Cap the list; a completion menu only needs the first handful and some dirs
    // are huge.
    out.truncate(50);
    out
}

#[derive(serde::Serialize)]
struct FontConfig {
    family: String,
    /// Point size from the desktop setting; the frontend converts to px.
    size_pt: Option<u16>,
}

/// The desktop's preferred monospace font, so the terminal can match the look
/// of the system terminal. Linux/GNOME only; returns None elsewhere or on any
/// failure (e.g. gsettings absent), and the frontend falls back to a stack.
#[tauri::command]
fn monospace_font() -> Option<FontConfig> {
    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "monospace-font-name"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let raw = String::from_utf8(out.stdout).ok()?;
        // e.g. 'Adwaita Mono 11' -> family "Adwaita Mono", size 11.
        let s = raw.trim().trim_matches(|c| c == '\'' || c == '"').trim();
        if s.is_empty() {
            return None;
        }
        let (family, size_pt) = match s.rsplit_once(' ') {
            Some((fam, num)) if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) => {
                (fam.trim().to_string(), num.parse::<u16>().ok())
            }
            _ => (s.to_string(), None),
        };
        Some(FontConfig { family, size_pt })
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Show a desktop notification, sent from Rust rather than the webview's Web
/// Notification API (unreliable under WebKitGTK). Uses notify-rust on every
/// platform. The Linux path is separate only because click handling
/// (wait_for_action) exists just on notify-rust's DBus backend, not on the
/// macOS/Windows backends.
#[tauri::command]
fn notify(
    window: tauri::WebviewWindow,
    summary: String,
    body: String,
    // The session/terminal the notification is about, so a click can jump to it.
    // Absent for coalesced banners that span terminals.
    session_id: Option<String>,
    terminal_id: Option<String>,
) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.summary(&summary).body(&body).appname("thel");

    #[cfg(target_os = "linux")]
    {
        // Clicking the banner should raise the window that posted it (each
        // profile runs in its own window and only notifies for its own
        // terminals), not a hardcoded "main".
        let label = window.label().to_string();
        let app = window.app_handle().clone();
        notification.action("default", "Open");
        // wait_for_action blocks for the notification's lifetime, so run it
        // off-thread.
        std::thread::spawn(move || match notification.show() {
            Ok(handle) => handle.wait_for_action(|action| {
                if action == "default" {
                    focus_window(&app, &label);
                    // Tell that window's frontend which tab to switch to.
                    if let (Some(s), Some(t)) = (&session_id, &terminal_id) {
                        let _ = app.emit_to(
                            label.clone(),
                            "notification-activated",
                            NotifTarget {
                                session_id: s.clone(),
                                terminal_id: t.clone(),
                            },
                        );
                    }
                }
            }),
            Err(e) => eprintln!("notify-rust failed: {e}"),
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        // wait_for_action (click handling) is DBus-backend-only, so elsewhere
        // just show the banner; the jump target is unused.
        let _ = (&window, &session_id, &terminal_id);
        notification.show().map(|_| ()).map_err(|e| {
            eprintln!("notify failed: {e}");
            e.to_string()
        })
    }
}

/// Open a URL in the user's default browser. The webview's window.open does
/// nothing useful under WebKitGTK, so the terminal's link addon routes clicks
/// here. Only http(s) links reach this (the addon matches those), and we reject
/// anything else as a guard against opening arbitrary schemes from terminal
/// output.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("refusing to open non-http url".into());
    }
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // `start` is a cmd builtin; the empty "" is its window-title argument so
        // the URL isn't consumed as the title.
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    cmd.arg(&url);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Same binary, two modes: re-invoked with `__daemon`, become the session
    // daemon and never touch the webview (checked before any Tauri init).
    #[cfg(unix)]
    if daemon::is_daemon_arg() {
        daemon::run();
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SessionManager::default())
        .setup(|app| {
            // Paint the webview dark from the start so the window never flashes
            // white before the page loads. Matches the app's --background.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(9, 9, 11, 255)));
            }
            // Establish (spawning if needed) the daemon connection and hold it
            // open for this GUI's lifetime, so the daemon stays alive while a
            // window is open and lingers briefly after. Slice 1: prove the link.
            #[cfg(unix)]
            std::thread::spawn(|| match daemon::ensure() {
                Ok(build) => eprintln!("[thel] daemon connected (build {build})"),
                Err(e) => eprintln!("[thel] daemon connect failed: {e}"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_session,
            resize_session,
            close_session,
            terminal_statuses,
            terminal_status,
            kill_terminal_window,
            check_daemon,
            restart_daemon,
            default_shell,
            home_dir,
            dir_exists,
            complete_dir,
            monospace_font,
            notify,
            open_url,
            git::git_info,
            git::worktree_info,
            git::list_worktrees,
            git::branches,
            git::create_worktree,
            git::remove_worktree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
