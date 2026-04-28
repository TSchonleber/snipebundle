import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, CardBody, type WalletInfo } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

export function Funding() {
  const nav = useNavigate();
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc.listWallets().then(setWallets).catch((e) => setError(String(e)));
  }, []);

  const master = wallets.find((w) => w.label === "master");

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">
        Step 2: Fund your master wallet.
      </h1>
      <p className="mt-3 text-fg-muted">
        Send SOL here from your CEX (Coinbase, Kraken, MEXC) or main wallet.
        We'll fan it out to your snipers in one batch.
      </p>

      {error && (
        <Card className="mt-6">
          <CardBody className="text-danger text-sm">{error}</CardBody>
        </Card>
      )}

      {master && (
        <Card className="mt-8">
          <CardBody className="space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-accent">
              MASTER WALLET — send SOL here
            </div>
            <code className="block break-all rounded-lg bg-bg-raised p-3 font-mono text-sm">
              {master.pubkey}
            </code>
            <p className="text-xs text-fg-subtle">
              Recommended: at least {(0.55).toFixed(2)} SOL per sniper wallet
              you created (~0.5 SOL to spend, ~0.05 for fees and Jito tips).
            </p>
          </CardBody>
        </Card>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={() => nav("/mode")}>
          I've sent it →
        </Button>
        <Button
          size="md"
          variant="ghost"
          onClick={() => nav("/mode")}
        >
          Skip — fund later
        </Button>
      </div>
      <p className="mt-3 text-xs text-fg-subtle">
        Auto-balance polling and one-click fan-out land in the next update. For
        now you can hand-fund each sniper directly if you prefer.
      </p>
    </div>
  );
}
