import { invoke, Channel } from "@tauri-apps/api/core";

export type TermMsg =
  | { kind: "data"; data: string }
  | { kind: "busy"; busy: boolean }
  | { kind: "notify"; message: string }
  // The TCP listeners in the terminal's process tree, pushed when they change.
  | { kind: "ports"; ports: ListenPort[] }
  | { kind: "exit"; code: number | null };

export interface CreateOpts {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

// The terminal commands run off the main thread, so two calls for one
// terminal can finish in either order. Input typed before the daemon knows the
// terminal would be lost, and a detach racing a remount's reattach would cut
// its output. Each terminal's calls therefore run one after another.
const queues = new Map<string, Promise<unknown>>();

/** Runs `call` once every earlier call queued for terminal `id` settled. */
function inOrder<T>(id: string, call: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(call);
  const tail = run.catch(() => {});
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

/** Spawn a PTY-backed session. `onMsg` receives streamed output and the exit. */
export function createSession(opts: CreateOpts, onMsg: (m: TermMsg) => void) {
  const onData = new Channel<TermMsg>();
  onData.onmessage = onMsg;
  return inOrder(opts.id, () => invoke<void>("create_session", { opts, onData }));
}

export const writeSession = (id: string, data: string) =>
  inOrder(id, () => invoke<void>("write_session", { id, data }));

export const resizeSession = (id: string, cols: number, rows: number) =>
  inOrder(id, () => invoke<void>("resize_session", { id, cols, rows }));

export const closeSession = (id: string) =>
  inOrder(id, () => invoke<void>("close_session", { id }));

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

/** Ask for a terminal's current busy state and hand it to `apply`, unless the
 * returned function has been called first.
 *
 * The daemon pushes busy only while a tab is busy, plus once as it goes idle,
 * so a listener attached after that edge hears nothing and would keep whatever
 * it already believed. Call the returned function when a pushed busy message
 * arrives: that message is fresher than this answer, whichever lands first. */
export function seedBusy(id: string, apply: (busy: boolean) => void) {
  let superseded = false;
  terminalBusy(id)
    .then((busy) => {
      if (!superseded) apply(busy);
    })
    .catch(() => {});
  return () => {
    superseded = true;
  };
}

export interface TerminalUsage {
  // Cumulative CPU seconds of the terminal's whole process tree, not a rate:
  // two samples make a percentage.
  cpuSeconds: number;
  rssBytes: number;
}

/** A TCP port in the LISTEN state in a terminal's process tree, and the
 * process holding it. */
export interface ListenPort {
  port: number;
  pid: number;
  // Process name, e.g. "node".
  name: string;
}

/** Resource use per terminal, sampled on demand. Ids whose process is gone are
 * absent from the result. */
export const sessionUsage = (ids: string[]) =>
  invoke<Record<string, TerminalUsage>>("session_usage", { ids });

/** SIGTERM to `pid`, which must still listen on a port in `terminalId`'s tree;
 * rejects with a message otherwise. */
export const stopPortProcess = (terminalId: string, pid: number) =>
  invoke<void>("stop_port_process", { terminal: terminalId, pid });

/** Permanently destroy a terminal (kills its process; the user closed the tab). */
export const killTerminalWindow = (id: string) =>
  inOrder(id, () => invoke<void>("kill_terminal_window", { id }));

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

/** Open an http(s) URL in the system browser (webview window.open is a no-op). */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

export const defaultShell = () => invoke<string>("default_shell");

export const homeDir = () => invoke<string | null>("home_dir");

/** True if the path exists and is a directory. */
/** Where a terminal's shell currently is; null when the OS won't say. */
export const terminalCwd = (id: string) =>
  invoke<string | null>("terminal_cwd", { id });

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
