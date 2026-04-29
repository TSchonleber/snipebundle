import { useCallback, useEffect, useState } from "react";
import { cn, type WalletInfo } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { AppNav } from "../components/AppNav";
import { BundleGroupsManager } from "../components/BundleGroupsManager";
import { FanOutPanel } from "../components/FanOutPanel";
import { SendPanel } from "../components/SendPanel";
import { WalletManager } from "../components/WalletManager";
import { WalletPanel } from "../components/WalletPanel";
import { ExportKeysModal } from "../components/ExportKeysModal";

const DEFAULT_PER_WALLET = 0.55;

type Section = "wallets" | "manage" | "fund" | "groups";

const SECTIONS: { id: Section; label: string; sub: string }[] = [
  { id: "wallets", label: "wallets", sub: "operate" },
  { id: "manage", label: "manage", sub: "create / import" },
  { id: "fund", label: "fund", sub: "master → snipers" },
  { id: "groups", label: "groups", sub: "saved bundle groups" },
];

export function Wallets() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [master, setMaster] = useState<WalletInfo | null>(null);
  const [snipers, setSnipers] = useState<WalletInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recommended, setRecommended] = useState(DEFAULT_PER_WALLET);
  const [section, setSection] = useState<Section>("wallets");
  const [editingTemplates, setEditingTemplates] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [activeMint, setActiveMint] = useState("");

  const load = useCallback(async () => {
    try {
      const [base, devs, cfg] = await Promise.all([
        ipc.listWallets(),
        ipc.listDevWallets().catch(() => [] as WalletInfo[]),
        ipc.loadConfig().catch(() => null),
      ]);
      // Tag each wallet with its role so downstream components can show
      // a badge and offer the reassign action without re-querying.
      const tagged: WalletInfo[] = [
        ...base.map(
          (w): WalletInfo => ({
            ...w,
            role: w.label === "master" ? "master" : "sniper",
          }),
        ),
        ...devs.map((w): WalletInfo => ({ ...w, role: "dev" })),
      ];
      setWallets(tagged);
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
      <div className="mx-auto max-w-5xl px-5 py-5">
        {/* Page subnav: section tabs left, contextual actions right. */}
        <div className="flex items-center justify-between border-b border-border pb-2 mb-4">
          <nav className="flex items-center gap-0.5">
            {SECTIONS.map((s) => {
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className={cn(
                    "relative font-mono text-2xs px-2.5 py-1 transition-colors",
                    "after:absolute after:left-2 after:right-2 after:bottom-0 after:h-px after:bg-accent after:transition-opacity",
                    active
                      ? "text-fg after:opacity-100"
                      : "text-fg-subtle hover:text-fg-muted after:opacity-0",
                  )}
                  title={s.sub}
                >
                  {s.label}
                </button>
              );
            })}
          </nav>
          {section === "wallets" && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditingTemplates((s) => !s)}
                className={cn(
                  "font-mono text-2xs transition-colors",
                  editingTemplates
                    ? "text-accent"
                    : "text-fg-subtle hover:text-fg-muted",
                )}
                title="Edit shared profile templates (affects every wallet bound to them)"
              >
                {editingTemplates ? "[ done ]" : "tpl"}
              </button>
              <button
                type="button"
                onClick={() => setShowExport(true)}
                className="font-mono text-2xs text-fg-subtle hover:text-fg-muted transition-colors"
                title="Reveal & export private keys for backup (passphrase required)"
              >
                keys
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 border-l-2 border-danger bg-danger/5 px-3 py-2 font-mono text-2xs text-danger">
            {error}
          </div>
        )}

        {section === "wallets" && wallets.length > 0 && (
          <WalletPanel
            wallets={wallets}
            mode="full"
            onConfigChanged={load}
            chromeless
            editingTemplatesExternal={editingTemplates}
            onCloseTemplates={() => setEditingTemplates(false)}
            activeMint={activeMint}
            onActiveMintChange={setActiveMint}
          />
        )}

        {section === "manage" && (
          <>
            {wallets.length > 0 ? (
              <WalletManager wallets={wallets} onChanged={load} />
            ) : (
              <EmptyHint>no wallets yet — go to /welcome to create a keystore</EmptyHint>
            )}
          </>
        )}

        {section === "groups" && (
          <BundleGroupsManager wallets={wallets} />
        )}

        {section === "fund" && (
          <>
            {master && snipers.length > 0 ? (
              <>
                <FanOutPanel
                  master={master}
                  snipers={snipers}
                  recommendedSol={recommended}
                />
                <div className="mt-4">
                  <SendPanel wallets={wallets} onComplete={load} />
                </div>
                <FundingNotes recommended={recommended} />
              </>
            ) : wallets.length > 0 ? (
              <SendPanel wallets={wallets} onComplete={load} />
            ) : (
              <EmptyHint>no wallets in keystore yet</EmptyHint>
            )}
          </>
        )}
      </div>

      {showExport && <ExportKeysModal onClose={() => setShowExport(false)} />}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="hatch border border-dashed border-border px-4 py-8 text-center font-mono text-2xs text-fg-subtle">
      {children}
    </div>
  );
}

function FundingNotes({ recommended }: { recommended: number }) {
  return (
    <div className="mt-6 border-t border-border pt-3">
      <div className="font-mono text-2xs text-fg-subtle mb-1.5">
        // notes
      </div>
      <ul className="space-y-1 font-mono text-2xs text-fg-muted">
        <li>
          recommended per sniper ≈{" "}
          <span className="text-fg">{recommended.toFixed(3)} SOL</span>{" "}
          (snipe + jito tip + priority fee + buffer)
        </li>
        <li>
          fund each wallet from a different source so chain analytics can't
          trivially group them
        </li>
        <li>balances poll every ~8s</li>
      </ul>
    </div>
  );
}
