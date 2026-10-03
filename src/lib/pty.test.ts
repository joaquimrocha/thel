import { beforeEach, describe, expect, it, vi } from "vitest";

// Each invoke stays pending until the test settles it, like a command still
// running on Tauri's worker pool.
const calls: { cmd: string; args: unknown; settle: (ok: boolean) => void }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) =>
    new Promise((resolve, reject) =>
      calls.push({ cmd, args, settle: (ok) => (ok ? resolve(undefined) : reject(new Error(cmd))) }),
    ),
  Channel: class {
    onmessage = () => {};
  },
}));

const { createSession, writeSession, resizeSession, closeSession, killTerminalWindow } =
  await import("./pty");

const flush = () => new Promise((r) => setTimeout(r, 0));
const issued = () => calls.map((c) => c.cmd);
const opts = (id: string) => ({ id, command: "bash", args: [], cols: 80, rows: 24 });

beforeEach(() => {
  calls.length = 0;
});

describe("terminal calls", () => {
  it("reach the backend in order, each after the previous one finished", async () => {
    void createSession(opts("a"), () => {});
    void writeSession("a", "l");
    void writeSession("a", "s");
    void resizeSession("a", 100, 30);
    await flush();
    expect(issued()).toEqual(["create_session"]);

    calls[0].settle(true);
    await flush();
    expect(issued()).toEqual(["create_session", "write_session"]);
    calls[1].settle(true);
    await flush();
    calls[2].settle(true);
    await flush();
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ["create_session", expect.anything()],
      ["write_session", { id: "a", data: "l" }],
      ["write_session", { id: "a", data: "s" }],
      ["resize_session", { id: "a", cols: 100, rows: 30 }],
    ]);
  });

  it("let a remount reattach only after the old pane detached", async () => {
    void createSession(opts("b"), () => {});
    void closeSession("b");
    void createSession(opts("b"), () => {});
    await flush();
    calls[0].settle(true);
    await flush();
    expect(issued()).toEqual(["create_session", "close_session"]);
    calls[1].settle(true);
    await flush();
    expect(issued()).toEqual(["create_session", "close_session", "create_session"]);
  });

  it("carry on after a failed call, and still report its error", async () => {
    const created = createSession(opts("c"), () => {});
    void killTerminalWindow("c");
    await flush();
    calls[0].settle(false);
    await expect(created).rejects.toThrow("create_session");
    await flush();
    expect(issued()).toEqual(["create_session", "kill_terminal_window"]);
  });

  it("don't wait on another terminal", async () => {
    void createSession(opts("d"), () => {});
    void writeSession("e", "x");
    await flush();
    expect(issued()).toEqual(["create_session", "write_session"]);
  });
});
