import { useState } from "react";
import { cn, inputClass } from "@/lib/utils";

// Free-text input with a branch suggestion dropdown (recency-ordered). The
// value is still freeform, so any ref can be typed; the list just assists.
// Arrows move the highlight; Enter picks it (instead of submitting the dialog).
export function BranchInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const q = value.trim().toLowerCase();
  const showAll = q === "" || options.includes(value);
  const suggestions = (
    showAll ? options : options.filter((o) => o.toLowerCase().includes(q))
  ).slice(0, 8);

  const pick = (o: string) => {
    onChange(o);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setSel(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && open && suggestions.length > 0) {
            // Pick the highlighted branch. stopPropagation keeps Enter from
            // also firing the dialog's "create session".
            e.preventDefault();
            e.stopPropagation();
            pick(suggestions[sel] ?? suggestions[0]);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setSel((i) => Math.min(i + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((i) => Math.max(i - 1, 0));
          } else if (e.key === "Escape" && open) {
            // Close the menu without letting Escape also close the dialog.
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        className={inputClass}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {suggestions.map((o, i) => (
            <button
              key={o}
              type="button"
              // mousedown fires before the input's blur, so the pick registers.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              className={cn(
                "block w-full truncate rounded-sm px-2 py-1 text-left text-sm",
                i === sel
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50",
              )}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
