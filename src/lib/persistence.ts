import { load, type Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { debouncedWriter } from "@/lib/persistDebounce";
import { storeFile } from "@/lib/storeFile";
import {
  useSessions,
  type SessionState,
  type LayoutNode,
  type Session,
  type Terminal,
} from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";

// Each profile keeps its own session layout. The default profile keeps the
// original filename so existing layouts are preserved. Computed from the window
// label here (not via the profiles store) to avoid an import cycle.
function profileIdFromWindow(): string {
  const label = getCurrentWindow().label;
  return label === "main" ? "default" : label.replace(/^profile-/, "");
}
function layoutFileFor(id: string): string {
  return storeFile(
    id === "default" ? "thel-layout.json" : `thel-layout-${id}.json`,
  );
}
const layoutFile = () => layoutFileFor(profileIdFromWindow());
const KEY = "layout";

// Set when hydrateSessions couldn't read the saved layout. It gates persistence
// off (see startPersistence) so we never overwrite a file we failed to load and
// destroy a possibly-recoverable layout.
let hydrationFailed = false;

// hydrateSessions is a one-shot startup step; guard against a second run (React
// StrictMode double-invokes the effect in dev) so it can't restore twice or
// raise the corrupt-layout prompt twice.
let hydrationStarted = false;

// Only structural fields are persisted; runtime state (started/exited/output)
// is intentionally dropped so restored terminals come back idle.
interface PersistedTerminal {
  id: string;
  title: string;
  defaultTitle?: string;
  renamed?: boolean;
  command: string;
  args: string[];
  cwd?: string;
  zoom?: number;
}

// Project a live terminal down to just its persisted fields, dropping runtime
// state (started/busy/attention/exited/procTitle). Used by both serialize and
// clonePersisted so the persisted shape is defined once.
export function toPersistedTerminal(t: Terminal): PersistedTerminal {
  return {
    id: t.id,
    title: t.title,
    defaultTitle: t.defaultTitle,
    renamed: t.renamed,
    command: t.command,
    args: t.args,
    cwd: t.cwd,
    zoom: t.zoom,
  };
}

interface PersistedGroup {
  id: string;
  terminals: PersistedTerminal[];
  activeTerminalId?: string;
}

interface PersistedSession {
  id: string;
  name: string;
  cwd?: string;
  repoRoot?: string;
  icon?: string;
  groups?: PersistedGroup[];
  layout?: LayoutNode;
  activeGroupId?: string;
  // Legacy (pre-split) layout: a flat terminal list on the session.
  terminals?: PersistedTerminal[];
  activeTerminalId?: string;
}

interface PersistedLayout {
  sessions: PersistedSession[];
  activeSessionId?: string;
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  return (storePromise ??= load(layoutFile(), { autoSave: false, defaults: {} }));
}

/**
 * Load the saved layout into the store. With the daemon (the default), restored
 * terminals come back started so they reattach immediately without flashing
 * their Start card; with a direct PTY they wait unless auto-start is on.
 */
export async function hydrateSessions(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  // Held outside the try so the failure handler can offer to set it aside.
  let raw: PersistedLayout | undefined;
  try {
    const store = await getStore();
    raw = await store.get<PersistedLayout>(KEY);
    if (!raw?.sessions?.length) return;
    const layout = raw;
    // With the daemon, every restored terminal comes back started: `open` is
    // attach-if-alive-else-respawn, so it reattaches a surviving shell or spawns
    // a fresh one at its cwd. With a direct PTY there's nothing to reattach, so
    // start them only if the user opted into auto-start.
    const useDaemon = usePrefs.getState().useDaemon;
    const autoStart = !useDaemon && usePrefs.getState().autoStartTerminals;
    const restoreTerminal = (t: PersistedTerminal) => ({
      id: t.id,
      title: t.title,
      defaultTitle: t.defaultTitle ?? t.title,
      renamed: t.renamed,
      command: t.command,
      args: t.args,
      cwd: t.cwd,
      zoom: t.zoom,
      started: useDaemon || autoStart,
    });
    useSessions.setState({
      activeSessionId: layout.activeSessionId,
      sessions: layout.sessions.map((s) => {
        // Migrate legacy flat layouts into a single split group.
        const groups = (
          s.groups ?? [
            {
              id: crypto.randomUUID(),
              terminals: s.terminals ?? [],
              activeTerminalId: s.activeTerminalId,
            },
          ]
        ).map((g) => ({
          id: g.id,
          activeTerminalId: g.activeTerminalId,
          terminals: g.terminals.map(restoreTerminal),
        }));
        // Use the saved split tree, or build a left-to-right row from the panes
        // for layouts saved before splits existed.
        const layout: LayoutNode =
          s.layout ??
          (groups.length === 1
            ? { t: "leaf", group: groups[0].id }
            : {
                t: "split",
                dir: "row",
                children: groups.map((g) => ({ t: "leaf", group: g.id })),
              });
        return {
          id: s.id,
          name: s.name,
          cwd: s.cwd,
          repoRoot: s.repoRoot,
          icon: s.icon,
          groups,
          layout,
          activeGroupId: s.activeGroupId ?? groups[0].id,
        };
      }),
    });
  } catch (e) {
    console.error("failed to restore layout", e);
    // Keep persistence from overwriting the unreadable file (see
    // startPersistence). Let the user recover it manually or set it aside and
    // start saving again.
    hydrationFailed = true;
    useUI.getState().requestConfirm({
      title: "Couldn't restore your saved layout",
      description:
        "Your saved session layout couldn't be read. Cancel to leave it untouched so it can be recovered (new sessions won't be saved this run), or start fresh to set it aside and begin saving again.",
      confirmLabel: "Start fresh",
      onConfirm: () => void discardCorruptLayout(raw),
    });
  } finally {
    // Mark hydration done (even when there was nothing to restore) so the
    // "No sessions" empty state can show without flashing during load.
    useSessions.setState({ hydrated: true });
  }
}

// Set the unreadable layout aside (copied to a sibling file so it can still be
// recovered by hand), reset the live layout, and resume persistence so the app
// saves again. Best-effort: a file the store plugin can't even open can't be
// reset from here, but the common case (a valid file whose shape drifted) can.
async function discardCorruptLayout(raw: PersistedLayout | undefined): Promise<void> {
  try {
    if (raw !== undefined) {
      const backup = await load(layoutFile().replace(/\.json$/, ".corrupt.json"), {
        autoSave: false,
        defaults: {},
      });
      await backup.set(KEY, raw);
      await backup.save();
    }
    const store = await getStore();
    await store.clear();
    await store.save();
  } catch (e) {
    console.error("failed to set aside corrupt layout", e);
  }
  // Resume saving and write the current (fresh) state right away.
  hydrationFailed = false;
  lastSaved = null;
  writer.schedule(serialize(useSessions.getState()));
}

// Deep-clone a session's layout tree, remapping pane-group ids.
function remapLayout(node: LayoutNode, groupIds: Map<string, string>): LayoutNode {
  if (node.t === "leaf") {
    return { t: "leaf", group: groupIds.get(node.group) ?? node.group };
  }
  return {
    t: "split",
    dir: node.dir,
    children: node.children.map((c) => remapLayout(c, groupIds)),
  };
}

// Build a persisted layout from live sessions with fresh ids, so a copied
// profile is structurally identical but independent (its terminals are new and
// won't reattach to the originals' daemon sessions).
function clonePersisted(sessions: Session[]): PersistedLayout {
  const out = sessions.map((s) => {
    const groupIds = new Map<string, string>();
    const groups = s.groups.map((g) => {
      const gid = crypto.randomUUID();
      groupIds.set(g.id, gid);
      const termIds = new Map<string, string>();
      const terminals = g.terminals.map((t) => {
        const tid = crypto.randomUUID();
        termIds.set(t.id, tid);
        // Fresh id so the copy is independent; the rest is the persisted shape.
        return { ...toPersistedTerminal(t), id: tid };
      });
      return {
        id: gid,
        activeTerminalId: g.activeTerminalId
          ? termIds.get(g.activeTerminalId)
          : undefined,
        terminals,
      };
    });
    return {
      id: crypto.randomUUID(),
      name: s.name,
      cwd: s.cwd,
      repoRoot: s.repoRoot,
      icon: s.icon,
      layout: remapLayout(s.layout, groupIds),
      activeGroupId: groupIds.get(s.activeGroupId),
      groups,
    };
  });
  return { sessions: out, activeSessionId: out[0]?.id };
}

/** Copy this window's current session layout into another profile's file. */
export async function copyLayoutToProfile(profileId: string): Promise<void> {
  const sessions = useSessions.getState().sessions;
  if (!sessions.length) return;
  try {
    const store = await load(layoutFileFor(profileId), {
      autoSave: false,
      defaults: {},
    });
    await store.set(KEY, clonePersisted(sessions));
    await store.save();
  } catch (e) {
    console.error("failed to copy layout to profile", e);
  }
}

function serialize(state: SessionState): PersistedLayout {
  return {
    activeSessionId: state.activeSessionId,
    sessions: state.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      repoRoot: s.repoRoot,
      icon: s.icon,
      layout: s.layout,
      activeGroupId: s.activeGroupId,
      groups: s.groups.map((g) => ({
        id: g.id,
        activeTerminalId: g.activeTerminalId,
        terminals: g.terminals.map(toPersistedTerminal),
      })),
    })),
  };
}

let lastSaved: string | null = null;

async function persist(layout: PersistedLayout): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, layout);
    await store.save();
  } catch (e) {
    console.error("failed to save layout", e);
  }
}

const writer = debouncedWriter(persist, 400);

/** Write any pending layout change immediately (e.g. before the app closes). */
export const flushSessions = writer.flush;

/**
 * Subscribe to store changes and persist them, debounced. Skips writes when no
 * persisted field changed, so high-frequency runtime updates (busy polling, git
 * refresh, attention) don't churn the layout file. Returns unsubscribe.
 */
export function startPersistence(): () => void {
  return useSessions.subscribe((state) => {
    // A failed hydration left the on-disk layout unreadable; don't overwrite it
    // until the user starts fresh (discardCorruptLayout clears this).
    if (hydrationFailed) return;
    const layout = serialize(state);
    const json = JSON.stringify(layout);
    if (json === lastSaved) return;
    lastSaved = json;
    writer.schedule(layout);
  });
}
