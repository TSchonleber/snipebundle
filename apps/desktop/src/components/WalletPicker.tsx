import { useEffect, useState } from "react";
import { Card, CardBody, type WalletInfo, cn } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

interface WalletPickerProps {
  selected: string[];
  onChange: (pubkeys: string[]) => void;
  /** include only sniper wallets (default), or all */
  scope?: "snipers" | "all" | "dev";
  max?: number;
}

export function WalletPicker({
  selected,
  onChange,
  scope = "snipers",
  max = 5,
}: WalletPickerProps) {
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);

  useEffect(() => {
    Promise.all([
      ipc.listWallets(),
      scope === "dev" || scope === "all"
        ? ipc.listDevWallets()
        : Promise.resolve([] as WalletInfo[]),
    ])
      .then(([base, devs]) => {
        const filtered = scope === "snipers"
          ? base.filter((w) => w.label !== "master")
          : scope === "dev"
            ? [...base.filter((w) => w.label === "master"), ...devs]
            : [...base, ...devs];
        setWallets(filtered);
      })
      .catch(() => setWallets([]));
  }, [scope]);

  function toggle(pk: string) {
    if (selected.includes(pk)) {
      onChange(selected.filter((p) => p !== pk));
    } else if (selected.length >= max) {
      return;
    } else {
      onChange([...selected, pk]);
    }
  }

  if (wallets === null) {
    return (
      <Card>
        <CardBody className="text-fg-subtle">Loading wallets…</CardBody>
      </Card>
    );
  }

  if (wallets.length === 0) {
    return (
      <Card>
        <CardBody className="text-fg-subtle text-sm">
          No wallets available. Generate or import one first.
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-1.5">
      {wallets.map((w) => {
        const isSel = selected.includes(w.pubkey);
        const atCap = !isSel && selected.length >= max;
        return (
          <button
            key={w.pubkey}
            type="button"
            disabled={atCap}
            onClick={() => toggle(w.pubkey)}
            className={cn(
              "w-full rounded-lg border bg-bg-subtle p-3 text-left transition-colors",
              isSel
                ? "border-accent bg-accent/5"
                : atCap
                  ? "border-border opacity-40 cursor-not-allowed"
                  : "border-border hover:border-border-strong",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs uppercase tracking-wider text-fg-muted">
                {w.label}
              </span>
              {isSel && (
                <span className="font-mono text-xs text-accent">✓ selected</span>
              )}
            </div>
            <code className="mt-1 block break-all font-mono text-xs text-fg">
              {w.pubkey}
            </code>
          </button>
        );
      })}
      <p className="text-xs text-fg-subtle font-mono pt-1">
        {selected.length} / {max} selected
      </p>
    </div>
  );
}
