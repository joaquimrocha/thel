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

test("the shortcuts panel filters by action and by key combo", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Shift+Slash");
  const panel = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const search = panel.getByRole("textbox", { name: "Search shortcuts" });
  const palette = panel.getByText("Command palette", { exact: true });
  const settings = panel.getByText("Settings", { exact: true });
  await expect(settings).toBeVisible();

  await search.fill("palette");
  await expect(palette).toBeVisible();
  await expect(settings).toBeHidden();
  // Nothing in the fixed list matches, so its heading goes too.
  await expect(panel.getByText("Fixed")).toBeHidden();

  // A rendered key combo matches as typed.
  const combo = await palette.locator("..").getByRole("button").last().innerText();
  await search.fill(combo);
  await expect(palette).toBeVisible();
  await expect(settings).toBeHidden();

  await search.fill("");
  await expect(settings).toBeVisible();
  await expect(panel.getByText("Fixed")).toBeVisible();
});

test("app-menu button opens the menu and lists Default", async ({ page }) => {
  await gotoApp(page);
  await appMenuButton(page).click();
  await expect(page.getByRole("menuitem", { name: "Default", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /New profile/ })).toBeVisible();
});
