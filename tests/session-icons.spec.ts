import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

// A minimal valid SVG used as a session icon.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor"><path d="M5 12h14"/></svg>';

function seedSession(extra: Record<string, unknown> = {}) {
  return {
    activeSessionId: "s0",
    sessions: [
      {
        id: "s0",
        name: "alpha",
        cwd: "/home/test/alpha",
        groups: [
          {
            id: "g0",
            activeTerminalId: "t0",
            terminals: [{ id: "t0", title: "shell", command: "bash", args: [] }],
          },
        ],
        layout: { t: "leaf", group: "g0" },
        activeGroupId: "g0",
        ...extra,
      },
    ],
  };
}

async function open(page: Page, layout: ReturnType<typeof seedSession>) {
  await page.addInitScript((l) => {
    // Seed once: reloads must keep what the app persisted, not re-seed over it.
    const key = "__store__thel-layout.json";
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify({ layout: l }));
    }
  }, layout);
  await gotoApp(page);
}

const slot = (page: Page) => page.locator("[data-status-slot]").first();
const openSettings = (page: Page) =>
  page
    .getByRole("complementary")
    .getByRole("button", { name: "Session settings" })
    .click();
const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Session Settings" });

test("a session with an icon shows it instead of the status dot", async ({
  page,
}) => {
  await open(page, seedSession({ icon: SVG }));
  await expect(slot(page).locator("img")).toBeVisible();
});

test("a session without an icon shows the dot, not an image", async ({ page }) => {
  await open(page, seedSession());
  await expect(slot(page).locator("img")).toHaveCount(0);
});

const titlebar = (page: Page) => page.locator("[data-tauri-drag-region]").first();

test("the active session's icon shows in the title bar", async ({ page }) => {
  await open(page, seedSession({ icon: SVG }));
  await expect(titlebar(page).locator("img")).toBeVisible();
});

test("the title bar shows no icon image when the session has none", async ({
  page,
}) => {
  await open(page, seedSession());
  await expect(titlebar(page).locator("img")).toHaveCount(0);
});

test("the settings dialog shows the default icon library", async ({ page }) => {
  await open(page, seedSession());
  await openSettings(page);
  // Six Lucide defaults, selectable from the grid.
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Use icon" }),
  ).toHaveCount(6);
});

test("choosing a library icon sets it, and it persists", async ({ page }) => {
  await open(page, seedSession());
  await expect(slot(page).locator("img")).toHaveCount(0);

  await openSettings(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Use icon" })
    .first()
    .click();
  await expect(slot(page).locator("img")).toBeVisible();

  await page.waitForTimeout(700); // debounced layout writer (~400ms)
  await page.reload();
  await expect(slot(page).locator("img")).toBeVisible();
});

test("the + button adds an SVG to the library via its own dialog", async ({
  page,
}) => {
  await open(page, seedSession());
  await openSettings(page);
  const settings = settingsDialog(page);
  await expect(settings.getByRole("button", { name: "Use icon" })).toHaveCount(6);

  await settings.getByRole("button", { name: "Add icon" }).click();
  const add = page.getByRole("dialog", { name: "Add icon" });
  await add.getByPlaceholder(/paste SVG markup/i).fill(SVG);
  await add.getByRole("button", { name: "Add to library" }).click();

  // Back in settings, the library grew to 7 (adding doesn't auto-select).
  await expect(settings.getByRole("button", { name: "Use icon" })).toHaveCount(7);
});

test("pasting non-SVG content is rejected", async ({ page }) => {
  await open(page, seedSession());
  await openSettings(page);
  await settingsDialog(page).getByRole("button", { name: "Add icon" }).click();
  const add = page.getByRole("dialog", { name: "Add icon" });
  await add.getByPlaceholder(/paste SVG markup/i).fill("not an svg");
  await add.getByRole("button", { name: "Add to library" }).click();
  await expect(add.getByText(/doesn't look like SVG/i)).toBeVisible();
});

test("user-added icons can be deleted; defaults cannot", async ({ page }) => {
  await open(page, seedSession());
  await openSettings(page);
  const settings = settingsDialog(page);
  // The six defaults have no delete affordance.
  await expect(settings.getByRole("button", { name: "Delete icon" })).toHaveCount(0);

  await settings.getByRole("button", { name: "Add icon" }).click();
  const add = page.getByRole("dialog", { name: "Add icon" });
  await add.getByPlaceholder(/paste SVG markup/i).fill(SVG);
  await add.getByRole("button", { name: "Add to library" }).click();
  await expect(settings.getByRole("button", { name: "Use icon" })).toHaveCount(7);

  // The added icon has a delete button; removing it returns to six.
  await settings.getByRole("button", { name: "Delete icon" }).click();
  await expect(settings.getByRole("button", { name: "Use icon" })).toHaveCount(6);
});

test("the add-icon dialog is independent of the edited session", async ({
  page,
}) => {
  await open(page, seedSession());
  await openSettings(page);
  await settingsDialog(page).getByRole("button", { name: "Add icon" }).click();
  const add = page.getByRole("dialog", { name: "Add icon" });
  // It's a library-wide dialog: no session name field, just the SVG input.
  await expect(add.getByText("alpha")).toHaveCount(0);
  await expect(add.getByPlaceholder(/paste SVG markup/i)).toBeVisible();
});

test("the icon library persists added icons across reload", async ({ page }) => {
  await open(page, seedSession());
  await openSettings(page);
  await settingsDialog(page).getByRole("button", { name: "Add icon" }).click();
  let add = page.getByRole("dialog", { name: "Add icon" });
  await add.getByPlaceholder(/paste SVG markup/i).fill(SVG);
  await add.getByRole("button", { name: "Add to library" }).click();
  await expect(settingsDialog(page).getByRole("button", { name: "Use icon" })).toHaveCount(7);

  await page.reload();
  await openSettings(page);
  await expect(settingsDialog(page).getByRole("button", { name: "Use icon" })).toHaveCount(7);
  // Sanity: the dialog still works after reload.
  await settingsDialog(page).getByRole("button", { name: "Add icon" }).click();
  add = page.getByRole("dialog", { name: "Add icon" });
  await expect(add.getByPlaceholder(/paste SVG markup/i)).toBeVisible();
});

test("removing the icon brings the dot back", async ({ page }) => {
  await open(page, seedSession({ icon: SVG }));
  await expect(slot(page).locator("img")).toBeVisible();

  await openSettings(page);
  await page.getByRole("dialog").getByRole("button", { name: "Remove icon" }).click();
  await expect(slot(page).locator("img")).toHaveCount(0);
});
