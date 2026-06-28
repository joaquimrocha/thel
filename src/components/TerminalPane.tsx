import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  createSession,
  writeSession,
  resizeSession,
  closeSession,
  terminalBusy,
  openUrl,
  daemonOptedOut,
} from "@/lib/pty";
import {
  useSessions,
  sessionTerminals,
  type Terminal as TerminalTab,
} from "@/store/sessions";
import { useUI } from "@/store/ui";
import { notify, useNotifications } from "@/store/notifications";
import { markInput, markOutput, clearActivity, busyAgeMs, markBusy } from "@/lib/activity";
import { appFocused } from "@/lib/focus";
import { copyText, pasteText, dedent } from "@/lib/clipboard";
import { comboMatches } from "@/lib/keymap";
import { effectiveCombo, shortcutLabel } from "@/store/keybindings";
import { usePrefs } from "@/store/prefs";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import {
  TERMINAL_THEME,
  getTerminalFont,
  loadTerminalFont,
  zoomedFontSize,
} from "@/lib/theme";

// Strips escape/control sequences; matches CSI, OSC and other ESC-introduced
// sequences so what's left is just printable content.
// eslint-disable-next-line no-control-regex
const ESC_SEQ =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;

// Whether a data chunk carries actual screen content (a printable character)
// rather than only control sequences. a multiplexer broadcasts a cursor-visibility update
// to every attached client whenever another client attaches; treating that as
// output would make every other terminal flag itself "finished".
function hasVisibleOutput(data: string): boolean {
  for (const ch of data.replace(ESC_SEQ, "")) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c !== 0x7f) return true;
  }
  return false;
}

// Transient "Copied" toast after a terminal copy, if the user enabled it.
function notifyCopied(dedented: boolean) {
  if (usePrefs.getState().copyToasts) {
    toast(dedented ? "Copied (no indentation)" : "Copied", {
      duration: 1500,
      // Semi-transparent (! overrides the Toaster's solid bg-popover) so the
      // brief copy confirmation is less obtrusive over terminal output.
      className: "!bg-popover/80 backdrop-blur-sm",
    });
  }
}

// Copy the terminal's selection (optionally dedented), shared by the copy
// shortcut and the right-click menu.
function copyTermSelection(term: Terminal, mode: "raw" | "dedent") {
  const sel = term.getSelection();
  if (!sel) return;
  void copyText(mode === "dedent" ? dedent(sel) : sel);
  notifyCopied(mode === "dedent");
}

// Paste the clipboard into the terminal, shared by the paste shortcut and menu.
function pasteIntoTerm(term: Terminal) {
  void pasteText().then((t) => {
    if (t) term.paste(t);
  });
}

// Construct an xterm with thel's addons (fit, system-browser links, Unicode 11
// widths, and a WebGL renderer that falls back to DOM), open it in `container`,
// and fit it. `onLinkHover` tracks the URL under the pointer (null on leave) so
// the context menu can offer "Copy URL".
function createXterm(
  container: HTMLDivElement,
  zoom: number,
  onLinkHover: (uri: string | null) => void,
): { term: Terminal; fit: FitAddon } {
  const font = getTerminalFont();
  const term = new Terminal({
    fontFamily: font.fontFamily,
    fontSize: zoomedFontSize(zoom),
    cursorBlink: true,
    allowProposedApi: true,
    // Matches a common default history limit. Kept modest to bound per-terminal
    // memory (each line costs cells + WebGL textures); make configurable later.
    scrollback: 2000,
    theme: TERMINAL_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Open links in the system browser; the webview's default window.open (what
  // WebLinksAddon uses otherwise) does nothing under WebKitGTK.
  term.loadAddon(
    new WebLinksAddon((_e, uri) => void openUrl(uri), {
      // React bails out when the value is unchanged, so per-move hovers are cheap.
      hover: (_e, uri) => onLinkHover(uri),
      leave: () => onLinkHover(null),
    }),
  );
  // Use Unicode 11 width tables so emoji and other wide glyphs occupy two cells;
  // otherwise the next character overlaps them.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(container);
  try {
    // GPU-accelerated renderer; dispose on context loss to fall back to DOM.
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // WebGL unavailable (e.g. headless/software GL); DOM renderer is fine.
  }
  fit.fit();
  return { term, fit };
}

export function TerminalPane({
  terminal: tab,
  visible,
  focused,
}: {
  terminal: TerminalTab;
  // Shown in its column (the active tab of its split group, session active).
  visible: boolean;
  // Has keyboard focus (visible AND its split group is the active one).
  focused: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Drives the enabled state of the right-click Copy items.
  const [hasSelection, setHasSelection] = useState(false);
  // The URL currently under the pointer (from the link addon's hover), so the
  // right-click menu can offer "Copy URL" when you click on a link.
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const markExited = useSessions((s) => s.markExited);
  const setAttention = useSessions((s) => s.setAttention);
  const setProcTitle = useSessions((s) => s.setProcTitle);
  const closeTerminal = useSessions((s) => s.closeTerminal);
  const clearNotifications = useNotifications((s) => s.clearForTerminal);

  // Read inside event handlers that were registered once; these change over the
  // pane's life. A terminal is "watched" when it's visible on screen AND the app
  // window is focused; otherwise activity warrants a notification (this is what
  // makes a terminal notify when it's a background tab or you've switched apps).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  // Effective zoom (px offset from the system font): the terminal's own zoom, or
  // the default for ones not individually zoomed. The default is read once at
  // mount (not subscribed) so changing it in Settings only affects terminals
  // opened afterward, never ones already on screen. The ref keeps the
  // once-mounted async font handler from reading a stale value.
  const defaultZoom = useRef(usePrefs.getState().terminalZoom).current;
  const zoom = tab.zoom ?? defaultZoom;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const watched = () => visibleRef.current && appFocused();
  // Fires when an unfocused terminal goes quiet after output (command done).
  const idleTimer = useRef<number | undefined>(undefined);
  // Ignore attention from the redraw a resize (SIGWINCH) provokes until this ms.
  const resizeQuietUntil = useRef(0);

  // Create the terminal + session exactly once; the pane is kept mounted
  // across tab switches so scrollback and PTY wiring survive.
  useEffect(() => {
    // Ignore channel messages once this instance is torn down. React StrictMode
    // (dev) mounts twice: the first child is spawned then killed on cleanup, and
    // its real exit must NOT mark the (re-spawned) terminal as exited.
    let closed = false;
    const { term, fit } = createXterm(
      containerRef.current!,
      zoomRef.current,
      setLinkUrl,
    );
    termRef.current = term;
    fitRef.current = fit;

    // Clipboard, handled here (not the global shortcut handler) because it needs
    // the focused terminal's selection. The combos are the rebindable terminal-*
    // shortcuts (defaults: Ctrl+Shift+C / V, Ctrl+Alt+C; ⌘ on macOS), read live
    // so they track the shortcuts panel. xterm paints to a canvas, so the
    // browser's native copy can't see the selection; preventDefault stops the
    // webview from also copying/pasting.
    const matches = (e: KeyboardEvent, id: string) => {
      const c = effectiveCombo(id);
      return !!c && comboMatches(e, c);
    };
    // Drop this terminal's attention dot once you're attending it. Guarded so an
    // ordinary keystroke doesn't churn the store.
    const clearAttention = () => {
      const has = useSessions
        .getState()
        .sessions.some((s) =>
          sessionTerminals(s).some((t) => t.id === tab.id && t.attention),
        );
      if (has) setAttention(tab.id, false);
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // A real keystroke means you're attending this terminal. Done here, not in
      // onData, because onData also fires for xterm's automatic replies to
      // terminal queries (which some programs provoke) and those must not clear the dot.
      clearAttention();
      // Shift+PageUp/PageDown page through xterm's scrollback; plain
      // PageUp/PageDown still reach the program. Exclude Ctrl/Alt so the
      // tab/session move shortcuts (Ctrl+Shift+PageUp etc.) still get through.
      if (
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "PageUp" || e.key === "PageDown")
      ) {
        e.preventDefault();
        term.scrollPages(e.key === "PageUp" ? -1 : 1);
        return false;
      }
      if (matches(e, "terminal-copy-dedent")) {
        e.preventDefault();
        copyTermSelection(term, "dedent");
        return false;
      }
      if (matches(e, "terminal-copy")) {
        e.preventDefault();
        copyTermSelection(term, "raw");
        return false;
      }
      if (matches(e, "terminal-paste")) {
        e.preventDefault();
        pasteIntoTerm(term);
        return false;
      }
      return true;
    });

    // Mouse-wheel scroll is left to xterm: the daemon (and the direct PTY) keep
    // the scrollback in xterm itself, so its native wheel handling scrolls
    // history on the normal screen and alternate-scrolls full-screen apps.

    // Settle the terminal on program exit (delivered as the channel's exit
    // message). Guarded so it runs once.
    let exitHandled = false;
    // Throttle for sampling foreground state while output flows (see below).
    let lastBusySample = 0;
    const handleExit = () => {
      if (exitHandled) return;
      exitHandled = true;
      closeTerminal(tab.id);
    };

    createSession(
      {
        id: tab.id,
        command: tab.command,
        args: tab.args,
        cwd: tab.cwd,
        cols: term.cols,
        rows: term.rows,
        use_daemon: usePrefs.getState().useDaemon && !daemonOptedOut(),
      },
      (msg) => {
        if (closed) return;
        if (msg.kind === "data") {
          term.write(msg.data);
          // Control-only chunks (e.g. a cursor-visibility broadcast when another
          // client attaches) aren't activity and must not trip the working
          // animation or the finished heuristic.
          if (!hasVisibleOutput(msg.data)) return;
          // Record output activity (unless it's an echo of the user's own
          // typing) so the busy poller can animate only while really working.
          markOutput(tab.id);
          // While unwatched the busy poller is paused, so sample the foreground
          // state here (throttled) as output flows. This is what lets the
          // finished heuristic below distinguish a real command that ran and
          // ended from an idle shell that merely got a redraw.
          if (!watched() && Date.now() - lastBusySample > 500) {
            lastBusySample = Date.now();
            terminalBusy(tab.id)
              .then((b) => b && markBusy(tab.id))
              .catch(() => {});
          }
          // Flag the session once an unfocused terminal goes quiet after output.
          // Skip output that's just a resize-triggered redraw.
          if (!watched() && Date.now() >= resizeQuietUntil.current) {
            window.clearTimeout(idleTimer.current);
            idleTimer.current = window.setTimeout(async () => {
              if (watched()) return;
              // Only a real return to the shell prompt counts as "finished". A
              // still-foreground process (an agent thinking, a dev server, an
              // editor) isn't done and would otherwise fire a false alert every
              // time it pauses. Resident agents like claude stay foreground
              // between turns, so they signal turn-completion via the bell
              // (onBell below), not this heuristic.
              const busy = await terminalBusy(tab.id).catch(() => false);
              if (closed || busy || watched()) return;
              // Only signal "finished" if a foreground command actually ran and
              // just ended. An idle shell that merely got a redraw (e.g. a
              // repaint when a sibling terminal opened) was never busy, so it has
              // nothing to report.
              if (busyAgeMs(tab.id) > 8000) return;
              setAttention(tab.id, true);
              notify(tab.id, "idle");
            }, 1000);
          }
        } else {
          handleExit();
        }
      },
    ).catch((e) => {
      if (closed) return;
      term.write(`\r\n\x1b[31mfailed to start session: ${e}\x1b[0m\r\n`);
      markExited(tab.id, null);
    });

    const onDataDisp = term.onData((d) => {
      markInput(tab.id);
      writeSession(tab.id, d).catch(() => {});
    });

    const onSelDisp = term.onSelectionChange(() =>
      setHasSelection(term.hasSelection()),
    );

    // The shell/program sets its title via the OSC title escape, exactly as
    // GNOME Terminal reads it; mirror it onto the tab (unless manually renamed).
    const onTitleDisp = term.onTitleChange((title) =>
      setProcTitle(tab.id, title),
    );

    // Bell = the program (e.g. an agent) wants attention. Flag it unless this
    // pane is the one in focus.
    const onBellDisp = term.onBell(() => {
      if (!watched()) {
        setAttention(tab.id, true);
        notify(tab.id, "bell");
      }
    });

    // When the app regains focus, clear notifications for the focused terminal.
    // The attention dot is left alone: it should linger so you can still see
    // which terminal wanted you, and clear only when you actually attend that
    // terminal (switch to its tab or type into it), not on mere window focus.
    const onWindowFocus = () => {
      if (!focusedRef.current) return;
      clearNotifications(tab.id);
      // On reopen / alt-tab back, the webview parks DOM focus on <body>, so the
      // mount-time focus is lost; restore it to the active terminal. Don't steal
      // focus from an open dialog or text input.
      const ae = document.activeElement;
      if (!ae || ae === document.body) termRef.current?.focus();
    };
    window.addEventListener("focus", onWindowFocus);

    // Clicking into the terminal attends it, so drop its attention dot (typing
    // already clears it via the key handler above). Bare window refocus does
    // not, by design: you dismiss a specific terminal by interacting with it.
    const container = containerRef.current;
    const onPointerDown = () => clearAttention();
    container?.addEventListener("mousedown", onPointerDown);

    let raf = 0;
    const ro = new ResizeObserver(() => {
      // Coalesce bursts of resize events into one fit per frame.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        fit.fit();
        resizeSession(tab.id, term.cols, term.rows).catch(() => {});
        // The resize makes programs redraw; don't treat that as activity.
        resizeQuietUntil.current = Date.now() + 1000;
        window.clearTimeout(idleTimer.current);
      });
    });
    ro.observe(containerRef.current!);

    return () => {
      closed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(idleTimer.current);
      ro.disconnect();
      onDataDisp.dispose();
      onBellDisp.dispose();
      onSelDisp.dispose();
      onTitleDisp.dispose();
      window.removeEventListener("focus", onWindowFocus);
      container?.removeEventListener("mousedown", onPointerDown);
      clearActivity(tab.id);
      closeSession(tab.id).catch(() => {});
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the system font once it resolves, in case this terminal was created
  // before the cache warmed (the very first open after launch).
  useEffect(() => {
    let cancelled = false;
    loadTerminalFont().then((font) => {
      const term = termRef.current;
      if (cancelled || !term) return;
      const size = zoomedFontSize(zoomRef.current);
      if (term.options.fontFamily === font.fontFamily && term.options.fontSize === size) {
        return;
      }
      term.options.fontFamily = font.fontFamily;
      term.options.fontSize = size;
      fitRef.current?.fit();
      resizeSession(tab.id, term.cols, term.rows).catch(() => {});
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply the font size when the zoom changes (Ctrl+± / Ctrl+0, or a change
  // to the default zoom for terminals following it).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const size = zoomedFontSize(zoom);
    if (term.options.fontSize === size) return;
    term.options.fontSize = size;
    fitRef.current?.fit();
    resizeSession(tab.id, term.cols, term.rows).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // When this pane becomes visible it's on screen, so drop its attention dot.
  // Hidden panes keep `visibility` (not `display`), so they keep their layout
  // dimensions and stay fitted in the background.
  useEffect(() => {
    if (visible) {
      window.clearTimeout(idleTimer.current);
      setAttention(tab.id, false);
    }
  }, [visible]);

  // Take keyboard focus when this pane becomes the focused one, and clear its
  // notifications; only the focused terminal counts as attended, so opening a
  // session with splits doesn't wipe the other panes' notifications.
  useEffect(() => {
    if (focused) {
      clearNotifications(tab.id);
      termRef.current?.focus();
    }
  }, [focused]);

  // Refocus the active terminal on request (e.g. leaving sidebar navigation).
  const focusNonce = useUI((s) => s.focusNonce);
  useEffect(() => {
    if (focused && focusNonce) termRef.current?.focus();
  }, [focusNonce, focused]);

  // Right-click menu acts on this exact pane's terminal.
  const copySelection = (mode: "raw" | "dedent") => {
    if (termRef.current) copyTermSelection(termRef.current, mode);
  };
  const pasteClipboard = () => {
    if (termRef.current) pasteIntoTerm(termRef.current);
  };

  // Hidden panes must keep a real size (visibility, not display:none): an
  // xterm in a zero-size container loses its renderer dimensions, which
  // corrupts the cursor/scroll state and leaves a stale frame painted over the
  // prompt when the pane is shown again.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ visibility: visible ? "visible" : "hidden" }}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {linkUrl && (
          <>
            <ContextMenuItem
              onSelect={() => {
                void copyText(linkUrl);
                notifyCopied(false);
              }}
            >
              Copy URL
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem disabled={!hasSelection} onSelect={() => copySelection("raw")}>
          Copy
          <ContextMenuShortcut>{shortcutLabel("terminal-copy")}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => copySelection("dedent")}
        >
          Copy without indentation
          <ContextMenuShortcut>{shortcutLabel("terminal-copy-dedent")}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={pasteClipboard}>
          Paste
          <ContextMenuShortcut>{shortcutLabel("terminal-paste")}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
