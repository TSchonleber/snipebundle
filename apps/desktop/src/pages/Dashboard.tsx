import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  MintFeedHeader,
  MintFeedRow,
  type EngineState,
} from "@snipebundle/ui";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _unused = EngineState;
import { ipc } from "../lib/ipc";
import { AppNav } from "../components/AppNav";
import { SniperSettings } from "../components/SniperSettings";

export function Dashboard() {
  const [state, setState] = useState<EngineState | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <div className="mx-auto max-w-6xl px-6 py-4 flex justify-end gap-2">
        {state?.running ? (
          <>
            <Button size="sm" variant="secondary" onClick={togglePause}>
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button size="sm" variant="danger" onClick={stop}>
              Stop
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={start}>
            GO LIVE
          </Button>
        )}
      </div>

      <div className="mx-auto max-w-6xl px-6 pb-6">
        {error && (
          <Card className="mb-4">
            <CardBody className="text-danger text-sm">{error}</CardBody>
          </Card>
        )}

        <div className="mb-4 grid grid-cols-3 gap-4">
          <Stat label="mints seen" value={state?.mint_count ?? 0} />
          <Stat
            label="matched"
            value={state?.matched_count ?? 0}
            accent
          />
          <Stat label="bundles fired" value={state?.bundle_count ?? 0} />
        </div>

        <PnlBar state={state} />


        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <Card className="overflow-hidden">
              <div className="border-b border-border bg-bg-raised px-4 py-2 text-xs font-mono uppercase tracking-wider text-fg-subtle">
                Live mint feed
              </div>
              <MintFeedHeader />
              <div className="max-h-[60vh] overflow-y-auto">
                {(state?.feed ?? []).slice(0, 50).map((e) => (
                  <MintFeedRow key={e.mint + e.at_ms} entry={e} />
                ))}
                {(!state || state.feed.length === 0) && (
                  <div className="px-3 py-8 text-center text-fg-subtle">
                    {state?.running
                      ? "Waiting for the next mint…"
                      : "Press GO LIVE to start the engine."}
                  </div>
                )}
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border bg-bg-raised px-4 py-2 text-xs font-mono uppercase tracking-wider text-fg-subtle">
                Active positions
              </div>
              <div className="divide-y divide-border/50">
                {(state?.positions ?? []).map((p) => {
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
                  const kindBadge =
                    kind === "launch"
                      ? "border-warn/40 bg-warn/10 text-warn"
                      : kind === "manual"
                        ? "border-fg-subtle/40 bg-bg-raised text-fg-muted"
                        : "border-accent/40 bg-accent/10 text-accent";
                  return (
                    <div key={p.mint} className="px-4 py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${kindBadge}`}
                          >
                            {kind}
                          </span>
                          <div className="font-mono text-sm">
                            {p.mint.slice(0, 12)}…
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span
                            className={`font-mono text-sm tabular-nums font-semibold ${pctColor}`}
                          >
                            {pctLabel}
                          </span>
                          <span className="font-mono text-xs uppercase tracking-wider text-accent">
                            {p.trigger}
                          </span>
                        </div>
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-sm text-fg-muted">
                        <span>{p.entry_total_sol.toFixed(3)} SOL</span>
                        <span>·</span>
                        <span>{p.wallet_count} wallets</span>
                        <span>·</span>
                        <span>
                          {Math.round((Date.now() - p.opened_at_ms) / 1000)}s
                        </span>
                        {p.entry_price != null && p.last_price != null && (
                          <>
                            <span>·</span>
                            <span className="font-mono text-xs text-fg-subtle">
                              {p.entry_price.toExponential(2)} →{" "}
                              {p.last_price.toExponential(2)}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-xs text-fg-subtle">
                        {p.status}
                      </div>
                    </div>
                  );
                })}
                {(!state || state.positions.length === 0) && (
                  <div className="px-4 py-8 text-center text-fg-subtle">
                    No open positions.
                  </div>
                )}
              </div>
            </Card>

            <ClosedPositionsLog state={state} />
          </div>

          <aside className="space-y-3">
            <Card>
              <CardBody>
                <div className="text-xs font-mono uppercase tracking-wider text-fg-subtle">
                  Last engine message
                </div>
                <div className="mt-2 text-sm text-fg">
                  {state?.last_message || "—"}
                </div>
              </CardBody>
            </Card>
            <SniperSettings />
          </aside>
        </div>
      </div>
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

  const fmt = (n: number) =>
    `${n >= 0 ? "+" : ""}${n.toFixed(4)} SOL`;
  const color = (n: number) =>
    n > 0 ? "text-accent" : n < 0 ? "text-danger" : "text-fg-muted";

  return (
    <Card className="mb-4">
      <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <PnlCell label="Net P&L" value={fmt(net)} className={color(net)} bold />
        <PnlCell
          label="Realized"
          value={fmt(realized)}
          className={color(realized)}
        />
        <PnlCell
          label="Unrealized"
          value={fmt(unrealized)}
          className={color(unrealized)}
        />
        <PnlCell
          label="Deployed"
          value={`${deployed.toFixed(4)} SOL`}
          className="text-fg"
        />
        <PnlCell
          label="Win rate"
          value={
            winRate == null
              ? "—"
              : `${winRate.toFixed(0)}% (${wins}W ${losses}L)`
          }
          className={
            winRate == null
              ? "text-fg-subtle"
              : winRate >= 50
                ? "text-accent"
                : "text-warn"
          }
        />
      </CardBody>
    </Card>
  );
}

function PnlCell({
  label,
  value,
  className,
  bold,
}: {
  label: string;
  value: string;
  className?: string;
  bold?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div
        className={`mt-1 font-mono tabular-nums ${
          bold ? "text-xl font-bold" : "text-sm"
        } ${className ?? ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function ClosedPositionsLog({ state }: { state: EngineState | null }) {
  const closed = state?.closed_positions ?? [];
  if (closed.length === 0) {
    return (
      <Card className="overflow-hidden">
        <div className="border-b border-border bg-bg-raised px-4 py-2 text-xs font-mono uppercase tracking-wider text-fg-subtle">
          Closed positions
        </div>
        <CardBody className="text-center text-fg-subtle text-sm">
          No closed positions yet.
        </CardBody>
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border bg-bg-raised px-4 py-2 text-xs font-mono uppercase tracking-wider text-fg-subtle flex items-center justify-between">
        <span>Closed positions ({closed.length})</span>
        <span className="text-[10px]">last 100 retained</span>
      </div>
      <div className="divide-y divide-border/50 max-h-[40vh] overflow-y-auto">
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
          const exitColor: Record<string, string> = {
            "take-profit": "text-accent",
            "stop-loss": "text-danger",
            "time-exit": "text-fg-muted",
            manual: "text-fg-muted",
            failed: "text-danger",
            mixed: "text-warn",
          };
          return (
            <div key={`${p.mint}-${p.closed_at_ms}`} className="px-4 py-2.5">
              <div className="flex items-center justify-between">
                <div className="font-mono text-xs text-fg-muted">
                  {p.mint.slice(0, 12)}…
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`font-mono text-sm tabular-nums font-semibold ${pctColor}`}
                  >
                    {pctLabel}
                  </span>
                  {realizedSol != null && (
                    <span
                      className={`font-mono text-xs tabular-nums ${pctColor}`}
                    >
                      {realizedSol >= 0 ? "+" : ""}
                      {realizedSol.toFixed(4)} SOL
                    </span>
                  )}
                  <span
                    className={`font-mono text-[10px] uppercase tracking-wider ${
                      exitColor[p.exit_kind] ?? "text-fg-subtle"
                    }`}
                  >
                    {p.exit_kind}
                  </span>
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-3 text-[11px] text-fg-subtle">
                <span>{p.entry_total_sol.toFixed(3)} SOL in</span>
                <span>·</span>
                <span>{p.wallet_count}w</span>
                <span>·</span>
                <span>
                  {Math.round((p.closed_at_ms - p.opened_at_ms) / 1000)}s held
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
                      buy bundle
                    </a>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs font-mono uppercase tracking-wider text-fg-subtle">
          {label}
        </div>
        <div
          className={`mt-2 text-3xl font-bold tabular-nums ${
            accent ? "text-accent" : ""
          }`}
        >
          {value}
        </div>
      </CardBody>
    </Card>
  );
}
