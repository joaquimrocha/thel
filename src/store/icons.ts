import { create } from "zustand";

// Reusable session-icon library. SVGs are stored as markup and rendered via an
// <img> data URI (see SvgIcon), so this is data, not executable. Persisted in
// localStorage (shared across profile windows, isolated from the installed app
// in dev by origin), like prefs/theme.
const KEY = "thel.iconLibrary";

// Six Lucide icons (markup lifted verbatim from lucide-react@0.475.0) so the
// library is useful out of the box without loading anything.
const wrap = (children: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;

export const DEFAULT_ICONS: string[] = [
  wrap('<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>'), // terminal
  wrap('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'), // code
  wrap('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'), // folder
  wrap('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'), // rocket
  wrap('<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'), // server
  wrap('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'), // git-branch
];

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((s) => typeof s === "string"))
        return arr;
    }
  } catch {
    // ignore parse/storage errors; fall back to defaults
  }
  return DEFAULT_ICONS;
}

function save(icons: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(icons));
  } catch {
    // ignore quota
  }
}

interface IconLibrary {
  icons: string[];
  /** Add an SVG to the library (no-op if already present). */
  addIcon: (svg: string) => void;
  /** Drop an SVG from the library. */
  removeIcon: (svg: string) => void;
}

export const useIconLibrary = create<IconLibrary>((set, get) => ({
  icons: load(),
  addIcon: (svg) => {
    if (get().icons.includes(svg)) return;
    const next = [...get().icons, svg];
    save(next);
    set({ icons: next });
  },
  removeIcon: (svg) => {
    const next = get().icons.filter((s) => s !== svg);
    save(next);
    set({ icons: next });
  },
}));
