import { test } from "./app";
import { gotoApp, appMenuButton, expect } from "./app";
import type { Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.keyboard.press("Control+Comma");
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
}

test("theme toggle switches the dark class on <html>", async ({ page }) => {
  await gotoApp(page);
  await openSettings(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("disabling the custom title bar hides it", async ({ page }) => {
  await gotoApp(page);
  await expect(appMenuButton(page)).toBeVisible();
  await openSettings(page);
  // The Appearance tab's only switch is the title-bar one.
  await page.getByRole("switch").click();
  await expect(appMenuButton(page)).toBeHidden();
});

test("default zoom can be changed and reset", async ({ page }) => {
  await gotoApp(page);
  await openSettings(page);
  await page.getByRole("tab", { name: "Terminal" }).click();
  await expect(page.getByRole("button", { name: "Reset" })).toHaveCount(0);
  await page.getByRole("button", { name: "Increase default zoom" }).click();
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByRole("button", { name: "Reset" })).toHaveCount(0);
});

test("Ctrl+Shift+W closes the active terminal", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(1);
  await page.keyboard.press("Control+Shift+W");
  await expect(page.getByText("No terminals in this pane.")).toBeVisible();
});

test("Ctrl+Shift+O opens the notifications panel", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+O");
  await expect(page.getByText("No notifications.")).toBeVisible();
});
