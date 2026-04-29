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
  volumeMin: string; // USD 24h
  volumeMax: string;
  curveMin: string; // bonding curve %
  curveMax: string;
  repliesMin: string;
  liveOnly: boolean;
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
}

const DEFAULT_FILTERS: Filters = {
  ageMin: "",
  ageMax: "",
  mcMin: "",
  mcMax: "",
  volumeMin: "",
  volumeMax: "",
  curveMin: "",
  curveMax: "",
  repliesMin: "",
  liveOnly: false,
  hasTwitter: false,
  hasTelegram: false,
  hasWebsite: false,
};

type ColumnKey = "new" | "almost" | "migrated";

interface ColumnState {
  filters: Filters;
  quickBuy: number;
}

const DEFAULT_COLUMN_STATE: Record<ColumnKey, ColumnState> = {
  new: { filters: DEFAULT_FILTERS, quickBuy: 0.05 },
  almost: { filters: DEFAULT_FILTERS, quickBuy: 0.1 },
  migrated: { filters: DEFAULT_FILTERS, quickBuy: 0.2 },
};

function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.ageMin || f.ageMax) n++;
  if (f.mcMin || f.mcMax) n++;
  if (f.volumeMin || f.volumeMax) n++;
  if (f.curveMin || f.curveMax) n++;
  if (f.repliesMin) n++;
  if (f.liveOnly) n++;
  if (f.hasTwitter) n++;
  if (f.hasTelegram) n++;
  if (f.hasWebsite) n++;
  return n;
}

export function Trenches() {
  const [buckets, setBuckets] = useState<TrenchBuckets>({
    new: [],
    almost: [],
    migrated: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // Per-column filter + quick-buy state. Different columns warrant different
  // defaults: 'new' bets are smaller (riskier), 'migrated' larger (more
  // established). See DEFAULT_COLUMN_STATE.
  const [columnState, setColumnState] = useState(() => {
    const init = { ...DEFAULT_COLUMN_STATE };
    // Pull last persisted quick-buy from the global helper as the initial
    // 'new' column quickBuy so users who configured it before the per-column
    // change get a sensible value.
    init.new = { ...init.new, quickBuy: getQuickBuySol() };
    return init;
  });
  const [primaryWallet, setPrimaryWallet] = useState(getPrimaryWallet());
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribeActiveWallet(() =>
      setPrimaryWallet(getPrimaryWallet()),
    );
    return unsub;
  }, []);

  function setColumn(key: ColumnKey, next: Partial<ColumnState>) {
    setColumnState((s) => {
      const merged = { ...s[key], ...next };
      // Keep the legacy global quick-buy in sync with the 'new' column so
      // other pages (Trade, Chart) still see the most-recent value.
      if (key === "new" && next.quickBuy != null) {
        setQuickBuySol(next.quickBuy);
      }
      return { ...s, [key]: merged };
    });
  }

  async function handleQuickBuy(coin: TrenchCoin, sol: number) {
    setError(null);
    if (!primaryWallet) {
      setError("set a primary wallet in the header first");
      return;
    }
    try {
      await ipc.manualSnipe({
        mint: coin.mint,
        wallet_pubkeys: [primaryWallet],
        strategy: { kind: "uniform", sol },
      });
      const sym = coin.symbol ?? coin.mint.slice(0, 6);
      setFeedback(`bought ${sol} SOL of ${sym}`);
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
      new: applyFilters(buckets.new, columnState.new.filters),
      almost: applyFilters(buckets.almost, columnState.almost.filters),
      migrated: applyFilters(buckets.migrated, columnState.migrated.filters),
    }),
    [buckets, columnState],
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
            colKey="new"
            label="new"
            sublabel="freshly minted"
            accent="accent"
            coins={filtered.new}
            totalCount={buckets.new.length}
            highlightUntil={highlightUntil}
            tick={tick}
            onQuickBuy={handleQuickBuy}
            state={columnState.new}
            onState={(next) => setColumn("new", next)}
            primaryReady={!!primaryWallet}
          />
          <Column
            colKey="almost"
            label="almost"
            sublabel="curve filling — close to migration"
            accent="warn"
            coins={filtered.almost}
            totalCount={buckets.almost.length}
            highlightUntil={highlightUntil}
            tick={tick}
            onQuickBuy={handleQuickBuy}
            state={columnState.almost}
            onState={(next) => setColumn("almost", next)}
            primaryReady={!!primaryWallet}
          />
          <Column
            colKey="migrated"
            label="migrated"
            sublabel="graduated to raydium"
            accent="muted"
            coins={filtered.migrated}
            totalCount={buckets.migrated.length}
            highlightUntil={highlightUntil}
            tick={tick}
            onQuickBuy={handleQuickBuy}
            state={columnState.migrated}
            onState={(next) => setColumn("migrated", next)}
            primaryReady={!!primaryWallet}
          />
        </div>
      </div>
    </div>
  );
}

function Column({
  colKey,
  label,
  sublabel,
  accent,
  coins,
  totalCount,
  highlightUntil,
  tick,
  onQuickBuy,
  state,
  onState,
  primaryReady,
}: {
  colKey: ColumnKey;
  label: string;
  sublabel: string;
  accent: "accent" | "warn" | "muted";
  coins: TrenchCoin[];
  totalCount: number;
  highlightUntil: Map<string, number>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tick: number; // forces re-render so age cells stay live
  onQuickBuy: (c: TrenchCoin, sol: number) => void;
  state: ColumnState;
  onState: (next: Partial<ColumnState>) => void;
  primaryReady: boolean;
}) {
  // colKey reserved for future per-column persistence (saved filter sets).
  void colKey;
  const accentClass =
    accent === "accent"
      ? "text-accent"
      : accent === "warn"
        ? "text-warn"
        : "text-fg-muted";

  return (
    <div className="border border-border bg-bg-subtle/30 flex flex-col min-h-0">
      <div className="border-b border-border px-3 py-2 shrink-0 space-y-1.5">
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className={cn("font-mono text-2xs", accentClass)}>
              {label}
            </span>
            <span className="font-mono text-2xs text-fg-subtle">
              [{coins.length}
              {coins.length !== totalCount && (
                <span className="text-fg-subtle/60">/{totalCount}</span>
              )}
              ]
            </span>
          </div>
          <span className="font-mono text-2xs text-fg-subtle/70 truncate ml-2">
            {sublabel}
          </span>
        </div>
        <ColumnControls
          state={state}
          onState={onState}
          accent={accent}
        />
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
              quickBuy={state.quickBuy}
              primaryReady={primaryReady}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ColumnControls({
  state,
  onState,
  accent,
}: {
  state: ColumnState;
  onState: (next: Partial<ColumnState>) => void;
  accent: "accent" | "warn" | "muted";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(state.filters);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const accentClass =
    accent === "accent"
      ? "border-accent/40 text-accent bg-accent/5"
      : accent === "warn"
        ? "border-warn/40 text-warn bg-warn/5"
        : "border-border text-fg-muted bg-bg-subtle";

  return (
    <div className="flex items-center justify-between gap-2">
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          className={cn(
            "font-mono text-2xs px-2 py-0.5 border transition-colors",
            count > 0 || open
              ? accentClass
              : "border-border text-fg-subtle hover:border-border-strong hover:text-fg-muted",
          )}
        >
          filters{count > 0 && <span className="ml-1">[{count}]</span>}
        </button>
        {open && (
          <FilterPanel
            filters={state.filters}
            onChange={(f) => onState({ filters: f })}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
      <span className="flex items-center gap-1 font-mono text-2xs text-fg-subtle">
        <span>buy</span>
        <input
          type="number"
          min="0.0001"
          step="0.01"
          defaultValue={state.quickBuy}
          onBlur={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n) && n > 0) onState({ quickBuy: n });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-14 bg-bg-raised border border-border px-1 py-0.5 font-mono text-2xs text-fg focus:outline-none focus:border-accent"
        />
        <span>SOL</span>
      </span>
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
  onQuickBuy: (c: TrenchCoin, sol: number) => void;
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
          onQuickBuy(coin, quickBuy);
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

function FilterPanel({
  filters,
  onChange,
  onClose,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute left-0 top-full mt-1 z-30 w-[420px] border border-border bg-bg shadow-xl p-3 space-y-3">
      <FilterGroup label="age (minutes)">
        <RangeFilter
          min={filters.ageMin}
          max={filters.ageMax}
          onMin={(v) => onChange({ ...filters, ageMin: v })}
          onMax={(v) => onChange({ ...filters, ageMax: v })}
        />
      </FilterGroup>
      <FilterGroup label="market cap (USD)">
        <RangeFilter
          min={filters.mcMin}
          max={filters.mcMax}
          onMin={(v) => onChange({ ...filters, mcMin: v })}
          onMax={(v) => onChange({ ...filters, mcMax: v })}
        />
      </FilterGroup>
      <FilterGroup label="24h volume (USD)">
        <RangeFilter
          min={filters.volumeMin}
          max={filters.volumeMax}
          onMin={(v) => onChange({ ...filters, volumeMin: v })}
          onMax={(v) => onChange({ ...filters, volumeMax: v })}
        />
      </FilterGroup>
      <FilterGroup label="bonding curve (%)">
        <RangeFilter
          min={filters.curveMin}
          max={filters.curveMax}
          onMin={(v) => onChange({ ...filters, curveMin: v })}
          onMax={(v) => onChange({ ...filters, curveMax: v })}
        />
      </FilterGroup>
      <FilterGroup label="engagement">
        <div className="flex items-center gap-2 font-mono text-2xs text-fg-subtle">
          <span>min replies</span>
          <input
            value={filters.repliesMin}
            onChange={(e) =>
              onChange({ ...filters, repliesMin: e.target.value })
            }
            placeholder="0"
            className="w-16 bg-bg-raised border border-border px-1 py-0.5 font-mono text-2xs text-fg focus:outline-none focus:border-accent placeholder:text-fg-subtle/50"
          />
        </div>
      </FilterGroup>
      <FilterGroup label="signal">
        <div className="flex items-center gap-3 flex-wrap">
          <ToggleFilter
            label="live only"
            checked={filters.liveOnly}
            onChange={(v) => onChange({ ...filters, liveOnly: v })}
            accent="danger"
          />
          <ToggleFilter
            label="has twitter"
            checked={filters.hasTwitter}
            onChange={(v) => onChange({ ...filters, hasTwitter: v })}
          />
          <ToggleFilter
            label="has telegram"
            checked={filters.hasTelegram}
            onChange={(v) => onChange({ ...filters, hasTelegram: v })}
          />
          <ToggleFilter
            label="has website"
            checked={filters.hasWebsite}
            onChange={(v) => onChange({ ...filters, hasWebsite: v })}
          />
        </div>
      </FilterGroup>

      <div className="border-t border-border pt-2 font-mono text-[10px] text-fg-subtle/60 leading-relaxed">
        coming next: bundle %, holders, dev hold %, kol/smart-money count,
        top-10 concentration. these need on-chain holder indexing.
      </div>

      <div className="flex items-center justify-between border-t border-border pt-2">
        <button
          type="button"
          onClick={() => onChange(DEFAULT_FILTERS)}
          className="font-mono text-2xs text-fg-subtle hover:text-danger"
        >
          reset
        </button>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-2xs text-accent hover:underline"
        >
          done
        </button>
      </div>
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-tight2 text-fg-subtle mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

function ToggleFilter({
  label,
  checked,
  onChange,
  accent,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  accent?: "accent" | "danger";
}) {
  return (
    <label className="flex items-center gap-1.5 font-mono text-2xs text-fg-muted cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={accent === "danger" ? "accent-danger" : "accent-accent"}
      />
      {label}
    </label>
  );
}

function filterSummary(f: Filters): string {
  const parts: string[] = [];
  if (f.ageMin || f.ageMax)
    parts.push(`age ${f.ageMin || "0"}–${f.ageMax || "∞"}m`);
  if (f.mcMin || f.mcMax)
    parts.push(`mc $${f.mcMin || "0"}–${f.mcMax || "∞"}`);
  if (f.curveMin || f.curveMax)
    parts.push(`curve ${f.curveMin || "0"}–${f.curveMax || "100"}%`);
  if (f.repliesMin) parts.push(`≥${f.repliesMin} replies`);
  if (f.liveOnly) parts.push("live");
  if (f.hasTwitter) parts.push("tw");
  if (f.hasTelegram) parts.push("tg");
  if (f.hasWebsite) parts.push("web");
  return parts.join(" · ");
}

function RangeFilter({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label?: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 font-mono text-2xs text-fg-subtle">
      {label && <span>{label}</span>}
      <input
        value={min}
        onChange={(e) => onMin(e.target.value)}
        placeholder="min"
        className="w-20 bg-bg-raised border border-border px-1.5 py-0.5 font-mono text-2xs text-fg focus:outline-none focus:border-accent placeholder:text-fg-subtle/50"
      />
      <span className="text-fg-subtle/40">–</span>
      <input
        value={max}
        onChange={(e) => onMax(e.target.value)}
        placeholder="max"
        className="w-20 bg-bg-raised border border-border px-1.5 py-0.5 font-mono text-2xs text-fg focus:outline-none focus:border-accent placeholder:text-fg-subtle/50"
      />
    </div>
  );
}

function applyFilters(coins: TrenchCoin[], f: Filters): TrenchCoin[] {
  const ageMin = parseFloat(f.ageMin);
  const ageMax = parseFloat(f.ageMax);
  const mcMin = parseFloat(f.mcMin);
  const mcMax = parseFloat(f.mcMax);
  const volMin = parseFloat(f.volumeMin);
  const volMax = parseFloat(f.volumeMax);
  const curveMin = parseFloat(f.curveMin);
  const curveMax = parseFloat(f.curveMax);
  const repliesMin = parseFloat(f.repliesMin);
  return coins.filter((c) => {
    if (f.liveOnly && !c.is_currently_live) return false;
    if (f.hasTwitter && !c.twitter) return false;
    if (f.hasTelegram && !c.telegram) return false;
    if (f.hasWebsite && !c.website) return false;
    if (Number.isFinite(ageMin) && (c.age_minutes ?? 0) < ageMin) return false;
    if (Number.isFinite(ageMax) && (c.age_minutes ?? Infinity) > ageMax)
      return false;
    if (Number.isFinite(mcMin) && (c.usd_market_cap ?? 0) < mcMin) return false;
    if (Number.isFinite(mcMax) && (c.usd_market_cap ?? Infinity) > mcMax)
      return false;
    if (Number.isFinite(volMin) && (c.volume_usd_24h ?? 0) < volMin)
      return false;
    if (Number.isFinite(volMax) && (c.volume_usd_24h ?? Infinity) > volMax)
      return false;
    if (
      Number.isFinite(curveMin) &&
      (c.bonding_curve_progress_pct ?? 0) < curveMin
    )
      return false;
    if (
      Number.isFinite(curveMax) &&
      (c.bonding_curve_progress_pct ?? Infinity) > curveMax
    )
      return false;
    if (Number.isFinite(repliesMin) && (c.reply_count ?? 0) < repliesMin)
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
