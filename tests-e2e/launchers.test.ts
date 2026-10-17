import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { App } from "./app.ts";

let app: App;
let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "thel-e2e-dir-"));
  app = await App.launch({
    seed: {
      "thel-launchers.json": {
        launchers: [{ id: "echo", name: "Echo dir", command: "echo dir=__SESSION_DIR__", shell: true }],
      },
    },
  });
});
after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a launcher runs its command with the session folder filled in", async () => {
  await app.openSession(dir);
  await app.press("L", { ctrl: true, shift: true });
  await app.click(await app.find("//*[@cmdk-item][contains(normalize-space(), 'Echo dir in current session')]", "xpath"));
  await app.terminalMatching(new RegExp(`^dir=${dir}$`, "m"));
});
