import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@snipebundle/ui";
import { ipc, type TrenchBuckets, type TrenchCoin } from "../lib/ipc";
import { AppNav } from "../components/AppNav";
import { TokenIcon } from "../components/TokenIcon";

const POLL_MS = 4_000;

export function Trenches() {
  const [buckets, setBuckets] = useState<TrenchBuckets>({
    new: [],
    almost: [],
    migrated: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  // Poll the unified buckets endpoint. We compare by mint set so we can
  // briefly highlight rows that just appeared — gives the GMGN-style
  // "live" feel even though we're polling.
  const prevMintsRef = useRef<{
    new: Set<string>;
    almost: Set<string>;
    migrated: Set<string>;
  }>({ new: new Set(), almost: new Set(), migrated: new Set() });
  const [highlightUntil, setHighlightUntil] = useState<Map<string, number>>(
    () => new Map(),
  );

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;

    async function load() {
      try {
        const next = await ipc.getPumpfunBuckets();
        if (!mounted) return;
        setError(null);
        setUpdatedAt(Date.now());

        // Detect freshly-arrived mints in each bucket and flash them.
        const flashes = new Map(highlightUntil);
        const now = Date.now();
        for (const k of ["new", "almost", "migrated"] as const) {
          const prev = prevMintsRef.current[k];
          for (const c of next[k]) {
            if (!prev.has(c.mint)) {
              flashes.set(c.mint, now + 2_500);
            }
          }
          prevMintsRef.current[k] = new Set(next[k].map((c) => c.mint));
        }
        // Drop expired flashes.
        for (const [m, t] of flashes) {
          if (t < now) flashes.delete(m);
        }
        setHighlightUntil(flashes);
        setBuckets(next);
      } catch (e) {
        if (mounted) setError(String(e));
      }
      if (mounted) timer = window.setTimeout(load, POLL_MS);
    }

    load();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1Hz tick so the "Xs ago" / age cells stay current between polls.
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <AppNav status="stopped" />
      <div className="mx-auto w-full max-w-[1600px] px-5 py-4 flex flex-col flex-1 min-h-0">
        <div className="flex items-baseline justify-between border-b border-border pb-3 mb-4 gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-base text-fg">trenches</h1>
            <span className="font-mono text-2xs text-fg-subtle">
              // pump.fun · live · poll {POLL_MS / 1000}s
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-2xs text-fg-subtle">
            <LivePulse />
            {updatedAt && (
              <span>
                upd {Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))}
                s ago
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-3 border-l-2 border-danger bg-danger/5 px-3 py-2 font-mono text-2xs text-danger">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 flex-1 min-h-0">
          <Column
            label="new"
            sublabel="freshly minted"
            accent="accent"
            coins={buckets.new}
            highlightUntil={highlightUntil}
            tick={tick}
          />
          <Column
            label="almost"
            sublabel="curve filling — close to migration"
            accent="warn"
            coins={buckets.almost}
            highlightUntil={highlightUntil}
            tick={tick}
          />
          <Column
            label="migrated"
            sublabel="graduated to raydium"
            accent="muted"
            coins={buckets.migrated}
            highlightUntil={highlightUntil}
            tick={tick}
          />
        </div>
      </div>
    </div>
  );
}

function Column({
  label,
  sublabel,
  accent,
  coins,
  highlightUntil,
  tick,
}: {
  label: string;
  sublabel: string;
  accent: "accent" | "warn" | "muted";
  coins: TrenchCoin[];
  highlightUntil: Map<string, number>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tick: number; // forces re-render so age cells stay live
}) {
  const accentClass =
    accent === "accent"
      ? "text-accent"
      : accent === "warn"
        ? "text-warn"
        : "text-fg-muted";

  return (
    <div className="border border-border bg-bg-subtle/30 flex flex-col min-h-0">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2 shrink-0">
        <div className="flex items-baseline gap-2">
          <span className={cn("font-mono text-2xs", accentClass)}>{label}</span>
          <span className="font-mono text-2xs text-fg-subtle">[{coins.length}]</span>
        </div>
        <span className="font-mono text-2xs text-fg-subtle/70">{sublabel}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border/40">
        {coins.length === 0 ? (
          <div className="hatch px-3 py-10 text-center font-mono text-2xs text-fg-subtle">
            loading…
          </div>
        ) : (
          coins.map((c) => (
            <CoinRow
              key={c.mint}
              coin={c}
              highlight={highlightUntil.has(c.mint)}
              accent={accent}
            />
          ))
        )}
      </div>
    </div>
  );
}

function CoinRow({
  coin,
  highlight,
  accent,
}: {
  coin: TrenchCoin;
  highlight: boolean;
  accent: "accent" | "warn" | "muted";
}) {
  const navigate = useNavigate();
  const age = formatAge(coin.age_minutes);
  const mc = formatUsd(coin.usd_market_cap);
  const progress = coin.bonding_curve_progress_pct;
  const accentClass =
    accent === "accent"
      ? "text-accent"
      : accent === "warn"
        ? "text-warn"
        : "text-fg";

  return (
    <button
      type="button"
      onClick={() => navigate(`/chart?mint=${encodeURIComponent(coin.mint)}`)}
      className={cn(
        "w-full text-left px-3 py-2 transition-colors flex items-center gap-2",
        highlight
          ? "bg-accent/10 animate-pulse"
          : "hover:bg-bg-subtle/60",
      )}
      title={coin.mint}
    >
      <TokenIcon src={coin.image_url} symbol={coin.symbol} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn("font-semibold text-xs truncate", accentClass)}>
            {coin.symbol ?? "—"}
          </span>
          {coin.name && (
            <span className="text-2xs text-fg-muted truncate">{coin.name}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 font-mono text-2xs text-fg-subtle">
          <span>{age}</span>
          {mc && (
            <>
              <span className="text-fg-subtle/40">·</span>
              <span className="text-fg-muted">mc {mc}</span>
            </>
          )}
          {coin.reply_count != null && coin.reply_count > 0 && (
            <>
              <span className="text-fg-subtle/40">·</span>
              <span>💬 {coin.reply_count}</span>
            </>
          )}
        </div>
        {progress != null && progress < 100 && (
          <div className="mt-1 h-1 w-full bg-bg-raised overflow-hidden">
            <div
              className={cn(
                "h-full",
                accent === "warn" ? "bg-warn" : "bg-accent",
              )}
              style={{ width: `${progress.toFixed(1)}%` }}
            />
          </div>
        )}
      </div>
      <span className="font-mono text-2xs text-fg-subtle shrink-0 self-start">
        {coin.mint.slice(0, 4)}..{coin.mint.slice(-4)}
      </span>
    </button>
  );
}

function LivePulse() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span>live</span>
    </span>
  );
}

function formatUsd(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function formatAge(min: number | null): string {
  if (min == null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / (60 * 24))}d`;
}
