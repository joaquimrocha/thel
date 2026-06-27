import type { ReactNode } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useKeybindings, effectiveCombo } from "@/store/keybindings";
import { comboToString } from "@/lib/keymap";

/**
 * Wraps a control with a tooltip showing its name and, if `shortcutId` names a
 * rebindable shortcut, the currently-assigned keys. Subscribing to overrides
 * keeps the shown keys in sync after a rebind.
 */
export function ActionTooltip({
  label,
  shortcutId,
  side,
  children,
}: {
  label: string;
  shortcutId?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  // Re-render when bindings change so the displayed shortcut stays current.
  useKeybindings((s) => s.overrides);
  const combo = shortcutId ? effectiveCombo(shortcutId) : null;
  const keys = combo ? comboToString(combo) : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span>{label}</span>
        {keys && (
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {keys}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
