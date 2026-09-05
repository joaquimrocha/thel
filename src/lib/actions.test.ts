import { describe, expect, it, beforeEach } from "vitest";
import { useSessions, type Session } from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { cycleSession } from "./actions";

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
