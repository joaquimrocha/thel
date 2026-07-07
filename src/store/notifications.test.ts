import { test, expect, describe, beforeEach } from "vitest";
import { useSessions, type Session } from "./sessions";
import { usePrefs } from "./prefs";
import { useNotifications, notify } from "./notifications";

// One session with one terminal is enough to resolve names in notify().
function seed(id: string): Session[] {
  return [
    {
      id: "s1",
      name: "S1",
      groups: [
        {
          id: "g1",
          terminals: [{ id, title: id, command: "bash", args: [] }],
          activeTerminalId: id,
        },
      ],
      layout: { t: "leaf", group: "g1" },
      activeGroupId: "g1",
    },
  ];
}

const items = () => useNotifications.getState().items;
const attention = (id: string) =>
  useSessions
    .getState()
    .sessions[0].groups[0].terminals.find((t) => t.id === id)?.attention;

let seq = 0;
// Unique id per test: the swallow set is module-lived, so reusing an id would
// bleed the "first bell already seen" state between tests.
function freshTerminal(): string {
  const id = `nt${seq++}`;
  useSessions.setState({
    sessions: seed(id),
    activeSessionId: "s1",
    hydrated: true,
  });
  return id;
}

beforeEach(() => {
  // notifyDesktop off so the OS-banner branch (Tauri) never runs under test.
  usePrefs.setState({ notifyBell: true, notifyDesktop: false });
  useNotifications.setState({ items: [] });
});

describe("startup-bell suppression", () => {
  test("a bell is swallowed until the user engages; then it notifies", () => {
    const id = freshTerminal();
    // Un-engaged: a re-run program's startup bell is dropped.
    notify(id, "bell");
    expect(items()).toHaveLength(0);
    expect(attention(id)).toBeFalsy();

    // After the user types into it, bells are real signals.
    useSessions.getState().markInteracted(id);
    notify(id, "bell");
    expect(items()).toHaveLength(1);
    expect(items()[0].kind).toBe("bell");
    expect(attention(id)).toBe(true);
  });

  test("only bells are gated -- idle/finished notifies even un-engaged", () => {
    const id = freshTerminal();
    notify(id, "idle");
    expect(items()).toHaveLength(1);
    expect(items()[0].kind).toBe("idle");
  });
});
