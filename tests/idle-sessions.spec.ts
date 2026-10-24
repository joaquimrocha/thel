import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

const dot = (page: Page) =>
  page.locator("[data-session-list] [data-row-id] [data-status-slot]").first().getByRole("img");

const pushIdle = (page: Page, id: string, idle: boolean) =>
  page.evaluate(
    ([t, v]) =>
      (
        window as never as {
          __TAURI_INTERNALS__: { __idleTerminalById(id: string, idle: boolean): boolean };
        }
      ).__TAURI_INTERNALS__.__idleTerminalById(t as string, v as boolean),
    [id, idle] as const,
  );

function seed() {
  const term = (id: string) => ({ id, title: "shell", command: "bash", args: [] });
  const layout = {
    activeSessionId: "s0",
    sessions: [
      {
        id: "s0",
        name: "app",
        cwd: "/home/test/app",
        groups: [{ id: "g0", activeTerminalId: "t0", terminals: [term("t0"), term("t1")] }],
        layout: { t: "leaf", group: "g0" },
        activeGroupId: "g0",
      },
    ],
  };
  if (!localStorage.getItem("__store__thel-layout.json"))
    localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout }));
}

test("a session shows idle once every terminal in it is idle", async ({ page }) => {
  await page.addInitScript(seed);
  await gotoApp(page);
  await expect(dot(page)).toHaveAccessibleName("Running");

  await expect.poll(() => pushIdle(page, "t0", true)).toBe(true);
  await expect(dot(page)).toHaveAccessibleName("Running");

  await expect.poll(() => pushIdle(page, "t1", true)).toBe(true);
  await expect(dot(page)).toHaveAccessibleName("Idle");

  await pushIdle(page, "t0", false);
  await expect(dot(page)).toHaveAccessibleName("Running");
});

test("turning off idle marking shows an idle session as running", async ({ page }) => {
  await page.addInitScript(seed);
  await gotoApp(page);
  await expect.poll(() => pushIdle(page, "t0", true)).toBe(true);
  await expect.poll(() => pushIdle(page, "t1", true)).toBe(true);
  await expect(dot(page)).toHaveAccessibleName("Idle");

  await page.keyboard.press("Control+Comma");
  await page.getByRole("tab", { name: "Sessions" }).click();
  await page.getByLabel("Mark idle terminals").click();
  await page.keyboard.press("Escape");
  await expect(dot(page)).toHaveAccessibleName("Running");
});
