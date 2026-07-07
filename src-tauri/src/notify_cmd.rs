//! `thel notify [message]`: from inside a thel terminal, post a desktop
//! notification for *this* terminal. It writes an OSC 9 escape to the
//! controlling tty; thel is already reading that PTY, so it attributes the
//! notification to the right terminal with no id or socket needed. OSC 9 is the
//! sequence iTerm2 uses too, so it degrades gracefully in other terminals.

use std::io::Write;

const DEFAULT_MSG: &str = "Terminal wants attention";

/// Drop control characters (C0, DEL, C1) so a crafted message can't inject its
/// own escape sequences into thel's terminal parser (e.g. a BEL to close the
/// OSC early followed by arbitrary control bytes). Printable ASCII and all
/// multibyte UTF-8 (accents, emoji) pass through.
fn sanitize(msg: &str) -> String {
    msg.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// The OSC 9 desktop-notification sequence carrying `msg`.
fn osc9(msg: &str) -> String {
    format!("\x1b]9;{msg}\x07")
}

/// Run the `notify` subcommand. `args` is everything after the `notify` token.
pub fn run(args: &[String]) {
    let msg = {
        let s = sanitize(&args.join(" "));
        if s.is_empty() {
            DEFAULT_MSG.to_string()
        } else {
            s
        }
    };
    if std::env::var_os("THEL").is_none() {
        eprintln!("thel notify: not running inside a thel terminal; sending anyway");
    }

    // Preferred path: hand the message to the daemon, addressed by this tab's id.
    // It reaches thel out-of-band, so it works even when this process has no
    // controlling tty (e.g. an agent's Stop hook), which the OSC-to-/dev/tty path
    // below cannot. Falls through if there's no daemon (direct-PTY mode).
    #[cfg(unix)]
    if let Some(id) = std::env::var_os("THEL_TERMINAL_ID").and_then(|s| s.into_string().ok()) {
        if crate::daemon::send_notify(&id, &msg) {
            return;
        }
    }

    let seq = osc9(&msg);
    // Write to the controlling terminal, not stdout, so a redirected stdout
    // (`thel notify done > log`) doesn't swallow the sequence. Fall back to
    // stderr where there's no /dev/tty.
    match std::fs::OpenOptions::new().write(true).open("/dev/tty") {
        Ok(mut tty) => {
            let _ = tty.write_all(seq.as_bytes());
            let _ = tty.flush();
        }
        Err(_) => {
            let _ = std::io::stderr().write_all(seq.as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_controls_so_no_escape_can_form() {
        // A message trying to close the OSC (BEL) then inject a clear-screen.
        let out = sanitize("hi\x07\x1b[2Jthere");
        assert!(!out.contains('\x07') && !out.contains('\x1b'));
        // The leftover "[2J" is inert text: without the ESC it's not a sequence.
        assert_eq!(out, "hi[2Jthere");
    }

    #[test]
    fn keeps_unicode() {
        assert_eq!(sanitize("build ✅ 完成"), "build ✅ 完成");
    }

    #[test]
    fn wraps_message_in_osc9() {
        assert_eq!(osc9("done"), "\x1b]9;done\x07");
    }
}
