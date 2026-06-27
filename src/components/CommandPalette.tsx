import { Command } from "cmdk";
import { TerminalSquare, ArrowRight, FolderPlus, Settings, Keyboard } from "lucide-react";
import { addTerminal } from "@/lib/launch";
import { useLaunchers } from "@/store/launchers";
import { useSessions, sessionTerminals } from "@/store/sessions";
import { useUI } from "@/store/ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const sessions = useSessions((s) => s.sessions);
  const setActiveSession = useSessions((s) => s.setActiveSession);
  const openNewSession = useUI((s) => s.openNewSession);
  const openSettings = useUI((s) => s.openSettings);
  const openLaunchers = useUI((s) => s.openLaunchers);
  const openHelp = useUI((s) => s.openHelp);
  const launchers = useLaunchers((s) => s.launchers);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center"
    >
      <div
        className="fixed inset-0 bg-black/50"
        onClick={() => onOpenChange(false)}
      />
      <div className="relative mt-[12vh] w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl">
        <Command.Input
          autoFocus
          placeholder="Type a command or search sessions..."
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
            No results.
          </Command.Empty>

          <Command.Group
            heading="Launch"
            className="px-1 py-1 text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            <Item onSelect={() => run(openNewSession)}>
              <FolderPlus className="size-4" /> New session…
            </Item>
            {/* "in current session" only makes sense when one exists. */}
            {sessions.length > 0 &&
              launchers.map((l) => (
                <Item key={l.id} onSelect={() => run(() => addTerminal(l))}>
                  <TerminalSquare className="size-4" /> {l.name} in current
                  session
                </Item>
              ))}
          </Command.Group>

          <Command.Group
            heading="Settings"
            className="px-1 py-1 text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            <Item onSelect={() => run(openSettings)}>
              <Settings className="size-4" /> Settings…
            </Item>
            <Item onSelect={() => run(openLaunchers)}>
              <TerminalSquare className="size-4" /> Launchers…
            </Item>
            <Item onSelect={() => run(openHelp)}>
              <Keyboard className="size-4" /> Keyboard shortcuts…
            </Item>
          </Command.Group>

          {sessions.length > 0 && (
            <Command.Group
              heading="Switch to session"
              className="px-1 py-1 text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              {sessions.map((s) => (
                <Item
                  key={s.id}
                  // Append the id so two same-named sessions don't collapse to
                  // one cmdk item (it dedups by value); the name keeps it
                  // searchable.
                  value={`${s.name} ${s.id}`}
                  onSelect={() => run(() => setActiveSession(s.id))}
                >
                  <ArrowRight className="size-4" /> {s.name}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {sessionTerminals(s).length} term
                    {sessionTerminals(s).length === 1 ? "" : "s"}
                  </span>
                </Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

function Item({
  children,
  onSelect,
  value,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  value?: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      {children}
    </Command.Item>
  );
}
