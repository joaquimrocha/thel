import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

type QuitMock = { killed?: string[] };
type CloseHooks = {
  __closeRequestedReady: () => boolean;
  __fireCloseRequested: () => Promise<boolean>;
};

// Preseed the background-sessions preference, which prefs reads at module load.
async function seedKeepSessions(page: Page, keep: boolean) {
  await page.addInitScript((v) => {
    localStorage.setItem("thel.useDaemon", v as string);
  }, keep ? "1" : "0");
}

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
}

// Fire the OS close flow the way the X button does, then report what the close
// handler killed.
async function closeAndCollectKills(page: Page): Promise<string[]> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __TAURI_INTERNALS__: CloseHooks }
        ).__TAURI_INTERNALS__.__closeRequestedReady(),
      ),
    )
    .toBe(true);
  return page.evaluate(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: CloseHooks;
      __MOCK__: QuitMock;
    };
    await w.__TAURI_INTERNALS__.__fireCloseRequested();
    return w.__MOCK__.killed ?? [];
  });
}

test("background sessions off: closing the window kills its terminals", async ({
  page,
}) => {
  await seedKeepSessions(page, false);
  await gotoApp(page);
  await createSession(page);

  expect(await closeAndCollectKills(page)).toHaveLength(1);
});

test("background sessions on: closing the window leaves them running", async ({
  page,
}) => {
  await seedKeepSessions(page, true);
  await gotoApp(page);
  await createSession(page);

  expect(await closeAndCollectKills(page)).toHaveLength(0);
});
