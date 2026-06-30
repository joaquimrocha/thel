import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

// Report a terminal's process exit over its mounted channel.
const exitTerminal = (page: Page, id: string, code: number | null) =>
  page.evaluate(
    ([terminalId, c]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __exitTerminalById: (id: string, c: number | null) => void;
          };
        }
      ).__TAURI_INTERNALS__.__exitTerminalById(
        terminalId as string,
        c as number | null,
      ),
    [id, code] as const,
  );

test("a clean process exit (code 0) closes the terminal tab", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T"); // a second terminal
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(2);

  const activeId = await tabs.nth(1).getAttribute("data-tab-id");
  await exitTerminal(page, activeId!, 0);
  await expect(tabs).toHaveCount(1);
});

test("a non-zero (error) exit also closes the tab", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T");
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(2);

  const activeId = await tabs.nth(1).getAttribute("data-tab-id");
  await exitTerminal(page, activeId!, 3); // the program crashed
  await expect(tabs).toHaveCount(1);
});

test("a daemon terminal exit closes the tab", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(1);

  const activeId = await tabs.first().getAttribute("data-tab-id");
  await exitTerminal(page, activeId!, 0);
  await expect(tabs).toHaveCount(0);
});
