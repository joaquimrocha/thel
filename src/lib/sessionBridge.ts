import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  useSessions,
  sessionTerminals,
  terminalDisplayTitle,
  closedSessions,
  type Session,
  type Terminal,
} from "@/store/sessions";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { useNotes, type NoteEdit } from "@/store/notes";
import { basename, refreshSessionGit } from "@/lib/launch";
import { defaultShell, killTerminalWindow } from "@/lib/pty";

/** A terminal the daemon started for `thel session` (session::Adopt). */
export interface Adopt {
  terminal: string;
  command: string;
  args: string[];
  cwd: string;
  place:
    | { kind: "new_session"; name: string; window: string | null }
    | { kind: "session"; id: string };
  sandboxed: boolean;
}

// Coalesces a burst of store changes (a drag, a restore) into one report.
const REPORT_DEBOUNCE_MS = 300;

// Set once this window's sessions left the daemon's directory for good.
let withdrawn = false;

const directory = (sessions: Session[]) =>
  sessions.map((s) => ({
    id: s.id,
    name: s.name,
    terminals: sessionTerminals(s).map((t) => t.id),
  }));

/** A sandboxed program's request (session::Approval). */
export interface Approval {
  req: number;
  caller: string;
  caller_session: string | null;
  summary: string;
  target: string | null;
  target_session: string | null;
  window: string | null;
  program: string | null;
}

// Names an approval's prompt, so the daemon's word that it is settled can take
// it back.
const approvalKey = (req: number) => `thel-session-${req}`;

// Requests already answered or timed out, for a window that hears so while it
// still looks up whether it is the one to ask. Never pruned: it grows by one
// number per request, and a replay can come at any time after.
const resolved = new Set<number>();

// The program can choose both the session name (`thel session new -n`) and
// its terminal's title (an OSC title sequence), so the prompt shows them the
// way the daemon shows names (Rust's escape_default; TITLE_MAX is NAME_MAX in
// session.rs): cut short, in quotes, with everything but printable ASCII
// escaped, so a look-alike quote or blank characters can't fake the end of a
// name or push the rest of the prompt out of view.
const TITLE_MAX = 60;
const SHORT_ESCAPES: Record<string, string> = { "\t": "t", "\r": "r", "\n": "n", '"': '"', "'": "'", "\\": "\\" };
/** `s` as the prompt shows a name the program chose (see TITLE_MAX). Exported
 * for its test. */
export const quoted = (s: string) => {
  // By code point, so the cut can't split a surrogate pair.
  const chars = [...s];
  const cut = chars.slice(0, TITLE_MAX).join("");
  const escaped = cut.replace(/["'\\]|[^\x20-\x7e]/gu, (c) =>
    c in SHORT_ESCAPES ? `\\${SHORT_ESCAPES[c]}` : `\\u{${c.codePointAt(0)?.toString(16)}}`,
  );
  return `"${escaped}${chars.length > TITLE_MAX ? "…" : ""}"`;
};

/** Whether window `me` is the one to act on what the daemon meant for
 * `window`: that window when it is open, else main, else the first open
 * window. Every window hears the daemon's events and asks this, and one says
 * yes. */
async function actsFor(window: string | null, me: string): Promise<boolean> {
  if (window === me) return true;
  const open = (await getAllWebviewWindows()).map((w) => w.label);
  if (window && open.includes(window)) return false;
  return (open.includes("main") ? "main" : [...open].sort()[0]) === me;
}

// The program by its file name in full, then its folder, which `quoted` may
// cut short: a long path would otherwise lose the name that tells what it is.
function program(path: string | null) {
  if (!path) return "";
  const at = path.lastIndexOf("/");
  return at < 0 ? `, ${quoted(path)},` : `, ${quoted(path.slice(at + 1))} (in ${quoted(path.slice(0, at) || "/")}),`;
}

/** Asks the user about a sandboxed program's request, in the window that
 * shows the program's terminal (see actsFor). */
export async function askApproval(a: Approval, windowLabel: string) {
  if (!(await actsFor(a.window, windowLabel)) || resolved.has(a.req)) return;
  const key = approvalKey(a.req);
  // The daemon replays waiting requests to every watch, so one can come twice.
  const ui = useUI.getState();
  if (ui.confirm?.key === key || ui.confirmQueue.some((r) => r.key === key)) return;
  const sessions = useSessions.getState().sessions;
  // The session as the daemon's summary names it, which this window can't
  // tell apart from a namesake in another window.
  const locate = (id: string, label: string | null) => {
    const session = sessions.find((s) => sessionTerminals(s).some((t) => t.id === id));
    const term = session && sessionTerminals(session).find((t) => t.id === id);
    return session && term
      ? `${quoted(terminalDisplayTitle(term))} in ${label ?? `session ${quoted(session.name)}`}`
      : null;
  };
  const who = locate(a.caller, a.caller_session);
  const target = !a.target
    ? null
    : a.target === a.caller
      ? "its own terminal, whose shell runs outside the sandbox"
      : (locate(a.target, a.target_session) ??
        (a.target_session
          ? `a terminal in ${a.target_session}, in another window`
          : "a terminal no window shows"));
  // Before the summary, which can be long enough to scroll.
  const into = target ? ` act on ${target}:` : "";
  const answer = (allow: boolean, remember: boolean) => {
    // Settled here at once: a replay the daemon sends another window before
    // it hears the answer must not show the prompt again.
    resolved.add(a.req);
    void invoke("answer_session", { req: a.req, allow, remember }).catch(() => {});
  };
  useUI.getState().requestConfirm({
    key,
    title: "Allow a sandboxed program?",
    description: `A sandboxed program${program(a.program)} in ${who ?? (a.caller_session ? `a terminal in ${a.caller_session}` : "a terminal")} asks thel to${into} ${a.summary}. It would run outside its sandbox.`,
    // Only for a program the prompt names: the daemon won't remember a yes
    // for one it can't.
    checkbox: a.program
      ? { label: "Allow everything from this program and what it runs, until it exits" }
      : undefined,
    guarded: true,
    confirmLabel: "Allow",
    cancelLabel: "Deny",
    onConfirm: (remember) => answer(true, remember),
    onCancel: () => answer(false, false),
  });
}

/** A notes change `thel session note` made (the thel-session-note event). */
export interface NoteChange {
  session: string;
  text: string;
  edit: NoteEdit;
}

/** Takes a notes change if this window shows the session. Every window gets
 * the event, and one that doesn't show the session keeps no notes for it:
 * they would be stale if the session came back after it missed a change. */
export function takeNote(n: NoteChange) {
  if (!useSessions.getState().sessions.some((s) => s.id === n.session)) return;
  useNotes.getState().receiveNote(n.session, n.text, n.edit);
}

let shellOnce: Promise<string> | undefined;

// Terminals the daemon started for a session this window doesn't hold, by
// session id. A session on its way here from another window takes them when
// it arrives, unless the daemon said meanwhile that one was claimed.
const waiting = new Map<string, Terminal[]>();

// Terminals the daemon said were claimed, for an adopt still looking up the
// shell when the word comes. Never pruned: one id per adopted terminal.
const claimed = new Set<string>();

/** Forgets a terminal held back for a session that hasn't come here, once
 * another window opened it or it closed: placing it here would start its
 * command again. */
export function forgetClaimed(terminal: string) {
  claimed.add(terminal);
  for (const [id, terms] of waiting) {
    const left = terms.filter((t) => t.id !== terminal);
    if (left.length) waiting.set(id, left);
    else waiting.delete(id);
  }
}

useSessions.subscribe(({ sessions }) => {
  if (waiting.size === 0) return;
  for (const s of sessions) {
    const terms = waiting.get(s.id);
    if (!terms) continue;
    waiting.delete(s.id);
    for (const t of terms) useSessions.getState().adoptTerminal(t, { sessionId: s.id });
  }
});

/** Places one adopted terminal if it belongs to this window: a new session
 * goes to the window the caller is in (see actsFor). */
export async function adopt(a: Adopt, windowLabel: string) {
  // Awaited by every adopt, so adopts for the same place are placed in the
  // order they came.
  const shell = await (shellOnce ??= defaultShell());
  // The user allowed a sandboxed program this one run, so a restore opens a
  // shell instead of the command.
  const term = {
    id: a.terminal,
    title: basename(a.command),
    defaultTitle: basename(a.command),
    command: a.sandboxed ? shell : a.command,
    args: a.sandboxed ? [] : a.args,
    cwd: a.cwd,
  };
  if (a.place.kind === "session") {
    const id = a.place.id;
    // The daemon hears of a close REPORT_DEBOUNCE_MS late.
    if (closedSessions.has(id)) void killTerminalWindow(a.terminal);
    else if (!useSessions.getState().adoptTerminal(term, { sessionId: id }) && !claimed.has(term.id)) {
      waiting.set(id, [...(waiting.get(id) ?? []), term]);
    }
  } else if (await actsFor(a.place.window, windowLabel)) {
    const session = useSessions.getState().adoptTerminal(term, { name: a.place.name, cwd: a.cwd });
    // Its repo decides where the sidebar groups it, so look it up now rather
    // than at the next launch.
    if (session) void refreshSessionGit(session);
  }
}

/** Takes this window's sessions out of what `thel session` can find and
 * list, for a window that is closing and won't come back. */
export async function withdrawSessions() {
  withdrawn = true;
  await invoke("report_sessions", { sessions: [] }).catch(() => {});
}

/** Connects this window to `thel session`: reports its sessions to the daemon
 * and shows the terminals the daemon starts for this window. Returns a stop
 * function. */
export function startSessionBridge(): () => void {
  const win = getCurrentWindow();
  const label = win.label;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const report = () => {
    if (withdrawn) return;
    const sessions = directory(useSessions.getState().sessions);
    const key = JSON.stringify(sessions);
    if (key === last) return;
    last = key;
    void invoke("report_sessions", { sessions }).catch(() => {});
  };
  report();
  // Only a change to the directory restarts the wait: titles and progress
  // change the store often enough to hold a report back for good.
  let seen = last;
  const unsubscribe = useSessions.subscribe(({ sessions }) => {
    const key = JSON.stringify(directory(sessions));
    if (key === seen) return;
    seen = key;
    clearTimeout(timer);
    timer = setTimeout(report, REPORT_DEBOUNCE_MS);
  });
  const allow = (enabled: boolean) => void invoke("allow_session_cli", { enabled }).catch(() => {});
  allow(usePrefs.getState().sessionCli);
  const unsubscribePrefs = usePrefs.subscribe((s, prev) => {
    if (s.sessionCli !== prev.sessionCli) allow(s.sessionCli);
  });
  const listening = Promise.all([
    win.listen<Adopt>("thel-session-adopt", (e) => void adopt(e.payload, label)),
    win.listen<string>("thel-session-claimed", (e) => forgetClaimed(e.payload)),
    win.listen<Approval>("thel-session-approve", (e) => void askApproval(e.payload, label)),
    win.listen<number>("thel-session-resolved", (e) => {
      resolved.add(e.payload);
      useUI.getState().withdrawConfirm(approvalKey(e.payload));
    }),
    win.listen<NoteChange>("thel-session-note", (e) => takeNote(e.payload)),
  ]);
  // After the listeners are in place, so the replay of what waits lands.
  void listening.then(() => invoke("watch_sessions")).catch(() => {});
  return () => {
    clearTimeout(timer);
    unsubscribe();
    unsubscribePrefs();
    void listening.then((fs) => fs.forEach((f) => f()));
  };
}
