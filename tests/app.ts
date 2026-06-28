import { type Page, expect } from "@playwright/test";
import { installTauriMock, type MockConfig } from "./tauri";
import { test } from "./coverage";

/** Install the Tauri mock, open the app, and wait for it to finish hydrating. */
export async function gotoApp(page: Page, config: MockConfig = {}) {
  await installTauriMock(page, config);
  await page.goto("/");
  // The app-menu (logo) title bar button is always present once the app has mounted.
  await expect(appMenuButton(page)).toBeVisible({ timeout: 15_000 });
}

/** The logo + profile button in the title bar (opens the app menu). */
export function appMenuButton(page: Page) {
  return page.getByTestId("app-menu");
}

export { expect, test };
