import { create } from "zustand";

/** What to do with a window's terminals, once the user has been asked. */
export type QuitChoice = "keep" | "stop" | "cancel";

export interface QuitPrompt {
  terminals: number;
  sessions: number;
}

// The close handler awaits the user's answer, so the promise it is waiting on
// lives here rather than in the dialog, which unmounts and remounts freely.
let resolve: ((choice: QuitChoice) => void) | null = null;

interface QuitPromptState {
  prompt: QuitPrompt | null;
  answer: (choice: QuitChoice) => void;
}

export const useQuitPrompt = create<QuitPromptState>((set) => ({
  prompt: null,
  answer: (choice) => {
    set({ prompt: null });
    const done = resolve;
    resolve = null;
    done?.(choice);
  },
}));

/**
 * Show the quit prompt and wait for an answer. A second call while one is open
 * cancels: the window is already asking, and closing twice makes no sense.
 */
export function askQuitSessions(prompt: QuitPrompt): Promise<QuitChoice> {
  if (resolve) return Promise.resolve("cancel");
  return new Promise<QuitChoice>((r) => {
    resolve = r;
    useQuitPrompt.setState({ prompt });
  });
}
