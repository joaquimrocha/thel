import { describe, expect, it } from "vitest";
import type { Session } from "@/store/sessions";
import {
  groupSessionsByRepo,
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

describe("groupSessionsByRepo", () => {
  it("groups worktrees of one repo under its folder name, in first-seen order", () => {
    const a1 = session("a1", { repoMain: "/work/thel", repoRoot: "/work/thel.feature" });
    const b1 = session("b1", { repoMain: "/work/site", repoRoot: "/work/site" });
    const a2 = session("a2", { repoMain: "/work/thel", repoRoot: "/work/thel" });
    const { groups, rest } = groupSessionsByRepo([a1, b1, a2]);
    expect(groups.map((g) => g.name)).toEqual(["thel", "site"]);
    expect(groups[0].key).toBe("/work/thel");
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a1", "a2"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["b1"]);
    expect(rest).toEqual([]);
  });

  it("leaves sessions outside any repo ungrouped", () => {
    const plain = session("plain");
    const repo = session("repo", { repoMain: "/work/thel" });
    const { groups, rest } = groupSessionsByRepo([plain, repo]);
    expect(groups.map((g) => g.key)).toEqual(["/work/thel"]);
    expect(rest.map((s) => s.id)).toEqual(["plain"]);
  });

  it("falls back to the session's own checkout until its repo is resolved", () => {
    const s = session("s", { repoRoot: "/work/thel.feature/" });
    const { groups } = groupSessionsByRepo([s]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("/work/thel.feature/");
    expect(groups[0].name).toBe("thel.feature");
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

  it("follows the grouped sidebar order, ungrouped sessions last", () => {
    expect(
      sessionsInDisplayOrder([a1, b1, plain, a2], true).map((s) => s.id),
    ).toEqual(["a1", "a2", "b1", "plain"]);
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
