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
  type WalletProfileBinding,
} from "../lib/ipc";
import { ExportKeysModal } from "./ExportKeysModal";

const DEFAULT_TEMPLATES: ExitProfile[] = [
  { label: "Conservative", take_profit_pct: 25, stop_loss_pct: 15, max_hold_seconds: 60 },
  { label: "Standard", take_profit_pct: 50, stop_loss_pct: 30, max_hold_seconds: 60 },
  { label: "Aggressive", take_profit_pct: 100, stop_loss_pct: 50, max_hold_seconds: 120 },
  { label: "Moonshot", take_profit_pct: 500, stop_loss_pct: 70, max_hold_seconds: 300 },
  { label: "Manual", take_profit_pct: 9999, stop_loss_pct: 99, max_hold_seconds: 600 },
];

const DEFAULT_CUSTOM: ExitProfile = {
  label: "Custom",
  take_profit_pct: 50,
  stop_loss_pct: 30,
  max_hold_seconds: 60,
};

function defaultBinding(): WalletProfileBinding {
  return {
    selected_template: 1, // "Standard"
    custom: { ...DEFAULT_CUSTOM },
    stop_loss_enabled: true,
    trailing_stop_pct: null,
    buy_presets_sol: [0.01, 0.05, 0.25, 0.5, 2.0],
    sell_presets_pct: [25, 50, 75, 100],
  };
}

/**
 * Migrate a legacy v0.1.12 WalletExitProfiles into a v0.1.17 binding.
 * The user's previously-selected profile copy lands in `custom` and the
 * binding starts on Custom — this preserves their actual numbers instead of
 * silently re-pointing them at a (potentially different) default template
 * at the same index.
 */
function migrateLegacy(legacy: WalletExitProfiles): WalletProfileBinding {
  const sel = Math.max(0, Math.min(legacy.selected, legacy.profiles.length - 1));
  const picked = legacy.profiles[sel];
  return {
    selected_template: null, // start on Custom; user can rebind explicitly
    custom: picked
      ? { ...picked, label: picked.label ?? "Custom" }
      : { ...DEFAULT_CUSTOM },
    stop_loss_enabled: legacy.stop_loss_enabled,
    trailing_stop_pct: legacy.trailing_stop_pct,
    buy_presets_sol:
      legacy.buy_presets_sol && legacy.buy_presets_sol.length > 0
        ? legacy.buy_presets_sol
        : [0.01, 0.05, 0.25, 0.5, 2.0],
    sell_presets_pct:
      legacy.sell_presets_pct && legacy.sell_presets_pct.length > 0
        ? legacy.sell_presets_pct
        : [25, 50, 75, 100],
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

  const templates: ExitProfile[] =
    cfg?.profile_templates && cfg.profile_templates.length > 0
      ? cfg.profile_templates
      : DEFAULT_TEMPLATES;

  function getBindingFor(pubkey: string): WalletProfileBinding {
    const stored = cfg?.wallet_bindings?.[pubkey];
    if (stored) return { ...defaultBinding(), ...stored };
    // Migrate legacy v0.1.12 wallet_profiles so the row reflects the user's
    // existing selection until they save (which writes the binding).
    const legacy = cfg?.wallet_profiles?.[pubkey];
    if (legacy) return migrateLegacy(legacy);
    return defaultBinding();
  }

  async function saveWalletPresets(
    pubkey: string,
    next: { buy?: number[]; sell?: number[] },
  ) {
    const binding = getBindingFor(pubkey);
    await patchWallet(pubkey, {
      ...binding,
      buy_presets_sol: next.buy ?? binding.buy_presets_sol,
      sell_presets_pct: next.sell ?? binding.sell_presets_pct,
    });
  }

  async function patchWallet(pubkey: string, next: WalletProfileBinding) {
    if (!cfg) return;
    setError(null);
    setBusyPubkey(pubkey);
    const updated: AppConfig = {
      ...cfg,
      wallet_bindings: {
        ...(cfg.wallet_bindings ?? {}),
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

  async function saveTemplates(next: ExitProfile[]) {
    if (!cfg) return;
    setError(null);
    const updated: AppConfig = {
      ...cfg,
      profile_templates: next,
      // Clamp any wallet's selected_template that's now out of range.
      wallet_bindings: Object.fromEntries(
        Object.entries(cfg.wallet_bindings ?? {}).map(([pk, b]) => [
          pk,
          b.selected_template != null && b.selected_template >= next.length
            ? { ...b, selected_template: null } // fall back to Custom
            : b,
        ]),
      ),
    };
    try {
      await ipc.saveConfig(updated);
      setCfg(updated);
      onConfigChanged?.();
    } catch (e) {
      setError(String(e));
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
  const [editingTemplates, setEditingTemplates] = useState(false);

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
                Each wallet picks a shared profile template or its own{" "}
                <strong className="text-fg-muted">Custom</strong> rule. Edit
                the templates here to retune every wallet bound to them.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!compact && (
              <>
                <Button
                  size="sm"
                  variant={editingTemplates ? "primary" : "secondary"}
                  onClick={() => setEditingTemplates((s) => !s)}
                  title="Edit shared profile templates (affects every wallet bound to them)"
                >
                  {editingTemplates ? "✓ Done" : "✎ Edit templates"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowExport(true)}
                  title="Reveal & export private keys for backup"
                >
                  🔑 Export keys
                </Button>
              </>
            )}
            <span className="text-xs text-fg-subtle font-mono">
              {wallets.length}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
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

        {!compact && editingTemplates && (
          <ProfileSetEditor
            initial={templates}
            title="Shared profile templates"
            subtitle="Applies to every wallet bound to a template"
            onSave={(next) => {
              saveTemplates(next);
              setEditingTemplates(false);
            }}
            onCancel={() => setEditingTemplates(false)}
          />
        )}

        <div className="space-y-3">
          {wallets.map((w) => {
            const binding = getBindingFor(w.pubkey);
            const pnl = walletPnl.get(w.pubkey);
            const busy = busyPubkey === w.pubkey;
            const fb = feedback?.pubkey === w.pubkey ? feedback.msg : null;
            const balance = balances[w.pubkey];
            return (
              <WalletRow
                key={w.pubkey}
                wallet={w}
                binding={binding}
                templates={templates}
                compact={compact}
                busy={busy}
                feedback={fb}
                pnl={pnl}
                balance={balance}
                activeMint={activeMint}
                onSelectTemplate={(idx) =>
                  patchWallet(w.pubkey, { ...binding, selected_template: idx })
                }
                onSelectCustom={() =>
                  patchWallet(w.pubkey, { ...binding, selected_template: null })
                }
                onToggleSL={() =>
                  patchWallet(w.pubkey, {
                    ...binding,
                    stop_loss_enabled: !binding.stop_loss_enabled,
                  })
                }
                onToggleTS={() =>
                  patchWallet(w.pubkey, {
                    ...binding,
                    trailing_stop_pct:
                      binding.trailing_stop_pct == null ? 20 : null,
                  })
                }
                onSaveCustom={(updated) =>
                  patchWallet(w.pubkey, {
                    ...binding,
                    custom: updated,
                    selected_template: null, // saving Custom auto-binds to it
                  })
                }
                onSaveBuyPresets={(next) =>
                  saveWalletPresets(w.pubkey, { buy: next })
                }
                onSaveSellPresets={(next) =>
                  saveWalletPresets(w.pubkey, { sell: next })
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
  binding,
  templates,
  compact,
  busy,
  feedback,
  pnl,
  balance,
  activeMint,
  onSelectTemplate,
  onSelectCustom,
  onToggleSL,
  onToggleTS,
  onSaveCustom,
  onSaveBuyPresets,
  onSaveSellPresets,
  onQuickBuy,
  onQuickSell,
}: {
  wallet: WalletInfo;
  binding: WalletProfileBinding;
  templates: ExitProfile[];
  compact: boolean;
  busy: boolean;
  feedback: string | null;
  pnl: { realized_sol: number; trades: number; wins: number } | undefined;
  balance: number | undefined;
  activeMint: string;
  onSelectTemplate: (idx: number) => void;
  onSelectCustom: () => void;
  onToggleSL: () => void;
  onToggleTS: () => void;
  onSaveCustom: (next: ExitProfile) => void;
  onSaveBuyPresets: (next: number[]) => void;
  onSaveSellPresets: (next: number[]) => void;
  onQuickBuy: (sol: number) => void;
  onQuickSell: (pct: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editingCustom, setEditingCustom] = useState(false);
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

  const usingCustom = binding.selected_template == null;
  const activeProfile: ExitProfile = usingCustom
    ? binding.custom
    : templates[binding.selected_template ?? 0] ?? binding.custom;

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
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
            Profile
          </span>
          <span className="text-[10px] font-mono text-fg-muted">
            TP +{activeProfile.take_profit_pct}% · SL{" "}
            {binding.stop_loss_enabled
              ? `-${activeProfile.stop_loss_pct}%`
              : "off"}
            {" · "}
            {activeProfile.max_hold_seconds}s
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {templates.map((p, idx) => {
            const sel = !usingCustom && binding.selected_template === idx;
            const name = p.label ?? `Template ${idx + 1}`;
            return (
              <button
                key={idx}
                type="button"
                disabled={busy}
                onClick={() => onSelectTemplate(idx)}
                title={`TP +${p.take_profit_pct}% / SL -${p.stop_loss_pct}% / ${p.max_hold_seconds}s hold (shared template)`}
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
          {!compact && (
            <div
              className={cn(
                "inline-flex items-center rounded-md border transition-colors",
                usingCustom
                  ? "border-warn bg-warn/10"
                  : "border-dashed border-border hover:border-border-strong",
              )}
            >
              <button
                type="button"
                disabled={busy}
                onClick={onSelectCustom}
                title={`This wallet's own override (TP +${binding.custom.take_profit_pct}% / SL -${binding.custom.stop_loss_pct}% / ${binding.custom.max_hold_seconds}s)`}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium disabled:opacity-50",
                  usingCustom ? "text-warn" : "text-fg-muted hover:text-fg",
                )}
              >
                {binding.custom.label?.trim() || "Custom"}
              </button>
              <button
                type="button"
                onClick={() => setEditingCustom((s) => !s)}
                className={cn(
                  "border-l px-2 py-1.5 text-[10px] transition-colors",
                  usingCustom
                    ? "border-warn/40 text-warn hover:bg-warn/15"
                    : "border-border text-fg-subtle hover:text-fg",
                )}
                title="edit this wallet's custom profile"
              >
                ✎
              </button>
            </div>
          )}
        </div>

        {editingCustom && !compact && (
          <SingleProfileEditor
            initial={binding.custom}
            onSave={(next) => {
              onSaveCustom(next);
              setEditingCustom(false);
            }}
            onCancel={() => setEditingCustom(false)}
          />
        )}
      </div>

      {/* SL/TS toggles */}
      <div className="mt-3 flex items-center gap-3">
        <ToggleChip
          label="Stop loss"
          on={binding.stop_loss_enabled}
          onLabel={`-${activeProfile.stop_loss_pct}%`}
          onClick={onToggleSL}
          disabled={busy}
        />
        <ToggleChip
          label="Trailing stop"
          on={binding.trailing_stop_pct != null}
          onLabel={`-${binding.trailing_stop_pct}%`}
          onClick={onToggleTS}
          disabled={busy}
          helper="engine support v0.1.13"
        />
      </div>

      {/* Quick-buy / quick-sell */}
      {!compact && (
        <>
          <PresetRow
            kind="buy"
            label="Buy this wallet"
            unit=" SOL"
            values={binding.buy_presets_sol}
            disabled={busy || !activeMint}
            disabledHint={!activeMint ? "set active mint to enable" : null}
            onAction={(v) => onQuickBuy(v)}
            onSave={onSaveBuyPresets}
          />
          <PresetRow
            kind="sell"
            label="Sell this wallet's holdings"
            unit="%"
            max100
            values={binding.sell_presets_pct}
            disabled={busy || !activeMint}
            disabledHint={!activeMint ? "set active mint to enable" : null}
            onAction={(v) => onQuickSell(v)}
            onSave={onSaveSellPresets}
          />
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

/// Per-wallet, per-button preset editor. In view mode each preset is a clickable
/// Button that fires onAction. In edit mode each preset becomes a small inline
/// chip with editable value + ✕ to remove, plus + Add to extend (max 8).
function PresetRow({
  kind,
  label,
  unit,
  values,
  max100,
  disabled,
  disabledHint,
  onAction,
  onSave,
}: {
  kind: "buy" | "sell";
  label: string;
  unit: string;
  values: number[];
  max100?: boolean;
  disabled: boolean;
  disabledHint: string | null;
  onAction: (v: number) => void;
  onSave: (next: number[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[]>(() => values.map(String));
  const [error, setError] = useState<string | null>(null);

  // Reset drafts when values change externally and we're not editing.
  useEffect(() => {
    if (!editing) setDrafts(values.map(String));
  }, [values, editing]);

  function setDraft(i: number, v: string) {
    setDrafts((d) => d.map((x, idx) => (idx === i ? v : x)));
  }
  function removeDraft(i: number) {
    setDrafts((d) => d.filter((_, idx) => idx !== i));
  }
  function addDraft() {
    if (drafts.length >= 8) return;
    setDrafts((d) => [...d, ""]);
  }

  function save() {
    setError(null);
    const out: number[] = [];
    for (let i = 0; i < drafts.length; i++) {
      const n = parseFloat(drafts[i]);
      if (!Number.isFinite(n) || n <= 0) {
        return setError(`Slot ${i + 1}: must be a positive number`);
      }
      if (max100 && n > 100) {
        return setError(`Slot ${i + 1}: must be ≤ 100`);
      }
      out.push(n);
    }
    if (out.length === 0) return setError("Need at least one preset");
    onSave(out);
    setEditing(false);
  }

  function cancel() {
    setDrafts(values.map(String));
    setError(null);
    setEditing(false);
  }

  const accent = kind === "buy" ? "text-accent" : "text-danger";
  const accentBorder = kind === "buy" ? "border-accent/30" : "border-danger/30";
  const accentBg = kind === "buy" ? "bg-accent/10" : "bg-danger/10";

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className={`text-[10px] uppercase tracking-wider ${accent}`}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          {!editing && disabledHint && (
            <span className="text-[10px] text-fg-subtle">{disabledHint}</span>
          )}
          {editing ? (
            <>
              <button
                type="button"
                onClick={cancel}
                className="text-[10px] text-fg-subtle hover:text-fg"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={save}
                className="text-[10px] text-accent hover:underline"
              >
                ✓ done
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[10px] text-fg-subtle hover:text-fg"
              title="edit preset values for this wallet"
            >
              ✎ edit
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {drafts.map((d, i) => (
              <div
                key={i}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border bg-bg-raised px-2 py-1",
                  accentBorder,
                )}
              >
                <input
                  value={d}
                  onChange={(e) => setDraft(i, e.target.value)}
                  inputMode="decimal"
                  className={cn(
                    "w-14 bg-transparent font-mono text-xs text-right focus:outline-none",
                    accent,
                  )}
                />
                <span className="font-mono text-[10px] text-fg-subtle">
                  {unit.trim()}
                </span>
                <button
                  type="button"
                  onClick={() => removeDraft(i)}
                  className="ml-0.5 text-[10px] text-fg-subtle hover:text-danger"
                  title="remove this preset"
                >
                  ✕
                </button>
              </div>
            ))}
            {drafts.length < 8 && (
              <button
                type="button"
                onClick={addDraft}
                className="rounded-md border border-dashed border-border bg-bg-raised px-3 py-1 text-xs text-fg-muted hover:border-border-strong hover:text-fg"
              >
                + add
              </button>
            )}
          </div>
          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger">
              {error}
            </div>
          )}
          <p className="text-[10px] text-fg-subtle">
            Up to 8 presets per wallet. Each value is{" "}
            {kind === "buy" ? "SOL spent on a buy" : "% of holdings sold"}.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {values.map((v) => (
            <Button
              key={v}
              size="sm"
              variant={kind === "buy" ? "secondary" : "danger"}
              disabled={disabled}
              onClick={() => onAction(v)}
              className={
                kind === "buy"
                  ? `${accentBorder} ${accentBg} ${accent} hover:bg-accent/20`
                  : ""
              }
            >
              {v}
              {unit}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileSetEditor({
  initial,
  title,
  subtitle,
  onSave,
  onCancel,
}: {
  initial: ExitProfile[];
  title?: string;
  subtitle?: string;
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

  function addRow() {
    if (drafts.length >= 12) return;
    setDrafts((d) => [
      ...d,
      { label: "", tp: "50", sl: "30", hold: "60" },
    ]);
  }

  function removeRow(i: number) {
    if (drafts.length <= 1) return;
    setDrafts((d) => d.filter((_, idx) => idx !== i));
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
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-accent">
          {title ?? "Profiles for this wallet"}
        </span>
        <span className="text-[10px] text-fg-subtle">
          {subtitle ?? "changes apply on next match"}
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr_60px_60px_60px_24px] gap-2 items-center text-[10px] text-fg-subtle uppercase tracking-wider">
        <span></span>
        <span>label</span>
        <span className="text-right">TP %</span>
        <span className="text-right">SL %</span>
        <span className="text-right">hold s</span>
        <span></span>
      </div>
      {drafts.map((d, i) => (
        <div
          key={i}
          className="grid grid-cols-[auto_1fr_60px_60px_60px_24px] gap-2 items-center"
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
          <button
            type="button"
            onClick={() => removeRow(i)}
            disabled={drafts.length <= 1}
            className="text-[11px] text-fg-subtle hover:text-danger disabled:opacity-30 disabled:cursor-not-allowed"
            title="remove this template"
          >
            ✕
          </button>
        </div>
      ))}
      {drafts.length < 12 && (
        <button
          type="button"
          onClick={addRow}
          className="w-full rounded-md border border-dashed border-border bg-bg-raised py-1.5 text-[11px] text-fg-muted hover:border-border-strong hover:text-fg"
        >
          + Add template
        </button>
      )}
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
          Save
        </Button>
      </div>
    </div>
  );
}

function SingleProfileEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: ExitProfile;
  onSave: (next: ExitProfile) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial.label ?? "Custom");
  const [tp, setTp] = useState(String(initial.take_profit_pct));
  const [sl, setSl] = useState(String(initial.stop_loss_pct));
  const [hold, setHold] = useState(String(initial.max_hold_seconds));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const tpN = parseFloat(tp);
    const slN = parseFloat(sl);
    const holdN = parseInt(hold, 10);
    if (!Number.isFinite(tpN) || tpN <= 0) return setError("TP must be > 0");
    if (!Number.isFinite(slN) || slN <= 0) return setError("SL must be > 0");
    if (!Number.isFinite(holdN) || holdN <= 0 || holdN > 600)
      return setError("Hold must be 1..=600s");
    onSave({
      label: label.trim() || "Custom",
      take_profit_pct: tpN,
      stop_loss_pct: slN,
      max_hold_seconds: holdN,
    });
  }

  return (
    <div className="mt-3 rounded-xl border border-warn/40 bg-warn/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-warn">
          Custom profile (this wallet only)
        </span>
        <span className="text-[10px] text-fg-subtle">
          saving auto-binds the wallet to Custom
        </span>
      </div>
      <div className="grid grid-cols-[1fr_70px_70px_70px] gap-2 items-center text-[10px] text-fg-subtle uppercase tracking-wider">
        <span>label</span>
        <span className="text-right">TP %</span>
        <span className="text-right">SL %</span>
        <span className="text-right">hold s</span>
      </div>
      <div className="grid grid-cols-[1fr_70px_70px_70px] gap-2 items-center">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Custom"
          className="rounded-md border border-border bg-bg-raised px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-warn"
        />
        <input
          value={tp}
          onChange={(e) => setTp(e.target.value)}
          inputMode="decimal"
          className="rounded-md border border-border bg-bg-raised px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-warn"
        />
        <input
          value={sl}
          onChange={(e) => setSl(e.target.value)}
          inputMode="decimal"
          className="rounded-md border border-border bg-bg-raised px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-warn"
        />
        <input
          value={hold}
          onChange={(e) => setHold(e.target.value)}
          inputMode="numeric"
          className="rounded-md border border-border bg-bg-raised px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-warn"
        />
      </div>
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
          Save custom
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
