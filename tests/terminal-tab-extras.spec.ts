import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

// Things that hang off a terminal's tab rather than its screen.

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

test("a tab can be muted and unmuted from its own bell button", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const tab = page.getByTestId("terminal-tab").first();

  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mute notifications" }).click();

  const unmute = page.getByRole("button", { name: "Unmute notifications" });
  await expect(unmute).toBeVisible();
  await unmute.click();
  await expect(unmute).toBeHidden();
});
