import { test } from "./app";
import { gotoApp, appMenuButton, expect } from "./app";

test("app loads, shows the app menu and empty state", async ({ page }) => {
  await gotoApp(page);
  // The lone default profile shows just the logo (no name), so the menu button
  // is present but carries no profile name.
  await expect(appMenuButton(page)).toBeVisible();
  await expect(appMenuButton(page)).not.toContainText("Default");
  await expect(page.getByText("No sessions open.")).toBeVisible();
});
