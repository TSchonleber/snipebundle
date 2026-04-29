import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import {
  ipc,
  type VolumeBotConfig,
  type VolumeSessionInfo,
} from "../lib/ipc";
import { AppNav } from "../components/AppNav";

/**
 * Volume bot page. v0.1.55. Inspired by pumpkit's EZ Mode.
 *
 * Configures and starts an automated buy/sell loop on a target mint that
 * generates chart activity, with user-configurable cadence and a set of
 * stop guards (market cap, realized PnL, outsider whale buy, max cycles)
 * that halt the session the moment any threshold is breached.
 *
 * Sessions run in-process on the Rust side; this page is just the UI.
 * Polls listVolumeSessions every 2s while at least one session is live
 * so the user sees status without manual refresh.
 */
export function Volume() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [sessions, setSessions] = useState<VolumeSessionInfo[]>([]);

  // Form state
  const [mint, setMint] = useState("");
  const [pickedWallets, setPickedWallets] = useState<Set<string>>(new Set());
  const [buyMode, setBuyMode] = useState<"uniform" | "random">("uniform");
  const [buyUniform, setBuyUniform] = useState("0.05");
  const [buyMin, setBuyMin] = useState("0.02");
  const [buyMax, setBuyMax] = useState("0.10");
  const [sellPct, setSellPct] = useState("100");
  const [intervalMode, setIntervalMode] = useState<"fixed" | "random">("random");
  const [intervalFixed, setIntervalFixed] = useState("5");
  const [intervalMin, setIntervalMin] = useState("3");
  const [intervalMax, setIntervalMax] = useState("8");
  const [gapEnabled, setGapEnabled] = useState(true);
  const [gapFixed, setGapFixed] = useState("2");

  // Stop guards
  const [mcMaxSolEnabled, setMcMaxSolEnabled] = useState(false);
  const [mcMaxSol, setMcMaxSol] = useState("100");
  const [mcMinSolEnabled, setMcMinSolEnabled] = useState(false);
  const [mcMinSol, setMcMinSol] = useState("5");
  const [tpEnabled, setTpEnabled] = useState(false);
  const [tpSol, setTpSol] = useState("0.5");
  const [slEnabled, setSlEnabled] = useState(true);
  const [slSol, setSlSol] = useState("-0.3");
  const [outsiderEnabled, setOutsiderEnabled] = useState(true);
  const [outsiderMinSol, setOutsiderMinSol] = useState("1");
  const [maxCyclesEnabled, setMaxCyclesEnabled] = useState(false);
  const [maxCycles, setMaxCycles] = useState("50");
  const [sellOnStop, setSellOnStop] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([ipc.listWallets(), ipc.listDevWallets().catch(() => [] as WalletInfo[])])
      .then(([base, devs]) => setWallets([...base, ...devs]))
      .catch((e) => setError(String(e)));
  }, []);

  // Poll sessions while any are live. Backs off when there are no
  // sessions so we don't hammer IPC for nothing.
  const pollIntervalRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await ipc.listVolumeSessions();
        if (!cancelled) setSessions(list);
      } catch {
        /* ignore */
      }
    };
    tick();
    pollIntervalRef.current = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  function toggleWallet(pk: string) {
    setPickedWallets((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });
  }

  function buildConfig(): VolumeBotConfig | string {
    const trimmed = mint.trim();
    if (!trimmed) return "Mint required.";
    if (pickedWallets.size === 0) return "Pick at least one wallet.";

    let buyAmount: VolumeBotConfig["buy_amount"];
    if (buyMode === "uniform") {
      const v = parseFloat(buyUniform);
      if (!Number.isFinite(v) || v <= 0) return "Buy SOL must be positive.";
      buyAmount = { kind: "uniform", sol: v };
    } else {
      const lo = parseFloat(buyMin);
      const hi = parseFloat(buyMax);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
        return "Buy random range must satisfy 0 < min ≤ max.";
      }
      buyAmount = { kind: "random", min_sol: lo, max_sol: hi };
    }

    const sp = parseFloat(sellPct);
    if (!Number.isFinite(sp) || sp <= 0 || sp > 100) {
      return "Sell percent must be 1–100.";
    }

    let interval: VolumeBotConfig["interval_between_cycles"];
    if (intervalMode === "fixed") {
      const s = parseInt(intervalFixed, 10);
      if (!Number.isFinite(s) || s < 1) return "Interval seconds must be ≥ 1.";
      interval = { kind: "fixed", seconds: s };
    } else {
      const lo = parseInt(intervalMin, 10);
      const hi = parseInt(intervalMax, 10);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 1 || hi < lo) {
        return "Interval random range must satisfy 1 ≤ min ≤ max.";
      }
      interval = { kind: "random", min_seconds: lo, max_seconds: hi };
    }

    let gap: VolumeBotConfig["buy_to_sell_gap"] = null;
    if (gapEnabled) {
      const g = parseInt(gapFixed, 10);
      if (!Number.isFinite(g) || g < 1) return "Buy→sell gap must be ≥ 1.";
      gap = { kind: "fixed", seconds: g };
    }

    const guards: VolumeBotConfig["stop_guards"] = {};
    if (mcMaxSolEnabled) guards.market_cap_max_sol = parseFloat(mcMaxSol);
    if (mcMinSolEnabled) guards.market_cap_min_sol = parseFloat(mcMinSol);
    if (tpEnabled) guards.pnl_take_profit_sol = parseFloat(tpSol);
    if (slEnabled) guards.pnl_stop_loss_sol = parseFloat(slSol);
    if (outsiderEnabled) guards.outsider_buy_min_sol = parseFloat(outsiderMinSol);
    if (maxCyclesEnabled) guards.max_cycles = parseInt(maxCycles, 10);

    return {
      mint: trimmed,
      wallet_pubkeys: Array.from(pickedWallets),
      buy_amount: buyAmount,
      sell_percent: sp,
      interval_between_cycles: interval,
      buy_to_sell_gap: gap,
      stop_guards: guards,
      sell_on_stop: sellOnStop,
    };
  }

  async function startSession() {
    setError(null);
    const cfg = buildConfig();
    if (typeof cfg === "string") return setError(cfg);
    setBusy(true);
    try {
      const id = await ipc.startVolumeSession(cfg);
      const list = await ipc.listVolumeSessions();
      setSessions(list);
      // eslint-disable-next-line no-console
      console.log("volume session started", id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopSession(id: string) {
    try {
      await ipc.stopVolumeSession(id);
      setSessions(await ipc.listVolumeSessions());
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="min-h-screen">
      <AppNav status="stopped" />
      <div className="mx-auto max-w-5xl px-5 py-5">
        <div className="flex items-baseline gap-3 border-b border-border pb-3 mb-5">
          <h1 className="font-mono text-base text-fg">volume</h1>
          <span className="font-mono text-2xs text-fg-subtle">
            // automated buy/sell loop · stop guards · cycle wallets through a target mint
          </span>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <div className="space-y-5">
            {/* Target & wallets */}
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Target</h2>
              </CardHeader>
              <CardBody className="space-y-3">
                <input
                  type="text"
                  value={mint}
                  onChange={(e) => setMint(e.target.value)}
                  placeholder="paste pump.fun mint"
                  spellCheck={false}
                  className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <div>
                  <div className="mb-1.5 text-xs text-fg-subtle uppercase tracking-wider">
                    Wallets ({pickedWallets.size} picked)
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded border border-border bg-bg divide-y divide-border/40">
                    {wallets.map((w) => {
                      const checked = pickedWallets.has(w.pubkey);
                      return (
                        <label
                          key={w.pubkey}
                          className="flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-fg/5"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleWallet(w.pubkey)}
                            className="h-3.5 w-3.5 accent-accent"
                          />
                          <span className="font-mono text-2xs text-fg shrink-0 w-20 truncate">
                            {w.label}
                          </span>
                          <span className="font-mono text-2xs text-fg-subtle truncate">
                            {w.pubkey.slice(0, 10)}…{w.pubkey.slice(-6)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* Cadence + sizing */}
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Cadence & sizing</h2>
              </CardHeader>
              <CardBody className="space-y-4">
                <div>
                  <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">
                    Buy amount
                  </div>
                  <div className="flex gap-1 mb-2">
                    {(["uniform", "random"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setBuyMode(m)}
                        className={cn(
                          "px-3 py-1 rounded-md font-mono text-2xs border transition-colors",
                          buyMode === m
                            ? "border-accent text-accent bg-accent/5"
                            : "border-border text-fg-subtle hover:text-fg-muted",
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  {buyMode === "uniform" ? (
                    <input
                      type="text"
                      inputMode="decimal"
                      value={buyUniform}
                      onChange={(e) => setBuyUniform(e.target.value)}
                      placeholder="SOL per buy"
                      className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={buyMin}
                        onChange={(e) => setBuyMin(e.target.value)}
                        placeholder="min SOL"
                        className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        value={buyMax}
                        onChange={(e) => setBuyMax(e.target.value)}
                        placeholder="max SOL"
                        className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">
                    Sell %
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={sellPct}
                    onChange={(e) => setSellPct(e.target.value)}
                    className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <p className="mt-1 font-mono text-2xs text-fg-subtle">
                    What percent of the wallet's holdings to dump each cycle.
                    100 = full round-trip; lower bias = direction (e.g. 80 sells less than the buy).
                  </p>
                </div>

                <div>
                  <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">
                    Cycle interval (seconds)
                  </div>
                  <div className="flex gap-1 mb-2">
                    {(["fixed", "random"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setIntervalMode(m)}
                        className={cn(
                          "px-3 py-1 rounded-md font-mono text-2xs border transition-colors",
                          intervalMode === m
                            ? "border-accent text-accent bg-accent/5"
                            : "border-border text-fg-subtle hover:text-fg-muted",
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  {intervalMode === "fixed" ? (
                    <input
                      type="text"
                      inputMode="numeric"
                      value={intervalFixed}
                      onChange={(e) => setIntervalFixed(e.target.value)}
                      className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={intervalMin}
                        onChange={(e) => setIntervalMin(e.target.value)}
                        placeholder="min"
                        className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                      <input
                        type="text"
                        inputMode="numeric"
                        value={intervalMax}
                        onChange={(e) => setIntervalMax(e.target.value)}
                        placeholder="max"
                        className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={gapEnabled}
                      onChange={(e) => setGapEnabled(e.target.checked)}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <span className="text-sm font-semibold">Buy → sell gap</span>
                    <span className="font-mono text-2xs text-fg-subtle">
                      // delay so the buy confirms before the sell fires
                    </span>
                  </label>
                  {gapEnabled && (
                    <input
                      type="text"
                      inputMode="numeric"
                      value={gapFixed}
                      onChange={(e) => setGapFixed(e.target.value)}
                      placeholder="seconds"
                      className="mt-2 w-32 rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  )}
                </div>
              </CardBody>
            </Card>

            {/* Stop guards */}
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Stop guards</h2>
              </CardHeader>
              <CardBody className="space-y-3">
                <p className="text-sm text-fg-muted">
                  Session halts the moment any active guard's threshold is
                  breached. Inactive guards are ignored.
                </p>

                <Guard
                  enabled={mcMaxSolEnabled}
                  setEnabled={setMcMaxSolEnabled}
                  label="Market cap max (SOL)"
                  value={mcMaxSol}
                  setValue={setMcMaxSol}
                  hint="halt if MC ≥ this"
                />
                <Guard
                  enabled={mcMinSolEnabled}
                  setEnabled={setMcMinSolEnabled}
                  label="Market cap min (SOL)"
                  value={mcMinSol}
                  setValue={setMcMinSol}
                  hint="halt if MC ≤ this — bail when the coin's dying"
                />
                <Guard
                  enabled={tpEnabled}
                  setEnabled={setTpEnabled}
                  label="Realized PnL TP (SOL)"
                  value={tpSol}
                  setValue={setTpSol}
                  hint="halt at this realized profit"
                />
                <Guard
                  enabled={slEnabled}
                  setEnabled={setSlEnabled}
                  label="Realized PnL SL (SOL)"
                  value={slSol}
                  setValue={setSlSol}
                  hint="negative number — halt at this realized loss"
                />
                <Guard
                  enabled={outsiderEnabled}
                  setEnabled={setOutsiderEnabled}
                  label="Outsider buy ≥ (SOL)"
                  value={outsiderMinSol}
                  setValue={setOutsiderMinSol}
                  hint="halt if any non-session wallet buys at least this much"
                />
                <Guard
                  enabled={maxCyclesEnabled}
                  setEnabled={setMaxCyclesEnabled}
                  label="Max cycles"
                  value={maxCycles}
                  setValue={setMaxCycles}
                  hint="auto-stop after this many buy/sell cycles"
                />

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sellOnStop}
                    onChange={(e) => setSellOnStop(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <span className="text-sm font-semibold">Sell on stop</span>
                  <span className="font-mono text-2xs text-fg-subtle">
                    // dump 100% across all session wallets when a guard trips
                  </span>
                </label>
              </CardBody>
            </Card>

            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                {error}
              </div>
            )}

            <Button onClick={startSession} disabled={busy} size="lg">
              {busy ? "Starting…" : "Start volume session"}
            </Button>
          </div>

          <aside className="space-y-3">
            <Card>
              <CardHeader>
                <h3 className="font-semibold">Active sessions</h3>
              </CardHeader>
              <CardBody className="space-y-2">
                {sessions.length === 0 ? (
                  <div className="hatch border border-dashed border-border px-3 py-4 text-center font-mono text-2xs text-fg-subtle">
                    no sessions running
                  </div>
                ) : (
                  sessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      onStop={() => stopSession(s.id)}
                    />
                  ))
                )}
              </CardBody>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Guard({
  enabled,
  setEnabled,
  label,
  value,
  setValue,
  hint,
}: {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  label: string;
  value: string;
  setValue: (v: string) => void;
  hint: string;
}) {
  return (
    <div className="rounded border border-border/60 bg-bg-raised px-3 py-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-3.5 w-3.5 accent-accent"
        />
        <span className="text-sm font-semibold flex-1">{label}</span>
        {enabled && (
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24 rounded border border-border bg-bg px-2 py-1 font-mono text-2xs text-right focus:outline-none focus:ring-2 focus:ring-accent"
          />
        )}
      </label>
      {enabled && (
        <p className="mt-1 pl-5 font-mono text-[10px] text-fg-subtle">{hint}</p>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onStop,
}: {
  session: VolumeSessionInfo;
  onStop: () => void;
}) {
  const s = session.status;
  const realized = s.session_sol_out - s.session_sol_in;
  return (
    <div
      className={cn(
        "rounded border px-3 py-2 space-y-1",
        s.running ? "border-accent/40 bg-accent/5" : "border-border bg-bg-raised",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-2xs text-fg-muted truncate">
          {session.id}
        </span>
        {s.running && (
          <button
            type="button"
            onClick={onStop}
            className="font-mono text-2xs text-danger/70 hover:text-danger"
          >
            stop
          </button>
        )}
      </div>
      <div className="font-mono text-2xs text-fg-subtle">
        {s.last_message}
      </div>
      <div className="grid grid-cols-3 gap-2 font-mono text-[10px] text-fg-subtle">
        <span>cycles {s.cycles_completed}</span>
        <span>buys {s.buys_submitted}</span>
        <span>sells {s.sells_submitted}</span>
        <span>in {s.session_sol_in.toFixed(3)}</span>
        <span>out {s.session_sol_out.toFixed(3)}</span>
        <span
          className={cn(
            realized >= 0 ? "text-accent" : "text-danger",
            "font-semibold",
          )}
        >
          pnl {realized >= 0 ? "+" : ""}
          {realized.toFixed(3)}
        </span>
        {s.current_mc_sol != null && <span>mc {s.current_mc_sol.toFixed(2)}</span>}
        {s.failures > 0 && <span className="text-warn">fail {s.failures}</span>}
      </div>
      {s.stop_reason && (
        <div className="font-mono text-[10px] text-warn">
          stopped: {s.stop_reason}
        </div>
      )}
    </div>
  );
}
