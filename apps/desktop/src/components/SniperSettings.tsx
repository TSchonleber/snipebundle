import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc, type AppConfig, type AmountStrategy } from "../lib/ipc";

type StrategyKind = "uniform" | "per_wallet" | "random";

export function SniperSettings({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<StrategyKind>("uniform");
  const [uniformSol, setUniformSol] = useState("0.05");
  const [perWalletAmounts, setPerWalletAmounts] = useState<Record<string, string>>(
    {},
  );
  const [randomMin, setRandomMin] = useState("0.02");
  const [randomMax, setRandomMax] = useState("0.10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([ipc.loadConfig(), ipc.listWallets()])
      .then(([c, ws]) => {
        setCfg(c);
        const snipersOnly = ws.filter((w) => w.label.startsWith("sniper"));
        setWallets(snipersOnly);
        setPicked(c.trigger.auto_snipe_wallets);
        setUniformSol(String(c.trigger.sol_per_snipe));
        const s = c.trigger.amount_strategy;
        if (s) {
          if (s.kind === "uniform") {
            setStrategy("uniform");
            setUniformSol(String(s.sol));
          } else if (s.kind === "per_wallet") {
            setStrategy("per_wallet");
            const map: Record<string, string> = {};
            for (const [k, v] of Object.entries(s.sol_per_wallet)) {
              map[k] = String(v);
            }
            setPerWalletAmounts(map);
          } else if (s.kind === "random") {
            setStrategy("random");
            setRandomMin(String(s.min_sol));
            setRandomMax(String(s.max_sol));
          }
        } else {
          setStrategy("uniform");
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  const totalEstimate = useMemo(() => {
    if (strategy === "uniform") {
      const v = parseFloat(uniformSol);
      return Number.isFinite(v) ? v * picked.length : 0;
    }
    if (strategy === "per_wallet") {
      return picked.reduce((acc, pk) => {
        const v = parseFloat(perWalletAmounts[pk] ?? "0");
        return acc + (Number.isFinite(v) ? v : 0);
      }, 0);
    }
    const lo = parseFloat(randomMin);
    const hi = parseFloat(randomMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
    return ((lo + hi) / 2) * picked.length;
  }, [strategy, uniformSol, perWalletAmounts, randomMin, randomMax, picked]);

  function toggle(pk: string) {
    if (picked.includes(pk)) {
      setPicked(picked.filter((p) => p !== pk));
    } else if (picked.length >= 5) {
      return;
    } else {
      setPicked([...picked, pk]);
      if (!perWalletAmounts[pk]) {
        setPerWalletAmounts({ ...perWalletAmounts, [pk]: uniformSol });
      }
    }
  }

  function buildStrategy(): AmountStrategy | null | string {
    if (strategy === "uniform") {
      const v = parseFloat(uniformSol);
      if (!Number.isFinite(v) || v <= 0) return "Uniform amount must be > 0.";
      // Uniform is the default; persist as a strategy so the backend uses it
      // explicitly (rather than falling back to sol_per_snipe).
      return { kind: "uniform", sol: v };
    }
    if (strategy === "per_wallet") {
      const map: Record<string, number> = {};
      for (const pk of picked) {
        const v = parseFloat(perWalletAmounts[pk] ?? "");
        if (!Number.isFinite(v) || v <= 0) {
          return `Set a positive amount for ${pk.slice(0, 8)}…`;
        }
        map[pk] = v;
      }
      return { kind: "per_wallet", sol_per_wallet: map };
    }
    const lo = parseFloat(randomMin);
    const hi = parseFloat(randomMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
      return "Random range must satisfy 0 < min ≤ max.";
    }
    return { kind: "random", min_sol: lo, max_sol: hi };
  }

  async function save() {
    setError(null);
    if (!cfg) return;
    if (picked.length === 0) return setError("Pick at least one sniper wallet.");
    const built = buildStrategy();
    if (typeof built === "string") return setError(built);

    const next: AppConfig = {
      ...cfg,
      trigger: {
        ...cfg.trigger,
        auto_snipe_wallets: picked,
        amount_strategy: built,
        // Keep sol_per_snipe in sync with uniform fallback so legacy
        // config readers still get sane defaults.
        sol_per_snipe:
          built && built.kind === "uniform" ? built.sol : cfg.trigger.sol_per_snipe,
      },
    };
    setBusy(true);
    try {
      await ipc.saveConfig(next);
      setCfg(next);
      setSavedAt(Date.now());
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <Card>
        <CardBody className="text-fg-subtle text-sm">Loading config…</CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Sniper config</h2>
      </CardHeader>
      <CardBody className="space-y-5">
        <p className="text-xs text-fg-muted">
          Which wallets fire on each auto-match, and how much each spends.
          Restart-free — the engine reads these on the next trigger.
        </p>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">
              Active wallets ({picked.length}/5)
            </h3>
            <span className="text-xs text-fg-subtle font-mono">
              of {wallets.length} snipers
            </span>
          </div>
          {wallets.length === 0 ? (
            <p className="text-sm text-fg-subtle">
              No sniper wallets yet. Add some in the Wallets tab.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {wallets.map((w) => {
                const isSel = picked.includes(w.pubkey);
                const atCap = !isSel && picked.length >= 5;
                return (
                  <button
                    key={w.pubkey}
                    type="button"
                    disabled={atCap}
                    onClick={() => toggle(w.pubkey)}
                    className={cn(
                      "w-full rounded-lg border bg-bg-subtle p-2 text-left transition-colors",
                      isSel
                        ? "border-accent bg-accent/5"
                        : atCap
                          ? "border-border opacity-40 cursor-not-allowed"
                          : "border-border hover:border-border-strong",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs uppercase tracking-wider text-fg-muted">
                        {w.label}
                      </span>
                      <code className="font-mono text-[10px] text-fg-subtle truncate">
                        {w.pubkey.slice(0, 16)}…
                      </code>
                      {isSel && (
                        <span className="font-mono text-xs text-accent shrink-0">
                          ✓
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Buy strategy per snipe</h3>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {(["uniform", "per_wallet", "random"] as StrategyKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setStrategy(k)}
                className={cn(
                  "rounded-lg border bg-bg-subtle p-2 text-xs capitalize transition-colors",
                  strategy === k
                    ? "border-accent text-accent"
                    : "border-border text-fg-muted hover:border-border-strong",
                )}
              >
                {k.replace("_", "-")}
              </button>
            ))}
          </div>

          {strategy === "uniform" && (
            <div>
              <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                SOL per wallet
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={uniformSol}
                onChange={(e) => setUniformSol(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          )}

          {strategy === "per_wallet" && (
            <div className="space-y-2">
              {picked.length === 0 ? (
                <p className="text-xs text-fg-subtle">
                  Pick wallets above first.
                </p>
              ) : (
                picked.map((pk) => {
                  const w = wallets.find((x) => x.pubkey === pk);
                  return (
                    <div
                      key={pk}
                      className="flex items-center gap-2 rounded-lg border border-border bg-bg-raised px-2 py-1.5"
                    >
                      <span className="font-mono text-xs text-fg-muted w-20 shrink-0">
                        {w?.label ?? "?"}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={perWalletAmounts[pk] ?? ""}
                        onChange={(e) =>
                          setPerWalletAmounts({
                            ...perWalletAmounts,
                            [pk]: e.target.value,
                          })
                        }
                        className="flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                      <span className="text-xs text-fg-subtle">SOL</span>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {strategy === "random" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                  Min SOL
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={randomMin}
                  onChange={(e) => setRandomMin(e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                  Max SOL
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={randomMax}
                  onChange={(e) => setRandomMax(e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>
          )}

          <p className="mt-2 text-xs text-fg-subtle font-mono">
            ~{totalEstimate.toFixed(4)} SOL per fire across {picked.length}{" "}
            wallets
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-subtle">
            {savedAt
              ? `saved ${new Date(savedAt).toLocaleTimeString()}`
              : "unsaved changes will not affect a running engine until next match"}
          </span>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
