import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc, type AmountStrategy } from "../lib/ipc";
import { AppNav } from "../components/AppNav";
import { MintChart } from "../components/MintChart";

interface BundleRecord {
  kind: "buy" | "sell";
  bundle_id: string;
  mint: string;
  ts: number;
}

type StrategyKind = "uniform" | "per_wallet" | "random";

export function Trade() {
  const [params] = useSearchParams();
  const [mint, setMint] = useState(params.get("mint") ?? "");
  const [strategy, setStrategy] = useState<StrategyKind>("uniform");
  const [uniformSol, setUniformSol] = useState("0.05");
  const [perWalletAmounts, setPerWalletAmounts] = useState<Record<string, string>>({});
  const [randomMin, setRandomMin] = useState("0.02");
  const [randomMax, setRandomMax] = useState("0.10");
  const [sellPercent, setSellPercent] = useState(100);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BundleRecord[]>([]);

  useEffect(() => {
    Promise.all([
      ipc.listWallets(),
      ipc.listDevWallets().catch(() => [] as WalletInfo[]),
    ])
      .then(([base, devs]) => setWallets([...base, ...devs]))
      .catch((e) => setError(String(e)));
  }, []);

  const totalUniform = useMemo(() => {
    const v = parseFloat(uniformSol);
    return Number.isFinite(v) ? v * picked.length : 0;
  }, [uniformSol, picked.length]);

  const totalPerWallet = useMemo(
    () =>
      picked.reduce((acc, pk) => {
        const v = parseFloat(perWalletAmounts[pk] ?? "0");
        return acc + (Number.isFinite(v) ? v : 0);
      }, 0),
    [picked, perWalletAmounts],
  );

  const totalRandomMidpoint = useMemo(() => {
    const lo = parseFloat(randomMin);
    const hi = parseFloat(randomMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
    return ((lo + hi) / 2) * picked.length;
  }, [randomMin, randomMax, picked.length]);

  function toggleWallet(pk: string) {
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

  function buildStrategy(): AmountStrategy | string {
    if (strategy === "uniform") {
      const sol = parseFloat(uniformSol);
      if (!Number.isFinite(sol) || sol <= 0) return "Uniform amount must be positive.";
      return { kind: "uniform", sol };
    }
    if (strategy === "per_wallet") {
      const map: Record<string, number> = {};
      for (const pk of picked) {
        const v = parseFloat(perWalletAmounts[pk] ?? "");
        if (!Number.isFinite(v) || v <= 0) return `Set a positive amount for ${pk.slice(0, 8)}…`;
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

  async function buy() {
    setError(null);
    if (!mint.trim()) return setError("Enter a mint address.");
    if (picked.length === 0) return setError("Pick at least one wallet.");
    const strat = buildStrategy();
    if (typeof strat === "string") return setError(strat);
    setBusy(true);
    try {
      const id = await ipc.manualSnipe({
        mint: mint.trim(),
        wallet_pubkeys: picked,
        strategy: strat,
      });
      setHistory((h) => [
        { kind: "buy", bundle_id: id, mint: mint.trim(), ts: Date.now() },
        ...h,
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sell() {
    setError(null);
    if (!mint.trim()) return setError("Enter a mint address.");
    if (picked.length === 0) return setError("Pick at least one wallet.");
    if (sellPercent <= 0 || sellPercent > 100) {
      return setError("Sell % must be 1–100.");
    }
    setBusy(true);
    try {
      const id = await ipc.manualDump({
        mint: mint.trim(),
        wallet_pubkeys: picked,
        percent: sellPercent,
      });
      setHistory((h) => [
        { kind: "sell", bundle_id: id, mint: mint.trim(), ts: Date.now() },
        ...h,
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function applyUniformToAll() {
    const next: Record<string, string> = { ...perWalletAmounts };
    for (const pk of picked) next[pk] = uniformSol;
    setPerWalletAmounts(next);
  }

  return (
    <div className="min-h-screen">
      <AppNav status="stopped" />
      <div className="mx-auto max-w-5xl px-5 py-5">
        <div className="flex items-baseline gap-3 border-b border-border pb-3 mb-5">
          <h1 className="font-mono text-base text-fg">trade</h1>
          <span className="font-mono text-2xs text-fg-subtle">
            // manual buy / sell — up to 5 wallets per bundle
          </span>
        </div>

        <div className="mb-5">
          <MintChart mint={mint} height={340} />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Target</h2>
              </CardHeader>
              <CardBody className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold mb-2">
                    Mint address
                  </label>
                  <input
                    value={mint}
                    onChange={(e) => setMint(e.target.value)}
                    placeholder="paste pump.fun mint address"
                    className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Buy strategy</h2>
                </div>
              </CardHeader>
              <CardBody className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  <StratPill
                    active={strategy === "uniform"}
                    onClick={() => setStrategy("uniform")}
                    label="Uniform"
                    sub="Same SOL each"
                  />
                  <StratPill
                    active={strategy === "per_wallet"}
                    onClick={() => setStrategy("per_wallet")}
                    label="Per-wallet"
                    sub="Set each amount"
                  />
                  <StratPill
                    active={strategy === "random"}
                    onClick={() => setStrategy("random")}
                    label="Random"
                    sub="In a range"
                  />
                </div>

                {strategy === "uniform" && (
                  <div>
                    <label className="block text-sm font-semibold mb-2">
                      SOL per wallet
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={uniformSol}
                      onChange={(e) => setUniformSol(e.target.value)}
                      className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                    <p className="mt-1 text-xs text-fg-subtle">
                      Total: {totalUniform.toFixed(4)} SOL across {picked.length} wallets
                    </p>
                  </div>
                )}

                {strategy === "per_wallet" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-fg-subtle">
                        Total: {totalPerWallet.toFixed(4)} SOL
                      </span>
                      <Button size="sm" variant="ghost" onClick={applyUniformToAll}>
                        Set all to {uniformSol}
                      </Button>
                    </div>
                    {picked.length === 0 ? (
                      <p className="text-sm text-fg-subtle">
                        Pick wallets on the right to set per-wallet amounts.
                      </p>
                    ) : (
                      picked.map((pk) => {
                        const w = wallets.find((x) => x.pubkey === pk);
                        return (
                          <div
                            key={pk}
                            className="flex items-center gap-3 rounded-lg border border-border bg-bg-raised px-3 py-2"
                          >
                            <span className="font-mono text-xs text-fg-muted w-20 shrink-0">
                              {w?.label ?? "?"}
                            </span>
                            <span className="font-mono text-[10px] text-fg-subtle truncate flex-1">
                              {pk.slice(0, 12)}…
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
                              className="w-24 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                            <span className="text-xs text-fg-subtle">SOL</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {strategy === "random" && (
                  <div className="grid grid-cols-2 gap-3">
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
                    <p className="col-span-2 text-xs text-fg-subtle">
                      ~{totalRandomMidpoint.toFixed(4)} SOL expected (midpoint × {picked.length})
                    </p>
                  </div>
                )}

                <Button size="lg" onClick={buy} disabled={busy} className="w-full">
                  {busy ? "Submitting…" : `BUY ${picked.length} wallet${picked.length === 1 ? "" : "s"}`}
                </Button>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <h2 className="font-semibold">Sell</h2>
              </CardHeader>
              <CardBody className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-semibold">Percent of holdings</label>
                    <span className="font-mono text-sm text-accent">{sellPercent}%</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={sellPercent}
                    onChange={(e) => setSellPercent(parseInt(e.target.value, 10))}
                    className="w-full accent-accent"
                  />
                  <div className="mt-1 grid grid-cols-4 gap-1 text-xs">
                    {[25, 50, 75, 100].map((p) => (
                      <button
                        key={p}
                        onClick={() => setSellPercent(p)}
                        className={cn(
                          "rounded border py-1 transition-colors",
                          sellPercent === p
                            ? "border-accent text-accent"
                            : "border-border text-fg-muted hover:border-border-strong",
                        )}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-fg-subtle">
                  Each wallet's actual token balance is queried live from
                  Solana RPC. Wallets holding none of this mint are skipped
                  automatically.
                </p>
                <Button
                  size="lg"
                  variant="danger"
                  onClick={sell}
                  disabled={busy}
                  className="w-full"
                >
                  {busy ? "Submitting…" : `SELL ${sellPercent}% from ${picked.length} wallet${picked.length === 1 ? "" : "s"}`}
                </Button>
              </CardBody>
            </Card>

            {error && (
              <Card className="border-danger/40">
                <CardBody className="text-sm text-danger">{error}</CardBody>
              </Card>
            )}

            <Card>
              <CardHeader>
                <h2 className="font-semibold">Recent bundles</h2>
              </CardHeader>
              <CardBody>
                {history.length === 0 ? (
                  <p className="text-sm text-fg-subtle">
                    No trades this session.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {history.slice(0, 10).map((h) => (
                      <li
                        key={h.bundle_id + h.ts}
                        className="rounded-lg border border-border bg-bg-raised p-3"
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`font-mono text-xs uppercase tracking-wider ${
                              h.kind === "buy" ? "text-accent" : "text-warn"
                            }`}
                          >
                            {h.kind}
                          </span>
                          <span className="text-xs text-fg-subtle">
                            {new Date(h.ts).toLocaleTimeString()}
                          </span>
                        </div>
                        <code className="mt-1 block break-all font-mono text-xs text-fg-muted">
                          {h.mint}
                        </code>
                        <a
                          href={`https://explorer.jito.wtf/bundle/${h.bundle_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block break-all font-mono text-xs text-accent hover:underline"
                        >
                          jito ▸ {h.bundle_id}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>

          <aside>
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Wallets ({picked.length}/5)</h2>
              </CardHeader>
              <CardBody className="space-y-1.5">
                {wallets.length === 0 ? (
                  <p className="text-sm text-fg-subtle">
                    No wallets in keystore.
                  </p>
                ) : (
                  wallets.map((w) => {
                    const isSel = picked.includes(w.pubkey);
                    const atCap = !isSel && picked.length >= 5;
                    return (
                      <button
                        key={w.pubkey}
                        type="button"
                        disabled={atCap}
                        onClick={() => toggleWallet(w.pubkey)}
                        className={cn(
                          "w-full rounded-lg border bg-bg-subtle p-2.5 text-left transition-colors",
                          isSel
                            ? "border-accent bg-accent/5"
                            : atCap
                              ? "border-border opacity-40 cursor-not-allowed"
                              : "border-border hover:border-border-strong",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs uppercase tracking-wider text-fg-muted">
                            {w.label}
                          </span>
                          {isSel && (
                            <span className="font-mono text-2xs text-accent">
                              on
                            </span>
                          )}
                        </div>
                        <code className="block break-all font-mono text-[10px] text-fg-subtle mt-0.5">
                          {w.pubkey.slice(0, 16)}…
                        </code>
                      </button>
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

function StratPill({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-lg border bg-bg-subtle p-3 text-left transition-colors",
        active
          ? "border-accent shadow-glow"
          : "border-border hover:border-border-strong",
      )}
    >
      <div className="font-semibold text-sm">{label}</div>
      <div className="text-xs text-fg-subtle mt-0.5">{sub}</div>
    </button>
  );
}
