import type { Session } from "@/store/sessions";

/** Sessions of one repo, in sidebar order. `name` is the repo folder's name. */
export interface RepoGroup {
  key: string;
  name: string;
  sessions: Session[];
}

/** A row at the sidebar's top level: a repo group, or a session in no repo. */
export type SidebarItem =
  | { t: "group"; group: RepoGroup }
  | { t: "session"; session: Session };

/**
 * The sidebar's top level, in the order it is drawn: one item per repo group,
 * one per session outside any repo. Both kinds sit where they first appear in
 * the session order, so a group moves when its first session does and a loose
 * session can sit anywhere among the groups rather than being pinned below
 * them. A session whose repo is still being resolved groups by its own
 * checkout until then.
 */
export function sidebarItems(sessions: Session[]): SidebarItem[] {
  const items: SidebarItem[] = [];
  const byKey = new Map<string, RepoGroup>();
  for (const s of sessions) {
    const key = s.repoMain ?? s.repoRoot;
    if (!key) {
      items.push({ t: "session", session: s });
      continue;
    }
    const g = byKey.get(key);
    if (g) {
      g.sessions.push(s);
      continue;
    }
    const created: RepoGroup = { key, name: lastSegment(key), sessions: [s] };
    byKey.set(key, created);
    items.push({ t: "group", group: created });
  }
  return items;
}

/** The sessions an item covers, in order. */
export function itemSessions(item: SidebarItem): Session[] {
  return item.t === "group" ? item.group.sessions : [item.session];
}

/**
 * The id of the session at an item's top (`after` false) or bottom (`after`
 * true) edge, which is what a reorder anchors to when something lands beside
 * the whole item. A group covers a run of sessions, so its edges are its first
 * and last, not just the row it starts at.
 */
export function itemEdgeId(item: SidebarItem, after: boolean): string {
  const covered = itemSessions(item);
  return (after ? covered[covered.length - 1] : covered[0]).id;
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
  const items = sidebarItems(sessions);
  const visible = items.flatMap((it) =>
    it.t === "group" && collapsedRepos.includes(it.group.key)
      ? []
      : itemSessions(it),
  );
  return visible.length > 0 ? visible : items.flatMap(itemSessions);
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
