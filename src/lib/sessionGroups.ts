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
 * grouping is on (folded groups included, since selecting a session in one
 * unfolds it), otherwise the plain order.
 */
export function sessionsInDisplayOrder(
  sessions: Session[],
  grouping: boolean,
): Session[] {
  if (!grouping) return sessions;
  const { groups, rest } = groupSessionsByRepo(sessions);
  return [...groups.flatMap((g) => g.sessions), ...rest];
}

function lastSegment(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
