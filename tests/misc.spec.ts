import { test } from "./app";
import { gotoApp, expect } from "./app";

test("empty state points to the new-session shortcut, not Ctrl+K", async ({
  page,
}) => {
  await gotoApp(page);
  await expect(page.getByText("No sessions open.")).toBeVisible();
  await expect(page.getByText(/to start a session/)).toBeVisible();
  await expect(page.getByText("Ctrl+Shift+N", { exact: true })).toBeVisible();
  await expect(page.getByText("Ctrl+K")).toHaveCount(0);
});

test("palette opens the new-session dialog", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("New session…").click();
  await expect(
    page.getByText("Anchor a session to a folder or git worktree."),
  ).toBeVisible();
});

test("palette opens settings", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("Settings…").click();
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
});

test("palette opens the launchers manager", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("Launchers…").click();
  await expect(
    page.getByText(/A launcher opens a terminal that runs a command/),
  ).toBeVisible();
});

test("Ctrl+B toggles the sidebar's session list", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("[data-session-list]")).toBeVisible();
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("[data-session-list]")).toBeHidden();
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("[data-session-list]")).toBeVisible();
});
