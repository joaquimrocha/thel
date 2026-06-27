#[cfg(unix)]
mod daemon;
mod git;
mod pty;

use pty::{CreateOpts, SessionManager, TermMsg, TermStatus};
use tauri::ipc::Channel;
use tauri::{Manager, State};

/// Bring the main window to the foreground (e.g. when a notification is clicked).
#[cfg(target_os = "linux")]
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
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
/// Notification API (unreliable under WebKitGTK). On Linux we shell out to
/// notify-send (libnotify): under WebKitGTK/distrobox, notify-rust's zbus call
/// reports success but no banner appears, while notify-send works. notify-rust
/// is the fallback and the path on other platforms.
#[tauri::command]
fn notify(app: tauri::AppHandle, summary: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // Register a default action and --wait for it: clicking the banner makes
        // notify-send print the action key, which is our cue to raise the window.
        // Runs off-thread because --wait blocks for the notification's lifetime.
        std::thread::spawn(move || {
            match std::process::Command::new("notify-send")
                .arg("--app-name=thel")
                .arg("--wait")
                .arg("--action=default=Open")
                .arg(&summary)
                .arg(&body)
                .output()
            {
                Ok(out) if out.status.success() => {
                    if String::from_utf8_lossy(&out.stdout).trim() == "default" {
                        focus_main_window(&app);
                    }
                }
                // Older libnotify lacks --wait/--action; still show a plain banner.
                Ok(out) => {
                    eprintln!(
                        "notify-send actions unsupported ({}): {}",
                        out.status,
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                    let _ = std::process::Command::new("notify-send")
                        .arg("--app-name=thel")
                        .arg(&summary)
                        .arg(&body)
                        .status();
                }
                Err(e) => eprintln!("notify-send unavailable: {e}"),
            }
        });
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = &app;
        notify_rust::Notification::new()
            .summary(&summary)
            .body(&body)
            .appname("thel")
            .show()
            .map(|_| ())
            .map_err(|e| {
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
