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

test("rename a session (double-click the name)", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page
    .locator('[data-session-list] [title="Double-click to rename"]')
    .dblclick();
  const input = page.locator("[data-session-list] input");
  await input.fill("MySession");
  await input.press("Enter");
  await expect(page.locator("[data-session-list]")).toContainText("MySession");
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
