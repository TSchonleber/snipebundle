import { cn } from "../lib/cn";

type Status = "live" | "paused" | "stopped";

export function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { label: string; className: string }> = {
    live: { label: "LIVE", className: "bg-accent/15 text-accent border-accent/40" },
    paused: {
      label: "PAUSED",
      className: "bg-warn/15 text-warn border-warn/40",
    },
    stopped: {
      label: "STOPPED",
      className: "bg-fg-subtle/20 text-fg-muted border-border",
    },
  };
  const { label, className } = map[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-mono font-semibold tracking-wider",
        className,
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          status === "live" && "bg-accent animate-pulse",
          status === "paused" && "bg-warn",
          status === "stopped" && "bg-fg-subtle",
        )}
      />
      {label}
    </span>
  );
}
