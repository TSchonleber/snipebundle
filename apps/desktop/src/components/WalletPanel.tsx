import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ExportKeysModal } from "./ExportKeysModal";

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
  /** "full" = Wallets tab; "compact" = Sniper sidebar (no buy/sell rows). */
  mode?: "full" | "compact";
  onConfigChanged?: () => void;
  activeMint?: string;
  onActiveMintChange?: (mint: string) => void;
}

const BALANCE_POLL_MS = 10_000;

export function WalletPanel({
  wallets,
  closedPositions,
  mode = "full",
  onConfigChanged,
  activeMint: activeMintProp,
  onActiveMintChange,
}: Props) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [busyPubkey, setBusyPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ pubkey: string; msg: string } | null>(null);
  const [internalMint, setInternalMint] = useState("");
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const activeMint = activeMintProp ?? internalMint;
  const setActiveMint = onActiveMintChange ?? setInternalMint;

  const reloadCfg = useCallback(async () => {
    try {
      setCfg(await ipc.loadConfig());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    reloadCfg();
  }, [reloadCfg]);

  // Balance polling — every 10 s, replaces the standalone WalletGrid card.
  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    const pubkeys = wallets.map((w) => w.pubkey);
    if (pubkeys.length === 0) return;
    async function tick() {
      try {
        const res = await ipc.getBalances(pubkeys);
        if (mounted) setBalances(res);
      } catch {
        /* ignore — show last good values */
      }
      if (mounted) timer = window.setTimeout(tick, BALANCE_POLL_MS);
    }
    tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [wallets]);

  const walletPnl = useMemo(() => {
    const map = new Map<
      string,
      { realized_sol: number; trades: number; wins: number }
    >();
    if (!closedPositions) return map;
    for (const cp of closedPositions) {
      const pks =
        (cp as ClosedPosition & { wallet_pubkeys?: string[] }).wallet_pubkeys ?? [];
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
    const stored = cfg?.wallet_profiles?.[pubkey];
    const defaults = defaultWalletProfiles();
    const globalPresets = cfg?.presets;
    // Wallet-specific presets win if explicitly set; otherwise fall back to
    // the global presets edited from the panel header.
    return {
      ...defaults,
      ...(stored ?? {}),
      buy_presets_sol:
        stored?.buy_presets_sol && stored.buy_presets_sol.length > 0
          ? stored.buy_presets_sol
          : globalPresets?.buy_presets_sol ?? defaults.buy_presets_sol,
      sell_presets_pct:
        stored?.sell_presets_pct && stored.sell_presets_pct.length > 0
          ? stored.sell_presets_pct
          : globalPresets?.sell_presets_pct ?? defaults.sell_presets_pct,
    };
  }

  async function saveGlobalPresets(buy: number[], sell: number[]) {
    if (!cfg) return;
    setError(null);
    const updated: AppConfig = {
      ...cfg,
      presets: { buy_presets_sol: buy, sell_presets_pct: sell },
    };
    try {
      await ipc.saveConfig(updated);
      setCfg(updated);
      setShowPresetEditor(false);
      onConfigChanged?.();
    } catch (e) {
      setError(String(e));
    }
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
      flashFeedback(pubkey, "saved");
      onConfigChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPubkey(null);
    }
  }

  function flashFeedback(pubkey: string, msg: string) {
    setFeedback({ pubkey, msg });
    window.setTimeout(() => setFeedback(null), 2200);
  }

  async function quickBuy(wallet: WalletInfo, sol: number) {
    if (!activeMint.trim()) {
      return setError("Set an active mint first.");
    }
    setError(null);
    setBusyPubkey(wallet.pubkey);
    try {
      await ipc.manualSnipe({
        mint: activeMint.trim(),
        wallet_pubkeys: [wallet.pubkey],
        strategy: { kind: "uniform", sol },
      });
      flashFeedback(wallet.pubkey, `BUY ${sol} SOL submitted`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPubkey(null);
    }
  }

  async function quickSell(wallet: WalletInfo, percent: number) {
    if (!activeMint.trim()) {
      return setError("Set an active mint first.");
    }
    setError(null);
    setBusyPubkey(wallet.pubkey);
    try {
      await ipc.manualDump({
        mint: activeMint.trim(),
        wallet_pubkeys: [wallet.pubkey],
        percent,
      });
      flashFeedback(wallet.pubkey, `SELL ${percent}% submitted`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPubkey(null);
    }
  }

  const compact = mode === "compact";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">
              {compact ? "Wallets" : "Wallet panel"}
            </h3>
            {!compact && (
              <p className="text-xs text-fg-subtle mt-0.5">
                Customize the buy / sell preset buttons via{" "}
                <strong className="text-fg-muted">Customize buttons</strong>.
                Customize what each profile (1–5) means per wallet via the ✎
                icon next to that wallet's profile row.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!compact && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowExport(true)}
                title="Reveal & export private keys for backup"
              >
                🔑 Export keys
              </Button>
            )}
            {!compact && cfg && (
              <Button
                size="sm"
                variant={showPresetEditor ? "primary" : "secondary"}
                onClick={() => setShowPresetEditor((s) => !s)}
              >
                {showPresetEditor ? "Close" : "Customize buttons"}
              </Button>
            )}
            <span className="text-xs text-fg-subtle font-mono">
              {wallets.length}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {showPresetEditor && cfg && !compact && (
          <PresetEditor
            initialBuy={cfg.presets.buy_presets_sol}
            initialSell={cfg.presets.sell_presets_pct}
            onSave={saveGlobalPresets}
            onCancel={() => setShowPresetEditor(false)}
          />
        )}

        {/* Active mint input — global to the panel */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-fg-subtle mb-1.5">
            Active mint (for quick buy/sell)
          </label>
          <input
            value={activeMint}
            onChange={(e) => setActiveMint(e.target.value)}
            placeholder="paste pump.fun mint address"
            className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {wallets.map((w) => {
            const profiles = getProfilesFor(w.pubkey);
            const pnl = walletPnl.get(w.pubkey);
            const busy = busyPubkey === w.pubkey;
            const fb = feedback?.pubkey === w.pubkey ? feedback.msg : null;
            const balance = balances[w.pubkey];
            return (
              <WalletRow
                key={w.pubkey}
                wallet={w}
                profiles={profiles}
                compact={compact}
                busy={busy}
                feedback={fb}
                pnl={pnl}
                balance={balance}
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
                    trailing_stop_pct:
                      profiles.trailing_stop_pct == null ? 20 : null,
                  })
                }
                onSaveProfiles={(updated) =>
                  patchWallet(w.pubkey, {
                    ...profiles,
                    profiles: updated,
                  })
                }
                onQuickBuy={(sol) => quickBuy(w, sol)}
                onQuickSell={(pct) => quickSell(w, pct)}
              />
            );
          })}
        </div>
      </CardBody>

      {showExport && <ExportKeysModal onClose={() => setShowExport(false)} />}
    </Card>
  );
}

function WalletRow({
  wallet,
  profiles,
  compact,
  busy,
  feedback,
  pnl,
  balance,
  activeMint,
  onSelectProfile,
  onToggleSL,
  onToggleTS,
  onSaveProfiles,
  onQuickBuy,
  onQuickSell,
}: {
  wallet: WalletInfo;
  profiles: WalletExitProfiles;
  compact: boolean;
  busy: boolean;
  feedback: string | null;
  pnl: { realized_sol: number; trades: number; wins: number } | undefined;
  balance: number | undefined;
  activeMint: string;
  onSelectProfile: (idx: number) => void;
  onToggleSL: () => void;
  onToggleTS: () => void;
  onSaveProfiles: (next: ExitProfile[]) => void;
  onQuickBuy: (sol: number) => void;
  onQuickSell: (pct: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editingProfiles, setEditingProfiles] = useState(false);
  const isMaster = wallet.label === "master";

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
      ? `${realized >= 0 ? "+" : ""}${realized.toFixed(4)} SOL`
      : "—";

  const activeProfile = profiles.profiles[profiles.selected];

  return (
    <div
      className={cn(
        "rounded-xl border bg-bg-subtle p-4",
        isMaster ? "border-accent/30" : "border-border",
      )}
    >
      {/* Header: identity + balance + P&L */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "shrink-0 rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
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
            className="font-mono text-xs text-fg-muted hover:text-fg truncate"
            title="copy pubkey"
          >
            {copied ? "✓ copied" : `${wallet.pubkey.slice(0, 12)}…`}
          </button>
        </div>
        <div className="flex items-center gap-4 text-right">
          <div>
            <div className="text-[9px] uppercase tracking-wider text-fg-subtle">
              balance
            </div>
            <div className="font-mono text-sm tabular-nums">
              {balance != null ? balance.toFixed(3) : "—"}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-fg-subtle">
              realized
            </div>
            <div
              className={`font-mono text-sm tabular-nums font-semibold ${realizedColor}`}
            >
              {realizedLabel}
            </div>
          </div>
          {pnl && pnl.trades > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle">
                W/L
              </div>
              <div className="font-mono text-xs">
                <span className="text-accent">{pnl.wins}</span>
                <span className="text-fg-subtle">/</span>
                <span className="text-danger">{pnl.trades - pnl.wins}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Profile + risk row */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
              Profile
            </span>
            {!compact && (
              <button
                type="button"
                onClick={() => setEditingProfiles((s) => !s)}
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                  editingProfiles
                    ? "border-accent text-accent bg-accent/10"
                    : "border-border text-fg-muted hover:text-fg hover:border-border-strong",
                )}
                title="customize what each profile (1–5) means for this wallet"
              >
                {editingProfiles ? "✓ Done" : "✎ Edit profiles"}
              </button>
            )}
          </div>
          {activeProfile && (
            <span className="text-[10px] font-mono text-fg-muted">
              TP +{activeProfile.take_profit_pct}% · SL{" "}
              {profiles.stop_loss_enabled
                ? `-${activeProfile.stop_loss_pct}%`
                : "off"}
              {" · "}
              {activeProfile.max_hold_seconds}s
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {profiles.profiles.map((p, idx) => {
            const sel = profiles.selected === idx;
            const name = p.label ?? `Profile ${idx + 1}`;
            return (
              <button
                key={idx}
                type="button"
                disabled={busy}
                onClick={() => onSelectProfile(idx)}
                title={`TP +${p.take_profit_pct}% / SL -${p.stop_loss_pct}% / ${p.max_hold_seconds}s hold`}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                  sel
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
                )}
              >
                {compact ? idx + 1 : name}
              </button>
            );
          })}
        </div>

        {editingProfiles && !compact && (
          <ProfileSetEditor
            initial={profiles.profiles}
            onSave={(next) => {
              onSaveProfiles(next);
              setEditingProfiles(false);
            }}
            onCancel={() => setEditingProfiles(false)}
          />
        )}
      </div>

      {/* SL/TS toggles */}
      <div className="mt-3 flex items-center gap-3">
        <ToggleChip
          label="Stop loss"
          on={profiles.stop_loss_enabled}
          onLabel={`-${activeProfile?.stop_loss_pct ?? 0}%`}
          onClick={onToggleSL}
          disabled={busy}
        />
        <ToggleChip
          label="Trailing stop"
          on={profiles.trailing_stop_pct != null}
          onLabel={`-${profiles.trailing_stop_pct}%`}
          onClick={onToggleTS}
          disabled={busy}
          helper="engine support v0.1.13"
        />
      </div>

      {/* Quick-buy / quick-sell */}
      {!compact && (
        <>
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-accent">
                Buy this wallet
              </span>
              {!activeMint && (
                <span className="text-[10px] text-fg-subtle">
                  set active mint to enable
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {profiles.buy_presets_sol.map((sol) => (
                <Button
                  key={sol}
                  size="sm"
                  variant="secondary"
                  disabled={busy || !activeMint}
                  onClick={() => onQuickBuy(sol)}
                  className="border-accent/30 bg-accent/10 text-accent hover:bg-accent/20"
                >
                  {sol} SOL
                </Button>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-danger mb-2">
              Sell this wallet's holdings
            </div>
            <div className="flex flex-wrap gap-2">
              {profiles.sell_presets_pct.map((pct) => (
                <Button
                  key={pct}
                  size="sm"
                  variant="danger"
                  disabled={busy || !activeMint}
                  onClick={() => onQuickSell(pct)}
                >
                  {pct}%
                </Button>
              ))}
            </div>
          </div>
        </>
      )}

      {feedback && (
        <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-1.5 text-xs text-accent">
          ✓ {feedback}
        </div>
      )}
    </div>
  );
}

function ProfileSetEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: ExitProfile[];
  onSave: (next: ExitProfile[]) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState(() =>
    initial.map((p) => ({
      label: p.label ?? "",
      tp: String(p.take_profit_pct),
      sl: String(p.stop_loss_pct),
      hold: String(p.max_hold_seconds),
    })),
  );
  const [error, setError] = useState<string | null>(null);

  function update(i: number, patch: Partial<(typeof drafts)[number]>) {
    setDrafts((d) => d.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function submit() {
    setError(null);
    const out: ExitProfile[] = [];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      const tp = parseFloat(d.tp);
      const sl = parseFloat(d.sl);
      const hold = parseInt(d.hold, 10);
      if (!Number.isFinite(tp) || tp <= 0)
        return setError(`Profile ${i + 1}: TP must be > 0`);
      if (!Number.isFinite(sl) || sl <= 0)
        return setError(`Profile ${i + 1}: SL must be > 0`);
      if (!Number.isFinite(hold) || hold <= 0 || hold > 600)
        return setError(`Profile ${i + 1}: hold must be 1..=600s`);
      out.push({
        label: d.label.trim() || null,
        take_profit_pct: tp,
        stop_loss_pct: sl,
        max_hold_seconds: hold,
      });
    }
    onSave(out);
  }

  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-accent">
          Profiles for this wallet
        </span>
        <span className="text-[10px] text-fg-subtle">
          changes apply on next match
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr_60px_60px_60px] gap-2 items-center text-[10px] text-fg-subtle uppercase tracking-wider">
        <span></span>
        <span>label</span>
        <span className="text-right">TP %</span>
        <span className="text-right">SL %</span>
        <span className="text-right">hold s</span>
      </div>
      {drafts.map((d, i) => (
        <div
          key={i}
          className="grid grid-cols-[auto_1fr_60px_60px_60px] gap-2 items-center"
        >
          <span className="font-mono text-xs text-fg-muted w-5 text-center">
            {i + 1}
          </span>
          <input
            value={d.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder={`Profile ${i + 1}`}
            className="rounded-md border border-border bg-bg-raised px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            value={d.tp}
            onChange={(e) => update(i, { tp: e.target.value })}
            inputMode="decimal"
            className="rounded-md border border-border bg-bg-raised px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            value={d.sl}
            onChange={(e) => update(i, { sl: e.target.value })}
            inputMode="decimal"
            className="rounded-md border border-border bg-bg-raised px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            value={d.hold}
            onChange={(e) => update(i, { hold: e.target.value })}
            inputMode="numeric"
            className="rounded-md border border-border bg-bg-raised px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      ))}
      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-[10px] text-danger">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit}>
          Save profiles
        </Button>
      </div>
    </div>
  );
}

function PresetEditor({
  initialBuy,
  initialSell,
  onSave,
  onCancel,
}: {
  initialBuy: number[];
  initialSell: number[];
  onSave: (buy: number[], sell: number[]) => void;
  onCancel: () => void;
}) {
  const [buyText, setBuyText] = useState(initialBuy.join(", "));
  const [sellText, setSellText] = useState(initialSell.join(", "));
  const [error, setError] = useState<string | null>(null);

  function parseList(s: string): number[] | string {
    const out: number[] = [];
    for (const tok of s.split(/[,\s]+/).filter((x) => x.length > 0)) {
      const n = parseFloat(tok);
      if (!Number.isFinite(n) || n <= 0) return `"${tok}" is not a positive number`;
      out.push(n);
    }
    return out;
  }

  function submit() {
    setError(null);
    const buy = parseList(buyText);
    if (typeof buy === "string") return setError(`Buy presets: ${buy}`);
    if (buy.length === 0 || buy.length > 8) {
      return setError("Buy presets must have 1–8 entries.");
    }
    const sell = parseList(sellText);
    if (typeof sell === "string") return setError(`Sell presets: ${sell}`);
    if (sell.length === 0 || sell.length > 8) {
      return setError("Sell presets must have 1–8 entries.");
    }
    if (sell.some((v) => v > 100)) {
      return setError("Sell percent values must be ≤ 100.");
    }
    onSave(buy, sell);
  }

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-accent">Edit preset buttons</h4>
        <span className="text-[10px] text-fg-subtle">applies to all wallets</span>
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-fg-subtle mb-1">
          Buy SOL amounts (comma- or space-separated, up to 8)
        </label>
        <input
          value={buyText}
          onChange={(e) => setBuyText(e.target.value)}
          placeholder="0.01, 0.05, 0.25, 0.5, 1, 2"
          className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-fg-subtle mb-1">
          Sell percentages (comma- or space-separated, up to 8, each ≤ 100)
        </label>
        <input
          value={sellText}
          onChange={(e) => setSellText(e.target.value)}
          placeholder="10, 25, 50, 75, 100"
          className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit}>
          Save presets
        </Button>
      </div>
    </div>
  );
}

function ToggleChip({
  label,
  on,
  onLabel,
  onClick,
  disabled,
  helper,
}: {
  label: string;
  on: boolean;
  onLabel: string;
  onClick: () => void;
  disabled?: boolean;
  helper?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={helper}
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50",
        on
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border text-fg-muted hover:border-border-strong",
      )}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          on ? "bg-accent" : "bg-fg-subtle",
        )}
      />
      <span>{label}</span>
      <span className="font-mono text-[10px] text-fg-subtle">
        {on ? onLabel : "OFF"}
      </span>
    </button>
  );
}
