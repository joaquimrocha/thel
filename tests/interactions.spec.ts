import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const c = page.getByRole("button", { name: "Create session" });
  await expect(c).toBeEnabled();
  await c.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
}

async function rename(page: Page, name: string) {
  // The newest (active) session is the last row; double-click opens its settings.
  await page
    .locator('[data-session-list] [title="Double-click for session settings"]')
    .last()
    .dblclick();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").first().fill(name);
  await dialog.getByRole("button", { name: "Done" }).click();
}

const gitRepo = {
  root: "/home/test",
  branches: ["main", "dev"],
  worktrees: [{ path: "/home/test", branch: "main", is_main: true }],
};
const activeName = (page: Page) => page.getByTestId("active-session-name");

test("closing a busy terminal asks for confirmation", async ({ page }) => {
  await gotoApp(page, { terminalBusy: true });
  await createSession(page);
  await page.keyboard.press("Control+Shift+W");
  await expect(page.getByText(/A command is still running/)).toBeVisible();
  await page.getByRole("button", { name: "Close terminal" }).click();
  await expect(page.getByText("No terminals in this pane.")).toBeVisible();
});

test("cycle / zoom / jump shortcuts run without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T"); // 2nd terminal
  await page.keyboard.press("Control+Shift+D"); // split -> 2 panes
  for (const k of [
    "Control+PageDown",
    "Control+PageUp",
    "Control+Alt+PageDown",
    "Control+Alt+PageUp",
    "Control+Shift+BracketRight",
    "Control+Shift+BracketLeft",
    "Control+Equal",
    "Control+Minus",
    "Control+Digit0",
    "Alt+Digit1",
    "Alt+Digit2",
  ]) {
    await page.keyboard.press(k);
  }
  // Ignore xterm's headless-WebGL render noise (not an app error).
  expect(errors.filter((e) => !/dimensions/.test(e))).toEqual([]);
  await expect(page.locator("[data-pane-group]")).toHaveCount(2);
});

test("cycle session changes the active session", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await rename(page, "Alpha");
  await createSession(page);
  await rename(page, "Beta");
  await expect(activeName(page)).toHaveText("Beta");
  await page.keyboard.press("Control+Alt+PageUp"); // previous session
  await expect(activeName(page)).toHaveText("Alpha");
});

test("session list: ArrowUp + Enter switches the active session", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await rename(page, "Alpha");
  await createSession(page);
  await rename(page, "Beta");
  await expect(activeName(page)).toHaveText("Beta");
  await page.keyboard.press("Control+Shift+E"); // focus list
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(activeName(page)).toHaveText("Alpha");
});

test("pane hover menu can split down", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(page.locator("[data-pane-group]")).toHaveCount(1);
  await page
    .getByRole("button", { name: "New terminal in this pane" })
    .first()
    .hover({ force: true });
  await page.getByRole("button", { name: "Split down" }).click();
  await expect(page.locator("[data-pane-group]")).toHaveCount(2);
});

test("pane hover menu can close all terminals", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page
    .getByRole("button", { name: "New terminal in this pane" })
    .first()
    .hover({ force: true });
  await page.getByRole("button", { name: "Close all terminals" }).click();
  await page.getByRole("button", { name: "Close all" }).click();
  await expect(page.getByText("No terminals in this pane.")).toBeVisible();
});

test("create-worktree Options reveal base and location", async ({ page }) => {
  await gotoApp(page, { git: gitRepo });
  await page.keyboard.press("Control+Shift+N");
  await page.getByRole("tab", { name: "Create Worktree" }).click();
  await page.getByPlaceholder("my-new-branch").fill("feature");
  await page.getByRole("button", { name: "Options" }).click();
  await expect(page.getByText("Base")).toBeVisible();
  await expect(page.getByText("Location")).toBeVisible();
});

test("browse-for-folder loads the picked folder", async ({ page }) => {
  await gotoApp(page, { pickedFolder: "/home/test/proj" });
  await page.keyboard.press("Control+Shift+N");
  await page.getByRole("button", { name: "Browse for folder" }).click();
  await expect(page.getByPlaceholder("/path/to/folder")).toHaveValue(/proj/);
});
