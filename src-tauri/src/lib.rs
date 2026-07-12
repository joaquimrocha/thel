#[cfg(unix)]
mod daemon;
mod git;
mod notify_cmd;
mod pty;

use pty::{CreateOpts, SessionManager, TermMsg, TermStatus};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

/// Bring a window to the foreground (e.g. when a notification is clicked). Must
/// run on the GTK main thread. On Wayland a background process can't raise
/// itself; `token` is the XDG activation token the compositor granted for the
/// click, fed to GTK so the present is allowed instead of bouncing to GNOME's
/// "app is ready" notification.
#[cfg(target_os = "linux")]
fn focus_window(app: &tauri::AppHandle, label: &str, token: Option<&str>) {
    use gtk::prelude::*;
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        if let Ok(gtk_win) = w.gtk_window() {
            if let Some(t) = token {
                gtk_win.set_startup_id(t);
            }
            gtk_win.present();
        }
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

/// Whether a program is spawnable: a path (contains a separator) is checked
/// directly, a bare name is searched in PATH. Lets the GUI fail a no-shell
/// launcher with an error dialog instead of a silently dead tab. Windows
/// PATHEXT resolution is skipped (Linux-first); a bare name there may probe
/// the literal file only.
#[tauri::command]
fn program_exists(name: String) -> bool {
    use std::path::Path;
    #[cfg(unix)]
    fn is_exec(p: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        p.is_file()
            && p.metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    fn is_exec(p: &Path) -> bool {
        p.is_file()
    }
    if name.contains('/') || (cfg!(windows) && name.contains('\\')) {
        return is_exec(Path::new(&name));
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| is_exec(&dir.join(&name)))
}

/// Launch a command detached in its own session, fire-and-forget. Used for
/// no-shell "app" launchers (e.g. `flatpak run <gui-app>`): they aren't
/// terminals, so they get no PTY/tab and must outlive thel and any tab close.
#[tauri::command]
fn spawn_detached(command: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    {
        // setsid forks the target into a new session and exits, so the target
        // reparents to init -- detached from thel's terminal and lifecycle, with
        // no zombie left here (we reap the short-lived setsid).
        let mut cmd = Command::new("setsid");
        cmd.arg(&command).args(&args);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to launch '{command}': {e}"))?;
        let _ = child.wait();
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let mut cmd = Command::new(&command);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to launch '{command}': {e}"))
    }
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
/// Notification API (unreliable under WebKitGTK). Linux shells out to
/// notify-send (so the binary skips notify-rust's zbus/async stack);
/// macOS/Windows use notify-rust. Both hit the same notification service with
/// the same text, so the banner is identical either way.
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
    #[cfg(target_os = "linux")]
    {
        // notify-send hits the same org.freedesktop.Notifications service that
        // notify-rust used, with the same app name, summary, body, and a
        // "default" action, so the banner and click are identical, but it avoids
        // pulling notify-rust's zbus/async stack into the Linux build.
        //
        // Clicking the banner triggers the "default" action, which notify-send
        // prints on stdout; --wait blocks for the notification's lifetime, so
        // run it off-thread. On click we raise the window that posted it (each
        // profile is its own window) and tell its frontend which tab to show.
        //
        // The desktop-entry hint ties the banner to our .desktop file so GNOME
        // raises the app itself on click. Without it the compositor won't grant
        // the focus (Wayland focus-stealing prevention), the window stays hidden,
        // and the still-unfocused terminal posts a second notification.
        let label = window.label().to_string();
        let app = window.app_handle().clone();
        std::thread::spawn(move || {
            use std::io::Read;
            use std::os::unix::io::FromRawFd;
            use std::os::unix::process::CommandExt;

            // Pipe so notify-send can hand back the XDG activation token the
            // compositor grants on click. O_CLOEXEC keeps it out of unrelated
            // children; pre_exec re-exposes the write end at fd 3 for this child.
            let mut fds = [0 as libc::c_int; 2];
            let have_pipe = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } == 0;
            let (read_fd, write_fd) = (fds[0], fds[1]);

            let mut cmd = std::process::Command::new("notify-send");
            cmd.arg("--app-name=thel")
                .arg("--hint=string:desktop-entry:com.joaquimrocha.thel")
                .arg("--wait")
                .arg("--action=default=Open");
            if have_pipe {
                cmd.arg("--activation-token-fd=3");
                unsafe {
                    cmd.pre_exec(move || {
                        // dup2 clears CLOEXEC on the copy, so fd 3 survives exec.
                        if libc::dup2(write_fd, 3) < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
            }
            let result = cmd.arg("--").arg(&summary).arg(&body).output();

            // Drop our write end so the read end hits EOF once the child exits,
            // then read whatever token it wrote (empty if the daemon can't grant
            // one, in which case we just present without it).
            let mut token = String::new();
            if have_pipe {
                unsafe { libc::close(write_fd) };
                let mut r = unsafe { std::fs::File::from_raw_fd(read_fd) };
                let _ = r.read_to_string(&mut token);
            }

            match result {
                Ok(out) if out.status.success() => {
                    if String::from_utf8_lossy(&out.stdout).trim() == "default" {
                        let app2 = app.clone();
                        let label2 = label.clone();
                        let token = token.trim().to_string();
                        // GTK calls must run on the main thread.
                        let _ = app.run_on_main_thread(move || {
                            let t = (!token.is_empty()).then_some(token.as_str());
                            focus_window(&app2, &label2, t);
                        });
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
                }
                // A non-zero exit can still mean the banner was shown (e.g. an
                // activation-token warning on click), so don't re-post here or
                // we'd double the banner. Just log; the user already saw it.
                Ok(out) => {
                    eprintln!(
                        "notify-send exited {}: {}",
                        out.status,
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
                Err(e) => eprintln!("notify-send unavailable: {e}"),
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS/Windows use notify-rust (no zbus there); the jump target is
        // unused since click handling is the DBus backend's.
        let _ = (&window, &session_id, &terminal_id);
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
    let mut cmd = std::process::Command::new("explorer");
    cmd.arg(&url);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The files on the clipboard (a file-manager "Copy"), as paths. Empty when
/// the clipboard holds no file list, so a paste can fall back to text.
#[tauri::command]
fn clipboard_files() -> Vec<String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get().file_list())
        .map(|paths| {
            paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn print_help() {
    print!(
        "thel - Terminal helper built for AI coding agents and other long-running sessions

Usage:
  thel                Launch the app
  thel notify [MSG]   Post a desktop notification for the current terminal
                      (run from inside a thel terminal; MSG is optional)

Options:
  -h, --help          Show this help and exit
  -V, --version       Show the version and exit
"
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // CLI dispatch, handled before any GUI/daemon work so these exit immediately.
    let argv: Vec<String> = std::env::args().collect();
    match argv.get(1).map(String::as_str) {
        // `thel notify [message]`: post a notification for the current terminal.
        Some("notify") => {
            notify_cmd::run(&argv[2..]);
            return;
        }
        Some("-h" | "--help") => {
            print_help();
            return;
        }
        Some("-V" | "--version") => {
            println!("thel {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {}
    }

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
            terminal_status,
            kill_terminal_window,
            check_daemon,
            restart_daemon,
            default_shell,
            home_dir,
            dir_exists,
            program_exists,
            spawn_detached,
            complete_dir,
            monospace_font,
            notify,
            open_url,
            clipboard_files,
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
