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

async function renameActiveSession(page: Page, name: string) {
  await page
    .locator('[data-session-list] [title="Double-click for session settings"]')
    .first()
    .dblclick();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").first().fill(name);
  await dialog.getByRole("button", { name: "Done" }).click();
}

test("Ctrl+Shift+E focuses the session list; x closes the highlighted one", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page);
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(2);

  await page.keyboard.press("Control+Shift+E");
  const focused = await page.evaluate(
    () => document.activeElement?.hasAttribute("data-session-list") ?? false,
  );
  expect(focused).toBe(true);

  await page.keyboard.press("x");
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);
});

test("palette can search and switch sessions", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await renameActiveSession(page, "Alpha");
  await createSession(page);

  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByText("Switch to session")).toBeVisible();
  await page
    .getByPlaceholder("Type a command or search sessions...")
    .fill("Alpha");
  const item = page.getByRole("option", { name: "Alpha" });
  await expect(item).toBeVisible();
  await item.click();
  // Selecting closes the palette.
  await expect(
    page.getByPlaceholder("Type a command or search sessions..."),
  ).toBeHidden();
});
