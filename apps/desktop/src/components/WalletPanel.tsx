import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type ClosedPosition,
  type WalletInfo,
} from "@snipebundle/ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ipc,
  type AppConfig,
  type ExitProfile,
  type WalletExitProfiles,
} from "../lib/ipc";

const DEFAULT_PROFILES: ExitProfile[] = [
  { label: "Conservative", take_profit_pct: 25, stop_loss_pct: 15, max_hold_seconds: 60 },
  { label: "Standard", take_profit_pct: 50, stop_loss_pct: 30, max_hold_seconds: 60 },
  { label: "Aggressive", take_profit_pct: 100, stop_loss_pct: 50, max_hold_seconds: 120 },
  { label: "Moonshot", take_profit_pct: 500, stop_loss_pct: 70, max_hold_seconds: 300 },
  { label: "Manual", take_profit_pct: 9999, stop_loss_pct: 99, max_hold_seconds: 600 },
];

function defaultWalletProfiles(): WalletExitProfiles {
  return {
    profiles: DEFAULT_PROFILES,
    selected: 1,
    stop_loss_enabled: true,
    trailing_stop_pct: null,
    buy_presets_sol: [0.01, 0.05, 0.25, 0.5, 2.0],
    sell_presets_pct: [25, 50, 75, 100],
  };
}

interface Props {
  wallets: WalletInfo[];
  closedPositions?: ClosedPosition[];
  /** "full" = Wallets tab; "compact" = Sniper sidebar (hides labels, denser). */
  mode?: "full" | "compact";
  onConfigChanged?: () => void;
  /** Mint defaulted into the quick-action buttons. Lifts to the parent so
   *  the same input can be controlled from outside (e.g. Sniper page). */
  activeMint?: string;
  onActiveMintChange?: (mint: string) => void;
}

export function WalletPanel({
  wallets,
  closedPositions,
  mode = "full",
  onConfigChanged,
  activeMint: activeMintProp,
  onActiveMintChange,
}: Props) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [busyPubkey, setBusyPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ pubkey: string; msg: string } | null>(null);
  const [internalMint, setInternalMint] = useState("");

  const activeMint = activeMintProp ?? internalMint;
  const setActiveMint = onActiveMintChange ?? setInternalMint;

  const reload = useCallback(async () => {
    try {
      setCfg(await ipc.loadConfig());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Aggregate realized P&L per wallet from closed_positions where
  // wallet_pubkeys overlap.
  const walletPnl = useMemo(() => {
    const map = new Map<string, { realized_sol: number; trades: number; wins: number }>();
    if (!closedPositions) return map;
    for (const cp of closedPositions) {
      const pks = (cp as ClosedPosition & { wallet_pubkeys?: string[] }).wallet_pubkeys ?? [];
      if (pks.length === 0) continue;
      const realized =
        cp.realized_pct != null ? (cp.entry_total_sol * cp.realized_pct) / 100 : 0;
      const perWallet = realized / pks.length;
      for (const pk of pks) {
        const cur = map.get(pk) ?? { realized_sol: 0, trades: 0, wins: 0 };
        cur.realized_sol += perWallet;
        cur.trades += 1;
        if ((cp.realized_pct ?? 0) >= 0) cur.wins += 1;
        map.set(pk, cur);
      }
    }
    return map;
  }, [closedPositions]);

  function getProfilesFor(pubkey: string): WalletExitProfiles {
    return cfg?.wallet_profiles?.[pubkey] ?? defaultWalletProfiles();
  }

  async function patchWallet(pubkey: string, next: WalletExitProfiles) {
    if (!cfg) return;
    setError(null);
    setBusyPubkey(pubkey);
    const updated: AppConfig = {
      ...cfg,
      wallet_profiles: {
        ...(cfg.wallet_profiles ?? {}),
        [pubkey]: next,
      },
    };
    try {
      await ipc.saveConfig(updated);
      setCfg(updated);
      setFeedback({ pubkey, msg: "saved" });
      window.setTimeout(() => setFeedback(null), 1500);
      onConfigChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPubkey(null);
    }
  }

  async function quickBuy(wallet: WalletInfo, sol: number) {
    if (!activeMint.trim()) {
      return setError("Set an active mint above to use quick-buy.");
    }
    setError(null);
    setBusyPubkey(wallet.pubkey);
    try {
      await ipc.manualSnipe({
        mint: activeMint.trim(),
        wallet_pubkeys: [wallet.pubkey],
        strategy: { kind: "uniform", sol },
      });
      setFeedback({ pubkey: wallet.pubkey, msg: `BUY ${sol} SOL submitted` });
      window.setTimeout(() => setFeedback(null), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPubkey(null);
    }
  }

  async function quickSell(wallet: WalletInfo, percent: number) {
    if (!activeMint.trim()) {
      return setError("Set an active mint above to use quick-sell.");
    }
    setError(null);
    setBusyPubkey(wallet.pubkey);
    try {
      await ipc.manualDump({
        mint: activeMint.trim(),
        wallet_pubkeys: [wallet.pubkey],
        percent,
      });
      setFeedback({ pubkey: wallet.pubkey, msg: `SELL ${percent}% submitted` });
      window.setTimeout(() => setFeedback(null), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPubkey(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">
              {mode === "compact" ? "Wallets" : "Wallet panel"}
            </h3>
            {mode === "full" && (
              <p className="text-xs text-fg-muted">
                Per-wallet TP/SL profile + quick buy/sell. Active mint applies
                to the preset buttons. SL/TS toggles affect Sniper + Trade
                positions only — Launch positions stay manual.
              </p>
            )}
          </div>
          <span className="text-xs text-fg-subtle font-mono">
            {wallets.length} wallets
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
            Active mint
          </span>
          <input
            value={activeMint}
            onChange={(e) => setActiveMint(e.target.value)}
            placeholder="paste mint for quick buy/sell buttons"
            className="flex-1 rounded-md border border-border bg-bg-raised px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {activeMint && (
            <button
              type="button"
              onClick={() => setActiveMint("")}
              className="text-[10px] text-fg-subtle hover:text-fg"
            >
              clear
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {wallets.map((w) => {
            const profiles = getProfilesFor(w.pubkey);
            const pnl = walletPnl.get(w.pubkey);
            const busy = busyPubkey === w.pubkey;
            const fb = feedback?.pubkey === w.pubkey ? feedback.msg : null;
            return (
              <WalletRow
                key={w.pubkey}
                wallet={w}
                profiles={profiles}
                mode={mode}
                busy={busy}
                feedback={fb}
                pnl={pnl}
                activeMint={activeMint}
                onSelectProfile={(idx) =>
                  patchWallet(w.pubkey, { ...profiles, selected: idx })
                }
                onToggleSL={() =>
                  patchWallet(w.pubkey, {
                    ...profiles,
                    stop_loss_enabled: !profiles.stop_loss_enabled,
                  })
                }
                onToggleTS={() =>
                  patchWallet(w.pubkey, {
                    ...profiles,
                    trailing_stop_pct: profiles.trailing_stop_pct == null ? 20 : null,
                  })
                }
                onQuickBuy={(sol) => quickBuy(w, sol)}
                onQuickSell={(pct) => quickSell(w, pct)}
              />
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

function WalletRow({
  wallet,
  profiles,
  mode,
  busy,
  feedback,
  pnl,
  activeMint,
  onSelectProfile,
  onToggleSL,
  onToggleTS,
  onQuickBuy,
  onQuickSell,
}: {
  wallet: WalletInfo;
  profiles: WalletExitProfiles;
  mode: "full" | "compact";
  busy: boolean;
  feedback: string | null;
  pnl: { realized_sol: number; trades: number; wins: number } | undefined;
  activeMint: string;
  onSelectProfile: (idx: number) => void;
  onToggleSL: () => void;
  onToggleTS: () => void;
  onQuickBuy: (sol: number) => void;
  onQuickSell: (pct: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const nav = useNavigate();
  const compact = mode === "compact";

  async function copy() {
    try {
      await writeText(wallet.pubkey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  const realized = pnl?.realized_sol ?? 0;
  const realizedColor =
    realized > 0 ? "text-accent" : realized < 0 ? "text-danger" : "text-fg-subtle";
  const realizedLabel =
    pnl && pnl.trades > 0
      ? `${realized >= 0 ? "+" : ""}${realized.toFixed(4)}`
      : "—";

  const isMaster = wallet.label === "master";

  return (
    <div
      className={cn(
        "rounded-lg border bg-bg-subtle p-2",
        isMaster ? "border-accent/30" : "border-border",
      )}
    >
      {/* Top row: label, pubkey, P&L, quick links */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
            isMaster
              ? "bg-accent/15 text-accent"
              : "bg-bg-raised text-fg-muted",
          )}
        >
          {wallet.label}
        </span>
        <button
          type="button"
          onClick={copy}
          className="flex-1 truncate text-left font-mono text-[10px] text-fg-subtle hover:text-fg"
          title="copy pubkey"
        >
          {copied ? "✓ copied" : `${wallet.pubkey.slice(0, 16)}…`}
        </button>
        <span
          className={`shrink-0 font-mono text-xs tabular-nums font-semibold ${realizedColor}`}
        >
          {realizedLabel}
          {pnl && pnl.trades > 0 && (
            <span className="ml-1 text-[9px] font-normal text-fg-subtle">
              {pnl.wins}W/{pnl.trades - pnl.wins}L
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => nav(`/trade?wallet=${encodeURIComponent(wallet.pubkey)}`)}
          className="shrink-0 text-[10px] text-fg-subtle hover:text-accent"
          title="open in Trade page"
        >
          ↗
        </button>
      </div>

      {/* Profile + toggle row */}
      <div className="mt-2 flex items-center gap-1.5 text-xs">
        <span className="text-[10px] uppercase tracking-wider text-fg-subtle w-6 shrink-0">
          TP
        </span>
        {profiles.profiles.map((p, idx) => {
          const sel = profiles.selected === idx;
          return (
            <button
              key={idx}
              type="button"
              disabled={busy}
              onClick={() => onSelectProfile(idx)}
              title={
                p.label
                  ? `${p.label} — TP ${p.take_profit_pct}% / SL ${p.stop_loss_pct}% / ${p.max_hold_seconds}s`
                  : `Profile ${idx + 1}`
              }
              className={cn(
                "rounded border px-2 py-0.5 font-mono text-[10px] transition-colors",
                sel
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-fg-muted hover:border-border-strong",
              )}
            >
              {idx + 1}
            </button>
          );
        })}
        <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-subtle">
          SL
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onToggleSL}
          className={cn(
            "rounded border px-2 py-0.5 font-mono text-[10px] transition-colors",
            profiles.stop_loss_enabled
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border text-fg-subtle",
          )}
        >
          {profiles.stop_loss_enabled
            ? `-${profiles.profiles[profiles.selected]?.stop_loss_pct ?? 0}%`
            : "OFF"}
        </button>
        <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
          TS
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onToggleTS}
          title="trailing stop (engine support v0.1.13)"
          className={cn(
            "rounded border px-2 py-0.5 font-mono text-[10px] transition-colors opacity-60",
            profiles.trailing_stop_pct != null
              ? "border-warn/40 bg-warn/10 text-warn"
              : "border-border text-fg-subtle",
          )}
        >
          {profiles.trailing_stop_pct != null
            ? `-${profiles.trailing_stop_pct}%`
            : "OFF"}
        </button>
      </div>

      {/* Quick-action rows: Buy / Sell */}
      {!compact && (
        <div className="mt-1.5 grid grid-cols-[16px_1fr] gap-1.5 items-center text-[10px]">
          <span className="text-accent font-mono uppercase tracking-wider">B</span>
          <div className="flex flex-wrap gap-1">
            {profiles.buy_presets_sol.map((sol) => (
              <button
                key={sol}
                type="button"
                disabled={busy || !activeMint}
                onClick={() => onQuickBuy(sol)}
                className={cn(
                  "rounded border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent hover:bg-accent/20 disabled:opacity-30 disabled:cursor-not-allowed",
                )}
              >
                {sol}
              </button>
            ))}
          </div>
          <span className="text-danger font-mono uppercase tracking-wider">S</span>
          <div className="flex flex-wrap gap-1">
            {profiles.sell_presets_pct.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={busy || !activeMint}
                onClick={() => onQuickSell(pct)}
                className={cn(
                  "rounded border border-danger/30 bg-danger/10 px-2 py-0.5 font-mono text-[10px] text-danger hover:bg-danger/20 disabled:opacity-30 disabled:cursor-not-allowed",
                )}
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>
      )}

      {feedback && (
        <div className="mt-1.5 text-[10px] font-mono text-accent">
          ✓ {feedback}
        </div>
      )}
    </div>
  );
}
