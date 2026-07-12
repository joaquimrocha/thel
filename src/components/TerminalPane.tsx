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
import { markInput, clearActivity } from "@/lib/activity";
import {
  createTerminalActivity,
  AGENT_QUIET_MS,
  type TerminalActivity,
} from "@/lib/termActivity";
import { appFocused, onFocusGained } from "@/lib/focus";
import {
  copyText,
  pasteText,
  dedent,
  clipboardFiles,
  shellQuote,
} from "@/lib/clipboard";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
import { hasVisibleOutput } from "@/lib/ansi";

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
// Copied files paste as their shell-quoted paths. Checked before text because
// file managers set both (the text form is file:// URIs, useless in a shell).
function pasteIntoTerm(term: Terminal) {
  void (async () => {
    const files = await clipboardFiles();
    if (files.length) {
      term.paste(files.map(shellQuote).join(" "));
      return;
    }
    const t = await pasteText();
    if (t) term.paste(t);
  })();
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
  const setBusy = useSessions((s) => s.setBusy);
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
  // The shared notification state machine (replay gate, bell debounce, idle
  // "finished" alert, busy→working edge). Created in the mount effect and fed by
  // the session callbacks; the visibility/resize effects also reach it.
  const activityRef = useRef<TerminalActivity | null>(null);
  // "Waiting for input" detection for resident agents: a periodic check watches
  // the visible screen *text*. An agent animates while working (a ticking
  // elapsed timer, a spinner) so the text keeps changing; when its turn ends
  // the text goes static even though the cursor stays visible (you can type
  // mid-turn) and a border may still shimmer in colour only. Static text while
  // busy = waiting for you. Cursor visibility can't tell the states apart here,
  // so we don't use it. See the interval in the mount effect. This stays here
  // (not in the shared core) because only a mounted pane has screen text.
  const agentCheck = useRef<number | undefined>(undefined);
  const lastScreen = useRef("");
  const screenChangedAt = useRef(0);
  const agentSawWork = useRef(false);
  const waitingNotified = useRef(false);

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
    const hasAttention = () =>
      useSessions
        .getState()
        .sessions.some((s) =>
          sessionTerminals(s).some((t) => t.id === tab.id && t.attention),
        );
    // Drop this terminal's attention dot once you're attending it. Guarded so an
    // ordinary keystroke doesn't churn the store.
    const clearAttention = () => {
      if (hasAttention()) setAttention(tab.id, false);
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
    const handleExit = () => {
      if (exitHandled) return;
      exitHandled = true;
      closeTerminal(tab.id);
    };

    // The shared notification core: replay gate, bell debounce, idle "finished"
    // alert, and the busy→working edge. watched() reads the same live refs as
    // the rest of the pane; onNotify/onWorking bridge to the store.
    const activity = createTerminalActivity({
      id: tab.id,
      watched,
      onNotify: (kind, text) => notify(tab.id, kind, text),
      onWorking: (working) => setBusy(tab.id, working),
    });
    activityRef.current = activity;

    // Snapshot of the current screen's visible text (colour/cursor ignored), so
    // an agent that only shimmers or blinks while idle reads as unchanged.
    const screenText = (): string => {
      const buf = term.buffer.active;
      let s = "";
      for (let i = 0; i < term.rows; i++) {
        s += (buf.getLine(buf.baseY + i)?.translateToString(true) ?? "") + "\n";
      }
      return s;
    };

    // Poll for the working -> waiting transition: while busy and unwatched,
    // watch the screen text. Each change resets the clock and marks that real
    // work happened; once it holds still for AGENT_QUIET_MS, notify once. A
    // busy-but-static screen from the start (an editor sitting open) never
    // "saw work", so it doesn't fire. Skips reattach replay and bell handling.
    const agentCheckTick = () => {
      if (watched() || !activity.isBusy() || !activity.isReplaySettled()) {
        lastScreen.current = screenText();
        screenChangedAt.current = Date.now();
        agentSawWork.current = false;
        return;
      }
      const scr = screenText();
      if (scr !== lastScreen.current) {
        lastScreen.current = scr;
        screenChangedAt.current = Date.now();
        agentSawWork.current = true;
        waitingNotified.current = false;
        return;
      }
      if (
        agentSawWork.current &&
        !waitingNotified.current &&
        !activity.isBellPending() &&
        Date.now() - screenChangedAt.current >= AGENT_QUIET_MS
      ) {
        waitingNotified.current = true;
        notify(tab.id, "waiting");
      }
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
          const visible = hasVisibleOutput(msg.data);
          // Absorb into the bell window before the write, so a bell inside THIS
          // chunk (armed by onBell during the write) isn't judged by its own
          // trailing text.
          activity.absorbOutputBeforeWrite(visible);
          term.write(msg.data);
          activity.noteOutput(visible);
        } else if (msg.kind === "busy") {
          // Pushed by the daemon (heartbeat while busy, once on going idle).
          activity.noteBusy(msg.busy);
        } else if (msg.kind === "notify") {
          // `thel notify` routed through the daemon (out-of-band, tty-independent).
          // It's a live, explicit request, so it skips the replay gate; suppress
          // only while watched, matching the OSC message path.
          if (!watched()) notify(tab.id, "message", msg.message);
        } else {
          handleExit();
        }
      },
    ).catch((e) => {
      if (closed) return;
      term.write(`\r\n\x1b[31mfailed to start session: ${e}\x1b[0m\r\n`);
      markExited(tab.id, null);
    });

    // Once the user types into a terminal, its bells become real "wants
    // input"/done signals (see notify's startup-bell filter). Set the flag once;
    // markInteracted is idempotent, so the local guard just avoids re-dispatch.
    let interacted = false;
    const onDataDisp = term.onData((d) => {
      markInput(tab.id);
      if (!interacted) {
        interacted = true;
        useSessions.getState().markInteracted(tab.id);
      }
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

    // Bell = the program (e.g. an agent) wants attention. Don't notify on the
    // bell itself: resident agents ring the bell mid-action too. Wait for the
    // terminal to fall quiet; if fresh output follows first, the data handler
    // cancels this. Skip when focused, or when the BEL is just a byte in the
    // reattach replay burst (historical, not a live request).
    const onBellDisp = term.onBell(() => activity.noteBell());

    // Programs can request a desktop notification directly: OSC 9 (iTerm2,
    // what Claude Code's iterm2/auto channel emits), OSC 777;notify (rxvt),
    // OSC 99 (kitty). Unlike a bell this is an explicit ask carrying its own
    // message, so it fires immediately; the replay gate keeps a reattach
    // snapshot from re-notifying with stale messages.
    const oscNotify = (body: string): boolean => {
      activity.noteMessage(body);
      return true;
    };
    const osc9Disp = term.parser.registerOscHandler(9, oscNotify);
    const osc777Disp = term.parser.registerOscHandler(777, (data) => {
      const [k, title, ...rest] = data.split(";");
      if (k !== "notify") return false;
      return oscNotify([title, rest.join(";")].filter(Boolean).join(": "));
    });
    const osc99Disp = term.parser.registerOscHandler(99, (data) => {
      // ponytail: minimal kitty support, payload only; metadata if ever needed.
      const i = data.indexOf(";");
      return oscNotify(i >= 0 ? data.slice(i + 1) : data);
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
    // Via the focus tracker (Tauri-authoritative) rather than the raw DOM
    // `focus` event, which WebKitGTK doesn't reliably emit on OS refocus.
    const offFocusGained = onFocusGained(onWindowFocus);

    // Clicking into the terminal attends it, so drop its attention dot (typing
    // already clears it via the key handler above). Bare window refocus does
    // not, by design: you dismiss a specific terminal by interacting with it.
    const container = containerRef.current;
    const onPointerDown = () => clearAttention();
    container?.addEventListener("mousedown", onPointerDown);

    // Dropping files onto this pane pastes their shell-quoted paths. The
    // webview swallows native HTML5 drops, so the real paths arrive via
    // Tauri's drag-drop event; it's webview-global, so hit-test the (physical)
    // drop position against this pane and ignore drops elsewhere.
    const unlistenDrop = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop" || !visibleRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.payload.position.x / window.devicePixelRatio;
      const y = e.payload.position.y / window.devicePixelRatio;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom)
        return;
      term.paste(e.payload.paths.map(shellQuote).join(" "));
      term.focus();
    });

    let raf = 0;
    const ro = new ResizeObserver(() => {
      // Coalesce bursts of resize events into one fit per frame.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        fit.fit();
        resizeSession(tab.id, term.cols, term.rows).catch(() => {});
        // The resize makes programs redraw; don't treat that as activity.
        activity.noteResize();
      });
    });
    ro.observe(containerRef.current!);

    // Poll the screen once a second for the working -> waiting transition.
    lastScreen.current = screenText();
    screenChangedAt.current = Date.now();
    agentCheck.current = window.setInterval(agentCheckTick, 1000);

    return () => {
      closed = true;
      cancelAnimationFrame(raf);
      window.clearInterval(agentCheck.current);
      activity.dispose();
      ro.disconnect();
      onDataDisp.dispose();
      onBellDisp.dispose();
      osc9Disp.dispose();
      osc777Disp.dispose();
      osc99Disp.dispose();
      onSelDisp.dispose();
      onTitleDisp.dispose();
      offFocusGained();
      container?.removeEventListener("mousedown", onPointerDown);
      unlistenDrop.then((f) => f()).catch(() => {});
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
      activityRef.current?.cancelIdle();
      // Watching this pane; let the next work burst re-establish the baseline.
      agentSawWork.current = false;
      waitingNotified.current = false;
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
