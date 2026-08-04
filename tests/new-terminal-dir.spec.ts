import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator(".xterm").first()).toBeVisible();
}

/** Put the newest terminal's shell in `dir`, as the OS would report it. */
async function shellMovesTo(page: Page, dir: string) {
  const id = await page
    .getByTestId("terminal-tab")
    .last()
    .getAttribute("data-tab-id");
  await page.evaluate(
    ([tid, d]) => {
      const mock = (window as unknown as { __MOCK__: Record<string, unknown> })
        .__MOCK__;
      const cwds = (mock.terminalCwds ??= {}) as Record<string, string>;
      cwds[tid!] = d!;
    },
    [id, dir] as const,
  );
}

interface Spawn {
  cwd?: string;
  args?: string[];
}

/** How the newest tab's terminal was spawned. */
async function newestSpawn(page: Page): Promise<Spawn | undefined> {
  const id = await page
    .getByTestId("terminal-tab")
    .last()
    .getAttribute("data-tab-id");
  return page.evaluate(
    (tid) =>
      ((window as unknown as { __MOCK__: Record<string, unknown> }).__MOCK__
        .spawns as Record<string, Spawn>)?.[tid!],
    id,
  );
}

const newestSpawnCwd = async (page: Page) => (await newestSpawn(page))?.cwd;

test("a new terminal follows the one you were last in", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  expect(await newestSpawnCwd(page)).toBe("/home/test");

  await shellMovesTo(page, "/home/test/projects/thel");
  await page.keyboard.press("Control+Shift+T");

  await expect.poll(() => newestSpawnCwd(page)).toBe("/home/test/projects/thel");
});

test("a split follows it too", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);

  await shellMovesTo(page, "/home/test/elsewhere");
  await page.keyboard.press("Control+Shift+D");

  await expect.poll(() => newestSpawnCwd(page)).toBe("/home/test/elsewhere");
});

// Nothing to read (a platform that won't say, or a terminal that never
// started) leaves the session's own folder as the answer.
test("without an answer the session's folder is used", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);

  await page.keyboard.press("Control+Shift+T");
  await expect.poll(() => newestSpawnCwd(page)).toBe("/home/test");
});

// The terminal follows, but __SESSION_DIR__ still means the session: a launcher
// that anchors itself with it must not drift with whatever a shell cd'd to.
test("__SESSION_DIR__ still resolves to the session's folder", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "__store__thel-launchers.json",
      JSON.stringify({
        launchers: [
          { id: "l1", name: "anchored", command: "echo __SESSION_DIR__" },
        ],
        defaultLauncherId: "l1",
      }),
    );
  });
  await gotoApp(page);
  await createSession(page);

  await shellMovesTo(page, "/home/test/projects/thel");
  await page.keyboard.press("Control+Shift+T");

  await expect.poll(() => newestSpawnCwd(page)).toBe("/home/test/projects/thel");
  const args = (await newestSpawn(page))?.args?.join(" ") ?? "";
  expect(args).toContain("echo '/home/test'");
});

test("the preference pins new terminals to the session's folder", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("thel.newTerminalInSessionDir", "1"),
  );
  await gotoApp(page);
  await createSession(page);

  await shellMovesTo(page, "/home/test/projects/thel");
  await page.keyboard.press("Control+Shift+T");

  await expect.poll(() => newestSpawnCwd(page)).toBe("/home/test");
});
