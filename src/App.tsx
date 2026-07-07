import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Titlebar } from "@/components/Titlebar";
import { ResizeHandles } from "@/components/ResizeHandles";
import { SessionSidebar } from "@/components/SessionSidebar";
import { TerminalArea } from "@/components/TerminalSurface";
import { CommandPalette } from "@/components/CommandPalette";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { LaunchersDialog } from "@/components/LaunchersDialog";
import { NotificationsDialog } from "@/components/NotificationsDialog";
import { SessionsDialog } from "@/components/SessionsDialog";
import { DaemonSkewDialog } from "@/components/DaemonSkewDialog";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { SessionSettingsDialog } from "@/components/SessionSettingsDialog";
import { AddIconDialog } from "@/components/AddIconDialog";
import { Toaster } from "@/components/ui/sonner";
import { hydrateSessions, startPersistence, flushSessions } from "@/lib/persistence";
import { checkDaemon, daemonOptedOut } from "@/lib/pty";
import { hydrateLaunchers, startLauncherPersistence, flushLaunchers } from "@/store/launchers";
import { hydrateKeybindings, startKeybindingPersistence, flushKeybindings } from "@/store/keybindings";
import { startIconSync } from "@/store/icons";
import { refreshSessionGit } from "@/lib/launch";
import { useGlobalShortcuts } from "@/lib/useGlobalShortcuts";
import { initFocusTracking, appFocused } from "@/lib/focus";
import { useSessions } from "@/store/sessions";
import { activateNotification } from "@/store/notifications";
import { useUI } from "@/store/ui";
import { usePrefs, initPrefsSync } from "@/store/prefs";
import { useProfiles } from "@/store/profiles";

export default function App() {
  const paletteOpen = useUI((s) => s.paletteOpen);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);

  // Reflect the active session (and non-default profile) in the OS window title.
  const activeName = useSessions((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId)?.name,
  );
  const profileName = useProfiles((s) => {
    const name = s.profiles.find((p) => p.id === s.currentId)?.name;
    // Keep the bare "thel" title for an uncustomized default profile.
    return name === "Default" ? undefined : name;
  });
  useEffect(() => {
    const base = profileName ? `thel · ${profileName}` : "thel";
    getCurrentWindow()
      .setTitle(activeName ? `${base} >_ ${activeName}` : base)
      .catch((e) => console.error("setTitle failed", e));
  }, [activeName, profileName]);

  // Load the profile registry (for the title-bar menu and the window title).
  useEffect(() => {
    void useProfiles.getState().hydrate();
  }, []);

  // Custom title bar means OS decorations off, and vice versa. Sync the window
  // on launch and whenever the preference changes.
  const customTitlebar = usePrefs((s) => s.customTitlebar);
  useEffect(() => {
    getCurrentWindow()
      .setDecorations(!customTitlebar)
      .catch((e) => console.error("setDecorations failed", e));
  }, [customTitlebar]);

  useGlobalShortcuts();

  useEffect(() => {
    void initFocusTracking();
    void initPrefsSync();
  }, []);

  // A clicked OS notification raises this window (in Rust) and emits this with
  // the terminal it was about; switch to that tab.
  useEffect(() => {
    const unlisten = getCurrentWindow().listen<{
      sessionId: string;
      terminalId: string;
    }>("notification-activated", (e) =>
      activateNotification(e.payload.sessionId, e.payload.terminalId),
    );
    return () => void unlisten.then((f) => f());
  }, []);

  // Writes are debounced, so flush any pending change before the window closes
  // (e.g. a session created right before quitting). onCloseRequested awaits this
  // handler and then destroys the window itself (we don't preventDefault), so we
  // just flush and return. Needs the window:allow-destroy capability.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async () => {
      await Promise.allSettled([
        flushSessions(),
        flushLaunchers(),
        flushKeybindings(),
      ]);
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // Restore the saved layout, then start persisting changes. Subscribing only
  // after hydration avoids overwriting the saved file with empty state. First
  // make sure we're not about to talk to an incompatible daemon left by a
  // previous version: if so, prompt to restart it and defer hydration (which
  // would auto-start terminals against it) until the user resolves it.
  useEffect(() => {
    let unsubscribe = () => {};
    void (async () => {
      if (!daemonOptedOut()) {
        const health = await checkDaemon().catch(() => "none" as const);
        if (health === "skew") {
          useUI.getState().setDaemonSkew(true);
          return;
        }
      }
      await hydrateSessions();
      unsubscribe = startPersistence();
      for (const s of useSessions.getState().sessions) void refreshSessionGit(s.id);
    })();
    return () => unsubscribe();
  }, []);

  // Restore + persist launchers.
  useEffect(() => {
    let unsubscribe = () => {};
    hydrateLaunchers().finally(() => {
      unsubscribe = startLauncherPersistence();
    });
    return () => unsubscribe();
  }, []);

  // Restore + persist keyboard shortcut overrides.
  useEffect(() => {
    let unsubscribe = () => {};
    hydrateKeybindings().finally(() => {
      unsubscribe = startKeybindingPersistence();
    });
    return () => unsubscribe();
  }, []);

  // Keep the icon library in sync across profile windows.
  useEffect(() => {
    let unlisten = () => {};
    startIconSync().then((u) => (unlisten = u));
    return () => unlisten();
  }, []);

  // Keep the active session's git branch/dirty state fresh: immediately when it
  // changes, and on a light interval to catch edits made in its terminals.
  useEffect(() => {
    let prev = useSessions.getState().activeSessionId;
    const unsub = useSessions.subscribe((s) => {
      if (s.activeSessionId && s.activeSessionId !== prev) {
        prev = s.activeSessionId;
        void refreshSessionGit(s.activeSessionId);
      }
    });
    const interval = setInterval(() => {
      // No need to spawn git while the user is in another app; refresh resumes
      // on the next tick after they return.
      if (!appFocused()) return;
      const id = useSessions.getState().activeSessionId;
      if (id) void refreshSessionGit(id);
    }, 5000);
    return () => {
      unsub();
      clearInterval(interval);
    };
  }, []);


  return (
    <TooltipProvider delayDuration={400} disableHoverableContent>
    <div
      className={cn(
        "flex h-full flex-col",
        // OS decorations off means no native frame, so the window edge vanishes
        // against a same-coloured desktop; a 1px border draws the outline.
        customTitlebar && "border border-black",
      )}
    >
      {/* With OS decorations off the WM gives no resize borders; add our own. */}
      {customTitlebar && <ResizeHandles />}
      {customTitlebar && <Titlebar />}
      <div className="flex min-h-0 flex-1">
        <SessionSidebar />
        <main className="min-h-0 min-w-0 flex-1">
          <TerminalArea />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <NewSessionDialog />
      <ConfirmDialog />
      <SettingsDialog />
      <LaunchersDialog />
      <NotificationsDialog />
      <SessionsDialog />
      <DaemonSkewDialog />
      <ShortcutsDialog />
      <SessionSettingsDialog />
      <AddIconDialog />
      <Toaster />
    </div>
    </TooltipProvider>
  );
}
