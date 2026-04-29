import { useEffect, useState } from "react";
import {
  cn,
  MintFeedHeader,
  MintFeedRow,
  type EngineState,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { AppNav } from "../components/AppNav";
import { MintChart } from "../components/MintChart";
import { SniperSettings } from "../components/SniperSettings";
import { WalletPanel } from "../components/WalletPanel";

type Section = "feed" | "positions" | "history";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "feed", label: "feed" },
  { id: "positions", label: "positions" },
  { id: "history", label: "history" },
];

export function Dashboard() {
  const [state, setState] = useState<EngineState | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allWallets, setAllWallets] = useState<WalletInfo[]>([]);
  const [activeMint, setActiveMint] = useState("");
  const [section, setSection] = useState<Section>("feed");
  const [showSettings, setShowSettings] = useState(false);
  const [showChart, setShowChart] = useState(true);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    async function tick() {
      try {
        const s = await ipc.getState();
        if (mounted) setState(s);
      } catch (e) {
        if (mounted) setError(String(e));
      }
      if (mounted) timer = window.setTimeout(tick, 500);
    }
    tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    Promise.all([
      ipc.listWallets(),
      ipc.listDevWallets().catch(() => [] as WalletInfo[]),
    ])
      .then(([base, devs]) => setAllWallets([...base, ...devs]))
      .catch(() => {});
  }, []);

  async function start() {
    try {
      await ipc.startEngine();
    } catch (e) {
      setError(String(e));
    }
  }
  async function stop() {
    try {
      await ipc.stopEngine();
    } catch (e) {
      setError(String(e));
    }
  }
  async function togglePause() {
    const next = !paused;
    setPaused(next);
    try {
      await ipc.setPaused(next);
    } catch (e) {
      setError(String(e));
    }
  }

  const status: "live" | "paused" | "stopped" = !state?.running
    ? "stopped"
    : paused
      ? "paused"
      : "live";

  return (
    <div className="min-h-screen">
      <AppNav status={status} />
      <div className="mx-auto max-w-6xl px-5 py-5">
        {/* Top control row: stats + engine controls */}
        <div className="flex items-center justify-between border-b border-border pb-3 mb-4 gap-4 flex-wrap">
          <StatStrip state={state} />
          <div className="flex items-center gap-3">
            {state?.running ? (
              <>
                <button
                  type="button"
                  onClick={togglePause}
                  className="font-mono text-xs px-3 py-1 border border-border text-fg-muted hover:text-fg hover:border-border-strong transition-colors"
                >
                  {paused ? "resume" : "pause"}
                </button>
                <button
                  type="button"
                  onClick={stop}
                  className="font-mono text-xs px-3 py-1 border border-danger/40 text-danger hover:bg-danger/10 transition-colors"
                >
                  stop
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={start}
                className="font-mono text-xs px-4 py-1 border border-accent/50 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
              >
                go live
              </button>
            )}
          </div>
        </div>

        <PnlBar state={state} />

        {/* Live chart — defaults to active mint from sidebar, falls back to
            the most recently opened position. Toggleable via the section bar. */}
        {showChart && (
          <div className="my-4">
            <MintChart
              mint={activeMint || state?.positions[0]?.mint || ""}
              height={300}
              onMintChange={setActiveMint}
              onClose={() => setShowChart(false)}
            />
          </div>
        )}
        {!showChart && (
          <button
            type="button"
            onClick={() => setShowChart(true)}
            className="font-mono text-2xs text-fg-subtle hover:text-fg-muted my-2"
          >
            + show chart
          </button>
        )}

        {error && (
          <div className="my-3 border-l-2 border-danger bg-danger/5 px-3 py-2 font-mono text-2xs text-danger">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px] mt-4">
          <div>
            {/* Section subnav */}
            <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
              <nav className="flex items-center gap-0.5">
                {SECTIONS.map((s) => {
                  const active = section === s.id;
                  const count =
                    s.id === "feed"
                      ? state?.feed.length ?? 0
                      : s.id === "positions"
                        ? state?.positions.length ?? 0
                        : state?.closed_positions.length ?? 0;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSection(s.id)}
                      className={cn(
                        "relative font-mono text-2xs px-2.5 py-1 transition-colors",
                        "after:absolute after:left-2 after:right-2 after:bottom-0 after:h-px after:bg-accent after:transition-opacity",
                        active
                          ? "text-fg after:opacity-100"
                          : "text-fg-subtle hover:text-fg-muted after:opacity-0",
                      )}
                    >
                      {s.label}{" "}
                      <span className="text-fg-subtle/70">[{count}]</span>
                    </button>
                  );
                })}
              </nav>
              <div className="font-mono text-2xs text-fg-subtle truncate max-w-[40%]">
                {state?.last_message || "idle"}
              </div>
            </div>

            {section === "feed" && <FeedSection state={state} />}
            {section === "positions" && <PositionsSection state={state} />}
            {section === "history" && <HistorySection state={state} />}
          </div>

          <aside className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-2xs text-fg-subtle">
                // controls
              </span>
              <button
                type="button"
                onClick={() => setShowSettings((s) => !s)}
                className={cn(
                  "font-mono text-2xs transition-colors",
                  showSettings
                    ? "text-accent"
                    : "text-fg-subtle hover:text-fg-muted",
                )}
              >
                {showSettings ? "[ hide ]" : "settings"}
              </button>
            </div>
            {showSettings && <SniperSettings />}
            {allWallets.length > 0 && (
              <WalletPanel
                wallets={allWallets}
                closedPositions={state?.closed_positions}
                mode="compact"
                activeMint={activeMint}
                onActiveMintChange={setActiveMint}
              />
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function StatStrip({ state }: { state: EngineState | null }) {
  const cell = (label: string, n: number, accent?: boolean) => (
    <span className="font-mono text-2xs text-fg-subtle">
      {label}{" "}
      <span
        className={cn(
          "tabular-nums text-xs",
          accent ? "text-accent" : "text-fg",
        )}
      >
        {n}
      </span>
    </span>
  );
  return (
    <div className="flex items-center gap-5">
      {cell("mints", state?.mint_count ?? 0)}
      <span className="text-fg-subtle/40">·</span>
      {cell("matched", state?.matched_count ?? 0, true)}
      <span className="text-fg-subtle/40">·</span>
      {cell("bundles", state?.bundle_count ?? 0)}
    </div>
  );
}

function PnlBar({ state }: { state: EngineState | null }) {
  if (!state) return null;
  const realized = state.realized_pnl_sol ?? 0;
  const deployed = state.deployed_sol_total ?? 0;
  const unrealized = (state.positions ?? []).reduce((acc, p) => {
    if (p.entry_price == null || p.unrealized_pct == null) return acc;
    return acc + (p.entry_total_sol * p.unrealized_pct) / 100;
  }, 0);
  const net = realized + unrealized;
  const wins = state.realized_wins ?? 0;
  const losses = state.realized_losses ?? 0;
  const total = wins + losses;
  const winRate = total === 0 ? null : (wins / total) * 100;

  const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
  const color = (n: number) =>
    n > 0 ? "text-accent" : n < 0 ? "text-danger" : "text-fg-muted";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-6 gap-y-2 border-b border-border/60 pb-3">
      <Pnl label="net" value={fmt(net)} unit="SOL" big className={color(net)} />
      <Pnl
        label="realized"
        value={fmt(realized)}
        unit="SOL"
        className={color(realized)}
      />
      <Pnl
        label="unrealized"
        value={fmt(unrealized)}
        unit="SOL"
        className={color(unrealized)}
      />
      <Pnl label="deployed" value={deployed.toFixed(4)} unit="SOL" />
      <Pnl
        label="winrate"
        value={winRate == null ? "—" : `${winRate.toFixed(0)}%`}
        suffix={
          winRate == null ? undefined : `${wins}w / ${losses}l`
        }
        className={
          winRate == null
            ? "text-fg-subtle"
            : winRate >= 50
              ? "text-accent"
              : "text-warn"
        }
      />
    </div>
  );
}

function Pnl({
  label,
  value,
  unit,
  suffix,
  big,
  className,
}: {
  label: string;
  value: string;
  unit?: string;
  suffix?: string;
  big?: boolean;
  className?: string;
}) {
  return (
    <div>
      <div className="font-mono text-2xs text-fg-subtle">{label}</div>
      <div
        className={cn(
          "font-mono tabular-nums",
          big ? "text-base font-semibold" : "text-xs",
          className,
        )}
      >
        {value}
        {unit && (
          <span className="ml-1 text-2xs text-fg-subtle font-normal">
            {unit}
          </span>
        )}
      </div>
      {suffix && (
        <div className="font-mono text-2xs text-fg-subtle">{suffix}</div>
      )}
    </div>
  );
}

function FeedSection({ state }: { state: EngineState | null }) {
  const empty = !state || state.feed.length === 0;
  return (
    <div className="border border-border bg-bg-subtle/30">
      <MintFeedHeader />
      <div className="max-h-[60vh] overflow-y-auto">
        {(state?.feed ?? []).slice(0, 50).map((e) => (
          <MintFeedRow key={e.mint + e.at_ms} entry={e} />
        ))}
        {empty && (
          <div className="hatch px-4 py-10 text-center font-mono text-2xs text-fg-subtle">
            {state?.running
              ? "waiting for the next mint…"
              : "engine stopped — press [ go live ]"}
          </div>
        )}
      </div>
    </div>
  );
}

function PositionsSection({ state }: { state: EngineState | null }) {
  const positions = state?.positions ?? [];
  if (positions.length === 0) {
    return (
      <div className="hatch border border-dashed border-border px-4 py-10 text-center font-mono text-2xs text-fg-subtle">
        no open positions
      </div>
    );
  }
  return (
    <div className="border border-border bg-bg-subtle/30 divide-y divide-border/60">
      {positions.map((p) => {
        const pct = p.unrealized_pct;
        const pctColor =
          pct == null
            ? "text-fg-subtle"
            : pct >= 0
              ? "text-accent"
              : "text-danger";
        const pctLabel =
          pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
        const kind = p.kind ?? "sniper";
        const kindColor =
          kind === "launch"
            ? "text-warn"
            : kind === "manual"
              ? "text-fg-muted"
              : "text-accent";
        return (
          <div key={p.mint} className="px-4 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn("font-mono text-2xs w-12", kindColor)}>
                  {kind}
                </span>
                <span className="font-mono text-xs text-fg truncate">
                  {p.mint.slice(0, 8)}..{p.mint.slice(-4)}
                </span>
                <span className="font-mono text-2xs text-fg-subtle">
                  {p.trigger}
                </span>
              </div>
              <span
                className={cn(
                  "font-mono text-sm tabular-nums font-semibold",
                  pctColor,
                )}
              >
                {pctLabel}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-2xs text-fg-subtle">
              <span>{p.entry_total_sol.toFixed(3)} SOL</span>
              <span>·</span>
              <span>{p.wallet_count}w</span>
              <span>·</span>
              <span>{Math.round((Date.now() - p.opened_at_ms) / 1000)}s</span>
              {p.entry_price != null && p.last_price != null && (
                <>
                  <span>·</span>
                  <span>
                    {p.entry_price.toExponential(2)} →{" "}
                    {p.last_price.toExponential(2)}
                  </span>
                </>
              )}
            </div>
            <div className="mt-0.5 font-mono text-2xs text-fg-subtle/80">
              {p.status}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HistorySection({ state }: { state: EngineState | null }) {
  const closed = state?.closed_positions ?? [];
  if (closed.length === 0) {
    return (
      <div className="hatch border border-dashed border-border px-4 py-10 text-center font-mono text-2xs text-fg-subtle">
        no closed positions yet
      </div>
    );
  }
  const exitColor: Record<string, string> = {
    "take-profit": "text-accent",
    "stop-loss": "text-danger",
    "trailing-stop": "text-danger",
    "time-exit": "text-fg-muted",
    manual: "text-fg-muted",
    failed: "text-danger",
    mixed: "text-warn",
  };
  return (
    <div className="border border-border bg-bg-subtle/30">
      <div className="flex items-center justify-between border-b border-border px-4 py-1.5 font-mono text-2xs text-fg-subtle">
        <span>closed [{closed.length}]</span>
        <span>last 100 retained</span>
      </div>
      <div className="divide-y divide-border/60 max-h-[55vh] overflow-y-auto">
        {closed.map((p) => {
          const pct = p.realized_pct;
          const pctColor =
            pct == null
              ? "text-fg-subtle"
              : pct >= 0
                ? "text-accent"
                : "text-danger";
          const pctLabel =
            pct == null
              ? "—"
              : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
          const realizedSol =
            pct != null ? (p.entry_total_sol * pct) / 100 : null;
          return (
            <div key={`${p.mint}-${p.closed_at_ms}`} className="px-4 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-fg-muted">
                  {p.mint.slice(0, 8)}..{p.mint.slice(-4)}
                </span>
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "font-mono text-xs tabular-nums font-semibold",
                      pctColor,
                    )}
                  >
                    {pctLabel}
                  </span>
                  {realizedSol != null && (
                    <span className={cn("font-mono text-2xs tabular-nums", pctColor)}>
                      {realizedSol >= 0 ? "+" : ""}
                      {realizedSol.toFixed(4)} SOL
                    </span>
                  )}
                  <span
                    className={cn(
                      "font-mono text-2xs",
                      exitColor[p.exit_kind] ?? "text-fg-subtle",
                    )}
                  >
                    {p.exit_kind}
                  </span>
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-2xs text-fg-subtle">
                <span>{p.entry_total_sol.toFixed(3)} SOL in</span>
                <span>·</span>
                <span>{p.wallet_count}w</span>
                <span>·</span>
                <span>
                  {Math.round((p.closed_at_ms - p.opened_at_ms) / 1000)}s
                </span>
                {p.bundle_id && (
                  <>
                    <span>·</span>
                    <a
                      href={`https://explorer.jito.wtf/bundle/${p.bundle_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-accent hover:underline"
                    >
                      bundle
                    </a>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
