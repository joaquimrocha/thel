import { describe, expect, it, beforeEach } from "vitest";
import { useSessions, type Session } from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { cycleSession, moveSession } from "./actions";

function session(id: string, repo: Partial<Pick<Session, "repoMain" | "repoRoot">> = {}): Session {
  return {
    id,
    name: id,
    groups: [{ id: `g-${id}`, terminals: [] }],
    layout: { t: "leaf", group: `g-${id}` },
    activeGroupId: `g-${id}`,
    ...repo,
  };
}

describe("cycleSession", () => {
  beforeEach(() => {
    usePrefs.setState({ groupSessionsByRepo: true });
    useUI.setState({ collapsedRepos: [] });
  });

  it("navigates to nearest visible session when active session is in a folded group", () => {
    const a1 = session("a1", { repoMain: "/work/repoA" });
    const a2 = session("a2", { repoMain: "/work/repoA" });
    const b1 = session("b1", { repoMain: "/work/repoB" });
    const b2 = session("b2", { repoMain: "/work/repoB" });
    const c1 = session("c1");

    useSessions.setState({
      sessions: [a1, a2, b1, b2, c1],
      activeSessionId: "b1",
    });
    // Fold repoB so b1 and b2 are hidden from visible display order ([a1, a2, c1]).
    useUI.setState({ collapsedRepos: ["/work/repoB"] });

    // Moving next (+1) from hidden b1 (index 2 in full order [a1, a2, b1, b2, c1]):
    // should land on c1.
    cycleSession(1);
    expect(useSessions.getState().activeSessionId).toBe("c1");

    // Set active back to b1 and move prev (-1) from hidden b1:
    // should land on a2.
    useSessions.setState({ activeSessionId: "b1" });
    cycleSession(-1);
    expect(useSessions.getState().activeSessionId).toBe("a2");
  });
});

describe("moveSession", () => {
  beforeEach(() => {
    usePrefs.setState({ groupSessionsByRepo: true });
    useUI.setState({ collapsedRepos: [] });
  });

  // The drawn top level for [a1, a2, b1, loose] is [repoA, repoB, loose].
  const setup = (order: string[], active: string) => {
    const byId: Record<string, Session> = {
      a1: session("a1", { repoMain: "/work/repoA" }),
      a2: session("a2", { repoMain: "/work/repoA" }),
      b1: session("b1", { repoMain: "/work/repoB" }),
      loose: session("loose"),
    };
    useSessions.setState({
      sessions: order.map((id) => byId[id]),
      activeSessionId: active,
    });
  };
  const ids = () => useSessions.getState().sessions.map((s) => s.id);

  it("hops a loose session over a whole group, not one row at a time", () => {
    setup(["a1", "a2", "b1", "loose"], "loose");
    // Up once clears repoB entirely, landing between the two groups.
    moveSession(-1);
    expect(ids()).toEqual(["a1", "a2", "loose", "b1"]);
    // Up again clears repoA, so it leads the list.
    moveSession(-1);
    expect(ids()).toEqual(["loose", "a1", "a2", "b1"]);
  });

  it("hops a loose session back down over a whole group", () => {
    setup(["loose", "a1", "a2", "b1"], "loose");
    moveSession(1);
    expect(ids()).toEqual(["a1", "a2", "loose", "b1"]);
    moveSession(1);
    expect(ids()).toEqual(["a1", "a2", "b1", "loose"]);
  });

  it("does nothing at either end", () => {
    setup(["loose", "a1", "a2", "b1"], "loose");
    moveSession(-1);
    expect(ids()).toEqual(["loose", "a1", "a2", "b1"]);

    setup(["a1", "a2", "b1", "loose"], "loose");
    moveSession(1);
    expect(ids()).toEqual(["a1", "a2", "b1", "loose"]);
  });

  it("still swaps a grouped session with its neighbour inside the group", () => {
    setup(["a1", "a2", "b1", "loose"], "a2");
    moveSession(-1);
    expect(ids()).toEqual(["a2", "a1", "b1", "loose"]);
  });

  it("moves the whole group down from its last row", () => {
    // a2 ends repoA, so there is nothing below it inside the group; the press
    // moves repoA itself, clear of repoB.
    setup(["a1", "a2", "b1", "loose"], "a2");
    moveSession(1);
    expect(ids()).toEqual(["b1", "a1", "a2", "loose"]);
  });

  it("moves the whole group up from its first row", () => {
    setup(["b1", "a1", "a2", "loose"], "a1");
    moveSession(-1);
    expect(ids()).toEqual(["a1", "a2", "b1", "loose"]);
  });

  it("moves a group past a loose session too", () => {
    setup(["loose", "a1", "a2", "b1"], "a1");
    moveSession(-1);
    expect(ids()).toEqual(["a1", "a2", "loose", "b1"]);
  });

  it("gathers a group's scattered sessions when it moves", () => {
    // repoA's sessions straddle the loose one, so the drawn order is
    // [repoA, loose, repoB]. Moving repoA down makes the block contiguous.
    setup(["a1", "loose", "b1", "a2"], "a2");
    moveSession(1);
    expect(ids()).toEqual(["loose", "a1", "a2", "b1"]);
  });

  it("does nothing when a group is already at the end", () => {
    setup(["loose", "b1", "a1", "a2"], "a2");
    moveSession(1);
    expect(ids()).toEqual(["loose", "b1", "a1", "a2"]);
  });
});
