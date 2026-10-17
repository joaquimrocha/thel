import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { App, until } from "./app.ts";

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
