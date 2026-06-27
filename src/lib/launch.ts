import { defaultShell } from "./pty";
import { gitInfo } from "./git";
import { abbreviatePath } from "./paths";
import { useSessions, type Terminal, type SplitDir } from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { type Launcher, getDefaultLauncher } from "@/store/launchers";

export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

// Default label for a session anchored to a directory. $HOME shows as "~"
// rather than the home folder's basename.
export function sessionNameForDir(cwd: string): string {
  return abbreviatePath(cwd) === "~" ? "~" : basename(cwd);
}

// Build a terminal for a launcher, pinned to the given cwd. A launcher with no
// command is a plain interactive shell; otherwise we run the command line via a
// login shell so the user's PATH/profile is available (thel may be launched
// from a GUI, not a terminal).
async function makeTerminal(
  launcher: Launcher,
  cwd?: string,
): Promise<Terminal> {
  const shell = await defaultShell();
  const command = launcher.command.trim();
  return {
    id: crypto.randomUUID(),
    title: launcher.name,
    defaultTitle: launcher.name,
    command: shell,
    args: command ? ["-l", "-c", command] : [],
    cwd,
    // Snapshot the default zoom at creation; later changes to the default only
    // affect new terminals, not this one.
    zoom: usePrefs.getState().terminalZoom,
  };
}

/** Refresh a session's git branch/dirty state from its cwd. */
export async function refreshSessionGit(sessionId: string) {
  const store = useSessions.getState();
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session?.cwd) return;
  const info = await gitInfo(session.cwd).catch(() => null);
  store.setSessionGit(sessionId, info?.branch, info?.dirty ?? false);
}

/** Create a session anchored to a directory, with a first terminal. */
export async function createSessionInDir(opts: {
  cwd: string;
  repoRoot?: string;
  name?: string;
  launcher?: Launcher;
}) {
  const store = useSessions.getState();
  const session = store.addSession({
    name: opts.name ?? sessionNameForDir(opts.cwd),
    cwd: opts.cwd,
    repoRoot: opts.repoRoot,
  });
  const term = await makeTerminal(opts.launcher ?? getDefaultLauncher(), opts.cwd);
  store.addTerminal(session.id, term);
  void refreshSessionGit(session.id);
  return session;
}

/** Add a terminal to the active session, inheriting its cwd. Targets the given
 * split group, or the active one when omitted. */
export async function addTerminal(launcher?: Launcher, groupId?: string) {
  const store = useSessions.getState();
  const session = store.sessions.find((s) => s.id === store.activeSessionId);
  if (!session) return; // no active session; the UI opens the dialog instead
  const term = await makeTerminal(launcher ?? getDefaultLauncher(), session.cwd);
  store.addTerminal(session.id, term, groupId);
}

/** Split a pane into a new terminal pane in the given direction ("row" = right,
 * "col" = down). Targets the given pane, or the active one when omitted. */
export async function splitPane(
  groupId?: string,
  dir: SplitDir = "row",
  launcher?: Launcher,
) {
  const store = useSessions.getState();
  const session = store.sessions.find((s) => s.id === store.activeSessionId);
  if (!session) return;
  const term = await makeTerminal(launcher ?? getDefaultLauncher(), session.cwd);
  store.splitGroup(session.id, term, dir, groupId);
}
