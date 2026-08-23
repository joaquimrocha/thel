import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

// Things that hang off a terminal's tab rather than its screen.

const emitTerminal = (page: Page, id: string, data: string) =>
  page.evaluate(
    ([terminalId, d]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __emitTerminalById: (id: string, d: string) => boolean;
          };
        }
      ).__TAURI_INTERNALS__.__emitTerminalById(
        terminalId as string,
        d as string,
      ),
    [id, data] as const,
  );

const setBusy = (page: Page, id: string, busy: boolean) =>
  page.evaluate(
    ([terminalId, b]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __busyTerminalById: (id: string, busy: boolean) => boolean;
          };
        }
      ).__TAURI_INTERNALS__.__busyTerminalById(terminalId as string, b as boolean),
    [id, busy] as const,
  );

async function activeTerminalId(page: Page): Promise<string> {
  const id = await page
    .getByTestId("terminal-tab")
    .first()
    .getAttribute("data-tab-id");
  return id!;
}

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

test("an OSC 9;4 progress report draws a bar on the tab", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const id = await activeTerminalId(page);

  await emitTerminal(page, id, "\x1b]9;4;1;40\x07");
  await expect(page.getByTestId("tab-progress")).toHaveAttribute(
    "data-progress",
    "40",
  );

  await emitTerminal(page, id, "\x1b]9;4;0\x07");
  await expect(page.getByTestId("tab-progress")).toBeHidden();
});

test("a command that ends without clearing its progress loses the bar", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const id = await activeTerminalId(page);

  await setBusy(page, id, true);
  await emitTerminal(page, id, "\x1b]9;4;1;60\x07");
  await expect(page.getByTestId("tab-progress")).toBeVisible();

  // Killed mid-run: no 9;4;0 ever arrives, so going idle has to clear it.
  await setBusy(page, id, false);
  await expect(page.getByTestId("tab-progress")).toBeHidden();
});
