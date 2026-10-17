import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { App } from "./app.ts";

let app: App;
let parent: string;
let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

before(async () => {
  parent = mkdtempSync(join(tmpdir(), "thel-e2e-git-"));
  repo = join(parent, "project");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  app = await App.launch();
});
after(async () => {
  await app?.close();
  rmSync(parent, { recursive: true, force: true });
});

test("creating a worktree from the New Session dialog checks it out and opens a session in it", async () => {
  await app.press("N", { ctrl: true, shift: true });
  await app.fill(await app.find('input[placeholder="/path/to/folder"]'), repo);
  // Only a git repo gets the branch field, on the Create Worktree tab.
  await app.fill(await app.find('input[placeholder="my-new-branch"]'), "e2e-branch");
  await app.click(await app.button("Create session"));

  const wt = `${repo}.e2e-branch`;
  await app.focused(".xterm-helper-textarea");
  await app.terminalMatching(/^\$ $/m);
  await app.run("pwd; git branch --show-current", new RegExp(`^${wt}\\ne2e-branch$`, "m"));
  assert.ok(existsSync(wt));
  assert.match(git("worktree", "list"), new RegExp(`^${wt} .*\\[e2e-branch\\]$`, "m"));
});
