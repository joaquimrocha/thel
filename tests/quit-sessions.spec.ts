import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

type QuitMock = { killed?: string[]; destroyed?: boolean };
type CloseHooks = {
  __closeRequestedReady: () => boolean;
  __fireCloseRequested: () => Promise<boolean>;
};

// Preseed the setting, which prefs reads at module load. "1"/"0" are the values
// the setting has stored since it was a plain on/off switch, so seeding them
// here is also the check that an existing config still decides.
const STORED = { keep: "1", stop: "0", ask: "ask" };

async function seedOnClose(page: Page, mode: keyof typeof STORED) {
  await page.addInitScript((v) => {
    localStorage.setItem("thel.useDaemon", v as string);
  }, STORED[mode]);
}

// Creates a session and returns the id of the terminal that came with it, so a
// test can name what it expects to be killed rather than counting.
async function createSession(page: Page): Promise<string> {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
  const pane = page.locator("[data-terminal-pane]").first();
  await expect(pane).toBeVisible();
  const id = await pane.getAttribute("data-terminal-pane");
  expect(id).toBeTruthy();
  return id ?? "";
}

async function closeRequestedReady(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __TAURI_INTERNALS__: CloseHooks }
        ).__TAURI_INTERNALS__.__closeRequestedReady(),
      ),
    )
    .toBe(true);
}

// Fire the OS close flow the way the X button does. The returned promise only
// settles once the handler does, which with "ask each time" means once the user
// has answered, so a test can click the dialog while this is in flight.
function fireClose(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const w = window as unknown as { __TAURI_INTERNALS__: CloseHooks };
    await w.__TAURI_INTERNALS__.__fireCloseRequested();
  });
}

function outcome(page: Page): Promise<QuitMock> {
  return page.evaluate(
    () => (window as unknown as { __MOCK__: QuitMock }).__MOCK__,
  );
}

async function closeAndCollect(page: Page): Promise<QuitMock> {
  await closeRequestedReady(page);
  await fireClose(page);
  return outcome(page);
}

test("stop: closing the window kills its terminals", async ({ page }) => {
  await seedOnClose(page, "stop");
  await gotoApp(page);
  const id = await createSession(page);

  const state = await closeAndCollect(page);
  expect(state.killed).toEqual([id]);
  expect(state.destroyed).toBe(true);
});

test("keep: closing the window leaves them running", async ({ page }) => {
  await seedOnClose(page, "keep");
  await gotoApp(page);
  await createSession(page);

  const state = await closeAndCollect(page);
  expect(state.killed ?? []).toEqual([]);
  expect(state.destroyed).toBe(true);
});

test.describe("ask each time", () => {
  const dialog = (page: Page) =>
    page.getByText("Keep these terminals running?");

  test("keeping closes the window and leaves them running", async ({ page }) => {
    await seedOnClose(page, "ask");
    await gotoApp(page);
    await createSession(page);
    await closeRequestedReady(page);

    const closing = fireClose(page);
    await expect(dialog(page)).toBeVisible();
    await page.getByRole("button", { name: "Keep running" }).click();
    await closing;

    const state = await outcome(page);
    expect(state.killed ?? []).toEqual([]);
    expect(state.destroyed).toBe(true);
  });

  test("stopping kills them, then closes", async ({ page }) => {
    await seedOnClose(page, "ask");
    await gotoApp(page);
    const id = await createSession(page);
    await closeRequestedReady(page);

    const closing = fireClose(page);
    await expect(dialog(page)).toBeVisible();
    await page.getByRole("button", { name: "Stop them" }).click();
    await closing;

    const state = await outcome(page);
    expect(state.killed).toEqual([id]);
    expect(state.destroyed).toBe(true);
  });

  // The point of asking: you can still say no. Nothing is killed before the
  // answer, so cancelling has to leave the window exactly as it was.
  test("cancelling keeps the window open and kills nothing", async ({ page }) => {
    await seedOnClose(page, "ask");
    await gotoApp(page);
    await createSession(page);
    await closeRequestedReady(page);

    const closing = fireClose(page);
    await expect(dialog(page)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await closing;

    const state = await outcome(page);
    expect(state.killed ?? []).toEqual([]);
    expect(state.destroyed).toBeFalsy();
    await expect(dialog(page)).toBeHidden();
  });

  // Asking about nothing is just a nag: an empty window closes straight away.
  test("no live terminals means no question", async ({ page }) => {
    await seedOnClose(page, "ask");
    await gotoApp(page);

    const state = await closeAndCollect(page);
    expect(state.destroyed).toBe(true);
    await expect(dialog(page)).toBeHidden();
  });
});
