import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { cn, type EngineState, type TrendingItem } from "@snipebundle/ui";
import { AppNav } from "../components/AppNav";
import { MintChart } from "../components/MintChart";
import { TokenIcon } from "../components/TokenIcon";
import { ipc } from "../lib/ipc";

const RECENT_KEY = "snipebundle:recent_mints";
const ACTIVE_KEY = "snipebundle:active_mint";
const MAX_RECENT = 8;
const TRENDING_REFRESH_MS = 30_000;

export function Chart() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const urlMint = params.get("mint") ?? "";
  const [mint, setMint] = useState(urlMint || readActive() || "");
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  const [feed, setFeed] = useState<{ mint: string; symbol?: string }[]>([]);
  const [trending, setTrending] = useState<TrendingItem[]>([]);
  const [state, setState] = useState<EngineState | null>(null);

  // URL ←→ state sync. URL is authoritative for deep-linking from Trending.
  useEffect(() => {
    if (urlMint && urlMint !== mint) setMint(urlMint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlMint]);

  useEffect(() => {
    if (mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      writeActive(mint);
      setRecents((r) => bumpRecent(r, mint));
    }
  }, [mint]);

  // Live engine state: powers the P&L widget + the live feed suggestions.
  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    async function tick() {
      try {
        const s = await ipc.getState();
        if (mounted && s) {
          setState(s);
          setFeed(
            (s.feed ?? [])
              .slice(0, 12)
              .map((e) => ({
                mint: e.mint,
                symbol: e.symbol ?? undefined,
              })),
          );
        }
      } catch {
        /* engine probably stopped — ignore */
      }
      if (mounted) timer = window.setTimeout(tick, 1500);
    }
    tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Trending feed for the sidebar mini-tracker.
  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const list = await ipc.getTrending();
        if (mounted) setTrending(list);
      } catch {
        /* ignore */
      }
    }
    load();
    const t = window.setInterval(load, TRENDING_REFRESH_MS);
    return () => {
      mounted = false;
      window.clearInterval(t);
    };
  }, []);

  function commitMint(next: string) {
    const v = next.trim();
    setMint(v);
    if (v) {
      setParams({ mint: v }, { replace: true });
    } else {
      setParams({}, { replace: true });
    }
  }

  function clearRecents() {
    writeRecents([]);
    setRecents([]);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <AppNav status={engineStatus(state)} />
      <div className="mx-auto w-full max-w-7xl px-5 py-4 flex flex-col flex-1">
        {/* Big input row */}
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <span className="font-mono text-2xs text-fg-subtle shrink-0">
            mint &gt;
          </span>
          <input
            value={mint}
            onChange={(e) => commitMint(e.target.value)}
            placeholder="paste pump.fun mint address — or click any recent / live / trending entry"
            spellCheck={false}
            autoFocus
            className="flex-1 border-b border-transparent bg-transparent px-1 py-1 font-mono text-sm focus:outline-none focus:border-accent placeholder:text-fg-subtle/60"
          />
          {mint && (
            <button
              type="button"
              onClick={() => commitMint("")}
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
              title="clear"
            >
              clear
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate(`/trade?mint=${encodeURIComponent(mint)}`)}
            disabled={!mint}
            className="font-mono text-2xs px-2.5 py-1 border border-accent/40 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="open in trade page"
          >
            trade →
          </button>
        </div>

        {/* Suggestion strip: recent + live feed */}
        <div className="flex flex-wrap items-center gap-3 mt-2 mb-3">
          {recents.length > 0 && (
            <SuggestionGroup
              label="recent"
              items={recents.map((m) => ({ mint: m }))}
              activeMint={mint}
              onPick={commitMint}
              onClear={clearRecents}
            />
          )}
          {feed.length > 0 && (
            <SuggestionGroup
              label="live"
              items={feed}
              activeMint={mint}
              onPick={(m) => commitMint(m)}
            />
          )}
        </div>

        {/* Main grid: chart + sidebar */}
        <div className="flex-1 min-h-[420px] grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
          <MintChart
            mint={mint}
            height={undefined as unknown as number}
            onMintChange={commitMint}
          />
          <aside className="flex flex-col gap-3 min-h-0">
            <PnlWidget state={state} />
            <PositionsWidget
              state={state}
              activeMint={mint}
              onPick={commitMint}
            />
            <TrendingWidget
              items={trending}
              activeMint={mint}
              onPick={commitMint}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function engineStatus(state: EngineState | null): "live" | "paused" | "stopped" {
  return !state?.running ? "stopped" : "live";
}

function PnlWidget({ state }: { state: EngineState | null }) {
  const realized = state?.realized_pnl_sol ?? 0;
  const unrealized = (state?.positions ?? []).reduce((acc, p) => {
    if (p.entry_price == null || p.unrealized_pct == null) return acc;
    return acc + (p.entry_total_sol * p.unrealized_pct) / 100;
  }, 0);
  const net = realized + unrealized;
  const wins = state?.realized_wins ?? 0;
  const losses = state?.realized_losses ?? 0;
  const total = wins + losses;
  const winRate = total === 0 ? null : (wins / total) * 100;

  const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
  const color = (n: number) =>
    n > 0 ? "text-accent" : n < 0 ? "text-danger" : "text-fg-muted";

  return (
    <div className="border border-border bg-bg-subtle/30 px-3 py-2.5">
      <div className="font-mono text-2xs text-fg-subtle mb-2">// pnl</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div>
          <div className="font-mono text-2xs text-fg-subtle">net</div>
          <div className={cn("font-mono text-sm font-semibold tabular-nums", color(net))}>
            {fmt(net)}
            <span className="text-2xs text-fg-subtle font-normal ml-1">SOL</span>
          </div>
        </div>
        <div>
          <div className="font-mono text-2xs text-fg-subtle">realized</div>
          <div className={cn("font-mono text-xs tabular-nums", color(realized))}>
            {fmt(realized)}
          </div>
        </div>
        <div>
          <div className="font-mono text-2xs text-fg-subtle">unreal.</div>
          <div className={cn("font-mono text-xs tabular-nums", color(unrealized))}>
            {fmt(unrealized)}
          </div>
        </div>
        <div>
          <div className="font-mono text-2xs text-fg-subtle">w/r</div>
          <div
            className={cn(
              "font-mono text-xs tabular-nums",
              winRate == null
                ? "text-fg-subtle"
                : winRate >= 50
                  ? "text-accent"
                  : "text-warn",
            )}
          >
            {winRate == null ? "—" : `${winRate.toFixed(0)}%`}
            <span className="text-fg-subtle ml-1">
              {wins}/{losses}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PositionsWidget({
  state,
  activeMint,
  onPick,
}: {
  state: EngineState | null;
  activeMint: string;
  onPick: (mint: string) => void;
}) {
  const positions = state?.positions ?? [];
  return (
    <div className="border border-border bg-bg-subtle/30 px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-2xs text-fg-subtle">
          // positions
        </span>
        <span className="font-mono text-2xs text-fg-subtle">
          [{positions.length}]
        </span>
      </div>
      {positions.length === 0 ? (
        <div className="font-mono text-2xs text-fg-subtle/70">none open</div>
      ) : (
        <div className="space-y-1">
          {positions.slice(0, 6).map((p) => {
            const pct = p.unrealized_pct;
            const pctColor =
              pct == null
                ? "text-fg-subtle"
                : pct >= 0
                  ? "text-accent"
                  : "text-danger";
            const pctLabel =
              pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
            const active = p.mint === activeMint;
            return (
              <button
                key={p.mint}
                type="button"
                onClick={() => onPick(p.mint)}
                className={cn(
                  "w-full flex items-center justify-between gap-2 px-1.5 py-1 font-mono text-2xs transition-colors text-left",
                  active
                    ? "bg-accent/10 text-accent"
                    : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                <span className="truncate">
                  {p.mint.slice(0, 6)}..{p.mint.slice(-4)}
                </span>
                <span className={cn("tabular-nums shrink-0", pctColor)}>
                  {pctLabel}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrendingWidget({
  items,
  activeMint,
  onPick,
}: {
  items: TrendingItem[];
  activeMint: string;
  onPick: (mint: string) => void;
}) {
  const top = items.filter((i) => i.mint).slice(0, 12);
  return (
    <div className="border border-border bg-bg-subtle/30 px-3 py-2.5 flex flex-col min-h-0 flex-1">
      <div className="font-mono text-2xs text-fg-subtle mb-2 shrink-0">
        // trending
      </div>
      {top.length === 0 ? (
        <div className="font-mono text-2xs text-fg-subtle/70">loading…</div>
      ) : (
        <div className="space-y-1 overflow-y-auto -mr-1 pr-1 min-h-0">
          {top.map((it) => {
            const pct = it.change_pct_24h;
            const pctColor =
              pct == null
                ? "text-fg-subtle"
                : pct >= 0
                  ? "text-accent"
                  : "text-danger";
            const active = it.mint === activeMint;
            const boosted = it.boost_amount != null && it.boost_amount > 0;
            return (
              <button
                key={it.mint!}
                type="button"
                onClick={() => onPick(it.mint!)}
                className={cn(
                  "w-full flex items-center gap-2 px-1.5 py-1 transition-colors text-left",
                  active
                    ? "bg-accent/10"
                    : "hover:bg-bg-subtle",
                )}
              >
                <TokenIcon
                  src={it.image_url}
                  symbol={it.symbol}
                  size={20}
                />
                <span
                  className={cn(
                    "font-mono text-2xs truncate flex-1",
                    active ? "text-accent" : "text-fg",
                  )}
                >
                  {it.symbol ?? `${it.mint!.slice(0, 4)}..`}
                </span>
                {boosted && (
                  <span
                    className="font-mono text-[9px] text-warn"
                    title="paid boost"
                  >
                    ★
                  </span>
                )}
                <span
                  className={cn(
                    "font-mono text-2xs tabular-nums shrink-0",
                    pctColor,
                  )}
                >
                  {pct == null
                    ? "—"
                    : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SuggestionGroup({
  label,
  items,
  activeMint,
  onPick,
  onClear,
}: {
  label: string;
  items: { mint: string; symbol?: string }[];
  activeMint: string;
  onPick: (mint: string) => void;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="font-mono text-2xs text-fg-subtle">{label}</span>
      {items.map((it) => {
        const active = it.mint === activeMint;
        return (
          <button
            key={it.mint}
            type="button"
            onClick={() => onPick(it.mint)}
            title={it.mint}
            className={cn(
              "font-mono text-2xs px-2 py-0.5 border transition-colors",
              active
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {it.symbol ?? `${it.mint.slice(0, 4)}..${it.mint.slice(-4)}`}
          </button>
        );
      })}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="font-mono text-2xs text-fg-subtle hover:text-danger px-1"
          title="clear recents"
        >
          ×
        </button>
      )}
    </div>
  );
}

function readActive(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeActive(v: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, v);
  } catch {
    /* ignore */
  }
}
function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s) => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}
function writeRecents(v: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
function bumpRecent(curr: string[], v: string): string[] {
  const next = [v, ...curr.filter((x) => x !== v)].slice(0, MAX_RECENT);
  writeRecents(next);
  return next;
}
