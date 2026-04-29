import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc, type AppConfig, type ExitRule } from "../lib/ipc";

interface Props {
  wallets: WalletInfo[];
  onChanged: () => void;
}

type Mode = null | "add" | "delete" | "reassign";
type RuleDraft = { tp: string; sl: string; hold: string };

export function WalletManager({ wallets, onChanged }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [target, setTarget] = useState<WalletInfo | null>(null);
  const [pass, setPass] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, RuleDraft>>({});
  const [savingRule, setSavingRule] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{
    label: string;
    pubkey: string;
    secret_b58: string;
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    ipc
      .loadConfig()
      .then((next) => {
        if (!mounted) return;
        setCfg(next);
        const drafts: Record<string, RuleDraft> = {};
        for (const wallet of wallets) {
          drafts[wallet.pubkey] = exitRuleToDraft(
            next.wallet_exit_rules?.[wallet.pubkey] ?? next.exit,
          );
        }
        setRuleDrafts(drafts);
      })
      .catch((e) => {
        if (mounted) setError(String(e));
      });
    return () => {
      mounted = false;
    };
  }, [wallets]);

  async function doAdd() {
    setError(null);
    if (pass.length < 12) return setError("Enter your keystore passphrase.");
    setBusy(true);
    try {
      const w = await ipc.addSniperWallet(pass, label.trim() || undefined);
      setRevealed(w);
      setLabel("");
      setPass("");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Target role we're reassigning to. Only meaningful while mode === "reassign".
  const [reassignTo, setReassignTo] = useState<"sniper" | "dev">("dev");

  async function doReassign() {
    if (!target) return;
    setError(null);
    if (pass.length < 12) return setError("Enter your keystore passphrase.");
    setBusy(true);
    try {
      await ipc.reassignWalletRole(target.pubkey, reassignTo, pass);
      setMode(null);
      setTarget(null);
      setPass("");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!target) return;
    setError(null);
    if (pass.length < 12) return setError("Enter your keystore passphrase.");
    setBusy(true);
    try {
      await ipc.deleteWallet(target.pubkey, pass);
      setMode(null);
      setTarget(null);
      setPass("");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function updateRuleDraft(pubkey: string, patch: Partial<RuleDraft>) {
    setRuleDrafts((drafts) => ({
      ...drafts,
      [pubkey]: {
        ...(drafts[pubkey] ?? exitRuleToDraft(cfg?.exit ?? defaultExitRule)),
        ...patch,
      },
    }));
  }

  async function saveWalletRule(pubkey: string) {
    setError(null);
    if (!cfg) return setError("Config not loaded.");
    const parsed = parseRuleDraft(ruleDrafts[pubkey]);
    if (typeof parsed === "string") return setError(parsed);

    const next: AppConfig = {
      ...cfg,
      wallet_exit_rules: {
        ...(cfg.wallet_exit_rules ?? {}),
        [pubkey]: parsed,
      },
    };

    setSavingRule(pubkey);
    try {
      await ipc.saveConfig(next);
      setCfg(next);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingRule(null);
    }
  }

  async function resetWalletRule(pubkey: string) {
    setError(null);
    if (!cfg) return setError("Config not loaded.");
    const nextRules = { ...(cfg.wallet_exit_rules ?? {}) };
    delete nextRules[pubkey];
    const next: AppConfig = {
      ...cfg,
      wallet_exit_rules: nextRules,
    };

    setSavingRule(pubkey);
    try {
      await ipc.saveConfig(next);
      setCfg(next);
      setRuleDrafts((drafts) => ({
        ...drafts,
        [pubkey]: exitRuleToDraft(next.exit),
      }));
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingRule(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Manage wallets</h3>
          <Button
            size="sm"
            onClick={() => {
              setMode("add");
              setError(null);
              setRevealed(null);
            }}
            disabled={mode === "add"}
          >
            + Add sniper
          </Button>
        </div>
      </CardHeader>

      {mode === "add" && !revealed && (
        <CardBody className="space-y-3">
          <p className="text-sm text-fg-muted">
            Generates a new sniper wallet, saves it to your encrypted keystore
            in addition to existing ones, and shows you the secret once. Up to
            50 sniper wallets total in the keystore.
          </p>
          <Field label="Label (optional, defaults to next sniper-N)">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="sniper-5"
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          <Field label="Keystore passphrase">
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={doAdd} disabled={busy}>
              {busy ? "Generating…" : "Generate + save"}
            </Button>
          </div>
        </CardBody>
      )}

      {revealed && (
        <CardBody className="space-y-3">
          <div className="rounded-lg border border-accent/40 bg-accent/5 p-4">
            <div className="text-sm font-semibold text-accent">
              ✓ {revealed.label} created. Save the secret NOW.
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              This secret will not be shown again. Copy it somewhere safe.
            </p>
          </div>
          <div>
            <div className="text-xs text-fg-subtle">public</div>
            <code className="block break-all font-mono text-xs">
              {revealed.pubkey}
            </code>
          </div>
          <div>
            <div className="text-xs text-fg-subtle">secret (one-time)</div>
            <code className="block break-all font-mono text-xs text-warn">
              {revealed.secret_b58}
            </code>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setRevealed(null);
                setMode(null);
              }}
            >
              I've saved it
            </Button>
          </div>
        </CardBody>
      )}

      {mode === "reassign" && target && (
        <CardBody className="space-y-3">
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
            Reassigning <span className="font-mono">{target.label}</span> from{" "}
            <strong>{target.role ?? "?"}</strong> to{" "}
            <strong>{reassignTo}</strong>. Keypair stays the same — funds
            and on-chain identity carry over. Useful for rotating
            already-doxxed dev wallets back into the sniper pool, or
            promoting an unused sniper to be the next dev.
          </div>
          <code className="block break-all font-mono text-xs">
            {target.pubkey}
          </code>
          <Field label="Keystore passphrase to confirm">
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setMode(null);
                setTarget(null);
                setPass("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={doReassign} disabled={busy}>
              {busy ? "Saving…" : `Reassign to ${reassignTo}`}
            </Button>
          </div>
        </CardBody>
      )}

      {mode === "delete" && target && (
        <CardBody className="space-y-3">
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            Deleting <span className="font-mono">{target.label}</span> removes
            its key from the keystore. <strong>Any SOL or tokens still in
            this wallet will be unrecoverable</strong> unless you copied the
            secret elsewhere. Withdraw everything before deleting.
          </div>
          <code className="block break-all font-mono text-xs">
            {target.pubkey}
          </code>
          <Field label="Keystore passphrase to confirm">
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setMode(null);
                setTarget(null);
                setPass("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={doDelete} disabled={busy}>
              {busy ? "Deleting…" : "Confirm delete"}
            </Button>
          </div>
        </CardBody>
      )}

      <CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold">App-wide wallet exits</h4>
            <p className="mt-1 text-xs text-fg-subtle">
              TP / SL / hold duration is saved per wallet.
            </p>
          </div>
          {cfg && (
            <div className="text-right text-[10px] text-fg-subtle">
              Global: {cfg.exit.take_profit_pct}% / {cfg.exit.stop_loss_pct}% /{" "}
              {cfg.exit.max_hold_seconds}s
            </div>
          )}
        </div>
        <ul className="space-y-2">
          {wallets.map((w) => {
            const deletable = w.label !== "master";
            const reassignable = w.role === "sniper" || w.role === "dev";
            const otherRole: "sniper" | "dev" =
              w.role === "dev" ? "sniper" : "dev";
            const custom = Boolean(cfg?.wallet_exit_rules?.[w.pubkey]);
            const draft =
              ruleDrafts[w.pubkey] ??
              exitRuleToDraft(cfg?.wallet_exit_rules?.[w.pubkey] ?? cfg?.exit ?? defaultExitRule);
            return (
              <li
                key={w.pubkey}
                className="rounded-lg border border-border bg-bg-subtle p-3"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs uppercase tracking-wider text-fg-muted w-24 shrink-0">
                    {w.label}
                  </span>
                  {w.role && (
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-mono shrink-0",
                        w.role === "master" && "border-warn/50 text-warn",
                        w.role === "dev" && "border-accent/50 text-accent",
                        w.role === "sniper" && "border-border text-fg-subtle",
                      )}
                    >
                      {w.role}
                    </span>
                  )}
                  <code className="flex-1 truncate font-mono text-[11px] text-fg-subtle">
                    {w.pubkey}
                  </code>
                  <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
                    {custom ? "custom" : "global"}
                  </span>
                  {reassignable && (
                    <button
                      onClick={() => {
                        setMode("reassign");
                        setTarget(w);
                        setReassignTo(otherRole);
                        setError(null);
                      }}
                      className="text-xs text-fg-subtle hover:text-fg-muted px-2 py-1"
                      disabled={mode !== null}
                      title={`reassign as ${otherRole}`}
                    >
                      → {otherRole}
                    </button>
                  )}
                  {deletable ? (
                    <button
                      onClick={() => {
                        setMode("delete");
                        setTarget(w);
                        setError(null);
                      }}
                      className="text-xs text-danger/70 hover:text-danger px-2 py-1"
                      disabled={mode !== null}
                    >
                      delete
                    </button>
                  ) : (
                    <span className="text-xs text-fg-subtle px-2 py-1">
                      (master)
                    </span>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
                  <RuleInput
                    label="TP %"
                    value={draft.tp}
                    onChange={(value) => updateRuleDraft(w.pubkey, { tp: value })}
                  />
                  <RuleInput
                    label="SL %"
                    value={draft.sl}
                    onChange={(value) => updateRuleDraft(w.pubkey, { sl: value })}
                  />
                  <RuleInput
                    label="Hold s"
                    value={draft.hold}
                    onChange={(value) => updateRuleDraft(w.pubkey, { hold: value })}
                  />
                  <Button
                    size="sm"
                    onClick={() => saveWalletRule(w.pubkey)}
                    disabled={savingRule === w.pubkey}
                    className="sm:self-end"
                  >
                    {savingRule === w.pubkey ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => resetWalletRule(w.pubkey)}
                    disabled={savingRule === w.pubkey || !custom}
                    className="sm:self-end"
                  >
                    Global
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}

const defaultExitRule: ExitRule = {
  take_profit_pct: 50,
  stop_loss_pct: 30,
  max_hold_seconds: 60,
};

function exitRuleToDraft(rule: ExitRule): RuleDraft {
  return {
    tp: String(rule.take_profit_pct),
    sl: String(rule.stop_loss_pct),
    hold: String(rule.max_hold_seconds),
  };
}

function parseRuleDraft(draft: RuleDraft | undefined): ExitRule | string {
  if (!draft) return "Set TP, SL, and hold duration first.";
  const tp = Number.parseFloat(draft.tp);
  const sl = Number.parseFloat(draft.sl);
  const hold = Number.parseInt(draft.hold, 10);
  if (!Number.isFinite(tp) || tp <= 0) return "TP % must be > 0.";
  if (!Number.isFinite(sl) || sl <= 0) return "SL % must be > 0.";
  if (!Number.isFinite(hold) || hold < 1 || hold > 600) {
    return "Hold duration must be 1..=600 seconds.";
  }
  return {
    take_profit_pct: tp,
    stop_loss_pct: sl,
    max_hold_seconds: hold,
  };
}

function RuleInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
      />
    </label>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-semibold mb-2">{label}</label>
      {children}
    </div>
  );
}
