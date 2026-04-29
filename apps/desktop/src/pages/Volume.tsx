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
 * Volume bot page. v0.1.55+ with v0.1.56 role/visualization additions.
 *
 * Only `volume`-role wallets are eligible — keeps hot snipers and dev
 * wallets from accidentally being sucked into a volume loop and leaving
 * their identity on-chain. Inline "+ create volume wallet" mints a fresh
 * keypair, lands it in the volume_wallets pool, and reveals the secret
 * once. Reassigning sniper/dev wallets to volume is one click on
 * /wallets > manage.
 *
 * Sessions run in-process on the Rust side; this page is just UI.
 * Polls listVolumeSessions every 1.5s while at least one is live so the
 * activity chart and per-wallet badges stay fresh without manual refresh.
 */
export function Volume() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [sessions, setSessions] = useState<VolumeSessionInfo[]>([]);

  // Sample buffer for the activity chart — append a snapshot every poll
  // so we can render a sparkline of cycles, in/out, realized PnL.
  const samplesRef = useRef<
    Map<string, { ts: number; cycles: number; in: number; out: number }[]>
  >(new Map());

  // Form state
  const [mint, setMint] = useState("");
  const [pickedWallets, setPickedWallets] = useState<Set<string>>(new Set());
  const [buyMode, setBuyMode] = useState<"uniform" | "random">("uniform");
  const [buyUniform, setBuyUniform] = useState("0.05");
  const [buyMin, setBuyMin] = useState("0.02");
  const [buyMax, setBuyMax] = useState("0.10");
  const [sellPct, setSellPct] = useState("100");
  const [intervalMode, setIntervalMode] = useState<"fixed" | "random">(
    "random",
  );
  const [intervalFixed, setIntervalFixed] = useState("5");
  const [intervalMin, setIntervalMin] = useState("3");
  const [intervalMax, setIntervalMax] = useState("8");
  const [gapEnabled, setGapEnabled] = useState(true);
  const [gapFixed, setGapFixed] = useState("2");

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

  // Inline wallet creation state.
  const [newWalletPass, setNewWalletPass] = useState("");
  const [newWalletLabel, setNewWalletLabel] = useState("");
  const [newWalletReveal, setNewWalletReveal] = useState<{
    label: string;
    pubkey: string;
    secret_b58: string;
  } | null>(null);
  const [newWalletBusy, setNewWalletBusy] = useState(false);
  const [newWalletErr, setNewWalletErr] = useState<string | null>(null);

  async function refreshWallets() {
    try {
      const list = await ipc.listVolumeWallets();
      setWallets(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refreshWallets();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await ipc.listVolumeSessions();
        if (cancelled) return;
        setSessions(list);
        // Append samples for chart rendering.
        const now = Date.now();
        for (const s of list) {
          const arr = samplesRef.current.get(s.id) ?? [];
          arr.push({
            ts: now,
            cycles: s.status.cycles_completed,
            in: s.status.session_sol_in,
            out: s.status.session_sol_out,
          });
          // Keep last 200 samples per session so the sparkline stays
          // bounded and we don't leak memory across long sessions.
          while (arr.length > 200) arr.shift();
          samplesRef.current.set(s.id, arr);
        }
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
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

  async function createWallet() {
    setNewWalletErr(null);
    if (newWalletPass.length < 12) {
      return setNewWalletErr("Enter your keystore passphrase.");
    }
    setNewWalletBusy(true);
    try {
      const w = await ipc.createVolumeWallet(
        newWalletPass,
        newWalletLabel.trim() || undefined,
      );
      setNewWalletReveal(w);
      setNewWalletLabel("");
      setNewWalletPass("");
      await refreshWallets();
    } catch (e) {
      setNewWalletErr(String(e));
    } finally {
      setNewWalletBusy(false);
    }
  }

  function buildConfig(): VolumeBotConfig | string {
    const trimmed = mint.trim();
    if (!trimmed) return "Mint required.";
    if (pickedWallets.size === 0)
      return "Pick at least one volume wallet — or create one below.";

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
    if (outsiderEnabled)
      guards.outsider_buy_min_sol = parseFloat(outsiderMinSol);
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
      await ipc.startVolumeSession(cfg);
      const list = await ipc.listVolumeSessions();
      setSessions(list);
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
            // automated buy/sell loop · stop guards · cycle volume wallets
            through a target mint
          </span>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <div className="space-y-5">
            {/* Target & wallets */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Target & wallets</h2>
                  <span className="font-mono text-2xs text-purple-400">
                    {wallets.length} volume wallet
                    {wallets.length === 1 ? "" : "s"}
                  </span>
                </div>
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
                {wallets.length === 0 ? (
                  <div className="hatch border border-dashed border-border px-4 py-6 text-center font-mono text-2xs text-fg-subtle">
                    no volume wallets yet — create one below or reassign a
                    sniper/dev to volume on{" "}
                    <span className="text-fg-muted">/wallets &gt; manage</span>
                  </div>
                ) : (
                  <div>
                    <div className="mb-1.5 text-xs text-fg-subtle uppercase tracking-wider">
                      Pick wallets ({pickedWallets.size} of {wallets.length})
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
                            <span className="font-mono text-[9px] uppercase tracking-wider text-purple-400 shrink-0">
                              vol
                            </span>
                            <span className="font-mono text-2xs text-fg-subtle truncate">
                              {w.pubkey.slice(0, 10)}…{w.pubkey.slice(-6)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Inline wallet creation */}
                <details className="rounded-lg border border-border bg-bg-raised p-3">
                  <summary className="cursor-pointer font-mono text-2xs text-fg-subtle hover:text-fg-muted">
                    + create volume wallet
                  </summary>
                  <div className="mt-3 space-y-2">
                    {newWalletReveal ? (
                      <div className="rounded border border-accent/40 bg-accent/5 p-3">
                        <div className="text-sm font-semibold text-accent">
                          ✓ {newWalletReveal.label} created — save the secret
                          NOW
                        </div>
                        <div className="mt-2 text-xs text-fg-subtle">
                          public
                        </div>
                        <code className="block break-all font-mono text-2xs">
                          {newWalletReveal.pubkey}
                        </code>
                        <div className="mt-2 text-xs text-fg-subtle">
                          secret (one-time)
                        </div>
                        <code className="block break-all font-mono text-2xs text-warn">
                          {newWalletReveal.secret_b58}
                        </code>
                        <Button
                          size="sm"
                          className="mt-2"
                          onClick={() => setNewWalletReveal(null)}
                        >
                          I saved it
                        </Button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={newWalletLabel}
                          onChange={(e) => setNewWalletLabel(e.target.value)}
                          placeholder="label (optional, e.g. vol-3)"
                          className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
                        />
                        <input
                          type="password"
                          value={newWalletPass}
                          onChange={(e) => setNewWalletPass(e.target.value)}
                          placeholder="keystore passphrase"
                          className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
                        />
                        {newWalletErr && (
                          <div className="rounded border border-danger/40 bg-danger/10 p-2 text-2xs text-danger">
                            {newWalletErr}
                          </div>
                        )}
                        <Button
                          size="sm"
                          onClick={createWallet}
                          disabled={newWalletBusy}
                        >
                          {newWalletBusy ? "Generating…" : "Generate + save"}
                        </Button>
                      </>
                    )}
                  </div>
                </details>
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
                    <span className="text-sm font-semibold">
                      Buy → sell gap
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

            <Card>
              <CardHeader>
                <h2 className="font-semibold">Stop guards</h2>
              </CardHeader>
              <CardBody className="space-y-3">
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
                  sessions.map((s) => {
                    const series = samplesRef.current.get(s.id) ?? [];
                    return (
                      <SessionRow
                        key={s.id}
                        session={s}
                        series={series}
                        onStop={() => stopSession(s.id)}
                      />
                    );
                  })
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
  series,
  onStop,
}: {
  session: VolumeSessionInfo;
  series: { ts: number; cycles: number; in: number; out: number }[];
  onStop: () => void;
}) {
  const s = session.status;
  const realized = s.session_sol_out - s.session_sol_in;
  return (
    <div
      className={cn(
        "rounded border px-3 py-2 space-y-1.5",
        s.running
          ? "border-accent/40 bg-accent/5"
          : "border-border bg-bg-raised",
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
      <div className="font-mono text-2xs text-fg-subtle truncate">
        {s.last_message}
      </div>

      {/* Live mini-chart of session activity over time. Two series: the
          PnL curve (realized SOL out − in) on the value axis and a
          cycle-count tick. The component renders a tiny SVG inline; no
          chart lib needed for a 12-line sparkline. */}
      <Sparkline series={series} />

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
        {s.current_mc_sol != null && (
          <span>mc {s.current_mc_sol.toFixed(2)}</span>
        )}
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

/**
 * Tiny inline-SVG sparkline of realized PnL across session samples.
 * Two parallel series visible: the PnL curve in accent or danger color
 * depending on direction, and a low-vis cycle-count tick row underneath.
 */
function Sparkline({
  series,
}: {
  series: { ts: number; cycles: number; in: number; out: number }[];
}) {
  const W = 280;
  const H = 36;
  const pad = 2;

  const points = useMemo(() => {
    if (series.length < 2) return [] as { x: number; y: number; pnl: number }[];
    const pnls = series.map((s) => s.out - s.in);
    const minP = Math.min(0, ...pnls);
    const maxP = Math.max(0, ...pnls);
    const range = maxP - minP || 1;
    return series.map((s, i) => {
      const x = pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2);
      const pnl = s.out - s.in;
      const yNorm = (pnl - minP) / range;
      const y = H - pad - yNorm * (H - pad * 2);
      return { x, y, pnl };
    });
  }, [series]);

  if (points.length < 2) {
    return (
      <div className="flex h-9 items-center justify-center font-mono text-[10px] text-fg-subtle/60">
        gathering samples…
      </div>
    );
  }

  const lastPnl = points[points.length - 1].pnl;
  const stroke = lastPnl >= 0 ? "rgb(95, 227, 154)" : "rgb(239, 111, 125)";
  const fill = lastPnl >= 0 ? "rgba(95, 227, 154, 0.1)" : "rgba(239, 111, 125, 0.1)";
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const area =
    `M${points[0].x},${H - pad} ` +
    points.map((p) => `L${p.x},${p.y}`).join(" ") +
    ` L${points[points.length - 1].x},${H - pad} Z`;

  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="rounded bg-bg/60"
    >
      <path d={area} fill={fill} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.25} />
    </svg>
  );
}
