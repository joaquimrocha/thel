import { describe, expect, it, test, beforeEach, vi } from "vitest";
import { useSessions, type Session, type Terminal } from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { sidebarItems } from "@/lib/sessionGroups";
import { cycleSession, moveSession, goToNextFinishedOrWorkingTerminal } from "./actions";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: vi.fn(),
}));

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
  // The sidebar's top level, which is what a move is judged by: the flat
  // session order it comes from reads differently once groups gather their
  // scattered rows under one header.
  const drawn = () =>
    sidebarItems(useSessions.getState().sessions).map((it) =>
      it.t === "group" ? it.group.name : it.session.id,
    );

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

  it("leaves the group put at its last row", () => {
    // a2 ends repoA, and it cannot leave the repo, so the press does nothing
    // rather than dragging repoA past repoB.
    setup(["a1", "a2", "b1", "loose"], "a2");
    moveSession(1);
    expect(ids()).toEqual(["a1", "a2", "b1", "loose"]);
  });

  it("leaves the group put at its first row", () => {
    setup(["b1", "a1", "a2", "loose"], "a1");
    moveSession(-1);
    expect(ids()).toEqual(["b1", "a1", "a2", "loose"]);
  });

  it("hops a loose session over a group without gathering it", () => {
    // repoA's sessions straddle the loose one, so the drawn order is
    // [repoA, loose, repoB]. The loose row clears repoB to land last; repoA
    // stays scattered, because nothing asked it to move.
    setup(["a1", "loose", "b1", "a2"], "loose");
    moveSession(1);
    expect(ids()).toEqual(["a1", "b1", "loose", "a2"]);
    expect(drawn()).toEqual(["repoA", "repoB", "loose"]);
  });

  it("does nothing at a group's edge with no item beyond it", () => {
    setup(["loose", "b1", "a1", "a2"], "a2");
    moveSession(1);
    expect(ids()).toEqual(["loose", "b1", "a1", "a2"]);
  });
});

const term = (id: string, extra: Partial<Terminal> = {}): Terminal => ({
  id,
  title: id,
  command: "bash",
  args: [],
  ...extra,
});

function seed(): Session[] {
  return [
    {
      id: "s1",
      name: "S1",
      groups: [
        { id: "g1", terminals: [term("t1"), term("t2")], activeTerminalId: "t1" },
      ],
      layout: { t: "leaf", group: "g1" },
      activeGroupId: "g1",
    },
    {
      id: "s2",
      name: "S2",
      groups: [{ id: "g2", terminals: [term("t3"), term("t4")], activeTerminalId: "t3" }],
      layout: { t: "leaf", group: "g2" },
      activeGroupId: "g2",
    },
  ];
}

describe("goToNextFinishedOrWorkingTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessions.setState({ sessions: seed(), activeSessionId: "s1", hydrated: true });
  });

  test("shows toast when no terminals are finished or working", () => {
    goToNextFinishedOrWorkingTerminal();
    expect(toast).toHaveBeenCalledWith("No finished or working terminals");
  });

  test("prioritizes finished terminal over working terminal", () => {
    // t2 is working, t4 is finished (attention)
    useSessions.setState((s) => ({
      sessions: s.sessions.map((ss) => {
        if (ss.id === "s1") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t1"), term("t2", { busy: true })] }],
          };
        }
        if (ss.id === "s2") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t3"), term("t4", { attention: true })] }],
          };
        }
        return ss;
      }),
    }));

    // Active is t1 in s1
    goToNextFinishedOrWorkingTerminal();

    // Should jump to s2 / t4 because t4 has attention
    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s2");
    expect(state.sessions.find((s) => s.id === "s2")?.groups[0].activeTerminalId).toBe("t4");
  });

  test("falls back to working terminal when no finished terminals exist", () => {
    // t3 is working (busy)
    useSessions.setState((s) => ({
      sessions: s.sessions.map((ss) => {
        if (ss.id === "s2") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t3", { busy: true }), term("t4")] }],
          };
        }
        return ss;
      }),
    }));

    // Active is t1 in s1
    goToNextFinishedOrWorkingTerminal();

    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s2");
    expect(state.sessions.find((s) => s.id === "s2")?.groups[0].activeTerminalId).toBe("t3");
  });

  test("moves to a working terminal when the active one is the only finished one", () => {
    useSessions.setState((s) => ({
      sessions: s.sessions.map((ss) => {
        if (ss.id === "s1") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t1", { attention: true }), term("t2")] }],
          };
        }
        if (ss.id === "s2") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t3", { busy: true }), term("t4")] }],
          };
        }
        return ss;
      }),
    }));

    // Active is t1 in s1, itself finished; the only other candidate is working.
    goToNextFinishedOrWorkingTerminal();

    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s2");
    expect(state.sessions.find((s) => s.id === "s2")?.groups[0].activeTerminalId).toBe("t3");
  });

  test("with no active terminal, the first candidate counts", () => {
    useSessions.setState((s) => ({
      sessions: s.sessions.map((ss) => {
        if (ss.id === "s1") {
          // Still waiting for its first terminal.
          return { ...ss, groups: [{ ...ss.groups[0], terminals: [], activeTerminalId: "" }] };
        }
        if (ss.id === "s2") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t3", { attention: true })] }],
          };
        }
        return ss;
      }),
    }));

    goToNextFinishedOrWorkingTerminal();

    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s2");
    expect(state.sessions.find((s) => s.id === "s2")?.groups[0].activeTerminalId).toBe("t3");
  });

  test("walks the sidebar's grouped order, not the raw session order", () => {
    // Raw order a1, plain, a2; grouped, a2 sits under a1's repo, ahead of plain.
    const withTerm = (s: Session, t: Terminal): Session => ({
      ...s,
      groups: [{ ...s.groups[0], terminals: [t], activeTerminalId: t.id }],
    });
    useSessions.setState({
      sessions: [
        withTerm(session("a1", { repoMain: "/work/thel", repoRoot: "/work/thel" }), term("t1")),
        withTerm(session("plain"), term("tp", { attention: true })),
        withTerm(
          session("a2", { repoMain: "/work/thel", repoRoot: "/work/thel.feature" }),
          term("t2", { attention: true }),
        ),
      ],
      activeSessionId: "a1",
      hydrated: true,
    });
    usePrefs.setState({ groupSessionsByRepo: true });

    goToNextFinishedOrWorkingTerminal();
    expect(useSessions.getState().activeSessionId).toBe("a2");
  });

  test("cycles through multiple finished terminals", () => {
    // t2 and t4 both have attention
    useSessions.setState((s) => ({
      sessions: s.sessions.map((ss) => {
        if (ss.id === "s1") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t1"), term("t2", { attention: true })] }],
          };
        }
        if (ss.id === "s2") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t3"), term("t4", { attention: true })] }],
          };
        }
        return ss;
      }),
    }));

    // Active is t1
    goToNextFinishedOrWorkingTerminal();
    expect(useSessions.getState().activeSessionId).toBe("s1");
    expect(useSessions.getState().sessions[0].groups[0].activeTerminalId).toBe("t2");

    // Active is now t2 in s1, call again -> should go to t4 in s2
    goToNextFinishedOrWorkingTerminal();
    expect(useSessions.getState().activeSessionId).toBe("s2");
    expect(useSessions.getState().sessions[1].groups[0].activeTerminalId).toBe("t4");
  });

  test("handles exited processes as finished terminals", () => {
    useSessions.setState((s) => ({
      sessions: s.sessions.map((ss) => {
        if (ss.id === "s2") {
          return {
            ...ss,
            groups: [{ ...ss.groups[0], terminals: [term("t3", { exited: true }), term("t4")] }],
          };
        }
        return ss;
      }),
    }));

    goToNextFinishedOrWorkingTerminal();
    expect(useSessions.getState().activeSessionId).toBe("s2");
    expect(useSessions.getState().sessions[1].groups[0].activeTerminalId).toBe("t3");
  });
});
