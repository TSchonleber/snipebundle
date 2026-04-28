import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Button,
  Card,
  CardBody,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ipc } from "../lib/ipc";

interface WalletGridProps {
  wallets: WalletInfo[];
  recommendedSol: number;
  pollMs?: number;
}

type Status = "ready" | "low" | "empty" | "unknown";

function statusOf(balance: number | undefined, recommended: number): Status {
  if (balance == null) return "unknown";
  if (balance >= recommended) return "ready";
  if (balance > 0) return "low";
  return "empty";
}

const STATUS_STYLE: Record<Status, string> = {
  ready: "border-accent/60 bg-accent/5",
  low: "border-warn/40 bg-warn/5",
  empty: "border-border",
  unknown: "border-border",
};

const STATUS_LABEL: Record<Status, { dot: string; label: string }> = {
  ready: { dot: "bg-accent", label: "FUNDED" },
  low: { dot: "bg-warn", label: "LOW" },
  empty: { dot: "bg-fg-subtle", label: "EMPTY" },
  unknown: { dot: "bg-fg-subtle", label: "—" },
};

export function WalletGrid({ wallets, recommendedSol, pollMs = 8000 }: WalletGridProps) {
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [pulsing, setPulsing] = useState(false);

  const pubkeys = useMemo(() => wallets.map((w) => w.pubkey), [wallets]);
  const fundedCount = useMemo(
    () =>
      pubkeys.filter(
        (pk) => (balances[pk] ?? 0) >= recommendedSol,
      ).length,
    [pubkeys, balances, recommendedSol],
  );

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;

    async function tick() {
      if (pubkeys.length === 0) return;
      setPulsing(true);
      try {
        const res = await ipc.getBalances(pubkeys);
        if (mounted) {
          setBalances(res);
          setError(null);
        }
      } catch (e) {
        if (mounted) setError(String(e));
      } finally {
        if (mounted) setPulsing(false);
      }
      if (mounted) timer = window.setTimeout(tick, pollMs);
    }
    tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [pubkeys, pollMs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-fg-muted">
          <span className="font-mono text-accent tabular-nums">
            {fundedCount}
          </span>
          {" / "}
          <span className="font-mono tabular-nums">{wallets.length}</span>{" "}
          wallets at ≥{" "}
          <span className="font-mono">{recommendedSol.toFixed(2)} SOL</span>
        </div>
        <span
          className={cn(
            "text-xs font-mono uppercase tracking-wider",
            pulsing ? "text-accent" : "text-fg-subtle",
          )}
        >
          {pulsing ? "● refreshing" : "○ idle"}
        </span>
      </div>

      {error && (
        <Card className="border-danger/40">
          <CardBody className="text-sm text-danger">{error}</CardBody>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {wallets.map((w) => {
          const bal = balances[w.pubkey];
          const status = statusOf(bal, recommendedSol);
          return (
            <WalletCard
              key={w.pubkey}
              wallet={w}
              balance={bal}
              status={status}
              recommended={recommendedSol}
            />
          );
        })}
      </div>
    </div>
  );
}

function WalletCard({
  wallet,
  balance,
  status,
  recommended,
}: {
  wallet: WalletInfo;
  balance: number | undefined;
  status: Status;
  recommended: number;
}) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  async function copy() {
    try {
      await writeText(wallet.pubkey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      try {
        await navigator.clipboard.writeText(wallet.pubkey);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      } catch {}
    }
  }

  const meta = STATUS_LABEL[status];

  return (
    <Card className={cn("transition-colors", STATUS_STYLE[status])}>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wider text-fg-muted">
            {wallet.label}
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider">
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
            {meta.label}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-2xl font-bold tabular-nums">
            {balance != null ? balance.toFixed(4) : "—"}
          </span>
          <span className="text-xs text-fg-subtle font-mono">
            SOL · need {recommended.toFixed(2)}
          </span>
        </div>

        <div className="rounded-lg bg-bg-raised p-2">
          <code className="block break-all font-mono text-[10px] text-fg-muted">
            {wallet.pubkey}
          </code>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? "✓ copied" : "Copy address"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowQr((q) => !q)}
          >
            {showQr ? "Hide QR" : "Show QR"}
          </Button>
        </div>

        {showQr && (
          <div className="flex justify-center rounded-lg bg-white p-3">
            <QRCodeSVG value={wallet.pubkey} size={160} level="M" />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
