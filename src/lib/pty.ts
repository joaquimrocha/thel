import { invoke, Channel } from "@tauri-apps/api/core";

export type TermMsg =
  | { kind: "data"; data: string }
  | { kind: "busy"; busy: boolean }
  | { kind: "exit"; code: number | null };

export interface CreateOpts {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  // Back the terminal with thel's own session daemon (unix); falls back to a
  // direct PTY when the daemon is unavailable or disabled.
  use_daemon?: boolean;
}

/** Spawn a PTY-backed session. `onMsg` receives streamed output and the exit. */
export function createSession(opts: CreateOpts, onMsg: (m: TermMsg) => void) {
  const onData = new Channel<TermMsg>();
  onData.onmessage = onMsg;
  return invoke<void>("create_session", { opts, onData });
}

export const writeSession = (id: string, data: string) =>
  invoke<void>("write_session", { id, data });

export const resizeSession = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { id, cols, rows });

export const closeSession = (id: string) =>
  invoke<void>("close_session", { id });

export interface TerminalStatus {
  // A foreground command is running (vs an idle shell).
  busy: boolean;
  // The program exited. Exit is normally delivered on the channel; this is the
  // polled fallback.
  dead: boolean;
  code: number | null;
}

export const terminalStatus = (id: string) =>
  invoke<TerminalStatus>("terminal_status", { id });

/** True if a foreground command is running in the terminal (vs an idle shell). */
export const terminalBusy = (id: string) =>
  terminalStatus(id).then((s) => s.busy);

/** Permanently destroy a terminal (kills its process; the user closed the tab). */
export const killTerminalWindow = (sessionId: string, id: string) =>
  invoke<void>("kill_terminal_window", { sessionId, id });

/** Launch a command detached in its own session, fire-and-forget -- for
 * no-shell "app" launchers, which aren't terminals and must outlive any tab. */
export const spawnDetached = (command: string, args: string[], cwd?: string) =>
  invoke<void>("spawn_detached", { command, args, cwd });

/** Probe the session daemon at startup: "ok" | "skew" (incompatible version
 * running) | "none". */
export const checkDaemon = () =>
  invoke<"ok" | "skew" | "none">("check_daemon");

/** Kill an incompatible daemon so the current build starts a fresh one. Ends the
 * sessions the old daemon was hosting. */
export const restartDaemon = () => invoke<void>("restart_daemon");

// Set (session-scoped) when the user declined to restart an incompatible daemon,
// so terminals fall back to a direct PTY for the rest of this run.
const DAEMON_OPT_OUT = "thel.daemonOptOut";
export const daemonOptedOut = () =>
  typeof sessionStorage !== "undefined" &&
  sessionStorage.getItem(DAEMON_OPT_OUT) === "1";
export const setDaemonOptOut = () => {
  try {
    sessionStorage.setItem(DAEMON_OPT_OUT, "1");
  } catch {
    // ignore
  }
};

/** Open an http(s) URL in the system browser (webview window.open is a no-op). */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

export const defaultShell = () => invoke<string>("default_shell");

export const homeDir = () => invoke<string | null>("home_dir");

/** True if the path exists and is a directory. */
export const dirExists = (path: string) =>
  invoke<boolean>("dir_exists", { path });

/** True if a program is spawnable (PATH lookup for bare names). */
export const programExists = (name: string) =>
  invoke<boolean>("program_exists", { name });

/** Subdirectory completions for a partial absolute path (shell Tab style). */
export const completeDir = (input: string) =>
  invoke<string[]>("complete_dir", { input });

export interface FontConfig {
  family: string;
  size_pt: number | null;
}

export const monospaceFont = () =>
  invoke<FontConfig | null>("monospace_font");
