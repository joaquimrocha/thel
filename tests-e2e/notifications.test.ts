import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { App, until } from "./app.ts";

let app: App;
let quiet: string;
let busy: string;
before(async () => {
  quiet = mkdtempSync(join(tmpdir(), "thel-e2e-quiet-"));
  busy = mkdtempSync(join(tmpdir(), "thel-e2e-busy-"));
  app = await App.launch();
});
after(async () => {
  await app?.close();
  rmSync(quiet, { recursive: true, force: true });
  rmSync(busy, { recursive: true, force: true });
});

const row = (dir: string) =>
  app.find(`//*[@data-session-list]//span[normalize-space()=${JSON.stringify(basename(dir))}]`, "xpath");

test("a command that finishes and rings in another session shows in Notifications", async () => {
  await app.openSession(quiet);
  await app.openSession(busy);
  await app.type("sleep 2; printf '\\a'");
  await app.press("Enter");
  await app.click(await row(quiet));

  await app.press("O", { ctrl: true, shift: true });
  const dialogText = () => app.exec("return document.querySelector('[role=dialog]')?.innerText ?? ''");
  await until("both notifications", async () => {
    const text: string = await dialogText();
    return (text.includes("Command finished") && text.includes("Wants input")) || undefined;
  }, 15_000);
});
