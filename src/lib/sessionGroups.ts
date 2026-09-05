import type { Session } from "@/store/sessions";

/** Sessions of one repo, in sidebar order. `name` is the repo folder's name. */
export interface RepoGroup {
  key: string;
  name: string;
  sessions: Session[];
}

/**
 * Split the sidebar's sessions into one group per repo plus the sessions in no
 * repo. Groups appear in the order their first session does, so reordering
 * sessions also reorders groups. A session whose repo is still being resolved
 * groups by its own checkout until then.
 */
export function groupSessionsByRepo(sessions: Session[]): {
  groups: RepoGroup[];
  rest: Session[];
} {
  const groups: RepoGroup[] = [];
  const byKey = new Map<string, RepoGroup>();
  const rest: Session[] = [];
  for (const s of sessions) {
    const key = s.repoMain ?? s.repoRoot;
    if (!key) {
      rest.push(s);
      continue;
    }
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: lastSegment(key), sessions: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.sessions.push(s);
  }
  return { groups, rest };
}

/**
 * The sessions in the order the sidebar lays them out: grouped by repo when
 * grouping is on, otherwise the plain order. `collapsedRepos` (group keys)
 * hides folded groups' sessions, so keyboard navigation only visits what's
 * on screen and a folded group doesn't spring open as you pass through it.
 * If every session would be hidden this way (every group folded, nothing
 * ungrouped), falls back to the full list so navigation is never a no-op.
 */
export function sessionsInDisplayOrder(
  sessions: Session[],
  grouping: boolean,
  collapsedRepos: string[] = [],
): Session[] {
  if (!grouping) return sessions;
  const { groups, rest } = groupSessionsByRepo(sessions);
  const visible = [
    ...groups.flatMap((g) => (collapsedRepos.includes(g.key) ? [] : g.sessions)),
    ...rest,
  ];
  return visible.length > 0
    ? visible
    : [...groups.flatMap((g) => g.sessions), ...rest];
}

/**
 * A session's name as shown inside its repo group: worktree checkouts are
 * usually named "<repo>.<branch>", and the group header already says the repo,
 * so drop that prefix. A session named exactly after the repo keeps its name.
 */
export function sessionNameInGroup(name: string, groupName: string): string {
  const prefix = `${groupName}.`;
  return name.startsWith(prefix) && name.length > prefix.length
    ? name.slice(prefix.length)
    : name;
}

function lastSegment(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
