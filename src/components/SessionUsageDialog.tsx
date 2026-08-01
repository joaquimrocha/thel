import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ActionTooltip } from "./ActionTooltip";
import { useUI } from "@/store/ui";
import { useSessions, terminalDisplayTitle } from "@/store/sessions";
import { activateNotification } from "@/store/notifications";
import { sessionUsage, type TerminalUsage } from "@/lib/pty";

const POLL_MS = 1000;

/** Percent of one core burned between two samples. 100% means a full core, so a
 * multi-threaded program can legitimately read above it. */
function cpuPercent(prev: number, next: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.max(0, ((next - prev) / (elapsedMs / 1000)) * 100);
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

interface Row {
  id: string;
  title: string;
  // null until a second sample gives something to compare against.
  cpu: number | null;
  rss: number;
}

export function SessionUsageDialog() {
  const sessionId = useUI((s) => s.sessionUsage);
  const close = useUI((s) => s.closeSessionUsage);
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId));
  const [rows, setRows] = useState<Row[]>([]);
  // The previous sample, to turn cumulative CPU seconds into a rate.
  const prev = useRef<{ at: number; cpu: Record<string, number> } | null>(null);

  const terminals = session?.groups.flatMap((g) => g.terminals) ?? [];
  // Restart the poll when the set of terminals changes, not on every render.
  const key = terminals.map((t) => t.id).join(",");

  useEffect(() => {
    if (!sessionId) {
      prev.current = null;
      setRows([]);
      return;
    }
    let live = true;
    const ids = key ? key.split(",") : [];
    const titles = new Map(
      useSessions
        .getState()
        .sessions.find((s) => s.id === sessionId)
        ?.groups.flatMap((g) => g.terminals)
        .map((t) => [t.id, terminalDisplayTitle(t)] as const) ?? [],
    );

    const tick = async () => {
      // Tolerates both a rejection and a null result, so a backend that can't
      // answer leaves the rows blank instead of throwing mid-render.
      const sample: Record<string, TerminalUsage> =
        (await sessionUsage(ids).catch(() => null)) ?? {};
      if (!live) return;
      const now = Date.now();
      const last = prev.current;
      setRows(
        ids.map((id) => {
          const u = sample[id];
          const before = last?.cpu[id];
          return {
            id,
            title: titles.get(id) ?? id,
            cpu:
              u && before !== undefined
                ? cpuPercent(before, u.cpuSeconds, now - last!.at)
                : null,
            rss: u?.rssBytes ?? 0,
          };
        }),
      );
      prev.current = {
        at: now,
        cpu: Object.fromEntries(
          Object.entries(sample).map(([id, u]) => [id, u.cpuSeconds]),
        ),
      };
    };

    void tick();
    const h = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(h);
    };
  }, [sessionId, key]);

  // The panel reports one session, so navigating to a different one leaves it
  // stale: close it. Keyed on the *change*, not on the current value, so opening
  // it for a session that isn't the active one still works; and "Show" activates
  // this same session, so it never closes the panel it was clicked in.
  useEffect(() => {
    if (!sessionId) return;
    return useSessions.subscribe((s, prevState) => {
      if (
        s.activeSessionId !== prevState.activeSessionId &&
        s.activeSessionId !== sessionId
      ) {
        close();
      }
    });
  }, [sessionId, close]);

  const measured = rows.filter((r) => r.cpu !== null);
  const totalCpu = measured.reduce((a, r) => a + (r.cpu ?? 0), 0);
  const totalRss = rows.reduce((a, r) => a + r.rss, 0);

  const show = (terminalId: string) => {
    if (sessionId) activateNotification(sessionId, terminalId);
  };

  return (
    <Dialog
      open={!!sessionId}
      modal={false}
      onOpenChange={(o) => !o && close()}
    >
      {/* Non-modal and overlay-free so "Show" can reveal a terminal with the
          panel still up, and clicking into that terminal doesn't dismiss it. */}
      <DialogPanel
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b border-border px-4 py-3 pr-10">
          <DialogTitle>{session?.name ?? "Resource usage"}</DialogTitle>
          <DialogDescription>
            CPU and memory of each terminal, including everything it started.
          </DialogDescription>
        </div>

        {/* The column header and total sit outside the scroll area so they stay
            put; all three share px-4, which also keeps the numbers clear of the
            overlay scrollbar. */}
        <div className="flex items-center gap-2 px-4 pb-1 pt-2 text-xs font-medium text-muted-foreground">
          <span className="flex-1">Terminal</span>
          <span className="w-12 text-right">CPU</span>
          <span className="w-16 text-right">Memory</span>
          <span className="w-7" />
        </div>

        <div className="flex-1 overflow-y-auto px-4">
          {rows.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              This session has no terminals.
            </p>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 py-1 text-sm">
                <span className="flex-1 truncate" title={r.title}>
                  {r.title}
                </span>
                <span className="w-12 text-right tabular-nums">
                  {r.cpu === null ? "--" : `${r.cpu.toFixed(0)}%`}
                </span>
                <span className="w-16 text-right tabular-nums text-muted-foreground">
                  {r.rss ? formatBytes(r.rss) : "--"}
                </span>
                <ActionTooltip label="Show terminal">
                  <button
                    aria-label={`Show ${r.title}`}
                    onClick={() => show(r.id)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <ArrowRight className="size-4" />
                  </button>
                </ActionTooltip>
              </div>
            ))
          )}
        </div>

        {rows.length > 1 && (
          <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-sm font-medium">
            <span className="flex-1">Total</span>
            <span className="w-12 text-right tabular-nums">
              {measured.length === 0 ? "--" : `${totalCpu.toFixed(0)}%`}
            </span>
            <span className="w-16 text-right tabular-nums">
              {totalRss ? formatBytes(totalRss) : "--"}
            </span>
            <span className="w-7" />
          </div>
        )}
      </DialogPanel>
    </Dialog>
  );
}
