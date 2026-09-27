//! One cgroup per terminal on Linux with a systemd user manager. The daemon
//! starts each shell through `systemd-run --user --scope`, which moves it into
//! a transient scope under `app-thel.slice` and then execs it, so the shell
//! keeps its pid, session, environment and cwd. The scope then holds every
//! process the terminal starts, including ones that setsid or double-fork away
//! from the shell's process tree.
//!
//! Only resource sampling reads the scope. Closing a terminal still kills just
//! the shell's session (see `daemon::kill_session`), so detached jobs outlive
//! the tab as they would in any terminal.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

const SLICE: &str = "app-thel.slice";

/// The systemd-run to wrap terminals in, or None to spawn them plainly. Probed
/// once per daemon by starting a throwaway scope, so a system without systemd,
/// or without a reachable user manager (containers, CI), falls back.
///
/// ponytail: probed once. If the user manager goes away later, systemd-run
/// fails and the new terminal exits at once; re-probe on that failure if it
/// ever happens in practice.
pub(crate) fn systemd_run() -> Option<&'static Path> {
    static PROBE: OnceLock<Option<PathBuf>> = OnceLock::new();
    PROBE
        .get_or_init(|| {
            let path = std::env::var("PATH").unwrap_or_default();
            let bin = which("systemd-run", &path, Path::new("/"))?;
            let mut child = Command::new(&bin)
                .args(SCOPE_ARGS)
                .arg("true")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            exited_ok_within(&mut child, PROBE_TIMEOUT).then_some(bin)
        })
        .as_deref()
}

/// How long the probe may take. It runs inside the first terminal's spawn, so a
/// hung user bus must not hang that terminal; systemd-run's own D-Bus timeout
/// is 25 s.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Whether `child` exits successfully within `limit`. Kills it otherwise.
fn exited_ok_within(child: &mut std::process::Child, limit: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Resolves `command` the way execvp would: a name with a slash is a path
/// (relative to `cwd`), anything else is looked up on `path`.
pub(crate) fn which(command: &str, path: &str, cwd: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let runnable = |p: &Path| {
        p.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    if command.contains('/') {
        let p = cwd.join(command);
        return runnable(&p).then_some(p);
    }
    std::env::split_paths(path)
        .map(|dir| dir.join(command))
        .find(|p| runnable(p))
}

/// systemd-run arguments that run what follows them in a new scope. systemd
/// names the unit (run-p<pid>-….scope), so a respawned terminal never collides
/// with a scope its escaped processes still keep alive. systemd-run expands
/// `$VAR` and `$$` in the command by default, which would rewrite the user's
/// command line; turning that off needs systemd 254, and on an older one the
/// probe fails on the flag, so terminals spawn plainly there.
pub(crate) const SCOPE_ARGS: [&str; 8] = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--expand-environment=no",
    "--slice",
    SLICE,
    "--",
];

/// The directory of `pid`'s scope when it is a thel terminal scope. None for
/// a shell that shares the daemon's cgroup (the fallback), since that cgroup
/// holds the daemon and every other terminal too.
pub(crate) fn scope_of(pid: u32) -> Option<PathBuf> {
    let file = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    let rel = terminal_scope(&file)?;
    Some(Path::new("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
}

/// Picks the cgroup v2 line (`0::<path>`) out of a /proc/<pid>/cgroup file and
/// keeps it only if it is a scope in thel's slice.
fn terminal_scope(file: &str) -> Option<&str> {
    let path = file.lines().find_map(|l| l.strip_prefix("0::"))?;
    let (parent, leaf) = path.rsplit_once('/')?;
    (parent.ends_with(&format!("/{SLICE}")) && leaf.ends_with(".scope")).then_some(path)
}

/// Every process in the scope.
pub(crate) fn procs(scope: &Path) -> Vec<u32> {
    std::fs::read_to_string(scope.join("cgroup.procs"))
        .map(|s| s.lines().filter_map(|l| l.parse().ok()).collect())
        .unwrap_or_default()
}

/// CPU time the scope has used since it started, exited processes included, in
/// seconds. The kernel keeps this in every cgroup, with or without the cpu
/// controller.
pub(crate) fn cpu_seconds(scope: &Path) -> f64 {
    std::fs::read_to_string(scope.join("cpu.stat"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("usage_usec "))?
                .parse::<u64>()
                .ok()
        })
        .map_or(0.0, |us| us as f64 / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hung_probe_counts_as_failed_and_is_killed() {
        let limit = std::time::Duration::from_millis(100);
        let mut ok = Command::new("true").spawn().unwrap();
        assert!(exited_ok_within(&mut ok, limit));
        let mut hung = Command::new("sleep").arg("30").spawn().unwrap();
        let start = std::time::Instant::now();
        assert!(!exited_ok_within(&mut hung, limit));
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        assert!(hung.try_wait().unwrap().is_some());
    }

    #[test]
    fn keeps_only_scopes_in_the_thel_slice() {
        let ours = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-thel.slice/run-p42-i7.scope\n";
        assert_eq!(
            terminal_scope(ours),
            Some("/user.slice/user-1000.slice/user@1000.service/app.slice/app-thel.slice/run-p42-i7.scope")
        );
        // The fallback: the shell sits in the daemon's own cgroup.
        let app = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-thel-9486.scope\n";
        assert_eq!(terminal_scope(app), None);
        // A slice nested under ours is not a terminal scope.
        let nested = "0::/app.slice/app-thel.slice/app-thel-x.slice\n";
        assert_eq!(terminal_scope(nested), None);
        // cgroup v1 lines only.
        assert_eq!(
            terminal_scope("12:pids:/app-thel.slice/run-p1.scope\n"),
            None
        );
    }

    #[test]
    fn which_resolves_like_execvp() {
        assert_eq!(
            which("sh", "/nonexistent:/bin", Path::new("/")),
            Some("/bin/sh".into())
        );
        assert_eq!(which("sh", "/nonexistent", Path::new("/")), None);
        assert_eq!(which("bin/sh", "", Path::new("/")), Some("/bin/sh".into()));
        assert_eq!(
            which("/bin/sh", "", Path::new("/tmp")),
            Some("/bin/sh".into())
        );
        // A directory is not runnable.
        assert_eq!(which("bin", "/", Path::new("/")), None);
    }

    #[test]
    fn passes_the_command_line_through_verbatim() {
        let Some(bin) = systemd_run() else {
            eprintln!("no systemd user manager; skipping");
            return;
        };
        let out = Command::new(bin)
            .args(SCOPE_ARGS)
            .args(["echo", "$HOME $$ ${X}"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "$HOME $$ ${X}\n");
    }

    /// Runs only where a user manager answers, as on a desktop session.
    #[test]
    fn a_scoped_shell_keeps_its_pid_and_is_found() {
        let Some(bin) = systemd_run() else {
            eprintln!("no systemd user manager; skipping");
            return;
        };
        let mut child = Command::new(bin)
            .args(SCOPE_ARGS)
            .args(["sleep", "30"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let scope = (0..50)
            .find_map(|_| {
                std::thread::sleep(std::time::Duration::from_millis(20));
                scope_of(pid)
            })
            .expect("the child lands in a thel scope");
        assert_eq!(procs(&scope), vec![pid]);
        let _ = child.kill();
        let _ = child.wait();
    }
}
