import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function openLaunchers(page: Page) {
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("Launchers…").click();
  await expect(page.getByText(/A launcher opens a terminal/)).toBeVisible();
}

const names = (page: Page) => page.getByPlaceholder("Name");

test("starts with the default Terminal launcher", async ({ page }) => {
  await gotoApp(page);
  await openLaunchers(page);
  await expect(names(page)).toHaveCount(1);
  await expect(names(page).first()).toHaveValue("Terminal");
});

test("add and delete launchers", async ({ page }) => {
  await gotoApp(page);
  await openLaunchers(page);
  await page.getByRole("button", { name: "Add launcher" }).click();
  await expect(names(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Delete launcher" }).last().click();
  await expect(names(page)).toHaveCount(1);
});

test("rename a launcher and it persists across reload", async ({ page }) => {
  await gotoApp(page);
  await openLaunchers(page);
  await names(page).first().fill("Claude");
  await expect(names(page).first()).toHaveValue("Claude");

  await page.waitForTimeout(500); // persistence is debounced ~300ms
  await page.reload();
  await openLaunchers(page);
  await expect(names(page).first()).toHaveValue("Claude");
});

test("starring sets the default, clicking it again unsets it", async ({
  page,
}) => {
  await gotoApp(page);
  await openLaunchers(page);
  // The Terminal launcher starts as the default.
  await expect(
    page.getByRole("button", { name: "Default launcher" }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Add launcher" }).click();
  // Make the new one the default.
  await page.getByRole("button", { name: "Set as default" }).click();
  await expect(
    page.getByRole("button", { name: "Default launcher" }),
  ).toHaveCount(1);

  // Click the current default to unset it -> no default.
  await page.getByRole("button", { name: "Default launcher" }).click();
  await expect(
    page.getByRole("button", { name: "Default launcher" }),
  ).toHaveCount(0);
});

test("renamed default launcher drives the New-session terminal title", async ({
  page,
}) => {
  await gotoApp(page);
  await openLaunchers(page);
  await names(page).first().fill("Claude"); // the default launcher
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  // The opened terminal's tab uses the launcher name.
  await expect(
    page.locator('[title="Double-click to rename"]', { hasText: "Claude" }),
  ).toBeVisible();
});
