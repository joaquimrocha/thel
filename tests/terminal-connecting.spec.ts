import { test, gotoApp, expect } from "./app";

test("a terminal shows Connecting until the daemon attaches it", async ({ page }) => {
  await gotoApp(page, { createSessionDelayMs: 1500 });
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();

  const connecting = page.getByText("Connecting...");
  await expect(connecting).toBeVisible();
  await expect(connecting).toBeHidden();
  await expect(page.locator(".xterm").first()).toBeVisible();
});
