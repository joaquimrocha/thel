import { test, gotoApp, expect } from "./app";
import caps from "../src-tauri/capabilities/default.json" with { type: "json" };

type CloseHooks = {
  __closeRequestedReady: () => boolean;
  __fireCloseRequested: () => Promise<boolean>;
};

// Regression: the close handler flushes pending writes, then the window must
// actually close. A handler that preventDefaults without granting the window
// destroy capability left the window stuck open with no way to quit.
test("the OS close request destroys the window (no stuck window)", async ({
  page,
}) => {
  await gotoApp(page);

  // Wait for the close handler to register, then fire the close exactly once,
  // as the X button does. A handler that preventDefaults and never destroys
  // (the bug) leaves `destroyed` false.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __TAURI_INTERNALS__: CloseHooks }
          ).__TAURI_INTERNALS__.__closeRequestedReady(),
      ),
    )
    .toBe(true);

  const destroyed = await page.evaluate(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: CloseHooks;
      __MOCK__: { destroyed?: boolean };
    };
    await w.__TAURI_INTERNALS__.__fireCloseRequested();
    return w.__MOCK__.destroyed === true;
  });
  expect(destroyed).toBe(true);
});

// The API's onCloseRequested issues window.destroy() once the handler returns
// without preventDefault, so that command must be permitted or the real window
// can't close (which the mock above can't enforce).
test("the window destroy capability is granted", () => {
  expect(caps.permissions).toContain("core:window:allow-destroy");
});
