import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

test("primary controls expose accessible names", async ({ page }) => {
  await gotoApp(page);
  for (const name of [
    "App menu",
    "Notifications",
    "New session",
    "Sessions settings",
  ]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
});

test("Escape closes a dialog", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Comma");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a settings switch toggles with the keyboard", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Comma");
  await page.getByRole("tab", { name: "Terminal" }).click();
  const toggle = page.getByRole("switch");
  await expect(toggle).toBeChecked(); // copy-toast defaults on
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
});

test("settings tabs move with arrow keys", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Comma");
  const appearance = page.getByRole("tab", { name: "Appearance" });
  await appearance.click();
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("the app menu is an arrow-navigable ARIA menu", async ({ page }) => {
  await gotoApp(page);
  const trigger = page.getByRole("button", { name: "App menu" });
  await trigger.click();
  await expect(page.getByRole("menu", { name: "App menu" })).toBeVisible();

  // Home/End and arrows move focus between menu items (with wraparound).
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitem", { name: "Settings", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown"); // wraps to the first item
  await expect(
    page.getByRole("menuitem", { name: "Manage profiles" }),
  ).toBeFocused();

  // Escape closes the menu and returns focus to the trigger.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "App menu" })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the session list is keyboard navigable", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page); // second is active (last row)

  const rows = page.locator("[data-session-list] > div");
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toHaveClass(/text-secondary-foreground/);

  await page.locator("[data-session-list]").focus();
  await page.keyboard.press("ArrowUp"); // highlight the first row
  await page.keyboard.press("Enter"); // activate it
  await expect(rows.first()).toHaveClass(/text-secondary-foreground/);
});
