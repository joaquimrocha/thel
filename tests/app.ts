import { type Page, expect } from "@playwright/test";
import { installTauriMock, type MockConfig } from "./tauri";
import { test } from "./coverage";

/** Install the Tauri mock, open the app, and wait for it to finish hydrating. */
export async function gotoApp(page: Page, config: MockConfig = {}) {
  await installTauriMock(page, config);
  await page.goto(config.spawned ? "/?spawned" : "/");
  // The app-menu (logo) title bar button is always present once the app has mounted.
  await expect(appMenuButton(page)).toBeVisible({ timeout: 15_000 });
}

/** The logo + profile button in the title bar (opens the app menu). */
export function appMenuButton(page: Page) {
  return page.getByTestId("app-menu");
}

/**
 * Creates a session in the home folder through the New Session dialog and
 * waits for its terminal. Returns that terminal's id.
 */
export async function createSession(page: Page): Promise<string> {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  const pane = page.locator("[data-terminal-pane]").first();
  await expect(pane.locator(".xterm")).toBeVisible();
  return (await pane.getAttribute("data-terminal-pane")) ?? "";
}

export { expect, test };
