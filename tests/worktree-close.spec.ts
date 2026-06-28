import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";
import type { MockConfig } from "./tauri";

// A restored session anchored to a directory (a worktree, in the worktree tests).
const layout = {
  activeSessionId: "s0",
  sessions: [
    {
      id: "s0",
      name: "feature",
      cwd: "/repo.feature",
      repoRoot: "/repo.feature",
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
};

// cwd is a linked worktree; removal must run from the main checkout (/repo).
const linked = { is_linked: true, path: "/repo.feature", main: "/repo" };

async function open(page: Page, config: MockConfig) {
  await page.addInitScript((l) => {
    localStorage.setItem(
      "__store__thel-layout.json",
      JSON.stringify({ layout: l }),
    );
  }, layout);
  await gotoApp(page, config);
  await page.getByRole("button", { name: "Close session" }).click();
  return page.getByRole("dialog");
}

const removed = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __MOCK__: { removed?: unknown[] } }).__MOCK__.removed,
  );

test("dirty worktree: warns, defaults off, removes from main with force", async ({
  page,
}) => {
  const dialog = await open(page, {
    worktreeInfo: linked,
    git: { root: "/repo.feature", dirty: true },
  });

  const checkbox = dialog.getByRole("checkbox");
  await expect(checkbox).not.toBeChecked(); // destructive: opt-in only
  // The data-loss warning belongs to the delete option, shown once it's chosen.
  await expect(dialog.getByText(/uncommitted or untracked/)).toHaveCount(0);
  await checkbox.click();
  await expect(dialog.getByText(/uncommitted or untracked/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close session" }).click();

  await expect(page.getByText("No sessions open.")).toBeVisible();
  await expect
    .poll(() => removed(page))
    .toEqual([{ repoRoot: "/repo", path: "/repo.feature", force: true }]);
});

test("clean worktree: no warning, defaults on, removes without force", async ({
  page,
}) => {
  const dialog = await open(page, {
    worktreeInfo: linked,
    git: { root: "/repo.feature", dirty: false },
  });
  await expect(dialog.getByText(/uncommitted or untracked/)).toHaveCount(0);

  await expect(dialog.getByRole("checkbox")).toBeChecked(); // safe default
  await dialog.getByRole("button", { name: "Close session" }).click();

  await expect
    .poll(() => removed(page))
    .toEqual([{ repoRoot: "/repo", path: "/repo.feature", force: false }]);
});

test("declining keeps the worktree", async ({ page }) => {
  const dialog = await open(page, {
    worktreeInfo: linked,
    git: { root: "/repo.feature", dirty: false },
  });
  await dialog.getByRole("checkbox").click(); // uncheck (clean default is on)
  await dialog.getByRole("button", { name: "Close session" }).click();

  await expect(page.getByText("No sessions open.")).toBeVisible();
  await expect.poll(() => removed(page)).toBeFalsy();
});

test("plain (non-worktree) session: confirms with no checkbox", async ({
  page,
}) => {
  // Not a linked worktree, so no removal option, but a session close still
  // confirms.
  const dialog = await open(page, {
    worktreeInfo: { is_linked: false, path: "/repo", main: "/repo" },
  });
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close session" }).click();

  await expect(page.getByText("No sessions open.")).toBeVisible();
  await expect.poll(() => removed(page)).toBeFalsy();
});
