import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

const rows = (page: Page) => page.locator("[data-session-list] [data-row-id]");
const tabs = (page: Page) => page.locator("[data-tab-id]");

interface MockWindow {
  __TAURI_INTERNALS__: {
    __emitEvent(event: string, payload: unknown): number;
    __emitTerminalById(id: string, data: string): boolean;
  };
  __MOCK__: {
    reported?: { id: string; name: string; terminals: string[] }[];
    watched?: number;
    answers?: unknown[];
    sessionCli?: boolean;
  };
}
const mock = (page: Page) =>
  page.evaluate(() => {
    const m = (window as never as MockWindow).__MOCK__;
    return { reported: m.reported, watched: m.watched };
  });
const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ([e, p]) => (window as never as MockWindow).__TAURI_INTERNALS__.__emitEvent(e, p),
    [event, payload] as [string, unknown],
  );
// An Adopt the daemon would send, with defaults for what a test doesn't name.
const adopt = (page: Page, payload: Record<string, unknown>) =>
  emit(page, "thel-session-adopt", { command: "sh", args: [], cwd: "/tmp", sandboxed: false, ...payload });

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
}

test("the window reports its sessions and asks for waiting terminals", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const { reported, watched } = await mock(page);
  expect(reported![0].terminals).toHaveLength(1);
  expect(watched).toBeGreaterThanOrEqual(1);
});

test("thel session stays off for the daemon until the user turns it on", async ({ page }) => {
  await gotoApp(page);
  const sessionCli = () => page.evaluate(() => (window as never as MockWindow).__MOCK__.sessionCli);
  await expect.poll(sessionCli).toBe(false);
  await page.keyboard.press("Control+Comma");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Sessions" }).click();
  await dialog.getByRole("switch", { name: /use thel session/ }).click();
  await expect.poll(sessionCli).toBe(true);
});

test("a terminal that keeps changing its title doesn't hold back the report", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const id = (await mock(page)).reported![0].terminals[0];
  await page.evaluate((id) => {
    let n = 0;
    setInterval(() => (window as never as MockWindow).__TAURI_INTERNALS__.__emitTerminalById(id, `\x1b]0;t${n++}\x07`), 50);
  }, id);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length, { timeout: 3000 }).toBe(2);
});

// Closes this window the way the X button does, keeping its terminals running.
async function closeWindow(page: Page, open: string[]) {
  type Hooks = { __closeRequestedReady(): boolean; __fireCloseRequested(): Promise<boolean> };
  await page.addInitScript((open) => {
    localStorage.setItem("thel.useDaemon", "1");
    const profiles = [{ id: "default", name: "Default" }, { id: "w1", name: "Work" }];
    localStorage.setItem("__store__thel-profiles.json", JSON.stringify({ profiles, open }));
  }, open);
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const ready = () => (window as never as { __TAURI_INTERNALS__: Hooks }).__TAURI_INTERNALS__.__closeRequestedReady();
  await expect.poll(() => page.evaluate(ready)).toBe(true);
  await page.evaluate(() => (window as never as { __TAURI_INTERNALS__: Hooks }).__TAURI_INTERNALS__.__fireCloseRequested());
  return (await mock(page)).reported;
}

test("a window that closes for good takes its sessions out of thel session's reach", async ({ page }) => {
  expect(await closeWindow(page, ["default", "w1"])).toEqual([]);
});

test("the last window to close leaves its sessions for the next launch", async ({ page }) => {
  expect(await closeWindow(page, ["default"])).toHaveLength(1);
});

test("a terminal started for thel session joins its session without taking focus", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const session = (await mock(page)).reported![0];

  await expect
    .poll(() =>
      adopt(page, {
        terminal: "adopted-1",
        command: "/usr/bin/htop",
        place: { kind: "session", id: session.id },
      }),
    )
    .toBeGreaterThan(0);
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.locator('[data-tab-id="adopted-1"]')).toContainText("htop");
  // Opened through the daemon even in the background, which is what tells
  // the daemon a window has it.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as never as MockWindow).__TAURI_INTERNALS__.__emitTerminalById("adopted-1", ""),
      ),
    )
    .toBe(true);
  // The tab the user was on stays the one shown.
  await expect(page.locator(`[data-tab-id="${session.terminals[0]}"]`)).toHaveClass(/bg-secondary/);

  // A replay of the same terminal adds nothing.
  await adopt(page, {
    terminal: "adopted-1",
    command: "htop",
    place: { kind: "session", id: session.id },
  });
  await expect(tabs(page)).toHaveCount(2);
});

test("a new session for this window appears beside the current one", async ({ page }) => {
  await gotoApp(page, { windows: ["profile-work"] });
  await createSession(page);
  await expect.poll(async () => (await mock(page)).watched).toBeGreaterThanOrEqual(1);

  // Another window's session is not this window's to show.
  await adopt(page, {
    terminal: "elsewhere",
    place: { kind: "new_session", name: "other", window: "profile-work" },
  });
  await adopt(page, {
    terminal: "adopted-2",
    cwd: "/srv/api",
    place: { kind: "new_session", name: "api", window: "main" },
  });
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText("api");
  // Still on the first session.
  await expect(rows(page).first()).toHaveClass(/bg-secondary/);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as never as MockWindow).__TAURI_INTERNALS__.__emitTerminalById("adopted-2", ""),
      ),
    )
    .toBe(true);
});

const approve = (page: Page, payload: unknown) => emit(page, "thel-session-approve", payload);
const answers = (page: Page) =>
  page.evaluate(() => (window as never as MockWindow).__MOCK__.answers ?? []);

test("a sandboxed program's request waits for the user's answer", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });

  await expect
    .poll(() =>
      approve(page, { req: 1, caller, summary: 'open a session running a shell in /, named "api"', program: "/home/u/.local/share/agents/versions/2.1.3/runtime/node_modules/.bin/agent" }),
    )
    .toBeGreaterThan(0);
  // A long path is cut short, but never the program's own name.
  await expect(dialog).toContainText('A sandboxed program, "agent" (in "/home/u/.local/share/agents/versions/2.1.3/runtime/node_modu…"), in');
  await expect(dialog).toContainText('open a session running a shell in /, named "api"');
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(dialog).toBeHidden();

  await approve(page, { req: 2, caller, summary: "open a session running a shell in /tmp", program: "/usr/bin/agent" });
  await dialog.getByText("Allow everything from this program").click();
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(dialog).toBeHidden();
  // A replay of it from before the daemon heard the answer doesn't ask again.
  await approve(page, { req: 2, caller, summary: "open a session running a shell in /tmp" });
  await page.waitForTimeout(300);
  await expect(dialog).toBeHidden();

  expect(await answers(page)).toEqual([
    { req: 1, allow: false, remember: false },
    { req: 2, allow: true, remember: true },
  ]);
});

test("a request answered elsewhere, or timed out, leaves the window", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });

  await expect.poll(() => approve(page, { req: 7, caller, summary: "open a session running a shell in /tmp" })).toBeGreaterThan(0);
  await expect(dialog).toBeVisible();
  // A program the daemon couldn't name can't be allowed for good.
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await emit(page, "thel-session-resolved", 7);
  await expect(dialog).toBeHidden();
  expect(await answers(page)).toEqual([]);
});

test("keys typed as a sandboxed program's prompt opens answer it neither way", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });
  const allow = dialog.getByRole("button", { name: "Allow" });

  await expect.poll(() => approve(page, { req: 3, caller, summary: "open a session running a shell in /tmp", program: "/usr/bin/agent" })).toBeGreaterThan(0);
  await expect(allow).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await expect(dialog).toBeFocused();
  for (const key of ["l", "s", "Space", "Enter", "Control+Shift+Enter", "Escape", "Tab", "Space", "Tab", "Tab", "Enter"])
    await page.keyboard.press(key);
  await expect(dialog).toBeFocused();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  // Each key starts the guard over, so the clicks below land on it however
  // slow the machine is.
  await page.keyboard.press("l");
  await page.mouse.click(5, 5);
  await page.keyboard.press("l");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeVisible();
  await expect(allow).toBeEnabled();
  await dialog.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await answers(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A queued request replacing the answered one gets the same guard: focus
  // must not stay on the button that just answered.
  await approve(page, { req: 4, caller, summary: "open a session running a shell in /tmp" });
  await approve(page, { req: 5, caller: "elsewhere", summary: "open a session running a shell in /tmp" });
  await allow.click();
  await expect(dialog).toContainText("in a terminal");
  await expect(allow).toBeDisabled();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(allow).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await answers(page)).toEqual([
    { req: 3, allow: false, remember: false },
    { req: 4, allow: true, remember: false },
    { req: 5, allow: false, remember: false },
  ]);
});

test("a sandboxed program's prompt is allowed by a pointer or its keys, once read to its end", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });
  const allow = dialog.getByRole("button", { name: "Allow" });

  const summary = `type into terminal t1: "${"ls; ".repeat(300)}rm -rf ~"`;
  await expect.poll(() => approve(page, { req: 9, caller, summary, program: "/usr/bin/agent" })).toBeGreaterThan(0);
  await expect(dialog).toContainText("Scroll to the end");
  await expect(allow).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Enter");
  await page.waitForTimeout(1500);
  await expect(allow).toBeDisabled();
  await page.keyboard.press("Control+Shift+Enter");
  expect(await answers(page)).toEqual([]);
  await dialog.locator("p.overflow-y-auto").evaluate((d) => d.scrollTo(0, d.scrollHeight));
  await expect(allow).toBeEnabled();

  const checkbox = dialog.getByRole("checkbox");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  await expect(allow).not.toBeFocused();
  await expect(checkbox).not.toBeFocused();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
  await allow.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(await answers(page)).toEqual([]);
  await allow.click();
  expect(await answers(page)).toEqual([{ req: 9, allow: true, remember: false }]);

  // Keys allow too, once the guard is over and the text read, but only the
  // ones it names.
  await approve(page, { req: 10, caller, summary: "open a session running a shell in /tmp" });
  await expect(allow).toBeEnabled();
  await dialog.focus();
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Shift+Enter");
  expect(await answers(page)).toHaveLength(1);
  await page.keyboard.press("Control+Shift+Enter");
  await expect(dialog).toBeHidden();
  expect((await answers(page))[1]).toEqual({ req: 10, allow: true, remember: false });
});

test("a sandboxed program's prompt can't hide its end in a long word or an old scroll", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });
  const text = dialog.locator("p.overflow-y-auto");
  const width = page.viewportSize()!.width;

  // One word with no spaces wraps instead of pushing the buttons out of view.
  const word = `type into terminal t1: "${"a".repeat(3000)}; rm -rf ~"`;
  await expect.poll(() => approve(page, { req: 10, caller, summary: word })).toBeGreaterThan(0);
  await expect(dialog).toContainText("Scroll to the end");
  for (const name of ["Allow", "Deny"]) {
    const box = await dialog.getByRole("button", { name }).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }

  // A queued prompt that replaces this one starts at its top again.
  const long = `type into terminal t1: "${"ls; ".repeat(300)}"`;
  await approve(page, { req: 11, caller: "elsewhere", summary: long });
  await text.evaluate((d) => d.scrollTo(0, d.scrollHeight));
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(dialog).toContainText("in a terminal");
  await expect(dialog).toContainText("Scroll to the end");
  expect(await text.evaluate((d) => d.scrollTop)).toBe(0);
});

test("a sandboxed program's prompt waits for the window to be back in front", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  const allow = page.getByRole("dialog", { name: "Allow a sandboxed program?" }).getByRole("button", { name: "Allow" });

  await expect.poll(() => approve(page, { req: 8, caller, summary: "open a session running a shell in /tmp" })).toBeGreaterThan(0);
  await expect(allow).toBeEnabled();
  // The click that brings the window back must not land on an armed Allow.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(allow).toBeDisabled();
  await expect(allow).toBeEnabled();
});

test("a prompt disarms on the window's own focus events, which WebKitGTK's DOM may miss", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  const allow = page.getByRole("dialog", { name: "Allow a sandboxed program?" }).getByRole("button", { name: "Allow" });

  await expect.poll(() => approve(page, { req: 13, caller, summary: "open a session running a shell in /tmp" })).toBeGreaterThan(0);
  await expect(allow).toBeEnabled();
  expect(await emit(page, "tauri://blur", null)).toBeGreaterThan(0);
  await expect(allow).toBeDisabled();
  await page.waitForTimeout(1200);
  await expect(allow).toBeDisabled();
  await emit(page, "tauri://focus", null);
  await expect(allow).toBeEnabled();
});

test("a sandboxed program's prompt shows the names it chose escaped", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).watched).toBeGreaterThanOrEqual(1);
  await adopt(page, {
    terminal: "adopted-x",
    place: { kind: "new_session", name: `it's\nx"\u202eevil\u201d ${"\u2800".repeat(80)}`, window: "main" },
  });
  await expect(rows(page)).toHaveCount(2);

  await approve(page, { req: 5, caller: "adopted-x", summary: "open a session running a shell in /tmp" });
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });
  // Escaped as the daemon escapes the names in its summary.
  await expect(dialog).toContainText(
    `in "sh" in session "it\\'s\\nx\\"\\u{202e}evil\\u{201d} ${"\\u{2800}".repeat(46)}…" asks`,
  );
});

test("a sandboxed program's prompt names the terminal it would type into", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const caller = (await mock(page)).reported![0].terminals[0];
  await adopt(page, {
    terminal: "adopted-t",
    command: "/usr/bin/htop",
    place: { kind: "new_session", name: "web", window: "main" },
  });
  await expect(rows(page)).toHaveCount(2);
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });

  const summary = 'type into terminal adopted-t: "q"';
  const named = { caller_session: 'session "api" (id 3f2a9c1d)', target_session: 'session "web"' };
  await expect.poll(() => approve(page, { req: 6, caller, summary, target: "adopted-t", ...named })).toBeGreaterThan(0);
  await expect(dialog).toContainText('in session "api" (id 3f2a9c1d) asks thel to act on "htop" in session "web": type into');
  await dialog.getByRole("button", { name: "Deny" }).click();

  await approve(page, { req: 7, caller, summary, target: caller });
  await expect(dialog).toContainText("asks thel to act on its own terminal, whose shell runs outside the sandbox: type into");
  await dialog.getByRole("button", { name: "Deny" }).click();

  await approve(page, { req: 8, caller, summary, target: "in-another-window", target_session: 'session "api" (id 3f2a9c1d)' });
  await expect(dialog).toContainText(
    'asks thel to act on a terminal in session "api" (id 3f2a9c1d), in another window: type into',
  );
  await dialog.getByRole("button", { name: "Deny" }).click();

  await approve(page, { req: 9, caller, summary, target: "nowhere" });
  await expect(dialog).toContainText("asks thel to act on a terminal no window shows: type into");
});

test("only the window showing a sandboxed program's terminal asks", async ({ page }) => {
  await gotoApp(page, { windows: ["profile-work"] });
  await createSession(page);
  await expect.poll(async () => (await mock(page)).watched).toBeGreaterThanOrEqual(1);
  const dialog = page.getByRole("dialog", { name: "Allow a sandboxed program?" });
  const ask = (req: number, window: string | null) =>
    approve(page, { req, caller: "t-x", summary: "open a session running a shell in /tmp", target: null, window });

  // Open elsewhere: that window asks, not this one.
  await expect.poll(() => ask(8, "profile-work")).toBeGreaterThan(0);
  // Already settled by the time this window would ask.
  await emit(page, "thel-session-resolved", 10);
  await ask(10, null);
  // Its window is closed, so main asks.
  await ask(9, "profile-gone");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(dialog).toBeHidden();
  expect(await answers(page)).toEqual([{ req: 9, allow: false, remember: false }]);
});

test("a new session for a closed window shows in one that is open", async ({ page }) => {
  await gotoApp(page, { label: "profile-w1" });
  await createSession(page);
  await expect.poll(async () => (await mock(page)).watched).toBeGreaterThanOrEqual(1);
  await adopt(page, {
    terminal: "adopted-3",
    cwd: "/srv/api",
    place: { kind: "new_session", name: "api", window: "main" },
  });
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText("api");
});

test("a note changed from the CLI leaves the editor's caret where it was", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect.poll(async () => (await mock(page)).reported?.length).toBe(1);
  const session = (await mock(page)).reported![0].id;
  await rows(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Notes" }).click();
  const editor = page.getByRole("dialog").getByRole("textbox");
  await editor.fill("ab");
  await page.keyboard.press("ArrowLeft");

  await emit(page, "thel-session-note", { session, text: "ab\nfrom cli\n", edit: { kind: "append", text: "from cli" } });
  await expect(editor).toHaveValue("ab\nfrom cli\n");
  await page.keyboard.type("X");
  await expect(editor).toHaveValue("aXb\nfrom cli\n");
});
