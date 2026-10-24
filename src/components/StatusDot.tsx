import { SvgIcon } from "./SvgIcon";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/store/prefs";
import { useTheme } from "@/store/theme";
import { sessionTerminals, type Session, type Terminal } from "@/store/sessions";

export type DotState =
  | "none" // session has no terminals
  | "exited" // every terminal has exited
  | "running" // something runs, but no foreground work
  | "idle" // only the shell has run for a while
  | "busy" // a foreground process is running
  | "attention"; // wants attention (bell / exit while unfocused)

// Muting covers the pulse too: it is a bid for attention like the rest.
export function terminalDotState(t: Terminal): DotState {
  if (t.attention) return "attention";
  if (t.exited) return "exited";
  if (t.busy && !t.muted) return "busy";
  return t.idle ? "idle" : "running";
}

export function sessionDotState(s: Session): DotState {
  const terminals = sessionTerminals(s);
  if (terminals.length === 0) return "none";
  if (terminals.some((t) => t.attention)) return "attention";
  const live = terminals.filter((t) => !t.exited);
  if (live.some((t) => t.busy && !t.muted)) return "busy";
  if (live.length === 0) return "exited";
  return live.every((t) => t.idle) ? "idle" : "running";
}

// One row per state, so the dot's class and the icon's tint can't drift apart.
// The icon needs a literal hex: it renders through an <img> data URI, which
// resolves no CSS.
//
// `light` overrides the hex under the light theme. Amber-500 carries about 7:1
// on the dark background but only 2:1 on white, under the 3:1 a non-text
// indicator needs, so the light theme drops a shade; the dot's `dark:` variants
// do the same. Busy is the only state near that line.
//
// Exited is hollow (a faded icon) so it reads apart from idle's solid gray.
const STYLE: Record<
  DotState,
  { label: string; dot: string; ping?: string; hex: string; light?: string; icon?: string }
> = {
  none: { label: "No terminals", dot: "bg-transparent", hex: "#71717a" },
  exited: {
    label: "Exited",
    dot: "border border-muted-foreground/60",
    hex: "#52525b",
    icon: "opacity-50",
  },
  running: { label: "Running", dot: "bg-emerald-500", hex: "#10b981" },
  idle: { label: "Idle", dot: "bg-zinc-500", hex: "#71717a" },
  busy: {
    label: "Working",
    dot: "bg-amber-600 dark:bg-amber-500",
    ping: "bg-amber-500 dark:bg-amber-400",
    hex: "#f59e0b",
    light: "#d97706",
  },
  attention: { label: "Needs attention", dot: "bg-blue-500", hex: "#3b82f6" },
};

// `className` carries the size (e.g. "size-2"); defaults to the tab/row size.
// `icon` (an SVG string, sessions only) replaces the dot in every state, and
// turns amber and pulses when busy.
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
  // Subscribed rather than read off <html>: an icon's colour is baked into its
  // markup at render, so a theme switch has to re-render it.
  const dark = useTheme((s) => s.theme === "dark");
  const markIdle = usePrefs((s) => s.markIdle);
  const size = className ?? "size-1.5";
  const style = STYLE[state === "idle" && !markIdle ? "running" : state];
  if (icon) {
    const color = !dark && style.light ? style.light : style.hex;
    if (state === "busy") {
      // Same effect as the busy dot: an expanding, fading echo of the icon
      // behind the solid one.
      return (
        <span role="img" aria-label={style.label} className="relative flex size-4 shrink-0">
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
        label={style.label}
        onError={onIconError}
        className={cn("size-4 shrink-0", style.icon)}
      />
    );
  }
  if (state === "busy") {
    // Solid dot under an expanding, fading ring to signal active work.
    return (
      <span role="img" aria-label={style.label} className={cn("relative flex shrink-0", size)}>
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            style.ping,
          )}
        />
        <span
          className={cn(
            "relative inline-flex h-full w-full rounded-full",
            style.dot,
          )}
        />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={style.label}
      className={cn("shrink-0 rounded-full", size, style.dot)}
    />
  );
}
