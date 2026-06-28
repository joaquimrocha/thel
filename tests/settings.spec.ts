import { test } from "./app";
import { gotoApp, expect } from "./app";

async function openSettings(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Comma");
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
}

test("settings shows every tab", async ({ page }) => {
  await gotoApp(page);
  await openSettings(page);
  for (const name of [
    "Appearance",
    "Terminal",
    "Sessions",
    "Profiles",
    "Launchers",
    "Keyboard",
  ]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }
});

test("appearance tab has theme and title-bar options", async ({ page }) => {
  await gotoApp(page);
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Light" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dark" })).toBeVisible();
  await expect(page.getByText("Use the app's own title bar")).toBeVisible();
});

test("copy-toast toggle persists across reload", async ({ page }) => {
  await gotoApp(page);
  await openSettings(page);
  await page.getByRole("tab", { name: "Terminal" }).click();
  const toggle = page.getByRole("switch");
  await expect(toggle).toBeChecked(); // default on
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  await page.reload();
  await openSettings(page);
  await page.getByRole("tab", { name: "Terminal" }).click();
  await expect(page.getByRole("switch")).not.toBeChecked();
});

test("sessions tab shows the daemon option on Linux", async ({ page }) => {
  await gotoApp(page);
  await openSettings(page);
  await page.getByRole("tab", { name: "Sessions" }).click();
  await expect(
    page.getByText("Keep sessions running in the background"),
  ).toBeVisible();
});

test("auto-start option appears when the daemon is off", async ({ page }) => {
  await gotoApp(page);
  await openSettings(page);
  await page.getByRole("tab", { name: "Sessions" }).click();
  // The daemon is on by default; auto-start only applies without it.
  await expect(page.getByText("Start terminals automatically")).toBeHidden();
  await page.getByText("Keep sessions running in the background").click();
  await expect(page.getByText("Start terminals automatically")).toBeVisible();
});

test("the sidebar Sessions button opens settings on the Sessions tab", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole("button", { name: "Sessions settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Sessions", selected: true }),
  ).toBeVisible();
});
