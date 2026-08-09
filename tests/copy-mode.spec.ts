import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function sessionWithOutput(page: Page, text: string) {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.evaluate(
    (t) => (window as never as MockWindow).__TAURI_INTERNALS__.__emitTerminal(0, t),
    text,
  );
}

interface MockWindow {
  __TAURI_INTERNALS__: { __emitTerminal(index: number, data: string): void };
  __MOCK__: { clipboard?: string };
}

const clipboard = (page: Page) =>
  page.evaluate(() => (window as never as MockWindow).__MOCK__.clipboard);
const hint = (page: Page) => page.locator("[data-copy-mode]");

test("copy mode selects and copies a line with the keyboard", async ({ page }) => {
  // The mock prints "$ " when the session starts, so this lands on row 0.
  await sessionWithOutput(page, "hello world\r\n");

  await page.keyboard.press("Control+Shift+Space");
  await expect(hint(page)).toBeVisible();

  await page.keyboard.press("g"); // top of the buffer
  await page.keyboard.press("Space"); // set the anchor
  await page.keyboard.press("$"); // to the row's last non-blank column
  await page.keyboard.press("y"); // copy and leave

  await expect(hint(page)).toBeHidden();
  expect(await clipboard(page)).toBe("$ hello world");
});

test("copy mode swallows keys instead of typing them", async ({ page }) => {
  await sessionWithOutput(page, "hello\r\n");
  await page.keyboard.press("Control+Shift+Space");
  // 'j' is a motion here, not input; the shell line must not gain a character.
  await page.keyboard.press("j");
  await page.keyboard.press("Escape");
  await expect(hint(page)).toBeHidden();

  await page.keyboard.press("Control+Shift+Space");
  await page.keyboard.press("g");
  await page.keyboard.press("Space");
  await page.keyboard.press("$");
  await page.keyboard.press("Enter");
  expect(await clipboard(page)).toBe("$ hello");
});
