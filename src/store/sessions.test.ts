import { test, expect, describe, beforeEach, vi } from "vitest";
import { useSessions, type Session, type Terminal } from "./sessions";

const term = (id: string, extra: Partial<Terminal> = {}): Terminal => ({
  id,
  title: id,
  command: "bash",
  args: [],
  ...extra,
});

// s1 has two groups (so we can check a sibling group's identity); s2 is a
// separate session (to check an untouched session's identity).
function seed(): Session[] {
  return [
    {
      id: "s1",
      name: "S1",
      groups: [
        { id: "g1", terminals: [term("t1"), term("t2")], activeTerminalId: "t1" },
        { id: "g2", terminals: [term("t3")], activeTerminalId: "t3" },
      ],
      layout: { t: "leaf", group: "g1" },
      activeGroupId: "g1",
    },
    {
      id: "s2",
      name: "S2",
      groups: [{ id: "g4", terminals: [term("t4")], activeTerminalId: "t4" }],
      layout: { t: "leaf", group: "g4" },
      activeGroupId: "g4",
    },
  ];
}

const S = () => useSessions.getState().sessions;
function findTerm(ss: Session[], id: string): Terminal | undefined {
  for (const s of ss)
    for (const g of s.groups) {
      const t = g.terminals.find((x) => x.id === id);
      if (t) return t;
    }
  return undefined;
}

beforeEach(() => {
  useSessions.setState({ sessions: seed(), activeSessionId: "s1", hydrated: true });
});

describe("patchTerminal identity preservation", () => {
  test("a real change rebuilds only the affected session and group", () => {
    const before = S();
    const otherSession = before[1];
    const siblingGroup = before[0].groups[1]; // the group without t1
    useSessions.getState().setBusy("t1", true);
    const after = S();
    expect(after).not.toBe(before); // the array changed
    expect(after[1]).toBe(otherSession); // untouched session kept its identity
    expect(after[0].groups[1]).toBe(siblingGroup); // sibling group too
    expect(findTerm(after, "t1")?.busy).toBe(true);
  });

  test("a redundant patch preserves the whole array identity", () => {
    useSessions.getState().setBusy("t1", true);
    const afterFirst = S();
    useSessions.getState().setBusy("t1", true); // same value
    expect(S()).toBe(afterFirst);

    useSessions.getState().setProcTitle("t1", "same");
    const afterTitle = S();
    useSessions.getState().setProcTitle("t1", "same"); // same title
    expect(S()).toBe(afterTitle);
  });

  test("a redundant busy heartbeat notifies nobody", () => {
    // Persistence subscribes without a selector and serializes the whole
    // layout, so a heartbeat that changed nothing has to stop at the setter.
    useSessions.getState().setBusy("t1", true);
    const woken = vi.fn();
    const unsub = useSessions.subscribe(woken);
    useSessions.getState().setBusy("t1", true);
    expect(woken).not.toHaveBeenCalled();
    unsub();
  });
});

describe("clearAllAttention", () => {
  test("rebuilds only sessions that had a flagged terminal", () => {
    useSessions.getState().setAttention("t1", true); // s1 only
    const before = S();
    const otherSession = before[1];
    useSessions.getState().clearAllAttention();
    const after = S();
    expect(after).not.toBe(before);
    expect(after[1]).toBe(otherSession); // s2 had none → untouched
    expect(findTerm(after, "t1")?.attention).toBe(false);
  });

  test("is a no-op on identity when nothing is flagged", () => {
    const before = S();
    useSessions.getState().clearAllAttention();
    expect(S()).toBe(before);
  });
});

describe("reorderSessionBlock", () => {
  const plain = (id: string): Session => ({
    id,
    name: id,
    groups: [{ id: `g-${id}`, terminals: [] }],
    layout: { t: "leaf", group: `g-${id}` },
    activeGroupId: `g-${id}`,
  });
  const ids = () => S().map((s) => s.id);
  const seedIds = (list: string[]) =>
    useSessions.setState({ sessions: list.map(plain) });

  test("moves a block, keeping the block's own order", () => {
    seedIds(["a", "b", "c", "d"]);
    useSessions.getState().reorderSessionBlock(["a", "b"], "d", true);
    expect(ids()).toEqual(["c", "d", "a", "b"]);
  });

  test("gathers a scattered block at the anchor", () => {
    seedIds(["a", "x", "b", "y"]);
    useSessions.getState().reorderSessionBlock(["a", "b"], "y", false);
    expect(ids()).toEqual(["x", "a", "b", "y"]);
  });

  test("is a no-op on identity when nothing moves", () => {
    seedIds(["a", "b", "c"]);
    const before = S();
    useSessions.getState().reorderSessionBlock(["a"], "b", false);
    expect(S()).toBe(before);
  });

  test("ignores an anchor inside the block, or one that is gone", () => {
    seedIds(["a", "b", "c"]);
    const before = S();
    useSessions.getState().reorderSessionBlock(["a", "b"], "a", true);
    useSessions.getState().reorderSessionBlock(["a"], "nope", true);
    expect(S()).toBe(before);
  });
});
