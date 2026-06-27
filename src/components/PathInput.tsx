import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { completeDir } from "@/lib/pty";
import { abbreviatePath, expandPath } from "@/lib/paths";

// Folder path input with shell-style directory completion. Suggestions are the
// subdirectories matching what's typed; Tab or Enter completes the highlighted
// one (and appends a "/" so completion can continue), arrows move the highlight.
export function PathInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [items, setItems] = useState<string[]>([]); // absolute paths
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  // Drop stale completion results when the user keeps typing.
  const req = useRef(0);

  useEffect(() => {
    const v = value.trim();
    // The segment being completed is whatever follows the last separator. Only
    // suggest once the user has typed a character of it: stay quiet for the bare
    // "~"/empty default and right after a trailing slash.
    const seg = v.slice(v.lastIndexOf("/") + 1);
    if (seg === "" || seg === "~") {
      setItems([]);
      return;
    }
    const r = ++req.current;
    completeDir(expandPath(v))
      .then((dirs) => {
        if (r !== req.current) return;
        setItems(dirs);
        setSel(0);
      })
      .catch(() => {});
  }, [value]);

  // Fill in a completion: show it abbreviated, with a trailing slash so the next
  // Tab lists its children, and reopen the menu on the new prefix.
  const pick = (abs: string) => {
    onChange(abbreviatePath(abs) + "/");
    setOpen(true);
  };

  // Force-list the current directory's children (ArrowDown), even when the
  // typed-a-character rule would otherwise keep the menu closed. Treats the
  // current value as a directory by completing against a trailing slash.
  const reveal = async () => {
    const v = expandPath(value.trim()) || "/";
    const path = /[/\\]$/.test(v) ? v : v + "/";
    const r = ++req.current;
    const dirs = await completeDir(path).catch(() => null);
    if (dirs == null || r !== req.current) return;
    setItems(dirs);
    setSel(0);
    setOpen(true);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if ((e.key === "Tab" || e.key === "Enter") && open && items.length > 0) {
            // Tab or Enter picks the highlighted folder. stopPropagation keeps
            // Enter from also firing the dialog's "create session"; the menu
            // reopens so you can keep completing into subfolders.
            e.preventDefault();
            e.stopPropagation();
            pick(items[sel] ?? items[0]);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (items.length === 0) {
              void reveal();
            } else {
              setOpen(true);
              setSel((i) => Math.min(i + 1, items.length - 1));
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((i) => Math.max(i - 1, 0));
          } else if (e.key === "Escape" && open) {
            // Close the menu without letting Escape also close the dialog.
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder="/path/to/folder"
        spellCheck={false}
        className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      {open && items.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {items.map((abs, i) => (
            <button
              key={abs}
              type="button"
              // mousedown fires before the input's blur, so the pick registers.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(abs);
              }}
              className={cn(
                "block w-full truncate rounded-sm px-2 py-1 text-left font-mono text-xs",
                i === sel
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50",
              )}
            >
              {abbreviatePath(abs)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
