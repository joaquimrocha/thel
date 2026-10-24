import { test, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

vi.mock("@/lib/launch", async (original) => ({
  ...(await original<typeof import("@/lib/launch")>()),
  refreshSessionGit: vi.fn(),
}));

vi.mock("@/lib/pty", async (original) => ({
  ...(await original<typeof import("@/lib/pty")>()),
  defaultShell: async () => "/bin/zsh",
  killTerminalWindow: vi.fn(async () => {}),
}));

import { adopt, forgetClaimed, quoted, type Adopt } from "./sessionBridge";
import { refreshSessionGit } from "@/lib/launch";
import { killTerminalWindow } from "@/lib/pty";
import { useSessions, sessionTerminals } from "@/store/sessions";

function started(a: Partial<Adopt> = {}): Adopt {
  return {
    terminal: "t1",
    command: "sh",
    args: [],
    cwd: "/repo",
    place: { kind: "new_session", name: "api", window: "main" },
    sandboxed: false,
    ...a,
  };
}

test("names show escaped and cut short as the daemon shows them", () => {
  // The same cases as session.rs's describe tests: a look-alike quote and a
  // run of blank characters, cut at 60 characters.
  expect(quoted(`api\u201d ${"\u2800".repeat(100)}`)).toBe(`"api\\u{201d} ${"\\u{2800}".repeat(55)}…"`);
  expect(quoted('a"b\\c\n\u{1f600}')).toBe('"a\\"b\\\\c\\n\\u{1f600}"');
});

test("a session started from the CLI gets its git info right away", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  await adopt(started(), "main");
  const [session] = useSessions.getState().sessions;
  expect(session.cwd).toBe("/repo");
  expect(refreshSessionGit).toHaveBeenCalledWith(session.id);
});

test("a terminal started for a sandboxed program comes back as a shell", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  await adopt(started({ command: "npm", args: ["run", "dev"], sandboxed: true }), "main");
  const [t] = sessionTerminals(useSessions.getState().sessions[0]);
  expect([t.title, t.command, t.args]).toEqual(["npm", "/bin/zsh", []]);
});

test("a rename of a terminal from the CLI sticks over its program's title", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  await adopt(started({ command: "npm" }), "main");
  const [t] = sessionTerminals(useSessions.getState().sessions[0]);
  useSessions.getState().renameTerminal(t.id, "dev server");
  expect(sessionTerminals(useSessions.getState().sessions[0])[0].renamed).toBe(true);
});

test("a terminal for a session on its way here waits for it", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  await adopt(started(), "main");
  const [moving] = useSessions.getState().sessions;
  useSessions.getState().dropSession(moving.id);
  await adopt(started({ terminal: "t2", place: { kind: "session", id: moving.id } }), "main");
  expect(useSessions.getState().sessions).toEqual([]);
  useSessions.getState().receiveSession(moving);
  const [back] = useSessions.getState().sessions;
  expect(sessionTerminals(back).map((t) => t.id)).toEqual(["t1", "t2"]);
});

test("a terminal another window opened doesn't come with its session", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  await adopt(started(), "main");
  const [moving] = useSessions.getState().sessions;
  useSessions.getState().dropSession(moving.id);
  await adopt(started({ terminal: "t2", place: { kind: "session", id: moving.id } }), "main");
  forgetClaimed("t2");
  // Claimed before this window held it back, as a slow shell lookup allows.
  forgetClaimed("t3");
  await adopt(started({ terminal: "t3", place: { kind: "session", id: moving.id } }), "main");
  useSessions.getState().receiveSession(moving);
  const [back] = useSessions.getState().sessions;
  expect(sessionTerminals(back).map((t) => t.id)).toEqual(["t1"]);
});

test("a terminal for a session closed here is closed too", async () => {
  useSessions.setState({ sessions: [], activeSessionId: undefined });
  await adopt(started(), "main");
  const [closing] = useSessions.getState().sessions;
  useSessions.getState().removeSession(closing.id);
  vi.mocked(killTerminalWindow).mockClear();
  await adopt(started({ terminal: "t2", place: { kind: "session", id: closing.id } }), "main");
  expect(killTerminalWindow).toHaveBeenCalledWith("t2");
  expect(useSessions.getState().sessions).toEqual([]);
});
