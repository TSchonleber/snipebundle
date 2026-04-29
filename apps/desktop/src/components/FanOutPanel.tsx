import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
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
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(recommendedSol.toFixed(3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    signature: string;
    total_sol: number;
  } | null>(null);
  const [masterBalance, setMasterBalance] = useState<number | null>(null);
  // Default: every sniper is a recipient. User can untick wallets they
  // don't want to fund right now (already-funded ones, hot wallets they
  // want to keep dry, etc.). Persisted only for the open session.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const recipients = useMemo(
    () =>
      snipers.filter((s) => !excluded.has(s.pubkey)).map((s) => s.pubkey),
    [snipers, excluded],
  );
  const totalRequired = useMemo(() => {
    const a = parseFloat(amount);
    if (!Number.isFinite(a)) return null;
    return a * recipients.length + 0.000005 * recipients.length;
  }, [amount, recipients.length]);

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
    const a = parseFloat(amount);
    if (!Number.isFinite(a) || a <= 0) {
      return setError("Amount must be positive.");
    }
    if (recipients.length === 0) {
      return setError("Pick at least one sniper to fund.");
    }
    if (totalRequired != null && masterBalance != null && totalRequired > masterBalance) {
      return setError(
        `Master holds ${masterBalance.toFixed(4)} SOL but ${totalRequired.toFixed(4)} required.`,
      );
    }
    setBusy(true);
    try {
      const res = await ipc.fanOutFromMaster(recipients, a);
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
              SOL per sniper
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
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
                  <label
                    key={s.pubkey}
                    className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-fg/5"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleWallet(s.pubkey)}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <span className="font-mono text-2xs text-fg shrink-0 w-20 truncate">
                      {s.label}
                    </span>
                    <span className="font-mono text-2xs text-fg-subtle truncate">
                      {s.pubkey.slice(0, 8)}…{s.pubkey.slice(-6)}
                    </span>
                  </label>
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
