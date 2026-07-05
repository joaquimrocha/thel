import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function openLaunchers(page: Page) {
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("Launchers…").click();
  await expect(page.getByText(/A launcher opens a terminal/)).toBeVisible();
}

// Create a launcher through the Create Launcher dialog.
async function createLauncher(page: Page, name: string, command?: string) {
  await page.getByRole("button", { name: "Create launcher…" }).click();
  await page.getByPlaceholder("e.g. Claude").fill(name);
  if (command) await page.getByPlaceholder(/empty = shell/).fill(command);
  await page.getByRole("button", { name: "Create", exact: true }).click();
}

// One "Delete launcher" button per row, so its count is the launcher count.
const launcherCount = (page: Page) =>
  page.getByRole("button", { name: "Delete launcher" });

test("starts with no launchers", async ({ page }) => {
  await gotoApp(page);
  await openLaunchers(page);
  await expect(launcherCount(page)).toHaveCount(0);
});

test("create and delete a launcher", async ({ page }) => {
  await gotoApp(page);
  await openLaunchers(page);
  await createLauncher(page, "Claude");
  await expect(launcherCount(page)).toHaveCount(1);
  await expect(page.getByText("Claude")).toBeVisible();

  await launcherCount(page).click();
  await expect(launcherCount(page)).toHaveCount(0);
});

test("edit a launcher name and it persists across reload", async ({ page }) => {
  await gotoApp(page);
  await openLaunchers(page);
  await createLauncher(page, "Claude");

  // Reopen it in the edit dialog and rename.
  await page.getByRole("button", { name: "Claude" }).click();
  await page.getByPlaceholder("e.g. Claude").fill("Claude 2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Claude 2")).toBeVisible();

  await page.waitForTimeout(500); // persistence is debounced ~300ms
  await page.reload();
  await openLaunchers(page);
  await expect(page.getByText("Claude 2")).toBeVisible();
});

test("rejects a duplicate launcher name", async ({ page }) => {
  await gotoApp(page);
  await openLaunchers(page);
  await createLauncher(page, "Claude");

  await page.getByRole("button", { name: "Create launcher…" }).click();
  await page.getByPlaceholder("e.g. Claude").fill("Claude");
  await expect(page.getByText(/name already exists/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
});

test("starring sets the default, clicking it again unsets it", async ({
  page,
}) => {
  await gotoApp(page);
  await openLaunchers(page);
  await createLauncher(page, "Claude");

  // No default until starred.
  await expect(
    page.getByRole("button", { name: "Default launcher" }),
  ).toHaveCount(0);
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

test("default launcher drives the New-session terminal title", async ({
  page,
}) => {
  await gotoApp(page);
  await openLaunchers(page);
  await createLauncher(page, "Claude");
  await page.getByRole("button", { name: "Set as default" }).click();
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
