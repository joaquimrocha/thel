import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  useSessions,
  sessionTerminals,
  closedSessions,
  type Session,
  type Terminal,
} from "@/store/sessions";
import { basename, refreshSessionGit } from "@/lib/launch";
import { killTerminalWindow } from "@/lib/pty";

/** A terminal the daemon started for `thel session` (session::Adopt). */
export interface Adopt {
  terminal: string;
  command: string;
  args: string[];
  cwd: string;
  place:
    | { kind: "new_session"; name: string; window: string | null }
    | { kind: "session"; id: string };
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
  const term = {
    id: a.terminal,
    title: basename(a.command),
    defaultTitle: basename(a.command),
    command: a.command,
    args: a.args,
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
  const label = getCurrentWindow().label;
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
  const listening = Promise.all([
    getCurrentWindow().listen<Adopt>("thel-session-adopt", (e) => void adopt(e.payload, label)),
    getCurrentWindow().listen<string>("thel-session-claimed", (e) => forgetClaimed(e.payload)),
  ]);
  // After the listeners are in place, so the replay of waiting terminals lands.
  void listening.then(() => invoke("watch_sessions")).catch(() => {});
  return () => {
    clearTimeout(timer);
    unsubscribe();
    void listening.then((fs) => fs.forEach((f) => f()));
  };
}
