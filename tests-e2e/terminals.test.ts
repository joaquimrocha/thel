import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { App, until } from "./app.ts";

const TAB = "[data-testid=terminal-tab]";

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

test("a session's shell starts in the session folder", async () => {
  await app.run("pwd", new RegExp(`^${dir}$`, "m"));
});

test("a new tab starts its own shell in the session folder", async () => {
  const [first] = Object.keys(await app.terminals());
  await app.press("T", { ctrl: true, shift: true });
  await until("a second tab", async () => (await app.count(TAB)) === 2);
  await app.focused(".xterm-helper-textarea");
  await app.terminalMatching(/^\$ $/m);
  const [second] = Object.keys(await app.terminals());
  assert.notEqual(second, first);
  await app.run("echo tab-$((1+1)); pwd", new RegExp(`^tab-2\\n${dir}$`, "m"));
});

test("exiting the shell closes its tab", async () => {
  const tabs = await app.count(TAB);
  await app.type("exit");
  await app.press("Enter");
  await until("the tab to close", async () => (await app.count(TAB)) === tabs - 1);
});

test("a split pane runs a second shell beside the first", async () => {
  await app.run("echo left-pane", /^left-pane$/m);
  await app.press("D", { ctrl: true, shift: true });
  await until("two panes", async () => Object.keys(await app.terminals()).length === 2);
  await app.focused(".xterm-helper-textarea");
  const right = await app.run("echo right-$((2+3))", /^right-5$/m);
  assert.doesNotMatch(right, /left-pane/);
});
