import { SvgIcon } from "./SvgIcon";
import { cn } from "@/lib/utils";
import { sessionTerminals, type Session, type Terminal } from "@/store/sessions";

export type DotState =
  | "none" // session has no terminals
  | "idle" // restored, not yet started
  | "exited" // started but all terminals have exited
  | "running" // shell alive, but no foreground work
  | "busy" // a foreground process is running
  | "attention"; // wants attention (bell / exit while unfocused)

export function terminalDotState(t: Terminal): DotState {
  if (t.attention) return "attention";
  if (!t.started) return "idle";
  if (t.exited) return "exited";
  return t.busy ? "busy" : "running";
}

export function sessionDotState(s: Session): DotState {
  const terminals = sessionTerminals(s);
  if (terminals.length === 0) return "none";
  if (terminals.some((t) => t.attention)) return "attention";
  const live = terminals.filter((t) => t.started && !t.exited);
  if (live.some((t) => t.busy)) return "busy";
  if (live.length) return "running";
  if (terminals.some((t) => t.started)) return "exited";
  return "idle";
}

const COLOR: Record<Exclude<DotState, "busy">, string> = {
  none: "bg-transparent",
  idle: "border border-muted-foreground/60",
  exited: "bg-muted-foreground/40",
  running: "bg-emerald-500",
  attention: "bg-blue-500",
};

// Icon tint mirrors the dot's colour for the same state, so a session icon still
// reads its status at a glance (green = running, blue = wants attention, faded =
// idle/exited). Concrete hex (not CSS classes): the icon renders via an <img>
// data URI, which can't resolve currentColor or theme variables.
const ICON_HEX: Record<Exclude<DotState, "busy">, string> = {
  none: "#71717a",
  idle: "#71717a",
  exited: "#52525b",
  running: "#10b981",
  attention: "#3b82f6",
};

// `className` carries the size (e.g. "size-2"); defaults to the tab/row size.
// `icon` (an SVG string, sessions only) replaces the dot in every state; when
// busy it pulses green so active work stays obvious.
export function StatusDot({
  state,
  className,
  icon,
  onIconError,
}: {
  state: DotState;
  className?: string;
  icon?: string;
  onIconError?: () => void;
}) {
  const size = className ?? "size-1.5";
  if (icon) {
    const color = ICON_HEX[state === "busy" ? "running" : state];
    if (state === "busy") {
      // Same effect as the busy dot: an expanding, fading echo of the icon
      // behind the solid one.
      return (
        <span className="relative flex size-4 shrink-0">
          <SvgIcon
            svg={icon}
            color={color}
            className="absolute inset-0 animate-ping opacity-75"
          />
          <SvgIcon
            svg={icon}
            color={color}
            onError={onIconError}
            className="relative size-4"
          />
        </span>
      );
    }
    return (
      <SvgIcon
        svg={icon}
        color={color}
        onError={onIconError}
        className="size-4 shrink-0"
      />
    );
  }
  if (state === "busy") {
    // Solid dot under an expanding, fading ring to signal active work.
    return (
      <span className={cn("relative flex shrink-0", size)}>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-full w-full rounded-full bg-emerald-500" />
      </span>
    );
  }
  return <span className={cn("shrink-0 rounded-full", size, COLOR[state])} />;
}
