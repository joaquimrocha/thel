import { useEffect, useState } from "react";
import { Command, defaultFilter } from "cmdk";
import { TerminalSquare, ArrowRight, FolderPlus, Settings, Keyboard } from "lucide-react";
import { addTerminal } from "@/lib/launch";
import { useLaunchers } from "@/store/launchers";
import { useSessions, sessionTerminals } from "@/store/sessions";
import { useUI } from "@/store/ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Section prefixes: typing one narrows the palette to that section, with the
// rest of the query searched within it. Longest first so "set:" wins over "s:".
const SECTIONS = [
  { prefix: "set:", key: "settings" },
  { prefix: "s:", key: "sessions" },
  { prefix: "l:", key: "launchers" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

const sectionFor = (query: string) =>
  SECTIONS.find((s) => query.toLowerCase().startsWith(s.prefix));

function GroupHeading({ title, prefix }: { title: string; prefix: string }) {
  return (
    <span className="flex items-center gap-2">
      {title}
      <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
        {prefix}
      </kbd>
    </span>
  );
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

  const [query, setQuery] = useState("");
  // A fresh palette starts from the seed (e.g. "l:" from the launcher
  // shortcut) or empty, never from the previous query.
  useEffect(() => {
    setQuery(open ? useUI.getState().paletteSeed : "");
  }, [open]);
  const active = sectionFor(query);
  const show = (key: SectionKey) => !active || active.key === key;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center"
      // Score against the query with the section prefix stripped; a bare
      // prefix ("l:") keeps its whole section visible.
      filter={(value, search, keywords) => {
        const m = sectionFor(search);
        const term = m ? search.slice(m.prefix.length).trim() : search;
        return term ? defaultFilter(value, term, keywords) : 1;
      }}
    >
      <div
        className="fixed inset-0 bg-black/50"
        onClick={() => onOpenChange(false)}
      />
      <div className="relative mt-[12vh] w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl">
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Type a command or search sessions..."
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
            No results.
          </Command.Empty>

          {show("sessions") && (
            <Command.Group
              heading={<GroupHeading title="Sessions" prefix="s:" />}
              className="px-1 py-1 text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              <Item onSelect={() => run(openNewSession)}>
                <FolderPlus className="size-4" /> New session…
              </Item>
              {/* Default-launcher terminal in the current session; the
                  per-launcher variants live under Launchers. */}
              {sessions.length > 0 && (
                <Item onSelect={() => run(() => void addTerminal())}>
                  <TerminalSquare className="size-4" /> New terminal
                </Item>
              )}
              {sessions.map((s) => {
                const count = sessionTerminals(s).length;
                return (
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
                      {count} term{count === 1 ? "" : "s"}
                    </span>
                  </Item>
                );
              })}
            </Command.Group>
          )}

          {/* "in current session" only makes sense when one exists. */}
          {show("launchers") && sessions.length > 0 && launchers.length > 0 && (
            <Command.Group
              heading={<GroupHeading title="Launchers" prefix="l:" />}
              className="px-1 py-1 text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              {launchers.map((l) => (
                <Item key={l.id} onSelect={() => run(() => addTerminal(l))}>
                  <TerminalSquare className="size-4" /> {l.name} in current
                  session
                </Item>
              ))}
            </Command.Group>
          )}

          {show("settings") && (
            <Command.Group
              heading={<GroupHeading title="Settings" prefix="set:" />}
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
