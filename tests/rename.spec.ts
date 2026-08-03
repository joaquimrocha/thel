import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
}

test("rename a session (double-click opens settings)", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  // Double-clicking the row opens the Session Settings dialog; rename there.
  await page
    .locator('[data-session-list] [title="Double-click for session settings"]')
    .dblclick();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").first().fill("MySession");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("[data-session-list]")).toContainText("MySession");
});

test("rename a terminal tab from its context menu", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.locator('[data-testid="terminal-tab"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.locator("input:focus");
  await input.fill("MenuTerm");
  await input.press("Enter");
  await expect(
    page.locator('[data-testid="terminal-tab"]', { hasText: "MenuTerm" }),
  ).toBeVisible();
});

// The webview can hand focus back to the terminal just as the context menu
// closes. Committing on that blur closed the field the instant it opened, which
// read as "Rename does nothing" while double-click still worked.
test("a rename survives focus being taken as the menu closes", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.locator('[data-testid="terminal-tab"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.locator("input:focus")).toBeVisible();

  await page.evaluate(() =>
    (document.querySelector(".xterm-helper-textarea") as HTMLElement)?.focus(),
  );

  const input = page.locator("input:focus");
  await expect(input).toBeVisible();
  await input.fill("StolenTerm");
  await input.press("Enter");
  await expect(
    page.locator('[data-testid="terminal-tab"]', { hasText: "StolenTerm" }),
  ).toBeVisible();
});

// The other side of the blur rule: a blur the user did cause still commits.
test("clicking away commits the rename", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page
    .locator('[title="Double-click to rename"]', { hasText: "Terminal" })
    .dblclick();
  await page.locator("input:focus").fill("ClickAway");
  await page.locator(".xterm-screen").first().click();
  await expect(page.locator("input")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="terminal-tab"]', { hasText: "ClickAway" }),
  ).toBeVisible();
});

test("rename a terminal tab with Shift+F2", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Shift+F2");
  const input = page.locator("input:focus");
  await input.fill("KeyTerm");
  await input.press("Enter");
  await expect(
    page.locator('[data-testid="terminal-tab"]', { hasText: "KeyTerm" }),
  ).toBeVisible();
});

test("a cancelled rename does not re-open when revisiting the session", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Shift+F2");
  await expect(page.locator("input:focus")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("input:focus")).toHaveCount(0);

  // Cycling to another session unmounts the tab strip; coming back remounts
  // it, which must not replay the cancelled rename request.
  await createSession(page); // a second session, now active
  await page.keyboard.press("Control+Alt+PageDown"); // wraps back to the first
  await expect(page.getByTestId("terminal-tab")).toBeVisible();
  await expect(page.getByTestId("terminal-tab").locator("input")).toHaveCount(0);
});

test("close a terminal tab from its context menu", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const tab = page.locator('[data-testid="terminal-tab"]');
  await tab.click({ button: "right" });
  const close = page.getByRole("menuitem", { name: "Close" });
  // The menu item shows the close-terminal shortcut.
  await expect(close).toContainText("Ctrl");
  await close.click();
  await expect(tab).toHaveCount(0);
});

test("rename a terminal tab (double-click the title)", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page
    .locator('[title="Double-click to rename"]', { hasText: "Terminal" })
    .dblclick();
  const input = page.locator("input:focus");
  await input.fill("MyTerm");
  await input.press("Enter");
  await expect(
    page.locator('[title="Double-click to rename"]', { hasText: "MyTerm" }),
  ).toBeVisible();
});
