import { homeDir } from "./pty";

// Cache $HOME once so display helpers can run synchronously during render.
let home: string | null = null;
void homeDir()
  .then((h) => {
    home = h;
  })
  .catch(() => {});

/** Replace a leading $HOME with "~" for display. No-op outside home. */
export function abbreviatePath(p?: string | null): string {
  if (!p) return "";
  if (home && (p === home || p.startsWith(home + "/"))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** Expand a leading "~" back to $HOME before sending a path to the backend. */
export function expandPath(p: string): string {
  if (home && (p === "~" || p.startsWith("~/"))) {
    return home + p.slice(1);
  }
  return p;
}
