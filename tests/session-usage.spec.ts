import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

const rows = (page: Page) => page.locator("[data-session-list] [data-row-id]");

async function openUsage(page: Page, row: ReturnType<typeof rows>) {
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Resource usage" }).click();
}

test("resource panel reports the session it was opened for", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await openUsage(page, rows(page).first());
  await expect(panel).toBeVisible();
  // A rate needs two samples; the first render shows "--" until the second.
  await expect(panel.getByText("%", { exact: false }).first()).toBeVisible();
});

test("opening the panel selects the session it reports", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page);
  const [first, second] = [rows(page).nth(0), rows(page).nth(1)];

  // Sessions created this way share a name (both "~"), so identify the active
  // one by its row styling rather than by text.
  const activeRow = /text-secondary-foreground/;

  // Open it from the row that isn't active: the panel sits beside the session
  // it describes, so that session comes up with it.
  await second.click();
  await expect(second).toHaveClass(activeRow);
  await openUsage(page, first);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(first).toHaveClass(activeRow);
});

test("resource panel closes when another session becomes active", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page);
  const panel = page.getByRole("dialog");
  const [first, second] = [rows(page).nth(0), rows(page).nth(1)];

  await openUsage(page, first);
  await expect(panel).toBeVisible();

  // Re-selecting the panel's own session is not "navigating away".
  await first.click();
  await expect(panel).toBeVisible();

  // A different session leaves the panel stale, so it closes.
  await second.click();
  await expect(panel).toBeHidden();
});
