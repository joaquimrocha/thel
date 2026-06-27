import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn's Switch styling/API without the @radix-ui/react-switch dependency: a
// boolean toggle is a button with role="switch", which is enough here.
const Switch = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }
>(({ className, checked = false, onCheckedChange, disabled, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onCheckedChange?.(!checked)}
    className={cn(
      "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-500",
      checked ? "bg-primary" : "bg-input",
      className,
    )}
    {...props}
  >
    <span
      className={cn(
        "pointer-events-none block size-3 rounded-full bg-background shadow-lg ring-0 transition-transform",
        checked ? "translate-x-3.5" : "translate-x-0",
      )}
    />
  </button>
));
Switch.displayName = "Switch";

export { Switch };
