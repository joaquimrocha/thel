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

// `className` carries the size (e.g. "size-2"); defaults to the tab/row size.
export function StatusDot({
  state,
  className,
}: {
  state: DotState;
  className?: string;
}) {
  const size = className ?? "size-1.5";
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
