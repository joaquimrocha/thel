import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

const PROFILES = [
  { id: "default", name: "Default" },
  { id: "w1", name: "Work" },
];

/** Seed the profile registry and the list of windows open at the last quit. */
async function seed(page: Page, open: string[], profiles = PROFILES) {
  await page.addInitScript(
    (d) =>
      localStorage.setItem("__store__thel-profiles.json", JSON.stringify(d)),
    { profiles, open },
  );
}

const openList = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("__store__thel-profiles.json") || "{}")
        .open as string[] | undefined,
  );

/** Run the OS close flow on this window, as the X button does. */
async function close(page: Page) {
  type Hooks = {
    __closeRequestedReady: () => boolean;
    __fireCloseRequested: () => Promise<boolean>;
  };
  const hooks = () =>
    page.evaluate(
      () =>
        (window as unknown as { __TAURI_INTERNALS__: Hooks })
          .__TAURI_INTERNALS__.__closeRequestedReady(),
    );
  await expect.poll(hooks).toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as { __TAURI_INTERNALS__: Hooks }
    ).__TAURI_INTERNALS__.__fireCloseRequested(),
  );
}

const destroyed = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __MOCK__: { destroyed?: boolean } }).__MOCK__
        .destroyed === true,
  );

const created = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { __createdWindows: () => string[] };
        }
      ).__TAURI_INTERNALS__.__createdWindows(),
  );

test("the profile windows open at the last quit are reopened", async ({
  page,
}) => {
  await seed(page, ["default", "w1"]);
  await gotoApp(page);
  await expect.poll(() => created(page)).toContain("profile-w1");
});

test("a profile deleted since the last quit is not reopened", async ({
  page,
}) => {
  await seed(page, ["default", "gone"]);
  await gotoApp(page);
  // The stale entry is pruned, so it can't linger and be retried every launch.
  await expect.poll(() => openList(page)).toEqual(["default"]);
  expect(await created(page)).toEqual([]);
});

test("the main window steps aside when the default profile wasn't open", async ({
  page,
}) => {
  // A layout for the default profile, which must stay untouched: this window is
  // only here to reopen Work, so spawning the default's shells would resurrect
  // a profile the last quit didn't leave open.
  await page.addInitScript(() =>
    localStorage.setItem(
      "__store__thel-layout.json",
      JSON.stringify({
        layout: {
          activeSessionId: "s0",
          sessions: [
            {
              id: "s0",
              name: "alpha",
              cwd: "/home/test/alpha",
              groups: [
                {
                  id: "g0",
                  activeTerminalId: "t0",
                  terminals: [{ id: "t0", title: "shell", command: "bash", args: [] }],
                },
              ],
              layout: { t: "leaf", group: "g0" },
              activeGroupId: "g0",
            },
          ],
        },
      }),
    ),
  );
  await seed(page, ["w1"]);
  await gotoApp(page);

  await expect.poll(() => created(page)).toEqual(["profile-w1"]);
  await expect.poll(() => destroyed(page)).toBe(true);
  // The list still describes what the next launch should open, main excluded.
  expect(await openList(page)).toEqual(["w1"]);
  const spawns = await page.evaluate(
    () => (window as unknown as { __MOCK__: { spawns?: object } }).__MOCK__.spawns,
  );
  expect(spawns).toBeUndefined();
});

test("the main window stays when it has nothing to hand over to", async ({
  page,
}) => {
  // The one profile in the list is gone, so stepping aside would leave no window
  // at all and no way back into the app.
  await seed(page, ["gone"]);
  await gotoApp(page);
  await expect.poll(() => openList(page)).toEqual(["default"]);
  expect(await destroyed(page)).toBeFalsy();
});

test("closing a profile window while another is open forgets it", async ({
  page,
}) => {
  await seed(page, ["default", "w1"]);
  await gotoApp(page, { label: "profile-w1" });
  await close(page);
  await expect.poll(() => openList(page)).toEqual(["default"]);
});

test("closing the last window keeps it for the next launch", async ({
  page,
}) => {
  // The main window is already gone; closing this one quits the app, so its
  // profile has to survive or the next launch would open the main window alone.
  await seed(page, ["w1"]);
  await gotoApp(page, { label: "profile-w1" });
  await close(page);
  await expect.poll(() => openList(page)).toEqual(["w1"]);
});
