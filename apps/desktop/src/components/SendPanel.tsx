import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

// Reserved minimum for the source wallet so the tx fee + a small headroom
// don't get drained alongside the transfer. Solana base fee ~5,000
// lamports plus a few thousand for safety.
const MIN_RESERVE_SOL = 0.001;

interface SendPanelProps {
  wallets: WalletInfo[];
  onComplete?: () => void;
}

/**
 * Send SOL from any wallet in the keystore to an arbitrary destination.
 * The dual of the FanOutPanel: where fan-out spreads master → snipers,
 * SendPanel covers the consolidate-back path (sniper → master), the
 * cash-out path (sniper/master → CEX deposit), and any one-off transfer
 * the user would otherwise have to fire up Phantom for.
 */
export function SendPanel({ wallets, onComplete }: SendPanelProps) {
  const [open, setOpen] = useState(false);
  const [sourcePubkey, setSourcePubkey] = useState<string>(
    wallets[0]?.pubkey ?? "",
  );
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [sourceBalance, setSourceBalance] = useState<number | null>(null);

  const source = useMemo(
    () => wallets.find((w) => w.pubkey === sourcePubkey) ?? null,
    [wallets, sourcePubkey],
  );

  // If the wallet list changes (e.g., dev wallet created), make sure we
  // still have a valid source selected.
  useEffect(() => {
    if (!sourcePubkey && wallets[0]) setSourcePubkey(wallets[0].pubkey);
    else if (sourcePubkey && !wallets.find((w) => w.pubkey === sourcePubkey)) {
      setSourcePubkey(wallets[0]?.pubkey ?? "");
    }
  }, [wallets, sourcePubkey]);

  // Refresh source balance whenever the panel is open or the source changes.
  useEffect(() => {
    if (!open || !sourcePubkey) {
      setSourceBalance(null);
      return;
    }
    ipc
      .getBalances([sourcePubkey])
      .then((m) => setSourceBalance(m[sourcePubkey] ?? 0))
      .catch(() => setSourceBalance(null));
  }, [open, sourcePubkey, signature]);

  const parsedAmount = parseFloat(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;

  function fillMax() {
    if (sourceBalance == null) return;
    const max = Math.max(0, sourceBalance - MIN_RESERVE_SOL);
    setAmount(max.toFixed(6).replace(/\.?0+$/, ""));
  }

  async function submit() {
    setError(null);
    setSignature(null);
    if (!source) return setError("Pick a source wallet.");
    if (!destination.trim()) return setError("Destination is required.");
    if (!amountValid) return setError("Amount must be positive.");
    if (
      sourceBalance != null &&
      parsedAmount > sourceBalance - MIN_RESERVE_SOL
    ) {
      return setError(
        `Source holds ${sourceBalance.toFixed(4)} SOL — need ≥${MIN_RESERVE_SOL} SOL reserve for the tx fee, so max sendable is ${(sourceBalance - MIN_RESERVE_SOL).toFixed(4)} SOL.`,
      );
    }
    setBusy(true);
    try {
      const sig = await ipc.sendSol(
        source.pubkey,
        destination.trim(),
        parsedAmount,
      );
      setSignature(sig);
      onComplete?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setOpen(false);
    setError(null);
    setSignature(null);
    setAmount("");
    setDestination("");
  }

  if (wallets.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Send SOL</h3>
          {!open && (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Open
            </Button>
          )}
        </div>
      </CardHeader>
      {open && (
        <CardBody className="space-y-4">
          <p className="text-sm text-fg-muted">
            Send SOL from any wallet in the keystore to an arbitrary
            destination — consolidate snipers back to the master, ship
            profits to a CEX deposit address, or move funds to a separate
            cold wallet without leaving the app.
          </p>

          <div>
            <label className="block text-sm font-semibold mb-2">
              From wallet
            </label>
            <select
              value={sourcePubkey}
              onChange={(e) => setSourcePubkey(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {wallets.map((w) => (
                <option key={w.pubkey} value={w.pubkey}>
                  {w.label} — {w.pubkey.slice(0, 8)}…{w.pubkey.slice(-6)}
                </option>
              ))}
            </select>
            <div className="mt-1 text-xs text-fg-subtle">
              Balance:{" "}
              <span className="font-mono text-fg">
                {sourceBalance != null
                  ? `${sourceBalance.toFixed(4)} SOL`
                  : "…"}
              </span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">
              Destination address
            </label>
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="paste a Solana pubkey"
              spellCheck={false}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-semibold">Amount</label>
              <button
                type="button"
                onClick={fillMax}
                disabled={sourceBalance == null}
                className="font-mono text-2xs text-fg-subtle hover:text-fg-muted disabled:opacity-50"
              >
                max
              </button>
            </div>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="SOL"
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <p className="mt-1 font-mono text-2xs text-fg-subtle">
              tx fee reserve: {MIN_RESERVE_SOL} SOL stays in the source wallet
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}

          {signature && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
              <div className="text-accent font-semibold">
                ✓ Sent {parsedAmount.toFixed(4)} SOL
              </div>
              <a
                href={`https://solscan.io/tx/${signature}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block break-all font-mono text-xs text-accent hover:underline"
              >
                solscan ▸ {signature}
              </a>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={submit} disabled={busy}>
              {busy ? "Sending…" : "Send"}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Close
            </Button>
          </div>
        </CardBody>
      )}
    </Card>
  );
}
