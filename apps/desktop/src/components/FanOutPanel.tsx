import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

interface FanOutPanelProps {
  master: WalletInfo | null;
  snipers: WalletInfo[];
  recommendedSol: number;
  onComplete?: () => void;
}

export function FanOutPanel({
  master,
  snipers,
  recommendedSol,
  onComplete,
}: FanOutPanelProps) {
  type Mode = "uniform" | "per_wallet" | "random";

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("uniform");
  const [amount, setAmount] = useState(recommendedSol.toFixed(3));
  const [randomMin, setRandomMin] = useState((recommendedSol * 0.7).toFixed(3));
  const [randomMax, setRandomMax] = useState((recommendedSol * 1.3).toFixed(3));
  const [perWallet, setPerWallet] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    signature: string;
    total_sol: number;
  } | null>(null);
  const [masterBalance, setMasterBalance] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const recipients = useMemo(
    () =>
      snipers.filter((s) => !excluded.has(s.pubkey)).map((s) => s.pubkey),
    [snipers, excluded],
  );

  // Resolve the active mode → per-recipient amounts. The submit path
  // samples random for real; the live preview uses the midpoint of the
  // range so the displayed total doesn't jitter every render.
  function resolveAmounts(forSubmit: boolean): number[] | string {
    if (mode === "uniform") {
      const a = parseFloat(amount);
      if (!Number.isFinite(a) || a <= 0) return "Amount must be positive.";
      return recipients.map(() => a);
    }
    if (mode === "random") {
      const lo = parseFloat(randomMin);
      const hi = parseFloat(randomMax);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
        return "Random range must satisfy 0 < min ≤ max.";
      }
      if (forSubmit) {
        return recipients.map(() => lo + Math.random() * (hi - lo));
      }
      const mid = (lo + hi) / 2;
      return recipients.map(() => mid);
    }
    // per_wallet
    const out: number[] = [];
    for (const pk of recipients) {
      const raw = perWallet[pk];
      const v = parseFloat(raw ?? "");
      if (!Number.isFinite(v) || v <= 0) {
        const sniper = snipers.find((s) => s.pubkey === pk);
        return `Set a positive amount for ${sniper?.label ?? pk.slice(0, 8)}…`;
      }
      out.push(v);
    }
    return out;
  }

  const totalRequired = useMemo(() => {
    const r = resolveAmounts(false);
    if (typeof r === "string") return null;
    return r.reduce((s, v) => s + v, 0) + 0.000005 * recipients.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, amount, randomMin, randomMax, perWallet, recipients]);

  function toggleWallet(pubkey: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(pubkey)) next.delete(pubkey);
      else next.add(pubkey);
      return next;
    });
  }
  function selectAll() {
    setExcluded(new Set());
  }
  function selectNone() {
    setExcluded(new Set(snipers.map((s) => s.pubkey)));
  }

  useEffect(() => {
    if (!open || !master) return;
    ipc
      .getBalances([master.pubkey])
      .then((m) => setMasterBalance(m[master.pubkey] ?? 0))
      .catch(() => {});
  }, [open, master]);

  useEffect(() => {
    setAmount(recommendedSol.toFixed(3));
  }, [recommendedSol]);

  if (!master || snipers.length === 0) return null;

  async function submit() {
    setError(null);
    if (recipients.length === 0) {
      return setError("Pick at least one sniper to fund.");
    }
    const resolved = resolveAmounts(true);
    if (typeof resolved === "string") return setError(resolved);
    const total = resolved.reduce((s, v) => s + v, 0) + 0.000005 * recipients.length;
    if (masterBalance != null && total > masterBalance) {
      return setError(
        `Master holds ${masterBalance.toFixed(4)} SOL but ${total.toFixed(4)} required.`,
      );
    }
    setBusy(true);
    try {
      const res = await ipc.fanOutFromMasterPerWallet(recipients, resolved);
      setResult({ signature: res.signature, total_sol: res.total_sol });
      onComplete?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Fund from master (one-click)</h3>
          {!open && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOpen(true)}
            >
              Open
            </Button>
          )}
        </div>
      </CardHeader>
      {open && (
        <CardBody className="space-y-4">
          <p className="text-sm text-fg-muted">
            Send SOL from your master wallet to each sniper wallet in one
            on-chain transaction. Convenient — but visible on-chain. For
            operational privacy, fund each sniper from an independent source
            (CEX, separate wallet) instead.
          </p>

          <div>
            <label className="block text-sm font-semibold mb-2">
              Distribution
            </label>
            <div className="flex gap-1 mb-3">
              {(
                [
                  ["uniform", "Uniform"],
                  ["per_wallet", "Per-wallet"],
                  ["random", "Random"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  className={cn(
                    "px-3 py-1 rounded-md font-mono text-2xs border transition-colors",
                    mode === key
                      ? "border-accent text-accent bg-accent/5"
                      : "border-border text-fg-subtle hover:text-fg-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === "uniform" && (
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="SOL per sniper"
                className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            )}
            {mode === "random" && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  value={randomMin}
                  onChange={(e) => setRandomMin(e.target.value)}
                  placeholder="min SOL"
                  className="rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  value={randomMax}
                  onChange={(e) => setRandomMax(e.target.value)}
                  placeholder="max SOL"
                  className="rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            )}
            {mode === "per_wallet" && (
              <p className="font-mono text-2xs text-fg-subtle">
                Set amounts on each wallet below.
              </p>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-semibold">
                Recipients ({recipients.length}/{snipers.length})
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
                >
                  all
                </button>
                <span className="font-mono text-2xs text-fg-subtle">·</span>
                <button
                  type="button"
                  onClick={selectNone}
                  className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
                >
                  none
                </button>
              </div>
            </div>
            <div className="max-h-44 overflow-y-auto rounded-lg border border-border bg-bg-raised divide-y divide-border/40">
              {snipers.map((s) => {
                const checked = !excluded.has(s.pubkey);
                return (
                  <div
                    key={s.pubkey}
                    className="flex items-center gap-3 px-3 py-1.5 hover:bg-fg/5"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleWallet(s.pubkey)}
                      className="h-3.5 w-3.5 accent-accent cursor-pointer"
                    />
                    <span className="font-mono text-2xs text-fg shrink-0 w-20 truncate">
                      {s.label}
                    </span>
                    <span className="font-mono text-2xs text-fg-subtle truncate flex-1">
                      {s.pubkey.slice(0, 8)}…{s.pubkey.slice(-6)}
                    </span>
                    {mode === "per_wallet" && checked && (
                      <input
                        type="text"
                        inputMode="decimal"
                        value={perWallet[s.pubkey] ?? ""}
                        onChange={(e) =>
                          setPerWallet({
                            ...perWallet,
                            [s.pubkey]: e.target.value,
                          })
                        }
                        placeholder="SOL"
                        className="w-20 rounded border border-border bg-bg px-2 py-0.5 font-mono text-2xs text-right focus:outline-none focus:border-accent"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <div className="text-xs text-fg-subtle uppercase tracking-wider">
                total required
              </div>
              <div className="font-mono text-fg">
                {totalRequired?.toFixed(4) ?? "—"} SOL
              </div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle uppercase tracking-wider">
                master balance
              </div>
              <div className="font-mono text-fg">
                {masterBalance != null ? masterBalance.toFixed(4) : "…"} SOL
              </div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle uppercase tracking-wider">
                after fan-out
              </div>
              <div className="font-mono text-fg">
                {masterBalance != null && totalRequired != null
                  ? Math.max(0, masterBalance - totalRequired).toFixed(4)
                  : "—"}{" "}
                SOL
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
              <div className="text-accent font-semibold">
                ✓ Sent {result.total_sol.toFixed(4)} SOL
              </div>
              <a
                href={`https://solscan.io/tx/${result.signature}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block break-all font-mono text-xs text-accent hover:underline"
              >
                solscan ▸ {result.signature}
              </a>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={submit} disabled={busy}>
              {busy ? "Sending…" : "Send fan-out"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setError(null);
                setResult(null);
              }}
              disabled={busy}
            >
              Close
            </Button>
          </div>
        </CardBody>
      )}
    </Card>
  );
}
