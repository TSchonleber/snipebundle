import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@snipebundle/ui";
import { ipc, type TrenchBuckets, type TrenchCoin } from "../lib/ipc";
import { AppNav } from "../components/AppNav";
import { TokenIcon } from "../components/TokenIcon";
import {
  getPrimaryWallet,
  getQuickBuySol,
  setQuickBuySol,
  subscribeActiveWallet,
} from "../lib/active-wallet";

const POLL_MS = 4_000;

interface Filters {
  ageMin: string; // minutes
  ageMax: string;
  mcMin: string; // USD
  mcMax: string;
  liveOnly: boolean;
}

const DEFAULT_FILTERS: Filters = {
  ageMin: "",
  ageMax: "",
  mcMin: "",
  mcMax: "",
  liveOnly: false,
};

export function Trenches() {
  const [buckets, setBuckets] = useState<TrenchBuckets>({
    new: [],
    almost: [],
    migrated: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [quickBuy, setQuickBuy] = useState(getQuickBuySol());
  const [primaryWallet, setPrimaryWallet] = useState(getPrimaryWallet());
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribeActiveWallet(() =>
      setPrimaryWallet(getPrimaryWallet()),
    );
    return unsub;
  }, []);

  function commitQuickBuy(v: string) {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) {
      setQuickBuy(n);
      setQuickBuySol(n);
    }
  }

  async function handleQuickBuy(coin: TrenchCoin) {
    setError(null);
    if (!primaryWallet) {
      setError("set a primary wallet in the header first");
      return;
    }
    try {
      await ipc.manualSnipe({
        mint: coin.mint,
        wallet_pubkeys: [primaryWallet],
        strategy: { kind: "uniform", sol: quickBuy },
      });
      const sym = coin.symbol ?? coin.mint.slice(0, 6);
      setFeedback(`bought ${quickBuy} SOL of ${sym}`);
      window.setTimeout(() => setFeedback(null), 2500);
    } catch (e) {
      setError(String(e));
    }
  }

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

  const filtered = useMemo(
    () => ({
      new: applyFilters(buckets.new, filters),
      almost: applyFilters(buckets.almost, filters),
      migrated: applyFilters(buckets.migrated, filters),
    }),
    [buckets, filters],
  );

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

        <FilterBar
          filters={filters}
          onChange={setFilters}
          quickBuy={quickBuy}
          onQuickBuy={commitQuickBuy}
        />

        {error && (
          <div className="mb-2 border-l-2 border-danger bg-danger/5 px-3 py-2 font-mono text-2xs text-danger">
            {error}
          </div>
        )}
        {feedback && (
          <div className="mb-2 border-l-2 border-accent bg-accent/5 px-3 py-2 font-mono text-2xs text-accent">
            {feedback}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 flex-1 min-h-0">
          <Column
            label="new"
            sublabel="freshly minted"
            accent="accent"
            coins={filtered.new}
            totalCount={buckets.new.length}
            highlightUntil={highlightUntil}
            tick={tick}
            onQuickBuy={handleQuickBuy}
            quickBuy={quickBuy}
            primaryReady={!!primaryWallet}
          />
          <Column
            label="almost"
            sublabel="curve filling — close to migration"
            accent="warn"
            coins={filtered.almost}
            totalCount={buckets.almost.length}
            highlightUntil={highlightUntil}
            tick={tick}
            onQuickBuy={handleQuickBuy}
            quickBuy={quickBuy}
            primaryReady={!!primaryWallet}
          />
          <Column
            label="migrated"
            sublabel="graduated to raydium"
            accent="muted"
            coins={filtered.migrated}
            totalCount={buckets.migrated.length}
            highlightUntil={highlightUntil}
            tick={tick}
            onQuickBuy={handleQuickBuy}
            quickBuy={quickBuy}
            primaryReady={!!primaryWallet}
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
  totalCount,
  highlightUntil,
  tick,
  onQuickBuy,
  quickBuy,
  primaryReady,
}: {
  label: string;
  sublabel: string;
  accent: "accent" | "warn" | "muted";
  coins: TrenchCoin[];
  totalCount: number;
  highlightUntil: Map<string, number>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tick: number; // forces re-render so age cells stay live
  onQuickBuy: (c: TrenchCoin) => void;
  quickBuy: number;
  primaryReady: boolean;
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
          <span className="font-mono text-2xs text-fg-subtle">
            [{coins.length}
            {coins.length !== totalCount && (
              <span className="text-fg-subtle/60">/{totalCount}</span>
            )}
            ]
          </span>
        </div>
        <span className="font-mono text-2xs text-fg-subtle/70">{sublabel}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border/40">
        {coins.length === 0 ? (
          <div className="hatch px-3 py-10 text-center font-mono text-2xs text-fg-subtle">
            {totalCount === 0 ? "loading…" : "no matches for filters"}
          </div>
        ) : (
          coins.map((c) => (
            <CoinRow
              key={c.mint}
              coin={c}
              highlight={highlightUntil.has(c.mint)}
              accent={accent}
              onQuickBuy={onQuickBuy}
              quickBuy={quickBuy}
              primaryReady={primaryReady}
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
  onQuickBuy,
  quickBuy,
  primaryReady,
}: {
  coin: TrenchCoin;
  highlight: boolean;
  accent: "accent" | "warn" | "muted";
  onQuickBuy: (c: TrenchCoin) => void;
  quickBuy: number;
  primaryReady: boolean;
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
    <div
      className={cn(
        "px-3 py-2 transition-colors flex items-center gap-2",
        highlight
          ? "bg-accent/10 animate-pulse"
          : "hover:bg-bg-subtle/60",
      )}
      title={coin.mint}
    >
      <button
        type="button"
        onClick={() => navigate(`/trade?mint=${encodeURIComponent(coin.mint)}`)}
        className="flex items-center gap-2 min-w-0 flex-1 text-left"
      >
        <TokenIcon src={coin.image_url} symbol={coin.symbol} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={cn("font-semibold text-xs truncate", accentClass)}>
              {coin.symbol ?? "—"}
            </span>
            {coin.name && (
              <span className="text-2xs text-fg-muted truncate">{coin.name}</span>
            )}
            {coin.is_currently_live && <LiveBadge />}
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
                <span>{coin.reply_count} replies</span>
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
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onQuickBuy(coin);
        }}
        disabled={!primaryReady}
        title={
          primaryReady
            ? `quick-buy ${quickBuy} SOL from primary wallet`
            : "set a primary wallet in the header first"
        }
        className={cn(
          "shrink-0 font-mono text-2xs px-2 py-1 border transition-colors",
          primaryReady
            ? "border-accent/40 text-accent hover:bg-accent/15"
            : "border-border/60 text-fg-subtle/60 cursor-not-allowed",
        )}
      >
        buy {quickBuy}
      </button>
    </div>
  );
}

function LiveBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 border border-danger/60 bg-danger/10 px-1 py-0 font-mono text-[9px] uppercase tracking-wider text-danger"
      title="creator is broadcasting on pump.fun right now"
    >
      <span className="relative inline-flex h-1 w-1">
        <span className="absolute inline-flex h-full w-full rounded-full bg-danger opacity-75 animate-ping" />
        <span className="relative inline-flex h-1 w-1 rounded-full bg-danger" />
      </span>
      live
    </span>
  );
}

function FilterBar({
  filters,
  onChange,
  quickBuy,
  onQuickBuy,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  quickBuy: number;
  onQuickBuy: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap mb-3 border border-border bg-bg-subtle/30 px-3 py-2">
      <RangeFilter
        label="age (m)"
        min={filters.ageMin}
        max={filters.ageMax}
        onMin={(v) => onChange({ ...filters, ageMin: v })}
        onMax={(v) => onChange({ ...filters, ageMax: v })}
      />
      <RangeFilter
        label="mc ($)"
        min={filters.mcMin}
        max={filters.mcMax}
        onMin={(v) => onChange({ ...filters, mcMin: v })}
        onMax={(v) => onChange({ ...filters, mcMax: v })}
      />
      <label className="flex items-center gap-1.5 font-mono text-2xs text-fg-subtle cursor-pointer">
        <input
          type="checkbox"
          checked={filters.liveOnly}
          onChange={(e) => onChange({ ...filters, liveOnly: e.target.checked })}
          className="accent-danger"
        />
        live only
      </label>
      <span className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-fg-subtle">
        <span>quick-buy</span>
        <input
          type="number"
          min="0.0001"
          step="0.01"
          defaultValue={quickBuy}
          onBlur={(e) => onQuickBuy(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-16 bg-bg-raised border border-border px-1 py-0.5 font-mono text-2xs text-fg focus:outline-none focus:border-accent"
        />
        <span>SOL</span>
      </span>
      <button
        type="button"
        onClick={() => onChange(DEFAULT_FILTERS)}
        className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
      >
        reset
      </button>
    </div>
  );
}

function RangeFilter({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 font-mono text-2xs text-fg-subtle">
      <span>{label}</span>
      <input
        value={min}
        onChange={(e) => onMin(e.target.value)}
        placeholder="min"
        className="w-14 bg-bg-raised border border-border px-1 py-0.5 font-mono text-2xs text-fg focus:outline-none focus:border-accent placeholder:text-fg-subtle/50"
      />
      <span className="text-fg-subtle/40">–</span>
      <input
        value={max}
        onChange={(e) => onMax(e.target.value)}
        placeholder="max"
        className="w-14 bg-bg-raised border border-border px-1 py-0.5 font-mono text-2xs text-fg focus:outline-none focus:border-accent placeholder:text-fg-subtle/50"
      />
    </div>
  );
}

function applyFilters(coins: TrenchCoin[], f: Filters): TrenchCoin[] {
  const ageMin = parseFloat(f.ageMin);
  const ageMax = parseFloat(f.ageMax);
  const mcMin = parseFloat(f.mcMin);
  const mcMax = parseFloat(f.mcMax);
  return coins.filter((c) => {
    if (f.liveOnly && !c.is_currently_live) return false;
    if (Number.isFinite(ageMin) && (c.age_minutes ?? 0) < ageMin) return false;
    if (Number.isFinite(ageMax) && (c.age_minutes ?? Infinity) > ageMax)
      return false;
    if (Number.isFinite(mcMin) && (c.usd_market_cap ?? 0) < mcMin) return false;
    if (Number.isFinite(mcMax) && (c.usd_market_cap ?? Infinity) > mcMax)
      return false;
    return true;
  });
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
