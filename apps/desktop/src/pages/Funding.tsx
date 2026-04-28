import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, CardBody, type WalletInfo } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { WalletGrid } from "../components/WalletGrid";

const DEFAULT_PER_WALLET = 0.55;

export function Funding() {
  const nav = useNavigate();
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [recommended, setRecommended] = useState(DEFAULT_PER_WALLET);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [list, cfg] = await Promise.all([
          ipc.listWallets(),
          ipc.loadConfig().catch(() => null),
        ]);
        // Onboarding focuses on funding the snipers, not the master.
        setWallets(list.filter((w) => w.label !== "master"));
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
    }
    load();
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">
        Step 2: Fund your sniper wallets.
      </h1>
      <p className="mt-3 text-fg-muted">
        Each wallet below is yours. Send SOL from any source you want — CEX
        withdrawal, Phantom, Solflare, hardware wallet. snipebundle never moves
        SOL on your behalf, so funding is fully under your control.
      </p>
      <p className="mt-2 text-sm text-fg-subtle">
        Tip: funding each wallet from a different source (e.g. different CEX
        accounts) keeps them unprofileable as a coordinated set.
      </p>

      {error && (
        <Card className="mt-6 border-danger/40">
          <CardBody className="text-sm text-danger">{error}</CardBody>
        </Card>
      )}

      <div className="mt-8">
        <WalletGrid wallets={wallets} recommendedSol={recommended} />
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={() => nav("/mode")}>
          Continue →
        </Button>
        <span className="text-xs text-fg-subtle">
          You can fund later from the Wallets tab. The engine won't fire on
          underfunded wallets.
        </span>
      </div>
    </div>
  );
}
