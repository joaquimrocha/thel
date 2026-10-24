import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

const rows = (page: Page) => page.locator("[data-session-list] [data-row-id]");
const tabs = (page: Page) => page.locator("[data-tab-id]");

interface MockWindow {
  __TAURI_INTERNALS__: {
    __emitEvent(event: string, payload: unknown): number;
    __emitTerminalById(id: string, data: string): boolean;
  };
  __MOCK__: { reported?: { id: string; name: string; terminals: string[] }[]; watched?: number };
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
