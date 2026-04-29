import { useEffect, useRef, useState } from "react";
import { cn, type WalletInfo } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import {
  getPrimaryWallet,
  setPrimaryWallet,
  subscribeActiveWallet,
} from "../lib/active-wallet";

/**
 * Compact dropdown that shows which wallet is currently set as the primary
 * trader (used by one-click Buy buttons across Trenches/Chart/Trade) and
 * lets you pick a different one. Mirrors GMGN's "selected wallet" chip.
 */
export function PrimaryWalletPicker() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [primary, setPrimary] = useState(getPrimaryWallet());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      ipc.listWallets().catch(() => [] as WalletInfo[]),
      ipc.listDevWallets().catch(() => [] as WalletInfo[]),
    ]).then(([base, devs]) => {
      if (!mounted) return;
      setWallets([...base, ...devs]);
      // If no primary set yet, auto-pick the first sniper wallet so quick-buy
      // works out of the box without forcing a config step.
      const current = getPrimaryWallet();
      if (!current) {
        const auto = base.find((w) => w.label.startsWith("sniper")) ?? base[0];
        if (auto) {
          setPrimaryWallet(auto.pubkey);
          setPrimary(auto.pubkey);
        }
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return subscribeActiveWallet(() => setPrimary(getPrimaryWallet()));
  }, []);

  // Click-outside close.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const active = wallets.find((w) => w.pubkey === primary);
  const label = active
    ? `${active.label}: ${active.pubkey.slice(0, 4)}..${active.pubkey.slice(-4)}`
    : "no wallet";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className={cn(
          "font-mono text-2xs px-2 py-1 border transition-colors",
          open
            ? "border-accent text-accent"
            : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
        )}
        title="primary trade wallet — used by one-click buy"
      >
        <span className="text-fg-subtle">w&gt;</span> {label}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 min-w-[260px] border border-border bg-bg shadow-xl">
          <div className="border-b border-border px-3 py-1.5 font-mono text-2xs text-fg-subtle">
            // primary trade wallet
          </div>
          {wallets.length === 0 ? (
            <div className="px-3 py-3 font-mono text-2xs text-fg-subtle">
              no wallets — set up at /wallets
            </div>
          ) : (
            <div className="max-h-[280px] overflow-y-auto">
              {wallets.map((w) => {
                const sel = w.pubkey === primary;
                return (
                  <button
                    key={w.pubkey}
                    type="button"
                    onClick={() => {
                      setPrimaryWallet(w.pubkey);
                      setPrimary(w.pubkey);
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full px-3 py-1.5 text-left font-mono text-2xs flex items-center justify-between gap-3 transition-colors",
                      sel
                        ? "bg-accent/10 text-accent"
                        : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                    )}
                  >
                    <span className="shrink-0">{w.label}</span>
                    <span className="text-fg-subtle truncate">
                      {w.pubkey.slice(0, 6)}..{w.pubkey.slice(-4)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
