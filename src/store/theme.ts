import { create } from "zustand";

export type Theme = "light" | "dark";

const KEY = "thel.theme";

function read(): Theme {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  return v === "light" || v === "dark" ? v : "dark";
}

// Toggle the `dark` class shadcn's CSS variables key off (see index.css).
function apply(theme: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

const initial = read();
// Apply at module load so the right palette is in place before first paint.
apply(initial);

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  theme: initial,
  setTheme: (theme) => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // ignore (private mode, etc.)
    }
    apply(theme);
    set({ theme });
  },
}));
