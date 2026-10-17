import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { App } from "./app.ts";

let app: App;
let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "thel-e2e-dir-"));
  app = await App.launch();
});
after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a terminal survives an app restart with its screen and shell state", async () => {
  await app.openSession(dir);
  await app.run("KEPT=still-here; echo before-restart", /^before-restart$/m);

  await app.restart();

  await app.terminalMatching(/^before-restart$/m);
  await app.focused(".xterm-helper-textarea");
  await app.run('echo "after-restart $KEPT"', /^after-restart still-here$/m);
});
