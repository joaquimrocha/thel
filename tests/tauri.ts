import type { Page } from "@playwright/test";

export interface MockConfig {
  // Window label this page reports (default "main" = the default profile).
  label?: string;
  // Whether dir_exists reports folders as existing (default true).
  dirExists?: boolean;
  // terminal_status responses.
  terminalBusy?: boolean;
  terminalDead?: boolean;
  // Bytes of output each create_session emits, simulating a reattach snapshot
  // (for the startup benchmark). 0/undefined → just a prompt.
  snapshotBytes?: number;
  // Folder returned by the "Browse for folder" dialog (null = cancelled).
  pickedFolder?: string;
  // Directory completions returned by complete_dir.
  completeDir?: string[];
  // worktree_info response (whether the session dir is a linked worktree).
  worktreeInfo?: { is_linked: boolean; path: string; main: string } | null;
  // A git repo to report for paths under `root`.
  git?: {
    root: string;
    branch?: string;
    dirty?: boolean;
    branches?: string[];
    worktrees?: {
      path: string;
      branch: string | null;
      head?: string;
      is_main?: boolean;
      detached?: boolean;
    }[];
  };
}

// Runs in the page before any app code. Installs a self-contained mock of the
// Tauri IPC layer so the React app runs in a plain browser: an in-memory
// (localStorage-backed) store plugin, no-op window/dialog/clipboard plugins, and
// stubbed app commands. Must not reference anything outside itself.
function install(config: MockConfig) {
  const cfg = config || {};
  const w = window as unknown as Record<string, unknown>;
  w.__MOCK__ = cfg;

  let nextCbId = 1;
  const callbacks = new Map<number, (m: unknown) => void>();
  // The id of the registered tauri://close-requested handler, so a test can fire
  // the OS close flow (see __fireCloseRequested below).
  let closeReqHandlerId: number | null = null;
  // Each started terminal's channel callback, keyed by terminal id so a remount
  // (e.g. React StrictMode) replaces the dead one. A test pushes output (e.g. a
  // bell) into a terminal by creation order (see __emitTerminal).
  const termChannels = new Map<string, (m: unknown) => void>();
  // The Channel's registered callback id per terminal. Real Tauri unregisters a
  // channel's callback when the Rust side drops it (close/kill); without doing
  // the same here, every closed terminal's channel closure (which holds the
  // xterm instance) stays in `callbacks` forever and reads as an app leak.
  const termCbIds = new Map<string, number>();
  const dropTermChannel = (id: string) => {
    termChannels.delete(id);
    const cbId = termCbIds.get(id);
    if (cbId !== undefined) callbacks.delete(cbId);
    termCbIds.delete(id);
  };

  // --- store plugin (persists in localStorage so it survives reloads) ---
  const ridToPath = new Map<number, string>();
  const pathToRid = new Map<string, number>();
  let nextRid = 1;
  const skey = (p: string) => "__store__" + p;
  const read = (p: string): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem(skey(p)) || "{}");
    } catch {
      return {};
    }
  };
  const write = (p: string, d: unknown) =>
    localStorage.setItem(skey(p), JSON.stringify(d));

  function storeInvoke(method: string, args: Record<string, unknown>): unknown {
    if (method === "load") {
      const path = args.path as string;
      let rid = pathToRid.get(path);
      if (!rid) {
        rid = nextRid++;
        pathToRid.set(path, rid);
        ridToPath.set(rid, path);
      }
      return rid;
    }
    if (method === "get_store") return pathToRid.get(args.path as string) ?? null;
    const path = ridToPath.get(args.rid as number) || "";
    const data = read(path);
    const key = args.key as string;
    switch (method) {
      case "get":
        return [data[key], Object.prototype.hasOwnProperty.call(data, key)];
      case "set":
        data[key] = args.value;
        write(path, data);
        return null;
      case "has":
        return Object.prototype.hasOwnProperty.call(data, key);
      case "delete": {
        const had = key in data;
        delete data[key];
        write(path, data);
        return had;
      }
      case "clear":
      case "reset":
        write(path, {});
        return null;
      case "keys":
        return Object.keys(data);
      case "values":
        return Object.values(data);
      case "entries":
        return Object.entries(data);
      case "length":
        return Object.keys(data).length;
      default:
        return null;
    }
  }

  // --- app commands ---
  function appInvoke(cmd: string, args: Record<string, unknown>): unknown {
    const m = (w.__MOCK__ || {}) as MockConfig;
    switch (cmd) {
      case "create_session": {
        const ch = args.onData as
          | { onmessage?: (msg: unknown) => void; id?: number }
          | undefined;
        if (ch && typeof ch.onmessage === "function") {
          const send = ch.onmessage;
          const termId = (args.opts as { id: string }).id;
          // A remount replaces the old channel in place (set() keeps Map order,
          // which __emitTerminal's creation-order indexing relies on); only the
          // stale callback registration is dropped.
          const oldCb = termCbIds.get(termId);
          if (oldCb !== undefined) callbacks.delete(oldCb);
          termChannels.set(termId, send);
          if (typeof ch.id === "number") termCbIds.set(termId, ch.id);
          if (m.snapshotBytes && m.snapshotBytes > 0) {
            // Simulate a reattach snapshot: a chunk xterm must parse on mount.
            const line = "restored scrollback line of terminal output\r\n";
            const data = line.repeat(Math.ceil(m.snapshotBytes / line.length));
            setTimeout(() => send({ kind: "data", data }), 0);
          } else {
            setTimeout(() => send({ kind: "data", data: "$ " }), 0);
          }
        }
        return null;
      }
      case "close_session":
        dropTermChannel(String(args.id));
        return null;
      case "kill_terminal_window":
        dropTermChannel(String(args.id));
        return null;
      case "terminal_status":
        return {
          busy: m.terminalBusy ?? false,
          dead: m.terminalDead ?? false,
          code: m.terminalDead ? 0 : null,
        };
      case "scroll_terminal": {
        const store = w.__MOCK__ as Record<string, unknown>;
        const list = (store.scrolls as unknown[]) || [];
        list.push({ id: args.id, up: args.up, lines: args.lines });
        store.scrolls = list;
        return null;
      }
      case "default_shell":
        return "/bin/bash";
      case "home_dir":
        return "/home/test";
      case "dir_exists":
        return m.dirExists !== false;
      case "complete_dir":
        return m.completeDir || [];
      case "monospace_font":
        return null;
      case "open_url":
        (w.__MOCK__ as Record<string, unknown>).lastOpenedUrl = args.url;
        return null;
      case "git_info": {
        const g = m.git;
        const cwd = String(args.cwd || "");
        if (g && (cwd === g.root || cwd.startsWith(g.root + "/"))) {
          return { repo_root: g.root, branch: g.branch || "main", dirty: !!g.dirty };
        }
        return null;
      }
      case "list_worktrees":
        return (m.git?.worktrees || []).map((wt) => ({
          head: "0000000",
          is_main: false,
          detached: false,
          ...wt,
        }));
      case "branches":
        return {
          branches: m.git?.branches || [],
          default_branch: m.git?.branches?.[0] ?? null,
        };
      case "create_worktree": {
        const created = (w.__MOCK__ as Record<string, unknown>).created as
          | unknown[]
          | undefined;
        const list = created || [];
        list.push(args);
        (w.__MOCK__ as Record<string, unknown>).created = list;
        return String(args.path);
      }
      case "worktree_info":
        return m.worktreeInfo ?? null;
      case "remove_worktree": {
        const store = w.__MOCK__ as Record<string, unknown>;
        const list = (store.removed as unknown[]) || [];
        list.push(args);
        store.removed = list;
        return null;
      }
      default:
        return null;
    }
  }

  function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    const a = args || {};
    try {
      if (cmd.startsWith("plugin:store|"))
        return Promise.resolve(storeInvoke(cmd.slice(13), a));
      if (cmd.startsWith("plugin:dialog|"))
        return Promise.resolve(
          (w.__MOCK__ as MockConfig).pickedFolder ?? null,
        );
      if (cmd.startsWith("plugin:clipboard-manager|")) {
        if (cmd.endsWith("read_text"))
          return Promise.resolve((w.__MOCK__ as Record<string, unknown>).clipboard || "");
        (w.__MOCK__ as Record<string, unknown>).clipboard = a.text ?? "";
        return Promise.resolve(null);
      }
      // Capture the close-requested handler so a test can fire the OS close flow.
      if (cmd === "plugin:event|listen" && a.event === "tauri://close-requested")
        closeReqHandlerId = a.handler as number;
      // Real Tauri returns the listener's id; the api hands it back to
      // unregisterListener on unlisten(). Returning null here would make every
      // unlisten a no-op, leaking each handler (and whatever its closure holds,
      // e.g. an xterm) in `callbacks`.
      if (cmd === "plugin:event|listen") return Promise.resolve(a.handler);
      // Record the window destroy the API issues after the close handler runs.
      if (cmd === "plugin:window|destroy")
        (w.__MOCK__ as Record<string, unknown>).destroyed = true;
      // Window/webview/event/app plugin calls: harmless no-ops.
      if (cmd.startsWith("plugin:")) return Promise.resolve(null);
      return Promise.resolve(appInvoke(cmd, a));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: cfg.label || "main" },
      currentWebview: { label: cfg.label || "main" },
    },
    invoke,
    transformCallback(cb: (m: unknown) => void) {
      const id = nextCbId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc(p: string) {
      return p;
    },
    // Whether the app has registered its close-requested handler (so a test can
    // wait for it before firing exactly once, as the X button does).
    __closeRequestedReady: () => closeReqHandlerId !== null,
    // Push output into the index-th started terminal (creation order), e.g. a
    // bell ("\x07") to exercise the attention indicator.
    __emitTerminal: (index: number, data: string) =>
      [...termChannels.values()][index]?.({ kind: "data", data }),
    __emitTerminalById: (id: string, data: string) => {
      const send = termChannels.get(id);
      send?.({ kind: "data", data });
      return !!send;
    },
    // Report the index-th terminal's process exit (the Direct path's exit
    // signal). code 0 = clean exit.
    __exitTerminal: (index: number, code: number | null) =>
      [...termChannels.values()][index]?.({ kind: "exit", code }),
    __exitTerminalById: (id: string, code: number | null) =>
      termChannels.get(id)?.({ kind: "exit", code }),
    __hasTerminalChannel: (id: string) => termChannels.has(id),
    // Drive the OS "close window" flow: run the registered close-requested
    // handler exactly as the @tauri-apps API does. Returns false if no handler
    // is registered yet. The window is "closed" when it then invokes destroy().
    __fireCloseRequested: async () => {
      if (closeReqHandlerId === null) return false;
      const cb = callbacks.get(closeReqHandlerId);
      if (!cb) return false;
      // The handler is async at runtime (the API awaits it before destroying).
      await (cb({ event: "tauri://close-requested", id: closeReqHandlerId }) as
        | Promise<void>
        | undefined);
      return true;
    },
  };
  // Tauri's event unlisten() (e.g. App's onCloseRequested cleanup, which
  // StrictMode runs on remount) calls into this global. Without it, every test
  // throws "unregisterListener of undefined" on teardown.
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, id: number) => callbacks.delete(id),
  };
  w.isTauri = true;
}

export async function installTauriMock(page: Page, config: MockConfig = {}) {
  await page.addInitScript(install, config);
}
