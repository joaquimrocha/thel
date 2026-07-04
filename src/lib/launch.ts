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

// The session values a launcher command can reference.
interface SessionCtx {
  id: string;
  name: string;
  cwd?: string;
}

// Replace __SESSION_DIR__ / __SESSION_ID__ / __SESSION_NAME__ with the
// session's values. Delimited so ordinary command text (e.g. a variable
// named SESSION_DIRECTORY) can't be shadowed, and space-free so the argv
// splitter needs no special casing. Unknown __...__ names are left as-is so
// a typo stays visible instead of silently disappearing. The replacement
// callback keeps values containing `$` away from replace()'s
// special-pattern handling.
function substituteVars(text: string, ctx: SessionCtx): string {
  const vars: Record<string, string> = {
    SESSION_DIR: ctx.cwd ?? "",
    SESSION_ID: ctx.id,
    SESSION_NAME: ctx.name,
  };
  return text.replace(
    /__(SESSION_DIR|SESSION_ID|SESSION_NAME)__/g,
    (_m, key: string) => vars[key],
  );
}

// Split a command line into argv for direct (no-shell) execution. Honors
// single/double quotes; no backslash escapes or other shell syntax (a
// launcher that needs those should run in a shell).
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let inToken = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === " " || ch === "\t") {
      if (inToken) {
        args.push(cur);
        cur = "";
        inToken = false;
      }
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) args.push(cur);
  return args;
}

// Build a terminal for a launcher, pinned to the session's cwd. A launcher
// with no command is a plain interactive shell. A shell launcher runs the
// command line via a login shell so the user's PATH/profile is available
// (thel may be launched from a GUI, not a terminal); a no-shell launcher is
// exec'd directly, with placeholders substituted per token so a directory
// with spaces stays a single argument.
async function makeTerminal(
  launcher: Launcher,
  session: SessionCtx,
): Promise<Terminal> {
  const shell = await defaultShell();
  const commandLine = launcher.command.trim();
  let command = shell;
  let args: string[] = [];
  if (commandLine && launcher.shell !== false) {
    args = ["-l", "-c", substituteVars(commandLine, session)];
  } else if (commandLine) {
    const argv = splitArgs(commandLine).map((t) => substituteVars(t, session));
    if (argv.length > 0) {
      command = argv[0];
      args = argv.slice(1);
    }
  }
  return {
    id: crypto.randomUUID(),
    title: launcher.name,
    defaultTitle: launcher.name,
    command,
    args,
    cwd: session.cwd,
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
  const term = await makeTerminal(opts.launcher ?? getDefaultLauncher(), {
    id: session.id,
    name: session.name,
    cwd: opts.cwd,
  });
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
  const term = await makeTerminal(launcher ?? getDefaultLauncher(), {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
  });
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
  const term = await makeTerminal(launcher ?? getDefaultLauncher(), {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
  });
  store.splitGroup(session.id, term, dir, groupId);
}
