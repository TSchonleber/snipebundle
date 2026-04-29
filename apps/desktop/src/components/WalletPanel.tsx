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
  /**
   * Controlled "edit templates" affordance — when provided the panel renders
   * its inline editor based on this flag and skips its own header button.
   * Lets the parent (Wallets page) put the trigger in the subnav.
   */
  editingTemplatesExternal?: boolean;
  onCloseTemplates?: () => void;
  /** When true, hide the in-panel header (parent owns the title row). */
  chromeless?: boolean;
}

const BALANCE_POLL_MS = 10_000;

export function WalletPanel({
  wallets,
  closedPositions,
  mode = "full",
  onConfigChanged,
  activeMint: activeMintProp,
  onActiveMintChange,
  editingTemplatesExternal,
  onCloseTemplates,
  chromeless = false,
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
  const [editingTemplatesLocal, setEditingTemplatesLocal] = useState(false);
  const editingTemplates =
    editingTemplatesExternal !== undefined
      ? editingTemplatesExternal
      : editingTemplatesLocal;
  const closeTemplates = () =>
    onCloseTemplates ? onCloseTemplates() : setEditingTemplatesLocal(false);

  return (
    <Card>
      {!chromeless && (
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h3 className="font-mono text-[13px] text-fg">wallets</h3>
              <span className="font-mono text-2xs text-fg-subtle">
                [{wallets.length}]
              </span>
            </div>
            {!compact && (
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditingTemplatesLocal((s) => !s)}
                  className={cn(
                    "font-mono text-2xs transition-colors",
                    editingTemplates
                      ? "text-accent"
                      : "text-fg-subtle hover:text-fg-muted",
                  )}
                  title="Edit shared profile templates (affects every wallet bound to them)"
                >
                  {editingTemplates ? "[ done ]" : "edit templates"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowExport(true)}
                  className="font-mono text-2xs text-fg-subtle hover:text-fg-muted transition-colors"
                  title="Reveal & export private keys for backup"
                >
                  export keys
                </button>
              </div>
            )}
          </div>
        </CardHeader>
      )}
      <CardBody className="space-y-3">
        {/* Active mint input — global to the panel */}
        <div className="flex items-center gap-3">
          <span className="font-mono text-2xs text-fg-subtle shrink-0">
            mint &gt;
          </span>
          <input
            value={activeMint}
            onChange={(e) => setActiveMint(e.target.value)}
            placeholder="paste pump.fun mint address"
            className="flex-1 border-b border-border bg-transparent px-1 py-1 font-mono text-xs focus:outline-none focus:border-accent placeholder:text-fg-subtle/60"
          />
        </div>

        {error && (
          <div className="border-l-2 border-danger bg-danger/5 px-3 py-2 font-mono text-2xs text-danger">
            {error}
          </div>
        )}

        {!compact && editingTemplates && (
          <ProfileSetEditor
            initial={templates}
            title="Shared profile templates"
            subtitle="changes apply to every wallet bound to a template"
            warnShared
            onSave={(next) => {
              saveTemplates(next);
              closeTemplates();
            }}
            onCancel={closeTemplates}
          />
        )}

        <div className="divide-y divide-border/60 -mx-4">
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
  // Rows are collapsed by default — most of the time the user is glancing at
  // balance / pnl, not changing the profile. Click anywhere on the header to
  // toggle the controls (profile pills, SL/TS, presets).
  const [expanded, setExpanded] = useState(false);
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

  // Bug fix v0.1.21: previously this always pulled binding.custom.label
  // first, so a wallet bound to "aggressive" still showed "custom" in the
  // collapsed chip. Read from the resolved active profile instead.
  const activeProfileLabel = (
    (activeProfile.label?.trim() || "custom") as string
  ).toLowerCase();

  return (
    <div
      className={cn(
        "border-l-2 bg-bg-subtle/40 transition-colors",
        isMaster
          ? "border-l-accent"
          : expanded
            ? "border-l-fg-subtle"
            : "border-l-border hover:border-l-fg-subtle",
      )}
    >
      {/* Header — always visible. Click toggles row expansion. */}
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "shrink-0 font-mono text-2xs w-12",
              isMaster ? "text-accent" : "text-fg-muted",
            )}
          >
            {wallet.label}
          </span>
          <span
            className="font-mono text-xs text-fg-subtle hover:text-fg-muted truncate transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              copy();
            }}
            title="copy pubkey"
          >
            {copied
              ? "copied"
              : `${wallet.pubkey.slice(0, 8)}..${wallet.pubkey.slice(-4)}`}
          </span>
          {/* Compact summary chip — shown only when collapsed. */}
          {!expanded && (
            <span
              className={cn(
                "ml-2 inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-2xs",
                usingCustom
                  ? "border-warn/50 text-warn"
                  : "border-border text-fg-muted",
              )}
            >
              <span>{activeProfileLabel}</span>
              <span className="text-fg-subtle">·</span>
              <span className="text-fg-subtle">
                tp{activeProfile.take_profit_pct}
                {binding.stop_loss_enabled
                  ? ` sl${activeProfile.stop_loss_pct}`
                  : " sl-off"}
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-right">
          <Stat
            label="bal"
            value={balance != null ? balance.toFixed(3) : "—"}
          />
          <Stat
            label="pnl"
            value={realizedLabel}
            valueClass={cn("font-semibold", realizedColor)}
          />
          {pnl && pnl.trades > 0 && (
            <div className="text-right">
              <div className="font-mono text-2xs text-fg-subtle leading-tight">
                w/l
              </div>
              <div className="font-mono text-xs leading-tight">
                <span className="text-accent">{pnl.wins}</span>
                <span className="text-fg-subtle">/</span>
                <span className="text-danger">{pnl.trades - pnl.wins}</span>
              </div>
            </div>
          )}
          <span
            className={cn(
              "ml-1 font-mono text-2xs text-fg-subtle transition-transform select-none",
              expanded ? "rotate-90" : "",
            )}
            aria-hidden
          >
            ›
          </span>
        </div>
      </button>

      {!expanded ? null : (
        <div className="px-4 pb-3">

      {/* Profile + risk row */}
      <div className="mt-1">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono text-2xs text-fg-subtle">profile</span>
          <span className="font-mono text-2xs text-fg-muted">
            tp+{activeProfile.take_profit_pct}
            <span className="text-fg-subtle"> / </span>
            {binding.stop_loss_enabled ? (
              <>sl-{activeProfile.stop_loss_pct}</>
            ) : (
              <span className="text-fg-subtle">sl off</span>
            )}
            <span className="text-fg-subtle"> / </span>
            {activeProfile.max_hold_seconds}s
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {templates.map((p, idx) => {
            const sel = !usingCustom && binding.selected_template === idx;
            const name = p.label ?? `t${idx + 1}`;
            return (
              <button
                key={idx}
                type="button"
                disabled={busy}
                onClick={() => onSelectTemplate(idx)}
                title={`tp+${p.take_profit_pct} / sl-${p.stop_loss_pct} / ${p.max_hold_seconds}s (shared)`}
                className={cn(
                  "border px-2.5 py-1 font-mono text-2xs transition-colors disabled:opacity-50",
                  sel
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border text-fg-subtle hover:border-border-strong hover:text-fg-muted",
                )}
              >
                {compact ? idx + 1 : name.toLowerCase()}
              </button>
            );
          })}
          {!compact && (
            <div
              className={cn(
                "inline-flex items-stretch border transition-colors",
                usingCustom
                  ? "border-warn bg-warn/10"
                  : "border-dashed border-border hover:border-border-strong",
              )}
            >
              <button
                type="button"
                disabled={busy}
                onClick={onSelectCustom}
                title={`Wallet override: tp+${binding.custom.take_profit_pct} / sl-${binding.custom.stop_loss_pct} / ${binding.custom.max_hold_seconds}s`}
                className={cn(
                  "px-2.5 py-1 font-mono text-2xs disabled:opacity-50",
                  usingCustom ? "text-warn" : "text-fg-subtle hover:text-fg-muted",
                )}
              >
                {(binding.custom.label?.trim() || "custom").toLowerCase()}
              </button>
              <button
                type="button"
                onClick={() => setEditingCustom((s) => !s)}
                className={cn(
                  "border-l px-1.5 py-1 font-mono text-2xs transition-colors",
                  usingCustom
                    ? "border-warn/40 text-warn hover:bg-warn/20"
                    : "border-border text-fg-subtle hover:text-fg-muted",
                )}
                title="edit this wallet's custom profile"
              >
                edit
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
      <div className="mt-2.5 flex items-center gap-2">
        <ToggleChip
          label="sl"
          on={binding.stop_loss_enabled}
          onLabel={`-${activeProfile.stop_loss_pct}`}
          onClick={onToggleSL}
          disabled={busy}
        />
        <ToggleChip
          label="trail"
          on={binding.trailing_stop_pct != null}
          onLabel={`-${binding.trailing_stop_pct}`}
          onClick={onToggleTS}
          disabled={busy}
        />
      </div>

      {/* Quick-buy / quick-sell */}
      {!compact && (
        <>
          <PresetRow
            kind="buy"
            label="buy"
            unit=" SOL"
            values={binding.buy_presets_sol}
            disabled={busy || !activeMint}
            disabledHint={!activeMint ? "set mint" : null}
            onAction={(v) => onQuickBuy(v)}
            onSave={onSaveBuyPresets}
          />
          <PresetRow
            kind="sell"
            label="sell"
            unit="%"
            max100
            values={binding.sell_presets_pct}
            disabled={busy || !activeMint}
            disabledHint={!activeMint ? "set mint" : null}
            onAction={(v) => onQuickSell(v)}
            onSave={onSaveSellPresets}
          />
        </>
      )}

      {feedback && (
        <div className="mt-3 border-l-2 border-accent/60 bg-accent/5 px-3 py-1.5 font-mono text-2xs text-accent">
          {feedback}
        </div>
      )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="text-right">
      <div className="font-mono text-2xs text-fg-subtle leading-tight">
        {label}
      </div>
      <div className={cn("font-mono text-xs leading-tight", valueClass)}>
        {value}
      </div>
    </div>
  );
}

/// Per-wallet, per-button preset editor. View mode = clickable preset buttons;
/// edit mode = chip-style inputs with × to remove and + to add (max 8).
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
  const accentBorder = kind === "buy" ? "border-accent/40" : "border-danger/40";
  const accentBgHover =
    kind === "buy" ? "hover:bg-accent/10" : "hover:bg-danger/10";

  return (
    <div className="mt-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className={cn("font-mono text-2xs", accent)}>{label}</span>
        <div className="flex items-center gap-3">
          {!editing && disabledHint && (
            <span className="font-mono text-2xs text-fg-subtle">
              {disabledHint}
            </span>
          )}
          {editing ? (
            <>
              <button
                type="button"
                onClick={cancel}
                className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={save}
                className="font-mono text-2xs text-accent hover:underline"
              >
                done
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
              title="edit preset values for this wallet"
            >
              edit
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {drafts.map((d, i) => (
              <div
                key={i}
                className={cn(
                  "inline-flex items-center gap-1 border bg-bg-raised px-1.5 py-0.5",
                  accentBorder,
                )}
              >
                <input
                  value={d}
                  onChange={(e) => setDraft(i, e.target.value)}
                  inputMode="decimal"
                  className={cn(
                    "w-12 bg-transparent font-mono text-xs text-right focus:outline-none",
                    accent,
                  )}
                />
                <span className="font-mono text-2xs text-fg-subtle">
                  {unit.trim()}
                </span>
                <button
                  type="button"
                  onClick={() => removeDraft(i)}
                  className="ml-0.5 font-mono text-2xs text-fg-subtle hover:text-danger"
                  title="remove"
                >
                  ×
                </button>
              </div>
            ))}
            {drafts.length < 8 && (
              <button
                type="button"
                onClick={addDraft}
                className="border border-dashed border-border bg-bg-raised px-2 py-0.5 font-mono text-2xs text-fg-subtle hover:border-border-strong hover:text-fg-muted"
              >
                +
              </button>
            )}
          </div>
          {error && (
            <div className="border-l-2 border-danger bg-danger/5 px-2 py-1 font-mono text-2xs text-danger">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <button
              key={v}
              type="button"
              disabled={disabled}
              onClick={() => onAction(v)}
              className={cn(
                "border px-2.5 py-1 font-mono text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                accent,
                accentBorder,
                accentBgHover,
              )}
            >
              {v}
              {unit}
            </button>
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
  warnShared,
  onSave,
  onCancel,
}: {
  initial: ExitProfile[];
  title?: string;
  subtitle?: string;
  /**
   * When true, render a prominent warn callout: "editing here retunes every
   * wallet bound to that template." Set this when editing the Config-level
   * templates list, NOT a single wallet's custom slot.
   */
  warnShared?: boolean;
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
    <div className="border border-accent/30 bg-accent/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-2xs text-accent">
          {title ?? "Profiles for this wallet"}
        </span>
        <span className="font-mono text-2xs text-fg-subtle">
          {subtitle ?? "changes apply on next match"}
        </span>
      </div>

      {warnShared && (
        <div className="border-l-2 border-warn bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn leading-snug">
          shared templates — editing any row retunes every wallet bound to
          that template. to change one wallet only, switch it to{" "}
          <span className="text-fg">custom</span> and edit its custom slot.
        </div>
      )}
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
            className="font-mono text-2xs text-fg-subtle hover:text-danger disabled:opacity-30 disabled:cursor-not-allowed"
            title="remove this template"
          >
            ×
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
        "inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-2xs transition-colors disabled:opacity-50",
        on
          ? "border-accent/50 bg-accent/5 text-accent"
          : "border-border text-fg-subtle hover:border-border-strong hover:text-fg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          on ? "bg-accent" : "bg-fg-subtle/60",
        )}
      />
      <span>{label}</span>
      <span
        className={cn(
          "tabular-nums",
          on ? "text-accent/80" : "text-fg-subtle/70",
        )}
      >
        {on ? onLabel : "off"}
      </span>
    </button>
  );
}
