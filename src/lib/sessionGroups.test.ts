import { describe, expect, it } from "vitest";
import type { Session } from "@/store/sessions";
import {
  sidebarItems,
  itemEdgeId,
  sessionNameInGroup,
  sessionsInDisplayOrder,
} from "./sessionGroups";

function session(id: string, repo: Partial<Pick<Session, "repoMain" | "repoRoot">> = {}): Session {
  return {
    id,
    name: id,
    groups: [{ id: "g", terminals: [] }],
    layout: { t: "leaf", group: "g" },
    activeGroupId: "g",
    ...repo,
  };
}

// A compact view of the top level: a group as its name, a loose session as its id.
const shape = (sessions: Session[]) =>
  sidebarItems(sessions).map((it) =>
    it.t === "group"
      ? `${it.group.name}(${it.group.sessions.map((s) => s.id).join(",")})`
      : it.session.id,
  );

describe("sidebarItems", () => {
  it("groups worktrees of one repo under its folder name, in first-seen order", () => {
    const a1 = session("a1", { repoMain: "/work/thel", repoRoot: "/work/thel.feature" });
    const b1 = session("b1", { repoMain: "/work/site", repoRoot: "/work/site" });
    const a2 = session("a2", { repoMain: "/work/thel", repoRoot: "/work/thel" });
    expect(shape([a1, b1, a2])).toEqual(["thel(a1,a2)", "site(b1)"]);
    const items = sidebarItems([a1, b1, a2]);
    expect(items[0].t === "group" && items[0].group.key).toBe("/work/thel");
  });

  it("keeps a loose session where it sits, not below the groups", () => {
    const a = session("a", { repoMain: "/work/thel" });
    const b = session("b", { repoMain: "/work/site" });
    const loose = session("loose");
    expect(shape([a, loose, b])).toEqual(["thel(a)", "loose", "site(b)"]);
    expect(shape([loose, a, b])).toEqual(["loose", "thel(a)", "site(b)"]);
    expect(shape([a, b, loose])).toEqual(["thel(a)", "site(b)", "loose"]);
  });

  it("places a loose session between two interleaved groups", () => {
    // The groups' sessions alternate, so their spans overlap; a group still
    // sits where its *first* session does, which keeps the gap addressable.
    const a1 = session("a1", { repoMain: "/work/thel" });
    const a2 = session("a2", { repoMain: "/work/thel" });
    const b1 = session("b1", { repoMain: "/work/site" });
    const loose = session("loose");
    expect(shape([a1, loose, b1, a2])).toEqual(["thel(a1,a2)", "loose", "site(b1)"]);
  });

  it("falls back to the session's own checkout until its repo is resolved", () => {
    const items = sidebarItems([session("s", { repoRoot: "/work/thel.feature/" })]);
    expect(items).toHaveLength(1);
    expect(items[0].t === "group" && items[0].group.key).toBe("/work/thel.feature/");
    expect(items[0].t === "group" && items[0].group.name).toBe("thel.feature");
  });
});

describe("itemEdgeId", () => {
  const a1 = session("a1", { repoMain: "/work/thel" });
  const loose = session("loose");
  const a2 = session("a2", { repoMain: "/work/thel" });
  const items = sidebarItems([a1, loose, a2]);

  it("spans a whole group, not just the row it starts at", () => {
    expect(itemEdgeId(items[0], false)).toBe("a1");
    expect(itemEdgeId(items[0], true)).toBe("a2");
  });

  it("uses a loose session itself on both sides", () => {
    expect(itemEdgeId(items[1], false)).toBe("loose");
    expect(itemEdgeId(items[1], true)).toBe("loose");
  });
});

describe("sessionsInDisplayOrder", () => {
  const a1 = session("a1", { repoMain: "/work/thel" });
  const b1 = session("b1", { repoMain: "/work/site" });
  const a2 = session("a2", { repoMain: "/work/thel" });
  const plain = session("plain");

  it("keeps the flat order when grouping is off", () => {
    expect(
      sessionsInDisplayOrder([a1, b1, plain, a2], false).map((s) => s.id),
    ).toEqual(["a1", "b1", "plain", "a2"]);
  });

  it("follows the grouped sidebar order", () => {
    expect(
      sessionsInDisplayOrder([a1, b1, plain, a2], true).map((s) => s.id),
    ).toEqual(["a1", "a2", "b1", "plain"]);
  });

  it("walks a loose session where it sits, not after every group", () => {
    expect(
      sessionsInDisplayOrder([a1, plain, b1, a2], true).map((s) => s.id),
    ).toEqual(["a1", "a2", "plain", "b1"]);
  });

  it("skips a folded group's sessions", () => {
    expect(
      sessionsInDisplayOrder([a1, b1, plain, a2], true, ["/work/thel"]).map(
        (s) => s.id,
      ),
    ).toEqual(["b1", "plain"]);
  });

  it("falls back to the full order if folding hides every session", () => {
    expect(
      sessionsInDisplayOrder([a1, a2], true, ["/work/thel"]).map((s) => s.id),
    ).toEqual(["a1", "a2"]);
  });
});

describe("sessionNameInGroup", () => {
  it("drops the repo prefix from worktree session names", () => {
    expect(sessionNameInGroup("dashboard.fix-login", "dashboard")).toBe("fix-login");
  });

  it("keeps a session named exactly after the repo", () => {
    expect(sessionNameInGroup("dashboard", "dashboard")).toBe("dashboard");
    expect(sessionNameInGroup("dashboard.", "dashboard")).toBe("dashboard.");
  });

  it("leaves unrelated names alone", () => {
    expect(sessionNameInGroup("dashboards.next", "dashboard")).toBe("dashboards.next");
    expect(sessionNameInGroup("api.v2", "dashboard")).toBe("api.v2");
  });
});
