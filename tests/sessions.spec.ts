import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled(); // home dir resolves and gets selected
  await create.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
}

test("create a session: sidebar entry and terminal controls appear", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);
  // One terminal opened in the new session (its tab carries a close button).
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(1);
});

test("closing a session returns to the empty state", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.getByRole("button", { name: "Close session" }).click();
  // Closing a session always confirms now; accept in the dialog.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close session" })
    .click();
  await expect(page.getByText("No sessions open.")).toBeVisible();
});

test("Ctrl+Shift+T adds a terminal to the pane", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(1);
  await page.keyboard.press("Control+Shift+T");
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(2);
});

test("Ctrl+Shift+D splits into a second pane", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(page.locator("[data-pane-group]")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+D");
  await expect(page.locator("[data-pane-group]")).toHaveCount(2);
});

test("closing a pane's terminals collapses the split", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(page.locator("[data-pane-group]")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+D"); // split right
  await expect(page.locator("[data-pane-group]")).toHaveCount(2);
  await page.keyboard.press("Control+Alt+KeyW"); // close all terminals in pane
  await page.getByRole("button", { name: "Close all" }).click();
  await expect(page.locator("[data-pane-group]")).toHaveCount(1);
});

test("palette lists launcher-in-session only when a session exists", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByText("in current session")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await createSession(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByText("in current session").first()).toBeVisible();
});

test("created session is restored after reload", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);

  // Persistence is debounced (~400ms); let it flush before reloading.
  await page.waitForTimeout(700);
  await page.reload();
  // The session persists; with no live backend session it comes back idle (Start).
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);
});
