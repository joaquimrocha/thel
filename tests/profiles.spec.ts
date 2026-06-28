import { test } from "./app";
import { gotoApp, appMenuButton, expect } from "./app";
import type { Page } from "@playwright/test";

const nameInput = (page: Page) => page.getByPlaceholder("Work, Experiments…");

async function openProfilesTab(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.getByRole("tab", { name: "Profiles" }).click();
}
const row = (page: Page, name: string) =>
  page.getByTestId("profile-row").filter({ hasText: name });

test("create a profile from the app menu, then it's listed", async ({ page }) => {
  await gotoApp(page);
  await appMenuButton(page).click();
  await page.getByRole("menuitem", { name: /New profile/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await nameInput(page).fill("Work");
  await page.getByRole("button", { name: "Create profile" }).click();

  await appMenuButton(page).click();
  await expect(
    page.getByRole("menuitem", { name: "Work", exact: true }),
  ).toBeVisible();
});

test("new profile dialog has color picker and copy option", async ({ page }) => {
  await gotoApp(page);
  await appMenuButton(page).click();
  await page.getByRole("menuitem", { name: /New profile/ }).click();
  await expect(page.getByText("Accent color")).toBeVisible();
  await expect(
    page.getByText("Start with a copy of this window's sessions"),
  ).toBeVisible();
});

test("rejects a duplicate profile name", async ({ page }) => {
  await gotoApp(page);
  await appMenuButton(page).click();
  await page.getByRole("menuitem", { name: /New profile/ }).click();
  await nameInput(page).fill("Default");
  await expect(page.getByText(/already exists/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create profile" }),
  ).toBeDisabled();
});

test("creating a profile that copies sessions writes its layout", async ({
  page,
}) => {
  await gotoApp(page);
  // A session to copy.
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);

  await appMenuButton(page).click();
  await page.getByRole("menuitem", { name: /New profile/ }).click();
  await nameInput(page).fill("Forked");
  await page.getByRole("checkbox").click(); // "copy this window's sessions"
  await page.getByRole("button", { name: "Create profile" }).click();

  // The new profile's own layout file got a (freshly-id'd) session.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const reg = JSON.parse(
          localStorage.getItem("__store__thel-profiles.json") || "{}",
        );
        const p = (reg.profiles || []).find(
          (x: { name: string }) => x.name === "Forked",
        );
        if (!p) return 0;
        const layout = JSON.parse(
          localStorage.getItem("__store__thel-layout-" + p.id + ".json") || "{}",
        );
        return layout.layout?.sessions?.length ?? 0;
      }),
    )
    .toBeGreaterThan(0);
});

test("profiles tab: default row's delete is disabled but edit is not", async ({
  page,
}) => {
  await gotoApp(page);
  await openProfilesTab(page);
  const def = row(page, "Default");
  await expect(def.getByRole("button", { name: "Edit profile" })).toBeEnabled();
  await expect(
    def.getByRole("button", { name: "Delete profile" }),
  ).toBeDisabled();
});

test("profiles tab: create, edit (rename), and delete a profile", async ({
  page,
}) => {
  await gotoApp(page);
  await openProfilesTab(page);

  // Create
  await page.getByRole("button", { name: /New profile/ }).click();
  await nameInput(page).fill("Scratch");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(row(page, "Scratch")).toBeVisible();

  // Edit -> rename
  await row(page, "Scratch").getByRole("button", { name: "Edit profile" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await nameInput(page).fill("Renamed");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "Renamed")).toBeVisible();
  await expect(row(page, "Scratch")).toHaveCount(0);

  // Delete
  await row(page, "Renamed")
    .getByRole("button", { name: "Delete profile" })
    .click();
  await expect(row(page, "Renamed")).toHaveCount(0);
});

test("the app menu's Settings opens the settings dialog", async ({ page }) => {
  await gotoApp(page);
  await appMenuButton(page).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("the app menu's Manage profiles opens settings on the Profiles tab", async ({
  page,
}) => {
  await gotoApp(page);
  await appMenuButton(page).click();
  await page.getByRole("menuitem", { name: "Manage profiles" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Profiles", selected: true }),
  ).toBeVisible();
});

test("the default profile can be edited and the rename persists", async ({
  page,
}) => {
  await gotoApp(page);
  await openProfilesTab(page);
  await row(page, "Default")
    .getByRole("button", { name: "Edit profile" })
    .click();
  await expect(page.getByRole("dialog", { name: "Edit profile" })).toBeVisible();
  await nameInput(page).fill("Home base");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "Home base")).toHaveCount(1);

  await page.waitForTimeout(700); // let the debounced save flush
  await page.reload();
  await openProfilesTab(page);
  await expect(row(page, "Home base")).toHaveCount(1);
});

test("saving the default with a blank name reverts it to Default", async ({
  page,
}) => {
  await gotoApp(page);
  await openProfilesTab(page);
  // Give it a custom name first.
  await row(page, "Default")
    .getByRole("button", { name: "Edit profile" })
    .click();
  await nameInput(page).fill("Custom");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "Custom")).toHaveCount(1);

  // Clearing the name and saving brings "Default" back.
  await row(page, "Custom")
    .getByRole("button", { name: "Edit profile" })
    .click();
  await nameInput(page).fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "Default")).toHaveCount(1);
  await expect(row(page, "Custom")).toHaveCount(0);
});

test("profiles tab scrolls when many profiles don't fit", async ({ page }) => {
  await page.addInitScript(() => {
    const profiles = Array.from({ length: 30 }, (_, i) => ({
      id: "p" + i,
      name: "Profile " + i,
    }));
    localStorage.setItem(
      "__store__thel-profiles.json",
      JSON.stringify({ profiles }),
    );
  });
  await gotoApp(page);
  await openProfilesTab(page);

  const area = page.getByTestId("settings-tab-content");
  // Content overflows its capped height (so it scrolls)...
  expect(await area.evaluate((e) => e.scrollHeight > e.clientHeight + 1)).toBe(
    true,
  );
  // ...while the area itself stays within the viewport.
  expect(await area.evaluate((e) => e.clientHeight <= window.innerHeight)).toBe(
    true,
  );
  // A row near the end is reachable by scrolling.
  const last = row(page, "Profile 29");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
});
