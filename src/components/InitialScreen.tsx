import { useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bell,
  Columns2,
  GitBranch,
  History,
  Keyboard,
  NotebookPen,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Logo } from "@/components/Logo";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { shortcutLabel, useKeybindings } from "@/store/keybindings";
import { isMac, runsDaemon } from "@/lib/platform";
import { openUrl } from "@/lib/pty";
import { savedLayoutFound } from "@/lib/persistence";
import { cn } from "@/lib/utils";

const SEEN_KEY = "thel.initialScreenSeen";

/** Opens the initial screen on thel's first run: in the main window, when no
 * layout was ever saved. An install that has one was run before, so it is
 * marked as seen without showing it. */
export async function showInitialScreenOnFirstRun() {
  try {
    if (localStorage.getItem(SEEN_KEY) || getCurrentWindow().label !== "main") return;
    const firstRun = !(await savedLayoutFound());
    localStorage.setItem(SEEN_KEY, "1");
    if (firstRun) useUI.getState().setInitialScreenOpen(true);
  } catch {
    // No localStorage: showing it on every start would be worse than never.
  }
}

function Feature({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function Keys({ id, label }: { id: string; label: string }) {
  const keys = shortcutLabel(id);
  if (!keys) return null;
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span>{label}</span>
      <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
    </div>
  );
}

function AgentsPage() {
  const sessionCli = usePrefs((s) => s.sessionCli);
  const setSessionCli = usePrefs((s) => s.setSessionCli);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A program in a thel terminal, such as a coding agent, can open sessions
        and terminals, list them, type into them and edit their notes with{" "}
        <code className="rounded bg-muted px-1 font-mono">thel session</code>.
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
        thel session new -n tests -- npm test --watch
      </pre>
      <div className="space-y-1.5 rounded-md border border-border p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch checked={sessionCli} onCheckedChange={setSessionCli} />
          Let programs in terminals use{" "}
          <code className="rounded bg-muted px-1 font-mono">thel session</code>
        </label>
        <p className="pl-9 text-xs text-muted-foreground">
          Off by default. Programs then act with your user's authority. Closing
          a terminal or a session always asks you first.{" "}
          {isMac
            ? "On macOS thel can't tell a sandboxed program apart, so this covers sandboxed programs too."
            : "A sandboxed program asks you before each request."}{" "}
          You can change this later in Settings &gt; Sessions.
        </p>
      </div>
      <button
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => void openUrl("https://github.com/joaquimrocha/thel/blob/main/docs/session-cli.md")}
      >
        Learn more about thel session
      </button>
    </div>
  );
}

interface Page {
  title: string;
  description: string;
  body: () => ReactNode;
}

// The daemon serves `thel session`, so the page shows only where it runs.
const AGENTS_PAGE: Page = {
  title: "Let agents drive thel",
  description: "Give programs in your terminals a way to manage sessions.",
  body: () => <AgentsPage />,
};

const PAGES: Page[] = [
  {
    title: "Welcome to thel",
    description: "Built for AI coding agents and other long-running sessions.",
    body: () => (
      <div className="space-y-4">
        <Logo className="mx-auto size-16 text-emerald-500" />
        <Feature icon={History} title="Sessions that keep running">
          Terminals live in a background daemon, so they survive closing or
          restarting the app and come back with their screen.
        </Feature>
        <Feature icon={GitBranch} title="Sessions for folders and worktrees">
          Anchor a session to a folder or a git worktree, or create a new
          worktree from the New Session dialog.
        </Feature>
        <Feature icon={Columns2} title="Splits and tabs">
          Split a session into panes, each with its own tabs. Drag tabs to
          reorder them or move them between panes.
        </Feature>
      </div>
    ),
  },
  {
    title: "Know what every terminal is doing",
    description: "thel watches the terminals you aren't looking at.",
    body: () => (
      <div className="space-y-4">
        <Feature icon={Bell} title="Status and notifications">
          A dot shows when a command runs. thel tells you when one finishes, a
          bell rings, or an agent waits for input.
        </Feature>
        <Feature icon={NotebookPen} title="Session notes">
          A markdown scratchpad beside each session, with checklists.
        </Feature>
        <Feature icon={Search} title="Find and copy mode">
          Search a terminal's scrollback, and select and copy it without the
          mouse.
        </Feature>
        <Feature icon={Users} title="Profiles">
          Separate windows, each with its own sessions and accent color.
        </Feature>
      </div>
    ),
  },
  {
    title: "Keyboard first",
    description: "Every major action has a shortcut.",
    body: () => (
      <div className="space-y-4">
        <div className="space-y-2 rounded-md border border-border p-3">
          <Keys id="palette" label="Command palette" />
          <Keys id="new-session" label="New session" />
          <Keys id="new-terminal" label="New terminal" />
          <Keys id="split-pane" label="Split pane" />
          <Keys id="terminal-find" label="Find in output" />
        </div>
        <Feature icon={Keyboard} title="Make them yours">
          Rebind any shortcut in Settings &gt; Keyboard.
        </Feature>
      </div>
    ),
  },
  ...(runsDaemon ? [AGENTS_PAGE] : []),
];

/** The initial screen: a short tour of thel, with the `thel session`
 * consent. Opens on the first run and from Settings > About. */
export function InitialScreen() {
  const open = useUI((s) => s.initialScreenOpen);
  const setOpen = useUI((s) => s.setInitialScreenOpen);
  // Re-render when bindings change so the shown shortcuts stay current.
  useKeybindings((s) => s.overrides);
  const [index, setIndex] = useState(0);
  const next = useRef<HTMLButtonElement>(null);
  const page = PAGES[index];
  const last = index === PAGES.length - 1;
  const close = () => {
    setOpen(false);
    setIndex(0);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent
        className="max-w-lg"
        data-testid="initial-screen"
        // On the way forward, not on the first page dot.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          next.current?.focus();
        }}
      >
        <div className="space-y-1 pr-6">
          <DialogTitle className="text-lg font-semibold">{page.title}</DialogTitle>
          <DialogDescription>{page.description}</DialogDescription>
        </div>
        <div className="min-h-[19rem]">{page.body()}</div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1.5">
            {PAGES.map((p, i) => (
              <button
                key={p.title}
                aria-label={`Go to page ${i + 1}: ${p.title}`}
                aria-current={i === index ? "step" : undefined}
                onClick={() => setIndex(i)}
                className={cn(
                  "size-2 rounded-full transition-colors",
                  i === index ? "bg-primary" : "bg-muted-foreground/30 hover:bg-muted-foreground/60",
                )}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {index > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setIndex(index - 1)}>
                Back
              </Button>
            )}
            <Button
              ref={next}
              size="sm"
              onClick={() => (last ? close() : setIndex(index + 1))}
            >
              {last ? "Get started" : "Next"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
