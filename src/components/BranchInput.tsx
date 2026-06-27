import { useState } from "react";
import { inputClass } from "@/lib/utils";

// Free-text input with a branch suggestion dropdown (recency-ordered). The
// value is still freeform, so any ref can be typed; the list just assists.
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
  const q = value.trim().toLowerCase();
  const showAll = q === "" || options.includes(value);
  const suggestions = (
    showAll ? options : options.filter((o) => o.toLowerCase().includes(q))
  ).slice(0, 8);

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        spellCheck={false}
        className={inputClass}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {suggestions.map((o) => (
            <button
              key={o}
              type="button"
              // mousedown fires before the input's blur, so the pick registers.
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o);
                setOpen(false);
              }}
              className="block w-full truncate rounded-sm px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
