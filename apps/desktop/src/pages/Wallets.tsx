import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, type WalletInfo } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { WalletGrid } from "../components/WalletGrid";
import { AppNav } from "../components/AppNav";
import { FanOutPanel } from "../components/FanOutPanel";
import { WalletManager } from "../components/WalletManager";
import { WalletPanel } from "../components/WalletPanel";

const DEFAULT_PER_WALLET = 0.55;

export function Wallets() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [master, setMaster] = useState<WalletInfo | null>(null);
  const [snipers, setSnipers] = useState<WalletInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recommended, setRecommended] = useState(DEFAULT_PER_WALLET);

  const load = useCallback(async () => {
    try {
      const [base, devs, cfg] = await Promise.all([
        ipc.listWallets(),
        ipc.listDevWallets().catch(() => [] as WalletInfo[]),
        ipc.loadConfig().catch(() => null),
      ]);
      const all = [...base, ...devs];
      setWallets(all);
      setMaster(base.find((w) => w.label === "master") ?? null);
      setSnipers(base.filter((w) => w.label.startsWith("sniper")));
      const c = cfg as
        | {
            trigger?: { sol_per_snipe?: number };
            network?: { jito_tip_sol?: number; priority_fee_sol?: number };
          }
        | null;
      if (c?.trigger?.sol_per_snipe) {
        const tip = c.network?.jito_tip_sol ?? 0.001;
        const fee = c.network?.priority_fee_sol ?? 0.0001;
        setRecommended(c.trigger.sol_per_snipe + tip + fee + 0.005);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen">
      <AppNav status="stopped" />
      <div className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-3xl font-bold tracking-tight">Wallets</h1>
        <p className="mt-2 text-fg-muted">
          Manage, fund, and inspect your wallets. snipebundle never moves SOL
          on your behalf for funding — funding source is your choice (CEX
          withdrawal, Phantom, Solflare, hardware wallet, etc).
        </p>

        {error && (
          <Card className="mt-4 border-danger/40">
            <CardBody className="text-sm text-danger">{error}</CardBody>
          </Card>
        )}

        <div className="mt-6">
          <WalletGrid wallets={wallets} recommendedSol={recommended} />
        </div>

        {wallets.length > 0 && (
          <div className="mt-6">
            <WalletPanel wallets={wallets} mode="full" onConfigChanged={load} />
          </div>
        )}

        {wallets.length > 0 && (
          <div className="mt-6">
            <WalletManager wallets={wallets} onChanged={load} />
          </div>
        )}

        {master && snipers.length > 0 && (
          <div className="mt-6">
            <FanOutPanel
              master={master}
              snipers={snipers}
              recommendedSol={recommended}
            />
          </div>
        )}

        <Card className="mt-8">
          <CardBody>
            <h3 className="font-semibold">Funding tips</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-fg-muted list-disc list-inside">
              <li>
                Every wallet here is yours. The sniper bundle runs from the
                snipers; the dev wallet runs the launch flow.
              </li>
              <li>
                Recommended amount per sniper ≈{" "}
                <span className="font-mono">
                  {recommended.toFixed(3)} SOL
                </span>{" "}
                (snipe size + Jito tip + priority fee + small buffer).
              </li>
              <li>
                For operational privacy, fund each wallet from a different
                source (CEX accounts, separate hot wallets) so chain analytics
                can't easily group them.
              </li>
              <li>
                Page polls Solana RPC every ~8s. New deposits appear next tick.
              </li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
