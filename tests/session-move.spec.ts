import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";
import type { MockConfig } from "./tauri";

const session = (id: string, name: string, terminal: string) => ({
  id,
  name,
  cwd: `/home/test/${name}`,
  groups: [
    {
      id: `g-${id}`,
      activeTerminalId: terminal,
      terminals: [{ id: terminal, title: "shell", command: "bash", args: [] }],
    },
  ],
  layout: { t: "leaf", group: `g-${id}` },
  activeGroupId: `g-${id}`,
});

async function open(page: Page, config: MockConfig = {}) {
  await page.addInitScript(
    ({ alpha, beta }) => {
      // Seed once: a reload must keep what the app persisted.
      if (localStorage.getItem("__store__thel-layout.json")) return;
      localStorage.setItem(
        "__store__thel-profiles.json",
        JSON.stringify({
          profiles: [
            { id: "default", name: "Default" },
            { id: "w1", name: "Work" },
          ],
        }),
      );
      localStorage.setItem(
        "__store__thel-layout.json",
        JSON.stringify({ layout: { activeSessionId: alpha.id, sessions: [alpha, beta] } }),
      );
    },
    { alpha: session("s0", "alpha", "t0"), beta: session("s1", "beta", "t1") },
  );
  await gotoApp(page, config);
}

const rows = (page: Page) => page.locator("[data-session-list] [data-row-id]");

async function moveAlphaToWork(page: Page) {
  await rows(page).filter({ hasText: "alpha" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Session Settings" }).getByRole("button", { name: "Work" }).click();
}

const savedIds = (page: Page, file: string) =>
  page.evaluate((f) => {
    const raw = JSON.parse(localStorage.getItem(`__store__${f}`) || "{}");
    return ((raw.layout?.sessions ?? []) as { id: string }[]).map((s) => s.id);
  }, file);

const mock = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { __MOCK__: Record<string, unknown> }).__MOCK__;
    return { emitted: m.emitted as { target: string; event: string; payload: { id: string } }[] | undefined, killed: m.killed as string[] | undefined };
  });

test("a moved session leaves this profile and lands in the other one", async ({ page }) => {
  await open(page);
  await moveAlphaToWork(page);

  await expect(page.getByText("Moved alpha to Work")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toHaveText(/beta/);
  expect(await savedIds(page, "thel-layout-w1.json")).toEqual(["s0"]);
  await expect.poll(() => savedIds(page, "thel-layout.json")).toEqual(["s1"]);
  const { emitted, killed } = await mock(page);
  expect(emitted?.map((e) => [e.target, e.event, e.payload.id])).toEqual([
    ["profile-w1", "thel-session-move", "s0"],
  ]);
  // Its terminals keep running for the other profile's window to attach.
  expect(killed ?? []).not.toContain("t0");
});

test("a move whose write fails keeps the session here and says so", async ({ page }) => {
  await open(page, { failStoreSave: ["thel-layout-w1.json"] });
  await moveAlphaToWork(page);

  await expect(page.getByText(/Could not move the session to Work/)).toBeVisible();
  await expect(page.getByText(/^Moved /)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  expect((await mock(page)).emitted).toBeUndefined();
  expect(await savedIds(page, "thel-layout.json")).toEqual(["s0", "s1"]);
});

test("a session moved here from another profile shows up once", async ({ page }) => {
  await open(page);
  await expect(rows(page)).toHaveCount(2);
  const moved = session("s9", "gamma", "t9");
  await page.evaluate((s) => {
    const t = (window as unknown as { __TAURI_INTERNALS__: { __emitEvent: (e: string, p: unknown) => void } })
      .__TAURI_INTERNALS__;
    t.__emitEvent("thel-session-move", s);
    t.__emitEvent("thel-session-move", s);
  }, moved);

  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: "gamma" })).toHaveCount(1);
  await expect.poll(() => savedIds(page, "thel-layout.json")).toEqual(["s0", "s1", "s9"]);
});
