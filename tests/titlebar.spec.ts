import { test } from "./app";
import { gotoApp, appMenuButton, expect } from "./app";

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
