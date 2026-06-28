import { test } from "./app";
import { gotoApp, appMenuButton, expect } from "./app";

// Headless Chromium reports a Linux platform, so the app uses the
// Ctrl+Shift+... bindings.

const palette = (page: import("@playwright/test").Page) =>
  page.getByPlaceholder("Type a command or search sessions...");

test("Ctrl+Shift+P toggles the command palette", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
});

test("Ctrl+Comma opens settings", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Comma");
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
});

test("Ctrl+Shift+M toggles the app menu", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+M");
  await expect(page.getByText("Profiles", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Profiles", { exact: true })).toBeHidden();
});

test("Ctrl+Shift+N opens the new-session dialog", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+N");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("? opens the keyboard shortcuts panel", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Shift+Slash"); // "?"
  await expect(page.getByText("Command palette")).toBeVisible();
});

test("app-menu button opens the menu and lists Default", async ({ page }) => {
  await gotoApp(page);
  await appMenuButton(page).click();
  await expect(page.getByRole("menuitem", { name: "Default", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /New profile/ })).toBeVisible();
});
