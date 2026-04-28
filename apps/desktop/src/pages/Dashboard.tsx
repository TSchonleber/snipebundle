import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  MintFeedHeader,
  MintFeedRow,
  type EngineState,
} from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { AppNav } from "../components/AppNav";

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

        <div className="mb-6 grid grid-cols-3 gap-4">
          <Stat label="mints seen" value={state?.mint_count ?? 0} />
          <Stat
            label="matched"
            value={state?.matched_count ?? 0}
            accent
          />
          <Stat label="bundles fired" value={state?.bundle_count ?? 0} />
        </div>

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
                  return (
                    <div key={p.mint} className="px-4 py-3">
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-sm">
                          {p.mint.slice(0, 12)}…
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
            <Card>
              <CardBody>
                <h3 className="font-semibold">Settings</h3>
                <p className="mt-2 text-sm text-fg-subtle">
                  Settings panel lands in the next update. For now, edit the
                  config file at{" "}
                  <code className="font-mono text-xs">
                    ~/.config/snipebundle/config.toml
                  </code>{" "}
                  (Linux/Mac) or{" "}
                  <code className="font-mono text-xs">
                    %APPDATA%\snipebundle\config.toml
                  </code>{" "}
                  (Windows) and restart.
                </p>
              </CardBody>
            </Card>
          </aside>
        </div>
      </div>
    </div>
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
