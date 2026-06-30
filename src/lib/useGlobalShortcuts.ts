import { useEffect } from "react";
import {
  SHORTCUTS,
  matchJumpDigit,
  matchZoom,
  comboMatches,
  comboFromEvent,
} from "@/lib/keymap";
import {
  focusTerminalByIndex,
  zoomActiveTerminal,
  resetActiveTerminalZoom,
} from "@/lib/actions";
import { useKeybindings, effectiveCombo } from "@/store/keybindings";
import { useUI } from "@/store/ui";

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable ||
    !!el.closest(".xterm")
  );
}

function isInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  // xterm holds focus on a hidden helper textarea; that's the normal terminal
  // state, not a form field, so shortcuts must still fire there.
  if (el.closest(".xterm")) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  );
}

function isModalOpen(): boolean {
  const ui = useUI.getState();
  return (
    ui.newSessionOpen ||
    ui.settingsOpen ||
    ui.launchersOpen ||
    ui.notificationsOpen ||
    ui.sessionsOpen ||
    ui.daemonSkew ||
    ui.paletteOpen ||
    ui.helpOpen ||
    ui.profileMenuOpen ||
    ui.sessionSettings !== null ||
    ui.addIconOpen ||
    ui.confirm !== null
  );
}

/**
 * App-wide keyboard shortcuts. Listens in the capture phase so a matched
 * shortcut is handled (and stopped) before the focused terminal's xterm sees
 * it; everything unmatched flows through to the terminal.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const lastRepeatRun = new Map<string, number>();
    const onKey = (e: KeyboardEvent) => {
      // While rebinding a shortcut, capture the next combo instead of acting.
      const recordingId = useKeybindings.getState().recordingId;
      if (recordingId) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          useKeybindings.getState().setRecording(null);
          return;
        }
        const combo = comboFromEvent(e);
        if (combo) useKeybindings.getState().setBinding(recordingId, combo);
        return;
      }

      // Suppress hotkeys while typing in inputs or when a modal is active
      if (isInputFocused() || isModalOpen()) {
        return;
      }

      // Bare "?" opens the shortcuts panel, but not while typing.
      if (
        e.key === "?" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isTyping()
      ) {
        e.preventDefault();
        useUI.getState().openHelp();
        return;
      }

      const digit = matchJumpDigit(e);
      if (digit !== null) {
        e.preventDefault();
        e.stopPropagation();
        focusTerminalByIndex(digit);
        return;
      }

      const zoom = matchZoom(e);
      if (zoom) {
        e.preventDefault();
        e.stopPropagation();
        if (zoom === "reset") resetActiveTerminalZoom();
        else zoomActiveTerminal(zoom === "in" ? 1 : -1);
        return;
      }

      for (const s of SHORTCUTS) {
        // Terminal-scoped shortcuts (copy/paste) are handled in the focused
        // terminal; let the key flow through to xterm.
        if (s.terminalOnly) continue;
        const combo = effectiveCombo(s.id);
        if (combo && comboMatches(e, combo)) {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat && s.repeatThrottleMs) {
            const now = Date.now();
            const last = lastRepeatRun.get(s.id) ?? 0;
            if (now - last < s.repeatThrottleMs) return;
            lastRepeatRun.set(s.id, now);
          } else {
            lastRepeatRun.delete(s.id);
          }
          s.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
