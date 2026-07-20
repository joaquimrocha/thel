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
