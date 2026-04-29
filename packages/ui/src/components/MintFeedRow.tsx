import type { FeedEntry } from "../lib/types";
import { cn } from "../lib/cn";

export function MintFeedRow({ entry }: { entry: FeedEntry }) {
  const matched = entry.matched != null;
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_70px_100px_70px_50px_100px] gap-3 px-4 py-1.5 font-mono text-2xs items-center border-b border-border/50 last:border-0 transition-colors",
        matched ? "bg-accent/5" : "hover:bg-bg-subtle/40",
      )}
    >
      <span className="truncate text-fg-muted" title={entry.mint}>
        {entry.mint.slice(0, 8)}..{entry.mint.slice(-4)}
      </span>
      <span className="text-fg">{entry.symbol ?? "—"}</span>
      <span className="text-fg-subtle truncate" title={entry.creator}>
        {entry.creator.slice(0, 6)}..{entry.creator.slice(-3)}
      </span>
      <span className="text-fg-muted tabular-nums">
        {entry.mc_sol != null ? entry.mc_sol.toFixed(1) : "—"}
      </span>
      <span className={entry.socials ? "text-accent" : "text-fg-subtle"}>
        {entry.socials ? "y" : "—"}
      </span>
      <span className={cn(matched ? "text-accent" : "text-fg-subtle")}>
        {entry.matched ?? "—"}
      </span>
    </div>
  );
}

export function MintFeedHeader() {
  return (
    <div className="grid grid-cols-[1fr_70px_100px_70px_50px_100px] gap-3 px-4 py-1.5 font-mono text-2xs text-fg-subtle border-b border-border bg-bg-subtle">
      <span>mint</span>
      <span>sym</span>
      <span>creator</span>
      <span>mc</span>
      <span>soc</span>
      <span>match</span>
    </div>
  );
}
