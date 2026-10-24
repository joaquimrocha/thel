//! `thel session`: lets a program in a thel terminal open sessions and
//! terminals, list them and type into them, the way `thel notify` posts a
//! notification. The CLI sends a request to the daemon, which acts only for a
//! caller running inside one of its terminals. Sessions are the GUI's: each
//! window reports its sessions to the daemon, and the daemon hands the
//! terminals it starts to the GUI to place.

// The daemon is unix-only, and most of this serves it; elsewhere only the
// CLI's parser runs.
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
    List,
    SendKeys {
        terminal: String,
        data: Vec<u8>,
    },
}

impl Request {
    /// Refuses what the CLI never sends: a relative directory would resolve
    /// against the daemon's own, and the prompt would show it as `.`.
    pub fn check(&self) -> Result<(), String> {
        match self {
            Request::New { cwd, .. } | Request::Terminal { cwd, .. } if !Path::new(cwd).is_absolute() => {
                Err(format!("the directory {cwd} is not an absolute path"))
            }
            _ => Ok(()),
        }
    }
}

/// The daemon's answer to a Request.
#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Reply {
    pub error: Option<String>,
    /// The terminal a New or Terminal request started.
    pub terminal: Option<String>,
    pub sessions: Vec<Listed>,
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
    if let Some(hit) = sessions(dir).find(|(_, s)| s.id == key) {
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

Open, list and type into thel sessions from inside a thel terminal, e.g. from
an agent. A sandboxed caller is refused.

Commands:
  new [-n NAME] [-c DIR] [-- CMD [ARG...]]
        Open a session with one terminal running CMD (default: your shell) in
        DIR (default: the current directory). Prints the terminal's id.
  terminal [-t SESSION] [-c DIR] [-- CMD [ARG...]]
        Open a terminal in SESSION, an id or a name (default: this terminal's
        session). Prints the terminal's id.
  list [--json]
        List the sessions and their terminals.
  send-keys -t TERMINAL [-l] KEY...
        Type into a terminal. Each KEY is text or a key name: Enter, Tab,
        Escape, BSpace, Space, Up, Down, Left, Right, Home, End, C-<letter>,
        M-<char>. Control characters in text are dropped; -l sends every KEY
        as it is, with no key names. Put -- before a first KEY that starts
        with -.

Example:
  id=$(thel session new -n tests -- npm test --watch)
  thel session send-keys -t \"$id\" q
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

fn parse(args: &[String], cwd: &str) -> Result<Parsed, String> {
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
            "-l" | "--json" => {
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
        "list" => &["--json"],
        "send-keys" => &["-t", "-l"],
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
        "list" => Request::List,
        "send-keys" => Request::SendKeys {
            terminal: opts.get("-t").cloned().ok_or("send-keys needs -t TERMINAL")?,
            data: keys(&tail, flags.contains("-l")),
        },
        _ => unreachable!("takes already turned away the rest"),
    };
    Ok(Parsed::Ask { req, json: flags.contains("--json") })
}

/// Runs `thel session ARGS...` and returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let (req, json) = match parse(args, &cwd) {
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
    if req == Request::List {
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
        out.push_str(&format!("{}\t{id}\n", if s.name.is_empty() { "?" } else { &s.name }));
        for t in &s.terminals {
            out.push_str(&format!("  {}\t{}\n", t.id, t.state.as_str()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_each_command() {
        assert_eq!(
            parse(&args(&["new", "-n", "api", "-c", "srv", "--", "npm", "run", "dev"]), "/w").unwrap(),
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
            parse(&args(&["terminal", "-t", "api", "htop", "-d", "5"]), "/w").unwrap(),
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
            parse(&args(&["list", "--json"]), "/w").unwrap(),
            Parsed::Ask { req: Request::List, json: true }
        );
        assert_eq!(parse(&args(&[]), "/w").unwrap(), Parsed::Help);
        assert_eq!(parse(&args(&["new", "--help"]), "/w").unwrap(), Parsed::Help);
        assert_eq!(parse(&args(&["--help"]), "/w").unwrap(), Parsed::Help);
        assert_eq!(parse(&args(&["-h"]), "/w").unwrap(), Parsed::Help);
        let err = |a: &[&str]| parse(&args(a), "/w").unwrap_err();
        assert_eq!(err(&["send-keys", "ls"]), "send-keys needs -t TERMINAL");
        assert_eq!(err(&["new", "-x"]), "unknown option -x");
        assert_eq!(err(&["frob"]), "unknown command frob");
        assert_eq!(parse(&args(&["list", "-t", "x"]), "/w").unwrap_err(), "list takes no -t");
        assert_eq!(parse(&args(&["new", "-l"]), "/w").unwrap_err(), "new takes no -l");
        // An absolute -c stays as given.
        let Parsed::Ask { req: Request::New { cwd, .. }, .. } =
            parse(&args(&["new", "-c", "/tmp"]), "/w").unwrap()
        else {
            panic!()
        };
        assert_eq!(cwd, "/tmp");
        // With no current directory to read, only an absolute -c will do.
        assert!(parse(&args(&["new", "-c", "/tmp"]), "").is_ok());
        assert_eq!(
            parse(&args(&["new", "-c", "srv"]), "").unwrap_err(),
            "can't read the current directory; pass -c with an absolute path"
        );
        assert!(parse(&args(&["list"]), "").is_ok());
        assert!(parse(&args(&["send-keys", "-t", "t", "- y"]), "/w").is_ok());
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
            parse(&args(&["new", "-c", "../web/."]), "/w/srv")
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
            },
            Adopt {
                terminal: "t6".into(),
                command: "sh".into(),
                args: vec![],
                cwd: "/".into(),
                place: Place::NewSession { name: "fresh".into(), window: Some("main".into()) },
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
    }
}
