import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { App, until } from "./app.ts";

// Terminals get a cgroup only where a systemd user manager answers, which CI
// runners lack. In a container with its own cgroup namespace (toolbox) the
// scope is out of view.
const scoped =
  spawnSync("systemd-run", [
    "--user", "--scope", "--quiet", "--collect", "--",
    "sh", "-c", 'p=$(sed -n "s/^0:://p" /proc/self/cgroup); case $p in */..*) exit 1;; esac; test -f "/sys/fs/cgroup$p/cgroup.procs"',
  ]).status === 0;

let app: App;
let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "thel-e2e-dir-"));
  app = await App.launch();
  await app.openSession(dir);
});
after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the usage dialog lists a terminal's listening port and stops its process", async () => {
  const out = await app.run("python3 -m http.server 0 --bind 127.0.0.1", /Serving HTTP on \S+ port (\d+)/);
  const port = out.match(/Serving HTTP on \S+ port (\d+)/)![1];
  await app.press("R", { ctrl: true, shift: true });
  const row = `//*[@data-testid='listen-port'][contains(normalize-space(), ':${port}')]`;
  await app.find(row, "xpath");
  await app.click(await app.find(`${row}//button[starts-with(@aria-label, 'Stop python3 (pid ')]`, "xpath"));
  await app.terminalMatching(/^Terminated/m);
  await until("the port row to go", async () => (await app.count("[data-testid=listen-port]")) === 0);
});

test("a listener that left the shell's tree still shows, from the terminal's cgroup", { skip: !scoped && "no systemd user manager" }, async () => {
  // A tab of its own, so a server left running by the test above can't take the input.
  const tabs = await app.count("[data-testid=terminal-tab]");
  await app.press("T", { ctrl: true, shift: true });
  await until("a new tab", async () => (await app.count("[data-testid=terminal-tab]")) === tabs + 1);
  await app.focused(".xterm-helper-textarea");
  // The subshell exits at once, so the server is no longer a descendant of the shell.
  const out = await app.run("(python3 -m http.server 0 --bind 127.0.0.2 &)", /Serving HTTP on 127\.0\.0\.2 port (\d+)/);
  const port = out.match(/Serving HTTP on 127\.0\.0\.2 port (\d+)/)![1];
  if ((await app.count("[role=dialog]")) === 0) await app.press("R", { ctrl: true, shift: true });
  const row = `//*[@data-testid='listen-port'][contains(normalize-space(), ':${port}')]`;
  await app.click(await app.find(`${row}//button[starts-with(@aria-label, 'Stop python3 (pid ')]`, "xpath"));
  await until("the port row to go", async () => (await app.count("[data-testid=listen-port]")) === 0);
});
