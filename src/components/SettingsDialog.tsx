import {
  Keyboard,
  Sun,
  Moon,
  TerminalSquare,
  Palette,
  Rocket,
  FolderCog,
  Users,
  Info,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useUI } from "@/store/ui";
import { useTheme } from "@/store/theme";
import { usePrefs, type SessionsOnClose } from "@/store/prefs";
import { zoomedFontSize } from "@/lib/theme";
import { runsDaemon } from "@/lib/platform";
import { openUrl } from "@/lib/pty";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";

// What a closing window does to the terminals it was showing. The hint below the
// choices describes the selected one.
const SESSIONS_ON_CLOSE: {
  value: SessionsOnClose;
  label: string;
  hint: string;
}[] = [
  {
    value: "keep",
    label: "Keep them running",
    hint: "Terminals carry on in the background and come back with their screen when you reopen thel.",
  },
  {
    value: "stop",
    label: "Stop them",
    hint: "Terminals end with the window that was showing them, along with whatever they were running.",
  },
  {
    value: "ask",
    label: "Ask each time",
    hint: "Closing a window with terminals still running asks what to do, and lets you change your mind.",
  },
];
import { ProfilesSettings } from "@/components/ProfilesSettings";

export function SettingsDialog() {
  const open = useUI((s) => s.settingsOpen);
  const settingsTab = useUI((s) => s.settingsTab);
  const setOpen = useUI((s) => s.setSettingsOpen);
  const openHelp = useUI((s) => s.openHelp);
  const openLaunchers = useUI((s) => s.openLaunchers);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const copyToasts = usePrefs((s) => s.copyToasts);
  const setCopyToasts = usePrefs((s) => s.setCopyToasts);
  const terminalZoom = usePrefs((s) => s.terminalZoom);
  const setTerminalZoom = usePrefs((s) => s.setTerminalZoom);
  const customTitlebar = usePrefs((s) => s.customTitlebar);
  const setCustomTitlebar = usePrefs((s) => s.setCustomTitlebar);
  const newTerminalInSessionDir = usePrefs((s) => s.newTerminalInSessionDir);
  const setNewTerminalInSessionDir = usePrefs(
    (s) => s.setNewTerminalInSessionDir,
  );
  const sessionsOnClose = usePrefs((s) => s.sessionsOnClose);
  const setSessionsOnClose = usePrefs((s) => s.setSessionsOnClose);
  const notifyDesktop = usePrefs((s) => s.notifyDesktop);
  const setNotifyDesktop = usePrefs((s) => s.setNotifyDesktop);
  const notifyBell = usePrefs((s) => s.notifyBell);
  const setNotifyBell = usePrefs((s) => s.setNotifyBell);
  const notifyAgentWaiting = usePrefs((s) => s.notifyAgentWaiting);
  const setNotifyAgentWaiting = usePrefs((s) => s.setNotifyAgentWaiting);
  const notifyCommandFinished = usePrefs((s) => s.notifyCommandFinished);
  const setNotifyCommandFinished = usePrefs((s) => s.setNotifyCommandFinished);

  // Close this modal before opening another dialog/panel so overlays don't stack.
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Tabs key={settingsTab} defaultValue={settingsTab} orientation="vertical" className="flex gap-5">
          <TabsList className="flex h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-1 bg-transparent p-0">
            <TabsTrigger value="appearance" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <Palette className="size-4" /> Appearance
            </TabsTrigger>
            <TabsTrigger value="terminal" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <TerminalSquare className="size-4" /> Terminal
            </TabsTrigger>
            <TabsTrigger value="sessions" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <FolderCog className="size-4" /> Sessions
            </TabsTrigger>
            <TabsTrigger value="notifications" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <Bell className="size-4" /> Notifications
            </TabsTrigger>
            <TabsTrigger value="profiles" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <Users className="size-4" /> Profiles
            </TabsTrigger>
            <TabsTrigger value="launchers" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <Rocket className="size-4" /> Launchers
            </TabsTrigger>
            <TabsTrigger value="keyboard" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <Keyboard className="size-4" /> Keyboard
            </TabsTrigger>
            <TabsTrigger value="about" className="justify-start gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <Info className="size-4" /> About
            </TabsTrigger>
          </TabsList>

          <div
            data-testid="settings-tab-content"
            className="min-h-[16rem] max-h-[60vh] flex-1 overflow-y-auto"
          >
            <TabsContent value="appearance" className="mt-0 space-y-3">
              <div className="flex gap-1">
                <Button
                  variant={theme === "light" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTheme("light")}
                >
                  <Sun className="size-4" /> Light
                </Button>
                <Button
                  variant={theme === "dark" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTheme("dark")}
                >
                  <Moon className="size-4" /> Dark
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={customTitlebar}
                  onCheckedChange={setCustomTitlebar}
                />
                Use thel's own window decoration
              </label>
            </TabsContent>

            <TabsContent value="terminal" className="mt-0 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={copyToasts} onCheckedChange={setCopyToasts} />
                Show a toast when copying
              </label>
              <div className="flex items-center gap-2 text-sm">
                <span>Default zoom</span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setTerminalZoom(terminalZoom - 1)}
                  aria-label="Decrease default zoom"
                >
                  −
                </Button>
                <span className="w-12 text-center tabular-nums">
                  {zoomedFontSize(terminalZoom)}px
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setTerminalZoom(terminalZoom + 1)}
                  aria-label="Increase default zoom"
                >
                  +
                </Button>
                {terminalZoom !== 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setTerminalZoom(0)}>
                    Reset
                  </Button>
                )}
              </div>
            </TabsContent>

            <TabsContent value="sessions" className="mt-0 space-y-4">
              {runsDaemon && (
                <div className="space-y-1.5">
                  <p className="text-sm">When you close a window</p>
                  <div
                    role="radiogroup"
                    aria-label="When you close a window"
                    className="flex gap-1.5"
                  >
                    {SESSIONS_ON_CLOSE.map((o) => (
                      <button
                        key={o.value}
                        role="radio"
                        aria-checked={sessionsOnClose === o.value}
                        onClick={() => setSessionsOnClose(o.value)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs transition-colors",
                          sessionsOnClose === o.value
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {
                      SESSIONS_ON_CLOSE.find((o) => o.value === sessionsOnClose)
                        ?.hint
                    }{" "}
                    If thel crashes instead, they survive either way and come
                    back when you reopen it.
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={newTerminalInSessionDir}
                    onCheckedChange={setNewTerminalInSessionDir}
                  />
                  Always open terminals in the session's folder
                </label>
                <p className="pl-9 text-xs text-muted-foreground">
                  A new terminal otherwise opens wherever the one you were last
                  in had got to, and falls back to the session's folder when the
                  shell doesn't report its directory.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="notifications" className="mt-0 space-y-4">
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={notifyDesktop}
                    onCheckedChange={setNotifyDesktop}
                  />
                  Desktop notifications
                </label>
                <p className="pl-9 text-xs text-muted-foreground">
                  Show an OS notification when a background terminal wants you
                  and the window isn't focused. The in-app notification list
                  works regardless.
                </p>
              </div>
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Notify me when…
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={notifyBell} onCheckedChange={setNotifyBell} />
                  A program rings the terminal bell
                </label>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={notifyAgentWaiting}
                      onCheckedChange={setNotifyAgentWaiting}
                    />
                    An agent finishes and waits for input
                  </label>
                  <p className="pl-9 text-xs text-muted-foreground">
                    Best-effort: detected from the terminal going quiet after
                    activity. Turn off if it fires at the wrong time.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={notifyCommandFinished}
                    onCheckedChange={setNotifyCommandFinished}
                  />
                  A command finishes in a background terminal
                </label>
              </div>
              <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                Notify from a script with{" "}
                <code className="rounded bg-muted px-1 font-mono">thel notify</code>
                .{" "}
                <button
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() =>
                    void openUrl(
                      "https://github.com/joaquimrocha/thel/blob/main/docs/notifications.md",
                    )
                  }
                >
                  Learn more
                </button>
              </p>
            </TabsContent>

            <TabsContent value="profiles" className="mt-0">
              <ProfilesSettings />
            </TabsContent>

            <TabsContent value="launchers" className="mt-0 space-y-3">
              <p className="text-sm text-muted-foreground">
                Command profiles (Claude, a shell, …) you can launch into a
                session.
              </p>
              <Button variant="outline" size="sm" onClick={go(openLaunchers)}>
                <TerminalSquare className="size-4" /> Manage launchers…
              </Button>
            </TabsContent>

            <TabsContent value="keyboard" className="mt-0 space-y-3">
              <p className="text-sm text-muted-foreground">
                View and rebind keyboard shortcuts.
              </p>
              <Button variant="outline" size="sm" onClick={go(openHelp)}>
                <Keyboard className="size-4" /> Edit shortcuts…
              </Button>
            </TabsContent>

            <TabsContent value="about" className="mt-0 space-y-4">
              <div className="flex items-center gap-4">
                <Logo className="size-14 shrink-0 text-emerald-500" />
                <div className="space-y-1">
                  <p className="text-base font-semibold">thel</p>
                  <p className="text-sm text-muted-foreground">
                    Terminal helper built for AI coding agents and other
                    long-running sessions
                  </p>
                </div>
              </div>
              <dl className="space-y-1 text-sm">
                <div className="flex gap-3">
                  <dt className="w-16 text-muted-foreground">Version</dt>
                  <dd className="font-mono">{__APP_VERSION__}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-16 text-muted-foreground">Git tag</dt>
                  <dd className="font-mono">{__GIT_TAG__ || "unknown"}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-16 text-muted-foreground">Website</dt>
                  <dd>
                    <button
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={() =>
                        void openUrl("https://github.com/joaquimrocha/thel")
                      }
                    >
                      github.com/joaquimrocha/thel
                    </button>
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-16 text-muted-foreground">Author</dt>
                  <dd>
                    <button
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={() => void openUrl("https://joaquimrocha.com")}
                    >
                      Joaquim Rocha
                    </button>
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-16 text-muted-foreground">License</dt>
                  <dd>Apache-2.0</dd>
                </div>
              </dl>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
