import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
  await page.waitForTimeout(700); // let the debounced layout save flush
}

test("a restored terminal auto-reattaches with the daemon", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.reload();
  // The daemon is the default backend, so restored terminals come back started
  // (open reattaches a live tab or respawns at its cwd), not behind a Start
  // button.
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
});

// Valid JSON but the wrong shape (a group's terminals isn't an array), so
// hydrateSessions throws mid-restore. Seeded before app code runs.
const CORRUPT_LAYOUT = {
  layout: {
    sessions: [{ id: "s1", name: "Broken", groups: [{ id: "g1", terminals: 5 }] }],
  },
};
const seedCorrupt = (page: Page) =>
  page.addInitScript((data) => {
    localStorage.setItem("__store__thel-layout.json", JSON.stringify(data));
  }, CORRUPT_LAYOUT);
const storeValue = (page: Page, file: string) =>
  page.evaluate((f) => localStorage.getItem(`__store__${f}`), file);

test("a corrupt saved layout warns and can be left untouched", async ({ page }) => {
  await seedCorrupt(page);
  await gotoApp(page);

  // The failure is surfaced, not swallowed.
  await expect(
    page.getByText("Couldn't restore your saved layout"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // Opening a session must not overwrite the unreadable file.
  await createSession(page);
  const parsed = JSON.parse((await storeValue(page, "thel-layout.json")) ?? "null");
  expect(parsed?.layout?.sessions?.[0]?.groups?.[0]?.terminals).toBe(5);
});

test("a corrupt saved layout can be set aside to start fresh", async ({ page }) => {
  await seedCorrupt(page);
  await gotoApp(page);

  await page.getByRole("button", { name: "Start fresh" }).click();

  // The unreadable layout is preserved in a sibling file for recovery.
  const backup = JSON.parse(
    (await storeValue(page, "thel-layout.corrupt.json")) ?? "null",
  );
  expect(backup?.layout?.sessions?.[0]?.groups?.[0]?.terminals).toBe(5);

  // Persistence resumed: a new session is now written to the live layout.
  await createSession(page);
  const live = JSON.parse((await storeValue(page, "thel-layout.json")) ?? "null");
  expect(live?.layout?.sessions?.length).toBe(1);
  expect(live?.layout?.sessions?.[0]?.groups?.[0]?.terminals).not.toBe(5);
});

test("Escape cancels an in-progress rename", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page
    .locator('[data-session-list] [title="Double-click to rename"]')
    .first()
    .dblclick();
  const input = page.locator("[data-session-list] input");
  await input.fill("Discarded");
  await input.press("Escape");
  await expect(page.locator("[data-session-list]")).not.toContainText(
    "Discarded",
  );
});
