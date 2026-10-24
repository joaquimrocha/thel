//! `thel session`: lets a program in a thel terminal open sessions and
//! terminals, list them, type into them and edit their notes, the way
//! `thel notify` posts a notification. The CLI sends a request to the daemon,
//! which acts only for a caller running inside one of its terminals. Sessions
//! are the GUI's: each window reports its sessions to the daemon, and the
//! daemon hands the terminals it starts to the GUI to place.

// The daemon is unix-only, and most of this serves it; elsewhere only the
// notes helpers and the CLI's parser run.
#![cfg_attr(not(unix), allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What the CLI asks the daemon for.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// A new session with one terminal. An empty `command` means the shell.
    New {
        name: Option<String>,
        cwd: String,
        command: Vec<String>,
    },
    /// A new terminal in `session` (an id or a name), by default the caller's.
    Terminal {
        session: Option<String>,
        cwd: String,
        command: Vec<String>,
    },
    /// The sessions; for a sandboxed caller, without `all`, only its own and
    /// those it started.
    List { all: bool },
    SendKeys {
        terminal: String,
        data: Vec<u8>,
    },
    /// Read the notes of `session` (an id or a name, by default the
    /// caller's), or change them when `edit` is set.
    Note {
        session: Option<String>,
        edit: Option<NoteEdit>,
    },
}

/// A notes change `thel session note` made, for the GUI windows.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NoteChange {
    pub session: String,
    pub text: String,
    pub edit: NoteEdit,
}

/// A change `thel session note` makes to a session's notes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteEdit {
    Set { text: String },
    /// Adds `text` as new lines at the end. An empty `text` changes nothing.
    Append { text: String },
}

impl NoteEdit {
    /// The notes after this edit of `old`.
    pub fn apply(&self, old: &str) -> String {
        match self {
            NoteEdit::Set { text } => text.clone(),
            NoteEdit::Append { text } if text.is_empty() => old.to_string(),
            NoteEdit::Append { text } => {
                let mut out = old.to_string();
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(text);
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out
            }
        }
    }
}

/// The notes file of session `id` in `dir`: one markdown file per session.
pub fn note_file(dir: &Path, id: &str) -> Result<PathBuf, String> {
    // The id comes from a window, so keep it to a bare filename: nothing here
    // may reach outside the notes folder.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid session id".into());
    }
    Ok(dir.join(format!("{id}.md")))
}

/// A notes file's text, empty when there is none yet. Fails on anything but
/// a regular file: a link put in the notes folder could point at any file the
/// reader may read, and a program that may only write that folder would get
/// it read back as notes.
pub fn read_note(path: &Path) -> Result<String, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    // Nonblocking, so a FIFO fails the check below instead of hanging the open.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut opts, libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = match opts.open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("the notes file is not a regular file".into());
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut file, &mut text).map_err(|e| e.to_string())?;
    Ok(text)
}

/// Saves a notes file. Empty notes remove it, so cleared notes leave nothing
/// behind.
pub fn write_note(path: &Path, text: &str) -> Result<(), String> {
    if text.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if let Some(dir) = path.parent() {
        make_notes_dir(dir)?;
    }
    // Written beside it and renamed over it, so a reader in the other process
    // (the GUI or the daemon) sees the old notes or the new, never half.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let res = opts
        .open(&tmp)
        .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, path));
    if res.is_err() {
        // Best effort: the error that matters is the one returned below.
        let _ = std::fs::remove_file(&tmp);
    }
    res.map_err(|e| e.to_string())
}

fn make_notes_dir(dir: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir).map_err(|e| e.to_string())
}

/// Locks the notes in `dir` until the returned file drops. The daemon and the
/// GUI are two processes that both edit notes; each takes this around a read
/// and the write after it, so neither saves over a change made in between.
/// Fails after a few seconds without the lock: any program of the user's can
/// take it and keep it.
pub fn lock_notes(dir: &Path) -> Result<std::fs::File, String> {
    make_notes_dir(dir)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        std::os::unix::fs::OpenOptionsExt::custom_flags(&mut opts, libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = opts.open(dir.join(".lock")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    for _ in 0..300 {
        use std::os::fd::AsRawFd;
        // SAFETY: the fd is open for as long as `file` lives.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(file);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    #[cfg(not(unix))]
    return Ok(file);
    #[cfg(unix)]
    Err("another program holds the notes lock".into())
}

/// Saves `text` as the GUI's edit of a note it last saw on disk as `base`.
/// Returns what is on disk instead, unsaved, when that changed in the
/// meantime: `thel session note` edited it, and the window merges its text
/// once it hears of that edit. Without a `base` it saves whatever is there.
pub fn save_note(path: &Path, base: Option<&str>, text: &str) -> Result<Option<String>, String> {
    let _lock = lock_notes(path.parent().ok_or("a notes file needs a folder")?)?;
    if let Some(base) = base {
        let now = read_note(path)?;
        if now != base {
            return Ok(Some(now));
        }
    }
    write_note(path, text).map(|()| None)
}

impl Request {
    /// Refuses what the CLI never sends: a relative directory would resolve
    /// against the daemon's own, and the prompt would show it as `.`.
    pub fn check(&self) -> Result<(), String> {
        match self {
            Request::New { cwd, .. } | Request::Terminal { cwd, .. } if !Path::new(cwd).is_absolute() => {
                Err(format!("the directory {} is not an absolute path", shown(cwd)))
            }
            _ => Ok(()),
        }
    }

    /// The request with the links in its directory resolved, so a prompt
    /// shows the folder the terminal starts in.
    pub fn resolved(self) -> Result<Request, String> {
        // One error whatever went wrong, so a sandboxed caller learns no more
        // of what is there than a prompt would show.
        let real = |cwd: String| match std::fs::canonicalize(&cwd) {
            Ok(p) if p.is_dir() => Ok(p.to_string_lossy().into_owned()),
            _ => Err(format!("no folder {}", shown(&cwd))),
        };
        Ok(match self {
            Request::New { name, cwd, command } => Request::New { name, cwd: real(cwd)?, command },
            Request::Terminal { session, cwd, command } => Request::Terminal { session, cwd: real(cwd)?, command },
            other => other,
        })
    }
}

/// The daemon's answer to a Request.
#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Reply {
    pub error: Option<String>,
    /// The terminal a New or Terminal request started.
    pub terminal: Option<String>,
    pub sessions: Vec<Listed>,
    /// The notes a Note request read. An edit leaves them out.
    pub note: Option<String>,
}

/// A session as `thel session list` shows it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Listed {
    /// None for a session the daemon started that no window has shown yet.
    pub id: Option<String>,
    pub name: String,
    pub terminals: Vec<ListedTerminal>,
}

/// A terminal of a Listed session.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ListedTerminal {
    pub id: String,
    pub state: TerminalState,
}

/// Whether a listed terminal runs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalState {
    Running,
    Exited,
    /// It runs, but no window has shown it yet.
    Starting,
}

impl TerminalState {
    /// Its name in `thel session list`, the same as in the JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            TerminalState::Running => "running",
            TerminalState::Exited => "exited",
            TerminalState::Starting => "starting",
        }
    }
}

/// A sandboxed caller's request, waiting for the user to allow or deny it in a
/// thel window.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Approval {
    pub req: u64,
    /// The terminal the caller runs in.
    pub caller: String,
    /// How the prompt names the session showing `caller` (see session_label).
    pub caller_session: Option<String>,
    /// What it asks for, in words.
    pub summary: String,
    /// The terminal a SendKeys request types into, for the GUI to name.
    pub target: Option<String>,
    /// How the prompt names the session showing `target` (see session_label).
    pub target_session: Option<String>,
    /// The window that shows the caller's terminal, which is the one to ask.
    pub window: Option<String>,
    /// The executable of the sandboxed program asking (see sandbox_program),
    /// which a yes for good trusts along with all it runs.
    pub program: Option<String>,
}

/// `req` in words, for the approval prompt. `session` is how it names the
/// session a Terminal or Note request acts on (see session_label); the other
/// requests have none. Every part the caller chose goes through `shown` or
/// `named`, so it can't pass for the prompt's own words. What runs and where
/// comes first, before any name the caller chose.
pub fn describe(req: &Request, session: &str) -> String {
    let cmd = |c: &[String]| {
        if c.is_empty() {
            "a shell".to_string()
        } else {
            format!("`{}`", c.iter().map(|a| shown(a)).collect::<Vec<_>>().join(" "))
        }
    };
    match req {
        Request::New { name, cwd, command } => format!(
            "open a session running {} in {}{}",
            cmd(command),
            shown(cwd),
            name.as_ref().map_or(String::new(), |n| format!(", named {}", named(n)))
        ),
        Request::Terminal { cwd, command, .. } => {
            format!("open a terminal running {} in {}, in {session}", cmd(command), shown(cwd))
        }
        Request::List { all: true } => "list every session and its terminals".into(),
        Request::List { all: false } => "list the sessions".into(),
        Request::SendKeys { terminal, data } => {
            format!("type into terminal {}: {}", shown(terminal), shown_bytes(data))
        }
        Request::Note { edit, .. } => match edit {
            None => format!("read the notes of {session}"),
            Some(NoteEdit::Set { text }) if text.is_empty() => format!("clear the notes of {session}"),
            Some(NoteEdit::Set { text }) => format!("replace the notes of {session} with: {}", shown(text)),
            Some(NoteEdit::Append { text }) => format!("add to the notes of {session}: {}", shown(text)),
        },
    }
}

/// Whether `b` shows as itself in the prompt: a plain path or word character.
fn plain(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"/._-+=:,@%~".contains(&b)
}

/// Something that runs, as the approval prompt shows it: as it is when it
/// holds only plain path and word characters, else in double quotes with
/// everything but printable ASCII escaped. A blank-looking or invisible
/// character can't hide what follows it.
fn shown(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(plain) {
        s.to_string()
    } else {
        format!("\"{}\"", s.escape_default())
    }
}

/// Bytes to type, as the approval prompt shows them: like `shown`, with any
/// byte outside printable ASCII as `\xNN`, so even bytes that aren't UTF-8
/// show as what gets typed.
fn shown_bytes(data: &[u8]) -> String {
    if !data.is_empty() && data.iter().copied().all(plain) {
        String::from_utf8_lossy(data).into_owned()
    } else {
        format!("\"{}\"", data.escape_ascii())
    }
}

/// How many characters of a name the approval prompt shows, the same as
/// TITLE_MAX in sessionBridge.ts for the names the GUI adds.
const NAME_MAX: usize = 60;

/// A name the caller chose, as the approval prompt shows it: its first
/// `NAME_MAX` characters in double quotes, with everything but printable ASCII
/// escaped. A look-alike quote or a run of blank characters can't fake the
/// end of the name or push the rest of the prompt out of view.
fn named(s: &str) -> String {
    let cut: String = s.chars().take(NAME_MAX).collect();
    let more = if cut.len() < s.len() { "…" } else { "" };
    format!("\"{}{more}\"", cut.escape_default())
}

/// A session as a GUI window reports it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DirSession {
    pub id: String,
    pub name: String,
    pub terminals: Vec<String>,
}

/// A terminal the daemon started for a request, for a GUI window to show.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Adopt {
    pub terminal: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub place: Place,
    /// Started for a sandboxed program. A window restores it as a plain
    /// shell, so the user's yes runs the command this once.
    pub sandboxed: bool,
}

/// Where a window shows an Adopt: in a new session in `window` (with none,
/// in the window the GUIs pick for it), or in the session `id`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Place {
    NewSession { name: String, window: Option<String> },
    Session { id: String },
}

/// The tab whose process tree holds `pid`: the first ancestor of `pid`
/// (itself included) that is a tab's root process.
pub fn tab_of(
    pid: u32,
    roots: &HashMap<u32, String>,
    parent: impl Fn(u32) -> Option<u32>,
) -> Option<String> {
    ancestors(pid, parent).find_map(|p| roots.get(&p).cloned())
}

/// `pid` and its ancestors, nearest first, stopping before init.
pub fn ancestors(pid: u32, parent: impl Fn(u32) -> Option<u32>) -> impl Iterator<Item = u32> {
    // A bound in case a reused pid ever closes a loop.
    std::iter::successors(Some(pid), move |&p| parent(p).filter(|&pp| pp > 1 && pp != p)).take(128)
}

/// Windows' reported sessions, by window label.
pub type Directory = HashMap<String, Vec<DirSession>>;

/// Records `sessions` as what `window` shows. A window that shows none, such
/// as one that closed for good, leaves the directory.
pub fn report(dir: &mut Directory, window: String, sessions: Vec<DirSession>) {
    if sessions.is_empty() {
        dir.remove(&window);
    } else {
        dir.insert(window, sessions);
    }
}

/// The session `key` names, by id or else by a unique name, and its window.
pub fn find_session<'a>(dir: &'a Directory, key: &str) -> Result<(&'a str, &'a DirSession), String> {
    if let Some(hit) = session_by_id(dir, key) {
        return Ok(hit);
    }
    let named: Vec<_> = sessions(dir).filter(|(_, s)| s.name == key).collect();
    match named.as_slice() {
        [one] => Ok(*one),
        [] => Err(format!("no session named or with id \"{key}\"")),
        many => Err(format!(
            "{} sessions are named \"{key}\"; use an id: {}",
            many.len(),
            many.iter().map(|(_, s)| s.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// How the approval prompt names session `id`, called `name`: by its name,
/// and the start of its id too when another session has that name.
pub fn session_label(dir: &Directory, id: &str, name: &str) -> String {
    if matches!(find_session(dir, name), Ok((_, s)) if s.id == id) {
        format!("session {}", named(name))
    } else {
        format!("session {} (id {})", named(name), shown(&id.chars().take(8).collect::<String>()))
    }
}

/// The session with id `id`, and its window.
pub fn session_by_id<'a>(dir: &'a Directory, id: &str) -> Option<(&'a str, &'a DirSession)> {
    sessions(dir).find(|(_, s)| s.id == id)
}

/// The session showing `terminal`, and its window.
pub fn session_of<'a>(dir: &'a Directory, terminal: &str) -> Option<(&'a str, &'a DirSession)> {
    sessions(dir).find(|(_, s)| s.terminals.iter().any(|t| t == terminal))
}

fn sessions(dir: &Directory) -> impl Iterator<Item = (&str, &DirSession)> {
    dir.iter().flat_map(|(w, ss)| ss.iter().map(move |s| (w.as_str(), s)))
}

/// The name a session in `cwd` gets by default: its folder's name, or "~" for
/// the home folder, as the GUI names it.
pub fn name_for_dir(cwd: &str) -> String {
    name_in(cwd, std::env::var_os("HOME").as_deref().map(Path::new))
}

/// name_for_dir with `home` as the home folder. The daemon resolves links in
/// a sandboxed caller's folder, so `home` counts with its links resolved too.
fn name_in(cwd: &str, home: Option<&Path>) -> String {
    let path = Path::new(cwd);
    if home.is_some_and(|h| h == path || std::fs::canonicalize(h).is_ok_and(|h| h == path)) {
        return "~".into();
    }
    path.file_name().map_or_else(|| cwd.to_string(), |n| n.to_string_lossy().into_owned())
}

/// Every session the windows report plus the ones still waiting for one.
pub fn list<'a>(dir: &Directory, alive: &HashSet<String>, adopts: impl IntoIterator<Item = &'a Adopt>) -> Vec<Listed> {
    let state = |id: &str| if alive.contains(id) { TerminalState::Running } else { TerminalState::Exited };
    let mut out: Vec<Listed> = dir
        .values()
        .flatten()
        .map(|s| Listed {
            id: Some(s.id.clone()),
            name: s.name.clone(),
            terminals: s
                .terminals
                .iter()
                .map(|t| ListedTerminal { id: t.clone(), state: state(t) })
                .collect(),
        })
        .collect();
    for a in adopts {
        let state = if alive.contains(&a.terminal) { TerminalState::Starting } else { TerminalState::Exited };
        let t = ListedTerminal { id: a.terminal.clone(), state };
        match &a.place {
            Place::Session { id } => match out.iter_mut().find(|l| l.id.as_deref() == Some(id)) {
                Some(l) => l.terminals.push(t),
                None => out.push(Listed { id: Some(id.clone()), name: String::new(), terminals: vec![t] }),
            },
            Place::NewSession { name, .. } => {
                out.push(Listed { id: None, name: name.clone(), terminals: vec![t] })
            }
        }
    }
    out
}

/// The bytes `thel session send-keys` types. Each argument is a key name
/// (Enter, Tab, Escape, BSpace, Space, Up, Down, Left, Right, Home, End,
/// C-<letter>, M-<char>) or text. Text loses its control characters, so a
/// crafted argument can't smuggle in escape sequences; `literal` sends every
/// argument as it is.
pub fn keys(args: &[String], literal: bool) -> Vec<u8> {
    let mut out = Vec::new();
    for a in args {
        if literal {
            out.extend_from_slice(a.as_bytes());
        } else if let Some(k) = key(a) {
            out.extend(k);
        } else {
            out.extend(a.chars().filter(|c| !c.is_control()).collect::<String>().bytes());
        }
    }
    out
}

fn key(name: &str) -> Option<Vec<u8>> {
    let fixed: &[u8] = match name {
        "Enter" => b"\r",
        "Tab" => b"\t",
        "Escape" | "Esc" => b"\x1b",
        "BSpace" => b"\x7f",
        "Space" => b" ",
        "Up" => b"\x1b[A",
        "Down" => b"\x1b[B",
        "Right" => b"\x1b[C",
        "Left" => b"\x1b[D",
        "Home" => b"\x1b[H",
        "End" => b"\x1b[F",
        _ => {
            let mut chars = name.chars();
            return match (chars.next(), chars.next(), chars.next(), chars.next()) {
                (Some('C'), Some('-'), Some(c), None) if c.is_ascii_alphabetic() => {
                    Some(vec![c.to_ascii_lowercase() as u8 - b'a' + 1])
                }
                (Some('M'), Some('-'), Some(c), None) if !c.is_control() => {
                    let mut v = vec![0x1b];
                    v.extend(c.to_string().bytes());
                    Some(v)
                }
                _ => None,
            };
        }
    };
    Some(fixed.to_vec())
}

// ---- the CLI ----------------------------------------------------------------

/// The text of `thel session --help`.
pub const HELP: &str = "Usage: thel session COMMAND [OPTIONS]

Open, list, type into and take notes on thel sessions from inside a thel
terminal, e.g. from an agent. On Linux, a sandboxed caller's request waits for
approval in the thel window.

Commands:
  new [-n NAME] [-c DIR] [-- CMD [ARG...]]
        Open a session with one terminal running CMD (default: your shell) in
        DIR (default: the current directory). Prints the terminal's id.
  terminal [-t SESSION] [-c DIR] [-- CMD [ARG...]]
        Open a terminal in SESSION, an id or a name (default: this terminal's
        session). Prints the terminal's id.
  list [-a] [--json]
        List the sessions and their terminals. A sandboxed caller sees only
        its own session and those it started; -a asks to see all of them.
  note [-t SESSION] [-w | -a [TEXT...]]
        Print the notes of SESSION, an id or a name (default: this terminal's
        session). -w replaces them with stdin; an empty stdin clears them.
        -a adds TEXT, or stdin when there is no TEXT, as new lines at the end.
  send-keys -t TERMINAL [-l] KEY...
        Type into a terminal. Each KEY is text or a key name: Enter, Tab,
        Escape, BSpace, Space, Up, Down, Left, Right, Home, End, C-<letter>,
        M-<char>. Control characters in text are dropped; -l sends every KEY
        as it is, with no key names. Put -- before a first KEY that starts
        with -.

Example:
  id=$(thel session new -n tests -- npm test --watch)
  thel session send-keys -t \"$id\" q
  thel session note -a \"- [ ] fix the flaky login test\"
";

/// `path` with its `.` and `..` parts folded away without reading the
/// filesystem, as a shell's `cd` does, so `-c ..` names the session after the
/// folder it opens in.
fn lexical(path: &Path) -> String {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out.to_string_lossy().into_owned()
}

/// What a command line asks for.
#[derive(Debug, PartialEq)]
enum Parsed {
    Help,
    Ask { req: Request, json: bool },
}

/// `stdin` is read only by a note edit that takes its text from there.
fn parse(
    args: &[String],
    cwd: &str,
    stdin: impl FnOnce() -> Result<String, String>,
) -> Result<Parsed, String> {
    let Some((sub, rest)) = args.split_first() else {
        return Ok(Parsed::Help);
    };
    let mut opts: HashMap<&str, String> = HashMap::new();
    let mut flags: HashSet<&str> = HashSet::new();
    let mut tail: Vec<String> = Vec::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "--" => {
                tail.extend(it.by_ref().cloned());
                break;
            }
            "-n" | "-c" | "-t" => {
                let v = it.next().ok_or_else(|| format!("{a} needs a value"))?;
                opts.insert(a.as_str(), v.clone());
            }
            "-l" | "--json" | "-w" | "-a" => {
                flags.insert(a.as_str());
            }
            // A word with a space in it is text, such as a note's "- [ ] item".
            s if s.starts_with('-') && s.len() > 1 && !s.contains(char::is_whitespace) => {
                return Err(format!("unknown option {s}"));
            }
            _ => {
                tail.push(a.clone());
                tail.extend(it.by_ref().cloned());
                break;
            }
        }
    }
    let takes: &[&str] = match sub.as_str() {
        "new" => &["-n", "-c"],
        "terminal" => &["-t", "-c"],
        "list" => &["-a", "--json"],
        "send-keys" => &["-t", "-l"],
        "note" => &["-t", "-w", "-a"],
        "help" | "-h" | "--help" => return Ok(Parsed::Help),
        other => return Err(format!("unknown command {other}")),
    };
    if let Some(bad) = opts.keys().chain(flags.iter()).find(|o| !takes.contains(o)) {
        return Err(format!("{sub} takes no {bad}"));
    }
    // `cwd` is empty when the CLI can't read its own.
    let dir = |opts: &HashMap<&str, String>| {
        let dir = match opts.get("-c") {
            Some(c) => lexical(&Path::new(cwd).join(c)),
            None => cwd.to_string(),
        };
        if Path::new(&dir).is_absolute() {
            Ok(dir)
        } else {
            Err("can't read the current directory; pass -c with an absolute path")
        }
    };
    let req = match sub.as_str() {
        "new" => Request::New {
            name: opts.get("-n").cloned(),
            cwd: dir(&opts)?,
            command: tail,
        },
        "terminal" => Request::Terminal {
            session: opts.get("-t").cloned(),
            cwd: dir(&opts)?,
            command: tail,
        },
        "list" if !tail.is_empty() => return Err(format!("unexpected argument {}", tail[0])),
        "list" => Request::List { all: flags.contains("-a") },
        "send-keys" => Request::SendKeys {
            terminal: opts.get("-t").cloned().ok_or("send-keys needs -t TERMINAL")?,
            data: keys(&tail, flags.contains("-l")),
        },
        "note" => {
            let edit = match (flags.contains("-w"), flags.contains("-a")) {
                (true, true) => return Err("note takes -w or -a, not both".into()),
                (true, false) if !tail.is_empty() => {
                    return Err("note -w reads stdin; use -a to pass TEXT".into())
                }
                (true, false) => Some(NoteEdit::Set { text: stdin()? }),
                (false, true) if tail.is_empty() => Some(NoteEdit::Append { text: stdin()? }),
                (false, true) => Some(NoteEdit::Append { text: tail.join(" ") }),
                (false, false) if !tail.is_empty() => {
                    return Err(format!("unexpected argument {}", tail[0]))
                }
                (false, false) => None,
            };
            Request::Note { session: opts.get("-t").cloned(), edit }
        }
        _ => unreachable!("takes already turned away the rest"),
    };
    Ok(Parsed::Ask { req, json: flags.contains("--json") })
}

/// Runs `thel session ARGS...` and returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let stdin = || {
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
            .map_err(|e| format!("reading stdin: {e}"))?;
        Ok(text)
    };
    let (req, json) = match parse(args, &cwd, stdin) {
        Ok(Parsed::Help) => {
            print!("{HELP}");
            return 0;
        }
        Ok(Parsed::Ask { req, json }) => (req, json),
        Err(e) => {
            eprintln!("thel session: {e}\nRun `thel session --help` for usage.");
            return 2;
        }
    };
    #[cfg(unix)]
    let reply = crate::daemon::session_request(&req);
    #[cfg(not(unix))]
    let reply: Result<Reply, String> = Err("thel session needs the thel daemon (Linux, macOS)".into());
    let reply = match reply {
        Ok(r) => r,
        Err(e) => {
            eprintln!("thel session: {e}");
            return 1;
        }
    };
    if let Some(e) = reply.error {
        eprintln!("thel session: {e}");
        return 1;
    }
    if let Some(t) = reply.terminal {
        println!("{t}");
    }
    if let Some(note) = reply.note {
        print!("{note}");
    }
    if matches!(req, Request::List { .. }) {
        if json {
            println!("{}", serde_json::to_string_pretty(&reply.sessions).unwrap_or_default());
        } else {
            print!("{}", format_list(&reply.sessions));
        }
    }
    0
}

/// `thel session list` for people: each session, then its terminals indented.
fn format_list(sessions: &[Listed]) -> String {
    let mut out = String::new();
    for s in sessions {
        let id = s.id.as_deref().unwrap_or("(not shown yet)");
        let name = if s.name.is_empty() { "?".to_string() } else { shown(&s.name) };
        out.push_str(&format!("{name}\t{}\n", shown(id)));
        for t in &s.terminals {
            out.push_str(&format!("  {}\t{}\n", shown(&t.id), t.state.as_str()));
        }
    }
    out
}

/// A private temp dir for a test, removed when dropped, so also by a failing
/// assertion.
#[cfg(test)]
pub(crate) struct TestDir(pub PathBuf);

#[cfg(test)]
impl TestDir {
    /// Creates it, `0700` and new: creation fails if the name already exists.
    pub fn new(prefix: &str) -> TestDir {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}-{n}", std::process::id()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&dir).unwrap();
        TestDir(dir)
    }
}

#[cfg(test)]
impl Drop for TestDir {
    fn drop(&mut self) {
        // Best effort: a leftover temp dir must not fail the test.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn no_stdin() -> Result<String, String> {
        panic!("read stdin")
    }

    #[test]
    fn parses_note_reads_and_edits() {
        let note = |a: &[&str]| match parse(&args(a), "/w", || Ok("from stdin".into())) {
            Ok(Parsed::Ask { req: Request::Note { session, edit }, .. }) => Ok((session, edit)),
            Ok(other) => panic!("{other:?}"),
            Err(e) => Err(e),
        };
        assert_eq!(note(&["note"]).unwrap(), (None, None));
        assert_eq!(
            note(&["note", "-t", "api", "-w"]).unwrap(),
            (Some("api".into()), Some(NoteEdit::Set { text: "from stdin".into() }))
        );
        assert_eq!(
            note(&["note", "-a", "fix", "it"]).unwrap().1,
            Some(NoteEdit::Append { text: "fix it".into() })
        );
        assert_eq!(
            note(&["note", "-a"]).unwrap().1,
            Some(NoteEdit::Append { text: "from stdin".into() })
        );
        assert_eq!(
            note(&["note", "-a", "- [ ] fix the flaky login test"]).unwrap().1,
            Some(NoteEdit::Append { text: "- [ ] fix the flaky login test".into() })
        );
        assert_eq!(note(&["note", "-w", "-a"]).unwrap_err(), "note takes -w or -a, not both");
        assert_eq!(note(&["note", "-w", "text"]).unwrap_err(), "note -w reads stdin; use -a to pass TEXT");
        assert_eq!(note(&["note", "stray"]).unwrap_err(), "unexpected argument stray");
        assert_eq!(note(&["note", "--json"]).unwrap_err(), "note takes no --json");
        // A plain read never touches stdin.
        assert!(parse(&args(&["note", "-t", "api"]), "/w", no_stdin).is_ok());
    }

    #[test]
    fn writes_notes_whole_and_leaves_nothing_beside_them() {
        let dir = TestDir::new("thel-notes");
        let path = dir.0.join("s1.md");
        write_note(&path, "one").unwrap();
        write_note(&path, "two").unwrap();
        assert_eq!(read_note(&path).unwrap(), "two");
        let names: Vec<_> = std::fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["s1.md"]);
        write_note(&path, "").unwrap();
        assert!(std::fs::read_dir(&dir.0).unwrap().next().is_none());
    }

    #[test]
    fn a_save_from_the_window_leaves_a_note_that_changed_since_alone() {
        let dir = TestDir::new("thel-notes");
        let path = dir.0.join("s1.md");
        assert_eq!(save_note(&path, Some(""), "old\n").unwrap(), None);
        write_note(&path, "old\nagent\n").unwrap();
        assert_eq!(save_note(&path, Some("old\n"), "old\ntyped").unwrap().as_deref(), Some("old\nagent\n"));
        assert_eq!(read_note(&path).unwrap(), "old\nagent\n");
        assert_eq!(save_note(&path, None, "").unwrap(), None);
        assert_eq!(read_note(&path).unwrap(), "");
        // Held, the lock keeps a save waiting, then fails it.
        let held = lock_notes(&dir.0).unwrap();
        assert_eq!(save_note(&path, None, "x").unwrap_err(), "another program holds the notes lock");
        drop(held);
        assert_eq!(save_note(&path, None, "x").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn reads_only_a_notes_file_itself() {
        let dir = TestDir::new("thel-notes");
        let secret = dir.0.join("secret");
        std::fs::write(&secret, "key").unwrap();
        let link = dir.0.join("s1.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(read_note(&link).is_err(), "a link isn't followed");
        let fifo = dir.0.join("s2.md");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: c is a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(read_note(&fifo).is_err(), "a FIFO fails without hanging");
        // A new notes folder is private.
        use std::os::unix::fs::PermissionsExt;
        write_note(&dir.0.join("new").join("s3.md"), "x").unwrap();
        assert_eq!(std::fs::metadata(dir.0.join("new")).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn edits_notes_and_keeps_the_file_inside_the_folder() {
        let add = |old: &str, t: &str| NoteEdit::Append { text: t.into() }.apply(old);
        assert_eq!(add("", "a"), "a\n");
        assert_eq!(add("x", "a"), "x\na\n");
        assert_eq!(add("x\n", "a\n"), "x\na\n");
        assert_eq!(add("", ""), "");
        assert_eq!(add("x", ""), "x");
        assert_eq!(NoteEdit::Set { text: "".into() }.apply("x"), "");
        let dir = Path::new("/n");
        assert_eq!(note_file(dir, "s-1_a").unwrap(), Path::new("/n/s-1_a.md"));
        for bad in ["", "../x", "a/b", "a.b"] {
            assert_eq!(note_file(dir, bad).unwrap_err(), "invalid session id", "{bad}");
        }
    }

    #[test]
    fn parses_each_command() {
        assert_eq!(
            parse(&args(&["new", "-n", "api", "-c", "srv", "--", "npm", "run", "dev"]), "/w", no_stdin).unwrap(),
            Parsed::Ask {
                req: Request::New {
                    name: Some("api".into()),
                    cwd: "/w/srv".into(),
                    command: args(&["npm", "run", "dev"]),
                },
                json: false,
            }
        );
        // A command needs no "--" when it starts the remaining arguments.
        assert_eq!(
            parse(&args(&["terminal", "-t", "api", "htop", "-d", "5"]), "/w", no_stdin).unwrap(),
            Parsed::Ask {
                req: Request::Terminal {
                    session: Some("api".into()),
                    cwd: "/w".into(),
                    command: args(&["htop", "-d", "5"]),
                },
                json: false,
            }
        );
        assert_eq!(
            parse(&args(&["list", "--json"]), "/w", no_stdin).unwrap(),
            Parsed::Ask { req: Request::List { all: false }, json: true }
        );
        assert_eq!(
            parse(&args(&["list", "-a"]), "/w", no_stdin).unwrap(),
            Parsed::Ask { req: Request::List { all: true }, json: false }
        );
        assert_eq!(parse(&args(&[]), "/w", no_stdin).unwrap(), Parsed::Help);
        assert_eq!(parse(&args(&["new", "--help"]), "/w", no_stdin).unwrap(), Parsed::Help);
        assert_eq!(parse(&args(&["--help"]), "/w", no_stdin).unwrap(), Parsed::Help);
        assert_eq!(parse(&args(&["-h"]), "/w", no_stdin).unwrap(), Parsed::Help);
        let err = |a: &[&str]| parse(&args(a), "/w", no_stdin).unwrap_err();
        assert_eq!(err(&["send-keys", "ls"]), "send-keys needs -t TERMINAL");
        assert_eq!(err(&["new", "-x"]), "unknown option -x");
        assert_eq!(err(&["frob"]), "unknown command frob");
        assert_eq!(parse(&args(&["list", "-t", "x"]), "/w", no_stdin).unwrap_err(), "list takes no -t");
        assert_eq!(parse(&args(&["list", "x"]), "/w", no_stdin).unwrap_err(), "unexpected argument x");
        assert_eq!(parse(&args(&["new", "-l"]), "/w", no_stdin).unwrap_err(), "new takes no -l");
        // An absolute -c stays as given.
        let Parsed::Ask { req: Request::New { cwd, .. }, .. } =
            parse(&args(&["new", "-c", "/tmp"]), "/w", no_stdin).unwrap()
        else {
            panic!()
        };
        assert_eq!(cwd, "/tmp");
        // With no current directory to read, only an absolute -c will do.
        assert!(parse(&args(&["new", "-c", "/tmp"]), "", no_stdin).is_ok());
        assert_eq!(
            parse(&args(&["new", "-c", "srv"]), "", no_stdin).unwrap_err(),
            "can't read the current directory; pass -c with an absolute path"
        );
        assert!(parse(&args(&["list"]), "", no_stdin).is_ok());
        assert!(parse(&args(&["send-keys", "-t", "t", "- y"]), "/w", no_stdin).is_ok());
    }

    #[test]
    fn types_keys_and_strips_control_characters_from_text() {
        assert_eq!(keys(&args(&["make test", "Enter"]), false), b"make test\r");
        assert_eq!(keys(&args(&["C-c", "C-D", "M-x", "Up"]), false), b"\x03\x04\x1bx\x1b[A");
        // A BEL closing an OSC early and an ESC starting a new sequence.
        assert_eq!(keys(&args(&["hi\x07\x1b[2J"]), false), b"hi[2J");
        assert_eq!(keys(&args(&["hi\x07", "Enter"]), true), b"hi\x07Enter");
        assert_eq!(keys(&args(&["M-\x07"]), false), b"M-");
    }

    #[test]
    fn tells_sessions_that_share_a_name_apart() {
        let mut d = Directory::new();
        let api = |id: &str| DirSession { id: id.into(), name: "api".into(), terminals: vec![] };
        d.insert("w".into(), vec![api("3f2a9c1d77")]);
        assert_eq!(session_label(&d, "3f2a9c1d77", "api"), "session \"api\"");
        d.get_mut("w").unwrap().push(api("b0"));
        assert_eq!(session_label(&d, "3f2a9c1d77", "api"), "session \"api\" (id 3f2a9c1d)");
    }

    #[test]
    fn names_a_session_after_its_folder() {
        assert_eq!(name_for_dir("/srv/api/"), "api");
        assert_eq!(name_for_dir("/"), "/");
        let home = std::env::var("HOME").unwrap();
        assert_eq!(name_for_dir(&home), "~");
        #[cfg(target_os = "linux")]
        {
            let real = std::env::current_dir().unwrap().canonicalize().unwrap();
            assert_eq!(name_in(&real.to_string_lossy(), Some(Path::new("/proc/self/cwd"))), "~");
        }
        // `-c` folds `.` and `..`, so the name is the folder's own.
        let Ok(Parsed::Ask { req: Request::New { cwd, .. }, .. }) =
            parse(&args(&["new", "-c", "../web/."]), "/w/srv", no_stdin)
        else {
            panic!("a new session")
        };
        assert_eq!((cwd.as_str(), name_for_dir(&cwd).as_str()), ("/w/web", "web"));
    }

    #[test]
    fn refuses_a_relative_directory() {
        let r = Request::New { name: None, cwd: ".".into(), command: vec![] };
        assert_eq!(r.check(), Err("the directory . is not an absolute path".into()));
        let r = Request::Terminal { session: None, cwd: "/srv".into(), command: vec![] };
        assert_eq!(r.check(), Ok(()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolves_a_link_in_the_directory_to_ask_about() {
        let r = Request::Terminal { session: None, cwd: "/proc/self/cwd".into(), command: vec![] };
        let Request::Terminal { cwd, .. } = r.resolved().unwrap() else { panic!() };
        assert_eq!(cwd, std::env::current_dir().unwrap().to_string_lossy());
        let gone = Request::New { name: None, cwd: "/nonexistent-thel".into(), command: vec![] };
        assert_eq!(gone.resolved().unwrap_err(), "no folder /nonexistent-thel");
        let file = Request::New { name: None, cwd: "/proc/self/exe".into(), command: vec![] };
        assert_eq!(file.resolved().unwrap_err(), "no folder /proc/self/exe");
    }

    #[test]
    fn describes_requests_for_the_prompt() {
        let r = Request::New { name: Some("api".into()), cwd: "/srv".into(), command: args(&["npm", "test"]) };
        assert_eq!(describe(&r, ""), "open a session running `npm test` in /srv, named \"api\"");
        let r = Request::Terminal { session: None, cwd: "/".into(), command: vec![] };
        assert_eq!(describe(&r, "session \"api\""), "open a terminal running a shell in /, in session \"api\"");
        // Control characters show escaped, so the prompt shows what gets typed.
        let r = Request::SendKeys { terminal: "t1".into(), data: b"rm -rf ~\r".to_vec() };
        assert_eq!(describe(&r, ""), "type into terminal t1: \"rm -rf ~\\r\"");
        // What the caller chose can't end the sentence early or reorder it.
        let r = Request::New {
            name: Some("x\" in /srv running `ls`. Safe".into()),
            cwd: "/srv\n\nthel checked this".into(),
            command: args(&["sh", "-c", "curl x | sh", "\u{202e}ls"]),
        };
        assert_eq!(
            describe(&r, ""),
            "open a session running `sh -c \"curl x | sh\" \"\\u{202e}ls\"` \
             in \"/srv\\n\\nthel checked this\", named \"x\\\" in /srv running `ls`. Safe\""
        );
        // A name can't fake its closing quote with a look-alike, nor hide what
        // follows it behind a long run of blank characters.
        let name = format!("api\u{201d} {}", "\u{2800}".repeat(100));
        assert_eq!(named(&name), format!("\"api\\u{{201d}} {}…\"", "\\u{2800}".repeat(55)));
        // A blank-looking character in what runs or gets typed shows escaped,
        // and so does a byte that isn't UTF-8.
        let r = Request::Terminal { session: None, cwd: "/".into(), command: args(&["\u{2800}\u{2800}rm"]) };
        assert_eq!(describe(&r, "session \"api\""), "open a terminal running `\"\\u{2800}\\u{2800}rm\"` in /, in session \"api\"");
        let r = Request::SendKeys { terminal: "t1".into(), data: b"\xe2\xa0\x80\x9b; rm".to_vec() };
        assert_eq!(describe(&r, ""), "type into terminal t1: \"\\xe2\\xa0\\x80\\x9b; rm\"");
    }

    #[test]
    fn describes_note_requests_for_the_prompt() {
        let r = Request::Note { session: Some("api".into()), edit: None };
        assert_eq!(describe(&r, "session \"api\""), "read the notes of session \"api\"");
        let r = Request::Note { session: None, edit: Some(NoteEdit::Append { text: "done".into() }) };
        assert_eq!(describe(&r, "session \"api\""), "add to the notes of session \"api\": done");
        // Text can't fake the end of the prompt with a look-alike quote, nor
        // hide a line behind blank characters.
        let text = format!("x\u{201d}. Safe {}\nrm", "\u{2800}".repeat(3));
        let r = Request::Note { session: None, edit: Some(NoteEdit::Set { text }) };
        assert_eq!(
            describe(&r, "session \"api\""),
            "replace the notes of session \"api\" with: \"x\\u{201d}. Safe \\u{2800}\\u{2800}\\u{2800}\\nrm\""
        );
        let r = Request::Note { session: None, edit: Some(NoteEdit::Set { text: String::new() }) };
        assert_eq!(describe(&r, "session \"api\""), "clear the notes of session \"api\"");
    }

    #[test]
    fn finds_the_caller_by_its_ancestry() {
        let roots = HashMap::from([(100, "t1".to_string()), (200, "t2".to_string())]);
        let parents = HashMap::from([(300, 250), (250, 200), (400, 1)]);
        let parent = |p: u32| parents.get(&p).copied();
        assert_eq!(tab_of(300, &roots, parent).as_deref(), Some("t2"));
        assert_eq!(tab_of(100, &roots, parent).as_deref(), Some("t1"));
        assert_eq!(tab_of(400, &roots, parent), None, "outside every terminal");
        assert_eq!(tab_of(999, &roots, parent), None, "gone");
    }

    fn dir() -> Directory {
        let s = |id: &str, name: &str, t: &[&str]| DirSession {
            id: id.into(),
            name: name.into(),
            terminals: args(t),
        };
        HashMap::from([
            ("main".to_string(), vec![s("s1", "api", &["t1", "t2"]), s("s2", "web", &["t3"])]),
            ("profile-work".to_string(), vec![s("s3", "web", &["t4"])]),
        ])
    }

    #[test]
    fn finds_a_session_by_id_or_unique_name() {
        let d = dir();
        assert_eq!(find_session(&d, "s2").unwrap().1.name, "web");
        let (window, api) = find_session(&d, "api").unwrap();
        assert_eq!((window, api.id.as_str()), ("main", "s1"));
        assert!(find_session(&d, "web").unwrap_err().contains("use an id"));
        assert_eq!(find_session(&d, "nope").unwrap_err(), "no session named or with id \"nope\"");
        assert_eq!(session_of(&d, "t4").unwrap().0, "profile-work");
        assert!(session_of(&d, "t9").is_none());
    }

    #[test]
    fn lists_shown_sessions_and_those_still_starting() {
        let mut d = dir();
        d.remove("profile-work");
        let alive = HashSet::from(["t1".to_string(), "t3".to_string(), "t5".to_string()]);
        let adopts = vec![
            Adopt {
                terminal: "t5".into(),
                command: "sh".into(),
                args: vec![],
                cwd: "/".into(),
                place: Place::Session { id: "s1".into() },
                sandboxed: false,
            },
            Adopt {
                terminal: "t6".into(),
                command: "sh".into(),
                args: vec![],
                cwd: "/".into(),
                place: Place::NewSession { name: "fresh".into(), window: Some("main".into()) },
                sandboxed: false,
            },
        ];
        let mut got = list(&d, &alive, &adopts);
        got.sort_by(|a, b| a.name.cmp(&b.name));
        fn states(l: &Listed) -> Vec<String> {
            l.terminals.iter().map(|t| format!("{} {:?}", t.id, t.state).to_lowercase()).collect()
        }
        assert_eq!(got[0].name, "api");
        assert_eq!(states(&got[0]), ["t1 running", "t2 exited", "t5 starting"]);
        // One that ended before a window showed it.
        assert_eq!((got[1].id.as_deref(), states(&got[1])), (None, vec!["t6 exited".to_string()]));
        assert_eq!(format_list(&got[2..]), "web\ts2\n  t3\trunning\n");
        got[2].name = "\x1b]52;c;eA==\x07".into();
        assert_eq!(format_list(&got[2..]), "\"\\u{1b}]52;c;eA==\\u{7}\"\ts2\n  t3\trunning\n");
    }
}
