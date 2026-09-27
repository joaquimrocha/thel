// Drives the real thel build (Rust backend, daemon, PTYs) through tauri-driver,
// which speaks W3C WebDriver and proxies to WebKitWebDriver on Linux. Plain
// fetch, no client library: the suite needs a handful of endpoints.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const APP = process.env.THEL_APP ?? join(ROOT, "src-tauri/target/debug/thel");
const DRIVER =
  process.env.TAURI_DRIVER ??
  [join(homedir(), ".cargo/bin/tauri-driver")].find(existsSync) ??
  "tauri-driver";
// The debug build loads its UI from the Vite dev server (tauri.conf devUrl).
const DEV_URL = "http://localhost:1420";

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
type El = { [ELEMENT]: string };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
    s.on("error", fail);
  });
}

/** Polls `fn` every 100ms until it returns something other than undefined or false. */
export async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const up = (url: string) => fetch(url).then((r) => r.ok || undefined, () => undefined);

// Every XDG dir points into a fresh temp dir, so the run gets its own daemon
// socket (daemon.rs runtime_dir), config and WebKit storage, and never touches
// the developer's thel-dev state. Moving XDG_RUNTIME_DIR would also hide the
// Wayland socket, so WAYLAND_DISPLAY is pinned to its absolute path, and the
// systemd user manager's sockets, which systemd-run needs to give each terminal
// its cgroup, so their dir is linked in.
//
// SHELL (what new terminals run) is a bash that skips the developer's rc files,
// with a "$ " prompt and no history file, so output and prompts are the same on
// every machine.
function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const wl = env.WAYLAND_DISPLAY;
  if (wl && !wl.startsWith("/") && env.XDG_RUNTIME_DIR) {
    env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR, wl);
  }
  const realRuntime = env.XDG_RUNTIME_DIR;
  for (const [k, sub] of [
    ["XDG_RUNTIME_DIR", "run"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_DATA_HOME", "data"],
    ["XDG_CACHE_HOME", "cache"],
  ]) {
    env[k] = join(dir, sub);
    mkdirSync(env[k]!, { mode: 0o700 });
  }
  if (realRuntime && existsSync(join(realRuntime, "systemd"))) {
    symlinkSync(join(realRuntime, "systemd"), join(env.XDG_RUNTIME_DIR!, "systemd"));
  }
  const rc = join(dir, "bashrc");
  writeFileSync(rc, "PS1='$ '\nunset HISTFILE\n");
  env.SHELL = join(dir, "bash");
  writeFileSync(env.SHELL, `#!/bin/sh\nexec /bin/bash --noprofile --rcfile '${rc}' "$@"\n`, { mode: 0o755 });
  return env;
}

// Linux only, like tauri-driver itself on this project's targets.
function processesWithEnv(entry: string): number[] {
  return readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return readFileSync(`/proc/${p}/environ`, "latin1").split("\0").includes(entry);
      } catch {
        return false; // Exited, or not ours to read.
      }
    })
    .map(Number);
}

async function newSession(driverUrl: string): Promise<string> {
  const res = await fetch(`${driverUrl}/session`, {
    method: "POST",
    body: JSON.stringify({
      capabilities: { alwaysMatch: { "tauri:options": { application: APP } } },
    }),
  }).then((r) => r.json());
  if (!res.value?.sessionId) throw new Error(`session failed: ${JSON.stringify(res)}`);
  return `${driverUrl}/session/${res.value.sessionId}`;
}

/** A running thel window under WebDriver control. */
export class App {
  private base: string;
  private driverUrl: string;
  private driver: ChildProcess;
  private vite: ChildProcess | undefined;
  private dir: string;

  private constructor(
    base: string,
    driverUrl: string,
    driver: ChildProcess,
    vite: ChildProcess | undefined,
    dir: string,
  ) {
    this.base = base;
    this.driverUrl = driverUrl;
    this.driver = driver;
    this.vite = vite;
    this.dir = dir;
  }

  /**
   * Starts Vite (unless one already serves :1420), tauri-driver, and the app.
   * `seed` maps store file names (e.g. "thel-layout.json") to their contents,
   * written to the app's config dir before it starts.
   */
  static async launch(opts: { seed?: Record<string, unknown> } = {}): Promise<App> {
    if (!existsSync(APP)) throw new Error(`no app binary at ${APP}; build it or set THEL_APP`);
    const dir = mkdtempSync(join(tmpdir(), "thel-e2e-"));
    const env = isolatedEnv(dir);
    // storeFile.ts: dev builds prefix every store file with "dev-".
    const config = join(env.XDG_CONFIG_HOME!, "dev.thel.Thel");
    mkdirSync(config, { recursive: true });
    for (const [name, data] of Object.entries(opts.seed ?? {})) {
      writeFileSync(join(config, `dev-${name}`), JSON.stringify(data));
    }

    let vite: ChildProcess | undefined;
    if (!(await up(DEV_URL))) {
      vite = spawn("pnpm", ["dev"], { cwd: ROOT, stdio: "ignore", detached: true });
      await until("vite", () => up(DEV_URL), 30_000);
    }

    const [port, nativePort] = [await freePort(), await freePort()];
    const driver = spawn(DRIVER, ["--port", `${port}`, "--native-port", `${nativePort}`], {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const driverUrl = `http://127.0.0.1:${port}`;
    await until("tauri-driver", () => up(`${driverUrl}/status`));

    const app = new App(await newSession(driverUrl), driverUrl, driver, vite, dir);
    await app.find("[data-testid=app-menu]");
    return app;
  }

  /**
   * Kills the app and starts it again on the same config and daemon, the way a
   * user quits and reopens thel. Terminals live in the daemon, so they survive.
   */
  async restart() {
    await sleep(1000); // The layout is saved 400ms after a change.
    await this.cmd("DELETE", "");
    this.base = await newSession(this.driverUrl);
    await this.find("[data-testid=app-menu]");
  }

  private async cmd(method: string, path: string, body?: unknown) {
    const r = await fetch(this.base + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json());
    if (r.value?.error) throw new Error(`${r.value.error}: ${r.value.message}`);
    return r.value;
  }

  /** Waits for the first element matching a CSS (or, with `using`, XPath) selector. */
  find(selector: string, using: "css selector" | "xpath" = "css selector"): Promise<El> {
    return until(selector, () => this.cmd("POST", "/element", { using, value: selector }));
  }

  /** Resizes the window, in logical pixels. */
  async setWindowSize(size: { width: number; height: number }) {
    await this.cmd("POST", "/window/rect", size);
  }

  /** Waits for an enabled button whose visible text is exactly `text`. */
  button(text: string): Promise<El> {
    return this.find(`//button[normalize-space()=${JSON.stringify(text)} and not(@disabled)]`, "xpath");
  }

  // WebKitWebDriver refuses every input command (click, element send keys,
  // actions) with "unsupported operation" (tauri-apps/tauri#6541), so input is
  // dispatched as DOM events from inside the page. The Rust side still runs
  // for real; only the OS input layer is skipped.
  /** Runs `script` in the page with `arguments` bound to `args`, returning its result. */
  exec(script: string, ...args: unknown[]) {
    return this.cmd("POST", "/execute/sync", { script, args });
  }

  // The full sequence, since Radix tabs and menus act on pointer/mouse down.
  async click(el: El) {
    await this.exec(
      `const el = arguments[0], o = { bubbles: true, cancelable: true, button: 0 };
       el.dispatchEvent(new PointerEvent("pointerdown", o));
       el.dispatchEvent(new MouseEvent("mousedown", o));
       el.dispatchEvent(new PointerEvent("pointerup", o));
       el.dispatchEvent(new MouseEvent("mouseup", o));
       el.click();`,
      el,
    );
  }

  /** Sets an input's value the way typing would, so React sees the change. */
  async fill(el: El, value: string) {
    await this.exec(
      `const [el, v] = arguments;
       el.focus();
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
       el.dispatchEvent(new Event("input", { bubbles: true }));`,
      el,
      value,
    );
  }

  /**
   * Presses one key on the focused element, e.g. `press("n", { ctrl: true, shift: true })`.
   * `code` is derived for letters and digits; pass it for others (`","` is "Comma").
   */
  async press(key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; code?: string } = {}) {
    await this.exec(
      `const [key, m] = arguments;
       const code = m.code ?? (/^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : /^\\d$/.test(key) ? "Digit" + key : key);
       const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt,
         keyCode: key === "Enter" ? 13 : /^[a-z0-9 ]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0 };
       const el = document.activeElement ?? document.body;
       if (el.dispatchEvent(new KeyboardEvent("keydown", init)))
         el.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: key === "Enter" ? 13 : key.charCodeAt(0) }));
       el.dispatchEvent(new KeyboardEvent("keyup", init));`,
      key,
      mods,
    );
  }

  /** Types `text` into the focused element, one key at a time. */
  async type(text: string) {
    for (const ch of text) await this.press(ch);
  }

  /**
   * Waits until the focused element matches `selector`. Unlike `:focus`, this
   * holds while the window lacks OS focus (another window was clicked).
   */
  focused(selector: string): Promise<true> {
    return until(`focus on ${selector}`, () =>
      this.exec("return document.activeElement?.matches(arguments[0]) || undefined", selector),
    );
  }

  /** How many elements match a CSS selector right now. */
  count(selector: string): Promise<number> {
    return this.exec("return document.querySelectorAll(arguments[0]).length", selector);
  }

  /**
   * Opens a session on a folder outside any git repo through the New Session
   * dialog, and waits for its shell prompt.
   */
  async openSession(dir: string) {
    await this.press("N", { ctrl: true, shift: true });
    const path = await this.find('input[placeholder="/path/to/folder"]');
    // The dialog resolves a typed path in the background, and until it does,
    // Create would use the previous one. A missing folder disables Create, so
    // Create coming back enabled means `dir` itself has resolved.
    await this.fill(path, join(dir, "missing"));
    await this.find("//*[contains(text(), 'Folder not found')]", "xpath");
    await this.fill(path, dir);
    await this.click(await this.button("Create session"));
    await this.focused(".xterm-helper-textarea");
    await this.terminalMatching(/^\$ $/m);
  }

  /** Terminal buffers by terminal id. */
  terminals(): Promise<Record<string, string>> {
    return this.exec("return window.__AUTOMATION__.terminals()");
  }

  /** Types `command` and Enter into the focused terminal, then waits for its output to match `re`. */
  async run(command: string, re: RegExp, ms?: number): Promise<string> {
    await this.type(command);
    await this.press("Enter");
    return this.terminalMatching(re, ms);
  }

  /** Waits until some terminal's buffer matches `re`, and returns that buffer. */
  async terminalMatching(re: RegExp, ms?: number): Promise<string> {
    try {
      return await until(`terminal output ${re}`, async () => {
        return Object.values(await this.terminals()).find((t) => re.test(t));
      }, ms);
    } catch (e) {
      const shown = Object.values(await this.terminals()).map((t) => t.trimEnd());
      throw new Error(`${(e as Error).message}\nterminals:\n${shown.join("\n---\n")}`);
    }
  }

  async screenshot(path: string) {
    writeFileSync(path, Buffer.from(await this.cmd("GET", "/screenshot"), "base64"));
  }

  /** Closes the window and stops every process the run started, the app's daemon and shells included. */
  async close() {
    await this.cmd("DELETE", "").catch(() => {});
    this.driver.kill();
    if (this.vite?.pid) process.kill(-this.vite.pid);
    await until("app processes to exit", async () => {
      const left = processesWithEnv(`XDG_RUNTIME_DIR=${join(this.dir, "run")}`);
      for (const pid of left) process.kill(pid);
      return left.length === 0 || undefined;
    }, 5_000);
    rmSync(this.dir, { recursive: true, force: true });
  }
}
