import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

const screen = (page: Page) => page.getByTestId("initial-screen");
const sessionCli = (page: Page) =>
  page.evaluate(() => (window as never as { __MOCK__: { sessionCli?: boolean } }).__MOCK__.sessionCli);

test("the first run shows the initial screen once, with the thel session consent", async ({ page }) => {
  await gotoApp(page, { firstRun: true });
  await expect(screen(page)).toContainText("Welcome to thel");
  await screen(page).getByRole("button", { name: "Next" }).click();
  await expect(screen(page)).toContainText("Know what every terminal is doing");
  await screen(page).getByRole("button", { name: "Next" }).click();
  await expect(screen(page)).toContainText("Command palette");
  await screen(page).getByRole("button", { name: "Next" }).click();
  await expect(screen(page)).toContainText("Let agents drive thel");
  await expect.poll(() => sessionCli(page)).toBe(false);
  await screen(page).getByRole("switch", { name: /use thel session/ }).click();
  await expect.poll(() => sessionCli(page)).toBe(true);
  await screen(page).getByRole("button", { name: "Get started" }).click();
  await expect(screen(page)).toBeHidden();

  await page.reload();
  await expect(page.getByTestId("app-menu")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(screen(page)).toBeHidden();
});

test("an install that saved a layout before doesn't show it", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout: { sessions: [] } })),
  );
  await gotoApp(page, { firstRun: true });
  await page.waitForTimeout(500);
  await expect(screen(page)).toBeHidden();
});

test("Settings opens the initial screen on its first page", async ({ page }) => {
  await gotoApp(page);
  await expect(screen(page)).toBeHidden();
  await page.keyboard.press("Control+Comma");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "About" }).click();
  await settings.getByRole("button", { name: "Show initial screen" }).click();
  await expect(settings).toBeHidden();
  await expect(screen(page)).toContainText("Welcome to thel");
  await page.keyboard.press("Control+Comma");
  await expect(settings).toBeHidden();
  await screen(page).getByRole("button", { name: /Go to page 3/ }).click();
  await expect(screen(page)).toContainText("Keyboard first");
  await page.keyboard.press("Escape");
  await expect(screen(page)).toBeHidden();
});
