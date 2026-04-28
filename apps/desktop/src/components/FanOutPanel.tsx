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

  const recipients = useMemo(() => snipers.map((s) => s.pubkey), [snipers]);
  const totalRequired = useMemo(() => {
    const a = parseFloat(amount);
    if (!Number.isFinite(a)) return null;
    return a * recipients.length + 0.000005 * recipients.length;
  }, [amount, recipients.length]);

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

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-fg-subtle uppercase tracking-wider">
                snipers
              </div>
              <div className="font-mono text-fg">{recipients.length}</div>
            </div>
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
