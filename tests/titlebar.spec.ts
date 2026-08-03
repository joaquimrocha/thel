import { test } from "./app";
import { gotoApp, appMenuButton, expect } from "./app";
import type { Page } from "@playwright/test";

/** The OS window title, as recorded by the mocked window plugin. */
const windowTitle = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __MOCK__: Record<string, unknown> }).__MOCK__
        .windowTitle as string | undefined,
  );

test("title bar has the window controls", async ({ page }) => {
  await gotoApp(page);
  for (const name of ["Minimize", "Maximize", "Close"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
});

test("app-menu button has a tooltip with its shortcut", async ({ page }) => {
  await gotoApp(page);
  await appMenuButton(page).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("App menu");
  await expect(tip).toContainText("Ctrl+Shift+M");
});

test("title bar hides the name for the lone, unnamed default", async ({
  page,
}) => {
  await gotoApp(page);
  await expect(appMenuButton(page)).not.toContainText("Default");
});

test("title bar shows the default's name once it's renamed", async ({
  page,
}) => {
  // Seed a custom name for the default profile before the app loads.
  await page.addInitScript(() => {
    localStorage.setItem(
      "__store__thel-profiles.json",
      JSON.stringify({ profiles: [{ id: "default", name: "Home" }] }),
    );
  });
  await gotoApp(page);
  await expect(appMenuButton(page)).toContainText("Home");
});

// Switching to the OS window decorations drops thel's title bar, which used to
// take the app menu (and with it the only button into Settings) along with it.
test("system decorations keep the app menu in the sidebar", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("thel.customTitlebar", "0");
    localStorage.setItem(
      "__store__thel-profiles.json",
      JSON.stringify({ profiles: [{ id: "default", name: "Home" }] }),
    );
  });
  await gotoApp(page);

  // No custom title bar, but the menu is still there and still opens Settings.
  await expect(page.locator("[data-tauri-drag-region]")).toHaveCount(0);
  await appMenuButton(page).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

// The sidebar header is three controls wide, so the name goes to the OS title
// bar rather than squeezing in between them.
test("system decorations: name in the window title, not the sidebar", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("thel.customTitlebar", "0");
    localStorage.setItem(
      "__store__thel-profiles.json",
      JSON.stringify({ profiles: [{ id: "default", name: "Home" }] }),
    );
  });
  await gotoApp(page);

  await expect(appMenuButton(page)).not.toContainText("Home");
  await expect.poll(() => windowTitle(page)).toContain("Home");
});

test("a profile window shows its name and a tinted title bar", async ({
  page,
}) => {
  // Seed the registry before the app loads, and report this window's label as
  // that profile's window.
  await page.addInitScript(() => {
    localStorage.setItem(
      "__store__thel-profiles.json",
      JSON.stringify({
        profiles: [{ id: "w1", name: "Work", color: "#ef4444" }],
      }),
    );
  });
  await gotoApp(page, { label: "profile-w1" });
  await expect(appMenuButton(page)).toContainText("Work");
  const bar = page.locator("[data-tauri-drag-region]").first();
  await expect(bar).toHaveCSS("border-bottom-color", "rgb(239, 68, 68)");
});
