import { defaultShell, programExists, spawnDetached } from "./pty";
import { toast } from "sonner";
import { gitInfo } from "./git";
import { abbreviatePath } from "./paths";
import { useSessions, type Terminal, type SplitDir } from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
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
// special-pattern handling. `escape` shell-quotes each value on the shell
// path so a directory/session name can't inject shell syntax.
function substituteVars(
  text: string,
  ctx: SessionCtx,
  escape: (v: string) => string = (v) => v,
): string {
  const vars: Record<string, string> = {
    SESSION_DIR: ctx.cwd ?? "",
    SESSION_ID: ctx.id,
    SESSION_NAME: ctx.name,
  };
  return text.replace(
    /__(SESSION_DIR|SESSION_ID|SESSION_NAME)__/g,
    (_m, key: string) => escape(vars[key]),
  );
}

// Single-quote a value for a POSIX shell so its contents can't be reparsed as
// shell syntax. Ends the quote, emits an escaped ', reopens: 'a'\''b' == a'b.
function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
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
  // A shell launcher with a command runs it, then stays in an interactive shell
  // so the tab lives on -- the session stays alive, so anything the command
  // launched (a GUI app, a background server) keeps running, and its output
  // stays visible. No command means a plain interactive shell. A no-shell
  // launcher isn't a terminal at all (see launchDetached) and never gets here.
  if (commandLine) {
    const line = substituteVars(commandLine, session, shQuote);
    args = ["-l", "-c", `${line}; exec '${shell}'`];
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

// A no-shell launcher is an app launcher, not a terminal: run it detached (its
// own session) so no tab close or shell exit can take it down, and don't open a
// terminal for it. Shell mode (makeTerminal) is the only path that gets a tab.
const isAppLauncher = (l: Launcher) => !!l.command.trim() && l.shell === false;

async function launchDetached(launcher: Launcher, session: SessionCtx) {
  const argv = splitArgs(launcher.command.trim()).map((t) =>
    substituteVars(t, session),
  );
  if (argv.length === 0) return;
  if (!(await programExists(argv[0]).catch(() => true))) {
    throw new Error(
      `"${argv[0]}" was not found (or is not executable). Use the full path, or enable "Run in a login shell".`,
    );
  }
  await spawnDetached(argv[0], argv.slice(1), session.cwd);
  toast(`Launched ${launcher.name}`);
}

function showLaunchError(launcher: Launcher, e: unknown) {
  useUI.getState().requestConfirm({
    title: `Couldn't start “${launcher.name}”`,
    description: e instanceof Error ? e.message : String(e),
    okOnly: true,
    onConfirm: () => {},
  });
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
  const launcher = opts.launcher ?? getDefaultLauncher();
  // A no-shell launcher just launches an app in the chosen dir -- no session,
  // no tab.
  if (isAppLauncher(launcher)) {
    try {
      await launchDetached(launcher, {
        id: "",
        name: opts.name ?? sessionNameForDir(opts.cwd),
        cwd: opts.cwd,
      });
    } catch (e) {
      showLaunchError(launcher, e);
    }
    return null;
  }
  // The session must exist first (its id/name feed the placeholders), so a
  // failed launcher rolls it back rather than leaving an empty session.
  const session = store.addSession({
    name: opts.name ?? sessionNameForDir(opts.cwd),
    cwd: opts.cwd,
    repoRoot: opts.repoRoot,
  });
  let term: Terminal;
  try {
    term = await makeTerminal(launcher, {
      id: session.id,
      name: session.name,
      cwd: opts.cwd,
    });
  } catch (e) {
    useSessions.getState().removeSession(session.id);
    showLaunchError(launcher, e);
    return null;
  }
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
  const l = launcher ?? getDefaultLauncher();
  const ctx = { id: session.id, name: session.name, cwd: session.cwd };
  try {
    if (isAppLauncher(l)) {
      await launchDetached(l, ctx);
      return;
    }
    store.addTerminal(session.id, await makeTerminal(l, ctx), groupId);
  } catch (e) {
    showLaunchError(l, e);
  }
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
  const l = launcher ?? getDefaultLauncher();
  const ctx = { id: session.id, name: session.name, cwd: session.cwd };
  try {
    if (isAppLauncher(l)) {
      await launchDetached(l, ctx);
      return;
    }
    store.splitGroup(session.id, await makeTerminal(l, ctx), dir, groupId);
  } catch (e) {
    showLaunchError(l, e);
  }
}
