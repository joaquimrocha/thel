// Drives the real thel build (Rust backend, daemon, PTYs) through tauri-driver,
// which speaks W3C WebDriver and proxies to WebKitWebDriver on Linux. Plain
// fetch, no client library: the suite needs a handful of endpoints.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
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

const up = (url: string) => fetch(url).then((r) => r.ok || undefined, () => undefined);

// Every XDG dir points into a fresh temp dir, so the run gets its own daemon
// socket (daemon.rs runtime_dir), config and WebKit storage, and never touches
// the developer's thel-dev state. Moving XDG_RUNTIME_DIR would also hide the
// Wayland socket, so WAYLAND_DISPLAY is pinned to its absolute path.
function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const wl = env.WAYLAND_DISPLAY;
  if (wl && !wl.startsWith("/") && env.XDG_RUNTIME_DIR) {
    env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR, wl);
  }
  for (const [k, sub] of [
    ["XDG_RUNTIME_DIR", "run"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_DATA_HOME", "data"],
    ["XDG_CACHE_HOME", "cache"],
  ]) {
    env[k] = join(dir, sub);
    mkdirSync(env[k]!, { mode: 0o700 });
  }
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

/** A running thel window under WebDriver control. */
export class App {
  private base: string;
  private driver: ChildProcess;
  private vite: ChildProcess | undefined;
  private dir: string;

  private constructor(base: string, driver: ChildProcess, vite: ChildProcess | undefined, dir: string) {
    this.base = base;
    this.driver = driver;
    this.vite = vite;
    this.dir = dir;
  }

  /** Starts Vite (unless one already serves :1420), tauri-driver, and the app. */
  static async launch(): Promise<App> {
    if (!existsSync(APP)) throw new Error(`no app binary at ${APP}; build it or set THEL_APP`);
    const dir = mkdtempSync(join(tmpdir(), "thel-e2e-"));
    const env = isolatedEnv(dir);

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
    const base = `http://127.0.0.1:${port}`;
    await until("tauri-driver", () => up(`${base}/status`));

    const res = await fetch(`${base}/session`, {
      method: "POST",
      body: JSON.stringify({
        capabilities: { alwaysMatch: { "tauri:options": { application: APP } } },
      }),
    }).then((r) => r.json());
    if (!res.value?.sessionId) throw new Error(`session failed: ${JSON.stringify(res)}`);

    const app = new App(`${base}/session/${res.value.sessionId}`, driver, vite, dir);
    await app.find("[data-testid=app-menu]");
    return app;
  }

  private async cmd(method: string, path: string, body?: unknown) {
    const r = await fetch(this.base + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json());
    if (r.value?.error) throw new Error(`${r.value.error}: ${r.value.message}`);
    return r.value;
  }

  /** Waits for the first element matching a CSS selector. */
  find(css: string): Promise<El> {
    return until(css, () => this.cmd("POST", "/element", { using: "css selector", value: css }));
  }

  /** Waits for an enabled button whose visible text is exactly `text`. */
  button(text: string): Promise<El> {
    const value = `//button[normalize-space()=${JSON.stringify(text)} and not(@disabled)]`;
    return until(`button "${text}"`, () => this.cmd("POST", "/element", { using: "xpath", value }));
  }

  // WebKitWebDriver refuses every input command (click, element send keys,
  // actions) with "unsupported operation" (tauri-apps/tauri#6541), so input is
  // dispatched as DOM events from inside the page. The Rust side still runs
  // for real; only the OS input layer is skipped.
  private exec(script: string, ...args: unknown[]) {
    return this.cmd("POST", "/execute/sync", { script, args });
  }

  async click(el: El) {
    await this.exec("arguments[0].click()", el);
  }

  /** Presses one key on the focused element, e.g. `press("n", { ctrl: true, shift: true })`. */
  async press(key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
    await this.exec(
      `const [key, m] = arguments;
       const code = /^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : /^\\d$/.test(key) ? "Digit" + key : key;
       const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!m.ctrl, shiftKey: !!m.shift,
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

  /** Waits until some terminal's buffer matches `re`, and returns that buffer. */
  terminalMatching(re: RegExp, ms?: number): Promise<string> {
    return until(`terminal output ${re}`, async () => {
      const all: Record<string, string> = await this.exec("return window.__AUTOMATION__.terminals()");
      return Object.values(all).find((t) => re.test(t));
    }, ms);
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
