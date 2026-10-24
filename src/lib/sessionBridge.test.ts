import { test, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

vi.mock("@/lib/pty", async (original) => ({
  ...(await original<typeof import("@/lib/pty")>()),
  killTerminalWindow: vi.fn(async () => {}),
}));

vi.mock("@/lib/launch", async (original) => ({
  ...(await original<typeof import("@/lib/launch")>()),
  refreshSessionGit: vi.fn(),
}));

import { adopt, forgetClaimed } from "./sessionBridge";
import { refreshSessionGit } from "@/lib/launch";
import { killTerminalWindow } from "@/lib/pty";
import { useSessions, sessionTerminals } from "@/store/sessions";

test("a session started from the CLI gets its git info right away", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  await adopt(
    {
      terminal: "t1",
      command: "sh",
      args: [],
      cwd: "/repo",
      place: { kind: "new_session", name: "api", window: "main" },
    },
    "main",
  );
  const [session] = useSessions.getState().sessions;
  expect(session.cwd).toBe("/repo");
  expect(refreshSessionGit).toHaveBeenCalledWith(session.id);
});

test("a terminal for a session on its way here waits for it", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  const term = { command: "sh", args: [], cwd: "/repo" };
  await adopt({ ...term, terminal: "t1", place: { kind: "new_session", name: "api", window: "main" } }, "main");
  const [moving] = useSessions.getState().sessions;
  useSessions.getState().dropSession(moving.id);
  await adopt({ ...term, terminal: "t2", place: { kind: "session", id: moving.id } }, "main");
  expect(useSessions.getState().sessions).toEqual([]);
  useSessions.getState().receiveSession(moving);
  const [back] = useSessions.getState().sessions;
  expect(sessionTerminals(back).map((t) => t.id)).toEqual(["t1", "t2"]);
});

test("a terminal another window opened doesn't come with its session", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  const term = { command: "sh", args: [], cwd: "/repo" };
  await adopt({ ...term, terminal: "t1", place: { kind: "new_session", name: "api", window: "main" } }, "main");
  const [moving] = useSessions.getState().sessions;
  useSessions.getState().dropSession(moving.id);
  await adopt({ ...term, terminal: "t2", place: { kind: "session", id: moving.id } }, "main");
  forgetClaimed("t2");
  // Claimed before this window held it back, as a slow shell lookup allows.
  forgetClaimed("t3");
  await adopt({ ...term, terminal: "t3", place: { kind: "session", id: moving.id } }, "main");
  useSessions.getState().receiveSession(moving);
  const [back] = useSessions.getState().sessions;
  expect(sessionTerminals(back).map((t) => t.id)).toEqual(["t1"]);
});

test("a terminal for a session closed here is closed too", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  const term = { command: "sh", args: [], cwd: "/repo" };
  await adopt({ ...term, terminal: "t1", place: { kind: "new_session", name: "api", window: "main" } }, "main");
  const [closing] = useSessions.getState().sessions;
  useSessions.getState().removeSession(closing.id);
  vi.mocked(killTerminalWindow).mockClear();
  await adopt({ ...term, terminal: "t2", place: { kind: "session", id: closing.id } }, "main");
  expect(killTerminalWindow).toHaveBeenCalledWith("t2");
  expect(useSessions.getState().sessions).toEqual([]);
});
