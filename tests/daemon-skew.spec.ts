import { test, gotoApp, expect } from "./app";

type SkewMock = { closed?: boolean; restartedDaemon?: boolean };

const mock = (page: Parameters<typeof gotoApp>[0]) =>
  page.evaluate(
    () => (window as unknown as { __MOCK__: SkewMock }).__MOCK__,
  );

// An incompatible daemon from a previous version holds the socket, so this build
// gets no terminals until the user chooses. "Close window" is the way out that
// leaves the old daemon (and every terminal it is still running) alone, so it
// must not restart the daemon on the way.
test("skew: closing the window keeps the previous version's sessions", async ({
  page,
}) => {
  await gotoApp(page, { daemonHealth: "skew" });

  await expect(page.getByText("Restart background sessions?")).toBeVisible();
  await page.getByRole("button", { name: "Close window" }).click();

  const state = await mock(page);
  expect(state.closed).toBe(true);
  expect(state.restartedDaemon).toBeFalsy();
});
