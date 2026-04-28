import type { FeedEntry } from "../lib/types";
import { cn } from "../lib/cn";

export function MintFeedRow({ entry }: { entry: FeedEntry }) {
  const matched = entry.matched != null;
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_80px_120px_80px_60px_120px] gap-3 px-3 py-2 text-sm font-mono items-center border-b border-border/50 last:border-0",
        matched && "bg-accent/5",
      )}
    >
      <span className="truncate text-fg-muted" title={entry.mint}>
        {entry.mint.slice(0, 12)}…
      </span>
      <span className="text-fg">{entry.symbol ?? "—"}</span>
      <span className="text-fg-subtle truncate" title={entry.creator}>
        {entry.creator.slice(0, 8)}…
      </span>
      <span className="text-fg-muted tabular-nums">
        {entry.mc_sol != null ? entry.mc_sol.toFixed(2) : "?"}
      </span>
      <span className={entry.socials ? "text-accent" : "text-fg-subtle"}>
        {entry.socials ? "yes" : "no"}
      </span>
      <span
        className={cn(
          "text-xs uppercase tracking-wide font-semibold",
          matched ? "text-accent" : "text-fg-subtle",
        )}
      >
        {entry.matched ?? "—"}
      </span>
    </div>
  );
}

export function MintFeedHeader() {
  return (
    <div className="grid grid-cols-[1fr_80px_120px_80px_60px_120px] gap-3 px-3 py-2 text-xs font-mono text-fg-subtle uppercase tracking-wider border-b border-border bg-bg-raised">
      <span>mint</span>
      <span>symbol</span>
      <span>creator</span>
      <span>mc(SOL)</span>
      <span>socials</span>
      <span>matched</span>
    </div>
  );
}
