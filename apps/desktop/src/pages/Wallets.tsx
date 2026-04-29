import { useCallback, useEffect, useState } from "react";
import { type WalletInfo } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
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
      <div className="mx-auto max-w-5xl px-5 py-6">
        <div className="flex items-baseline gap-3 mb-5">
          <h1 className="font-mono text-base text-fg">wallets</h1>
          <span className="font-mono text-2xs text-fg-subtle">
            // your keys, your funding, your problem
          </span>
        </div>

        {error && (
          <div className="mb-4 border-l-2 border-danger bg-danger/5 px-3 py-2 font-mono text-2xs text-danger">
            {error}
          </div>
        )}

        {wallets.length > 0 && (
          <div className="mb-5">
            <WalletPanel wallets={wallets} mode="full" onConfigChanged={load} />
          </div>
        )}

        {wallets.length > 0 && (
          <div className="mb-5">
            <WalletManager wallets={wallets} onChanged={load} />
          </div>
        )}

        {master && snipers.length > 0 && (
          <div className="mb-5">
            <FanOutPanel
              master={master}
              snipers={snipers}
              recommendedSol={recommended}
            />
          </div>
        )}

        <div className="mt-8 border-t border-border pt-4">
          <div className="font-mono text-2xs text-fg-subtle mb-2">
            // funding notes
          </div>
          <ul className="space-y-1 font-mono text-2xs text-fg-muted">
            <li>
              recommended per sniper ≈{" "}
              <span className="text-fg">{recommended.toFixed(3)} SOL</span>{" "}
              (snipe + jito tip + priority fee + buffer)
            </li>
            <li>
              fund each wallet from a different source so chain analytics
              can't trivially group them
            </li>
            <li>balances poll every ~8s</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
