// Regenerates the README and website screenshots from the real app:
//
//   pnpm screenshots
//
// Needs what `pnpm test:e2e` needs (see tests/README.md). The app runs
// isolated from your own thel setup: profiles, launchers and the session
// layout are seeded below, and shells skip your rc files for a plain prompt,
// so the shots come out the same every time and show nothing personal.
//
// THEL_SHOTS_WORK  folder holding the projects shown (default ~/work)
// THEL_SHOTS_AGENT command for the agent pane (default "claude")
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP, App } from "../tests-e2e/app.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs/screenshots");
const SITE = join(ROOT, "website/public");
const WORK = process.env.THEL_SHOTS_WORK ?? join(homedir(), "work");
const AGENT = process.env.THEL_SHOTS_AGENT ?? "claude";
const headlamp = join(WORK, "headlamp");
const thel = join(WORK, "thel");
// Looked up before anything is created, so a missing repo leaves nothing behind.
const [hl1, hl2] = worktrees(headlamp, 2);
const [th1, th2] = worktrees(thel, 2);
const BASH = "/bin/bash";
const RC_DIR = mkdtempSync(join(tmpdir(), "thel-shots-"));
const RC = join(RC_DIR, "bashrc");
// No history file, so the typed commands stay out of ~/.bash_history. The
// app binary is on PATH as `thel`, for the `thel session` scene.
symlinkSync(APP, join(RC_DIR, "thel"));
writeFileSync(RC, `PS1='\\u@\\h \\W\\$ '\nunset HISTFILE\nPATH=${RC_DIR}:$PATH\n`);
const BASH_ARGS = ["--noprofile", "--rcfile", RC, "-i"];
// The window size the published shots were taken at (2474x1542 at 2x).
const SIZE = { width: 1237, height: 771 };

// This script may itself run inside an agent session; its markers would leak
// into the agent pane (e.g. Claude Code warning that it is a child session).
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE|ANTHROPIC)/.test(k) && k !== "CLAUDE_CONFIG_DIR") delete process.env[k];
}
// Claude Code's updater installs under the run's temp XDG_DATA_HOME and
// repoints ~/.local/bin/claude there, which dangles once the run cleans up.
process.env.DISABLE_AUTOUPDATER = "1";

const shell = (cwd: string, title = "Terminal") => ({
  id: crypto.randomUUID(),
  title,
  command: BASH,
  args: BASH_ARGS,
  cwd,
});
const agent = (cwd: string) => ({
  ...shell(cwd, AGENT),
  args: ["--noprofile", "--norc", "-c", `${AGENT}; exec ${BASH} ${BASH_ARGS.join(" ")}`],
});

// A pane shows only its group's active terminal, so every group names one.
type Term = ReturnType<typeof shell>;
const group = (id: string, ...terminals: Term[]) => ({
  id,
  terminals,
  activeTerminalId: terminals[terminals.length - 1].id,
});

// A session with a single pane.
const session = (id: string, cwd: string, term: Term = shell(cwd), icon?: string) => ({
  id,
  name: id,
  cwd,
  icon,
  groups: [group(`${id}-g`, term)],
});

// The first `n` linked worktrees of `repo` that sit beside it as
// "<repo>.<branch>" (where thel creates them). Looked up at run time so the
// shots follow whatever branches exist instead of naming ones that come and go.
function worktrees(repo: string, n: number): string[] {
  const out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  const paths = out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const linked = paths.filter((p) => p.startsWith(`${repo}.`) && existsSync(p)).slice(0, n);
  if (linked.length < n) throw new Error(`${repo} needs ${n} linked worktrees, has ${linked.length}`);
  return linked;
}

const [claudePane, rightTop, rightBottom] = ["g1", "g2", "g3"];

const common = {
  "thel-profiles.json": {
    profiles: [
      { id: "work", name: "Work", color: "#3b82f6" },
      { id: "default", name: "Personal", color: "#facc15" },
    ],
    open: ["default"],
  },
  "thel-launchers.json": {
    launchers: [
      { id: "vsc", name: "vsc", command: "code __SESSION_DIR__", shell: true },
      { id: "emacs", name: "emacs", command: "emacs __SESSION_DIR__", shell: true },
    ],
  },
};

const seed = {
  ...common,
  "thel-layout.json": {
    layout: {
      activeSessionId: "headlamp",
      sessions: [
        {
          id: "headlamp",
          name: "headlamp",
          cwd: headlamp,
          icon: "rocket",
          groups: [
            group(claudePane, agent(headlamp)),
            group(rightTop, shell(headlamp), shell(headlamp)),
            group(rightBottom, shell(headlamp)),
          ],
          layout: {
            t: "split",
            dir: "row",
            children: [
              { t: "leaf", group: claudePane },
              {
                t: "split",
                dir: "col",
                children: [
                  { t: "leaf", group: rightTop },
                  { t: "leaf", group: rightBottom },
                ],
              },
            ],
          },
          activeGroupId: claudePane,
        },
        session("thel", thel, shell(thel), "terminal"),
        { ...session("home", homedir()), name: "~" },
      ],
    },
  },
};

// Two projects with a couple of worktrees each, for the grouped sidebar.
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const groupedSeed = {
  ...common,
  "thel-layout.json": {
    layout: {
      activeSessionId: base(hl1),
      sessions: [
        session("headlamp", headlamp, shell(headlamp), "rocket"),
        session(base(hl1), hl1, agent(hl1)),
        session(base(hl2), hl2),
        session("thel", thel, shell(thel), "terminal"),
        session(base(th1), th1),
        session(base(th2), th2),
        { ...session("home", homedir()), name: "~" },
      ],
    },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `site` null keeps the shot out of the website, for release notes only.
async function shot(app: App, name: string, site: string | null = `shots/${name}.png`) {
  await sleep(500); // Let dialog animations settle.
  const out = join(DOCS, `${name}.png`);
  await app.screenshot(out);
  if (site) copyFileSync(out, join(SITE, site));
  console.log(`wrote ${name}`);
}

// Closes the top dialog and waits until it is gone, so the focus it hands
// back on close cannot land after the next step moved focus elsewhere.
async function escape(app: App) {
  const open = () => app.exec("return document.querySelectorAll('[role=dialog]').length");
  const before = await open();
  await app.press("Escape");
  while ((await open()) >= before) await sleep(50);
  await sleep(200);
}

// Puts the caret at `caret` in the matching input, or with no selector drops
// focus, so no keyboard focus ring shows.
function focus(app: App, selector?: string, caret?: number) {
  return app.exec(
    `const [sel, at] = arguments;
     if (!sel) return document.activeElement?.blur();
     const el = document.querySelector(sel);
     el.focus();
     if (at != null) el.setSelectionRange(at, at);`,
    selector,
    caret,
  );
}

function sessionRow(app: App, name: string) {
  return app.find(`//*[@data-session-list]//span[normalize-space()=${JSON.stringify(name)}]`, "xpath");
}

// Launches the app on `seed`, waits for the agent pane to draw, runs `scenes`.
async function withApp(seed: Record<string, unknown>, scenes: (app: App) => Promise<void>) {
  const app = await App.launch({ seed });
  try {
    await app.setWindowSize(SIZE);
    await app.terminalMatching(new RegExp(AGENT === "claude" ? "Claude Code" : "."), 60_000);
    await sleep(3000);
    await scenes(app);
  } finally {
    await app.close();
  }
}

try {
  await withApp(seed, async (app) => {
    await shot(app, "split-panes", "screenshot.png");

    await app.press("P", { ctrl: true, shift: true });
    await app.find("[cmdk-input]");
    await shot(app, "command-palette");
    await escape(app);

    await app.press("N", { ctrl: true, shift: true });
    const branch = await app.find('input[placeholder="my-new-branch"]');
    await app.click(await app.button("Options"));
    await app.fill(await app.find('input[placeholder="HEAD"]'), "main");
    await app.fill(branch, "new-feature");
    await sleep(1000); // The dialog grabs focus back once git answers.
    await focus(app, 'input[placeholder="my-new-branch"]', "new-feature".length);
    await shot(app, "new-session-worktree");
    await escape(app);

    await app.press(",", { ctrl: true, code: "Comma" });
    await app.click(await app.button("Launchers"));
    await app.click(await app.button("Manage launchers…"));
    await app.click(await app.button("emacs"));
    await app.find('input[value="emacs __SESSION_DIR__"]');
    await focus(app, 'input[value="emacs __SESSION_DIR__"]', "emacs".length);
    await shot(app, "launchers");
    await escape(app);
    await escape(app);

    await app.press(",", { ctrl: true, code: "Comma" });
    await app.click(await app.button("Profiles"));
    await shot(app, "profiles");
    await escape(app);

    // Real notifications: a command that finishes and rings the bell in a
    // session you are not looking at.
    await app.click(await sessionRow(app, "thel"));
    await app.find(".xterm-helper-textarea");
    await focus(app, ".xterm-helper-textarea");
    await app.type("sleep 3; printf '\\a'");
    await app.press("Enter");
    await app.click(await sessionRow(app, "headlamp"));
    await sleep(6000);
    await app.press("O", { ctrl: true, shift: true });
    await app.find("[role=dialog]");
    await sleep(300);
    await focus(app);
    await shot(app, "notifications");
  });

  await withApp(groupedSeed, async (app) => {
    const menu = await app.find('button[aria-label="Sidebar menu"]');
    await app.click(menu);
    await app.click(await app.find("//*[@role='menuitemcheckbox'][normalize-space()='Group sessions by repo']", "xpath"));
    await app.click(menu);
    await app.find("[data-repo-group]");
    await focus(app);
    await shot(app, "grouped-sessions");
  });

  // Features new in 0.8.0, for its release notes.
  const plain = {
    ...common,
    "thel-layout.json": {
      layout: {
        activeSessionId: "headlamp",
        sessions: [
          session("headlamp", headlamp, agent(headlamp), "rocket"),
          session("thel", thel, shell(thel), "terminal"),
          { ...session("home", homedir()), name: "~" },
        ],
      },
    },
  };
  await withApp(plain, async (app) => {
    await app.click(await sessionRow(app, "thel"));
    await focus(app, ".xterm-helper-textarea");
    await app.run("python3 -m http.server 8000 --bind 127.0.0.1", /Serving HTTP/);
    await app.find("[data-testid=ports-indicator]");
    await app.press("R", { ctrl: true, shift: true });
    await app.find("[data-testid=listen-port]");
    await focus(app);
    await shot(app, "ports", null);
    await escape(app);

    await app.press(",", { ctrl: true, shift: true, code: "Comma" });
    await app.find("//*[normalize-space()='Move to profile']", "xpath");
    await focus(app);
    await shot(app, "move-to-profile", null);
    await escape(app);

    await app.press("N", { ctrl: true, shift: true });
    const path = await app.find('input[placeholder="/path/to/folder"]');
    const missing = join(WORK, "new-project");
    await app.fill(path, missing);
    await app.button("Create folder and session");
    await focus(app, 'input[placeholder="/path/to/folder"]', missing.length);
    await shot(app, "create-folder", null);
    await escape(app);

    await app.press(",", { ctrl: true, code: "Comma" });
    await app.click(await app.button("About"));
    await app.click(await app.button("Show initial screen"));
    await app.find("[data-testid=initial-screen]");
    await focus(app);
    await shot(app, "initial-screen", null);
    await escape(app);

    await app.press(",", { ctrl: true, code: "Comma" });
    await app.click(await app.button("Sessions"));
    await app.click(await app.find("//label[contains(., 'thel session')]//button[@role='switch']", "xpath"));
    await escape(app);
    await app.click(await sessionRow(app, "~"));
    await focus(app, ".xterm-helper-textarea");
    await app.type("setpriv --no-new-privs thel session new -n dev -- npm run dev");
    await app.press("Enter");
    await app.find("//*[normalize-space()='Allow a sandboxed program?']", "xpath");
    await focus(app);
    await shot(app, "sandbox-prompt", null);
  });
} finally {
  rmSync(RC_DIR, { recursive: true, force: true });
}
