import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc, type AppConfig, type AmountStrategy } from "../lib/ipc";

type StrategyKind = "uniform" | "per_wallet" | "random";

export function SniperSettings({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<StrategyKind>("uniform");
  const [uniformSol, setUniformSol] = useState("0.05");
  const [perWalletAmounts, setPerWalletAmounts] = useState<Record<string, string>>(
    {},
  );
  const [randomMin, setRandomMin] = useState("0.02");
  const [randomMax, setRandomMax] = useState("0.10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([ipc.loadConfig(), ipc.listWallets()])
      .then(([c, ws]) => {
        setCfg(c);
        const snipersOnly = ws.filter((w) => w.label.startsWith("sniper"));
        setWallets(snipersOnly);
        setPicked(c.trigger.auto_snipe_wallets);
        setUniformSol(String(c.trigger.sol_per_snipe));
        const s = c.trigger.amount_strategy;
        if (s) {
          if (s.kind === "uniform") {
            setStrategy("uniform");
            setUniformSol(String(s.sol));
          } else if (s.kind === "per_wallet") {
            setStrategy("per_wallet");
            const map: Record<string, string> = {};
            for (const [k, v] of Object.entries(s.sol_per_wallet)) {
              map[k] = String(v);
            }
            setPerWalletAmounts(map);
          } else if (s.kind === "random") {
            setStrategy("random");
            setRandomMin(String(s.min_sol));
            setRandomMax(String(s.max_sol));
          }
        } else {
          setStrategy("uniform");
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  const totalEstimate = useMemo(() => {
    if (strategy === "uniform") {
      const v = parseFloat(uniformSol);
      return Number.isFinite(v) ? v * picked.length : 0;
    }
    if (strategy === "per_wallet") {
      return picked.reduce((acc, pk) => {
        const v = parseFloat(perWalletAmounts[pk] ?? "0");
        return acc + (Number.isFinite(v) ? v : 0);
      }, 0);
    }
    const lo = parseFloat(randomMin);
    const hi = parseFloat(randomMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
    return ((lo + hi) / 2) * picked.length;
  }, [strategy, uniformSol, perWalletAmounts, randomMin, randomMax, picked]);

  function toggle(pk: string) {
    if (picked.includes(pk)) {
      setPicked(picked.filter((p) => p !== pk));
    } else if (picked.length >= 5) {
      return;
    } else {
      setPicked([...picked, pk]);
      if (!perWalletAmounts[pk]) {
        setPerWalletAmounts({ ...perWalletAmounts, [pk]: uniformSol });
      }
    }
  }

  function buildStrategy(): AmountStrategy | null | string {
    if (strategy === "uniform") {
      const v = parseFloat(uniformSol);
      if (!Number.isFinite(v) || v <= 0) return "Uniform amount must be > 0.";
      // Uniform is the default; persist as a strategy so the backend uses it
      // explicitly (rather than falling back to sol_per_snipe).
      return { kind: "uniform", sol: v };
    }
    if (strategy === "per_wallet") {
      const map: Record<string, number> = {};
      for (const pk of picked) {
        const v = parseFloat(perWalletAmounts[pk] ?? "");
        if (!Number.isFinite(v) || v <= 0) {
          return `Set a positive amount for ${pk.slice(0, 8)}…`;
        }
        map[pk] = v;
      }
      return { kind: "per_wallet", sol_per_wallet: map };
    }
    const lo = parseFloat(randomMin);
    const hi = parseFloat(randomMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
      return "Random range must satisfy 0 < min ≤ max.";
    }
    return { kind: "random", min_sol: lo, max_sol: hi };
  }

  // ----- v0.1.7 advanced sections (filter / targeted / exit) -----
  const [showFilters, setShowFilters] = useState(false);
  const [showTargeted, setShowTargeted] = useState(false);
  const [showExit, setShowExit] = useState(false);

  const [minDevBuyPct, setMinDevBuyPct] = useState("5");
  const [requireSocials, setRequireSocials] = useState(true);
  const [maxEntryMcSol, setMaxEntryMcSol] = useState("50");
  const [funderBlacklistText, setFunderBlacklistText] = useState("");
  const [targetedDevWallets, setTargetedDevWallets] = useState<string[]>([]);
  const [bypassFilters, setBypassFilters] = useState(true);
  const [takeProfitPct, setTakeProfitPct] = useState("50");
  const [stopLossPct, setStopLossPct] = useState("30");
  const [maxHoldSeconds, setMaxHoldSeconds] = useState("60");

  useEffect(() => {
    if (!cfg) return;
    setMinDevBuyPct(String(cfg.auto.min_dev_buy_pct));
    setRequireSocials(cfg.auto.require_socials);
    setMaxEntryMcSol(String(cfg.auto.max_entry_mc_sol));
    setFunderBlacklistText(cfg.auto.funder_blacklist.join("\n"));
    setTargetedDevWallets(cfg.targeted.dev_wallets);
    setBypassFilters(cfg.targeted.bypass_filters);
    setTakeProfitPct(String(cfg.exit.take_profit_pct));
    setStopLossPct(String(cfg.exit.stop_loss_pct));
    setMaxHoldSeconds(String(cfg.exit.max_hold_seconds));
  }, [cfg]);

  function parseList(s: string): string[] {
    return s
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }

  async function save() {
    setError(null);
    if (!cfg) return;
    if (picked.length === 0) return setError("Pick at least one sniper wallet.");
    const built = buildStrategy();
    if (typeof built === "string") return setError(built);

    const minDev = parseFloat(minDevBuyPct);
    const maxMc = parseFloat(maxEntryMcSol);
    const tp = parseFloat(takeProfitPct);
    const sl = parseFloat(stopLossPct);
    const hold = parseInt(maxHoldSeconds, 10);
    if (!Number.isFinite(minDev) || minDev < 0) return setError("min_dev_buy_pct must be ≥ 0.");
    if (!Number.isFinite(maxMc) || maxMc <= 0) return setError("max_entry_mc_sol must be > 0.");
    if (!Number.isFinite(tp) || tp <= 0) return setError("take_profit_pct must be > 0.");
    if (!Number.isFinite(sl) || sl <= 0) return setError("stop_loss_pct must be > 0.");
    if (!Number.isFinite(hold) || hold <= 0 || hold > 600) return setError("max_hold_seconds must be 1..=600.");

    const next: AppConfig = {
      ...cfg,
      trigger: {
        ...cfg.trigger,
        auto_snipe_wallets: picked,
        amount_strategy: built,
        sol_per_snipe:
          built && built.kind === "uniform" ? built.sol : cfg.trigger.sol_per_snipe,
      },
      auto: {
        ...cfg.auto,
        min_dev_buy_pct: minDev,
        require_socials: requireSocials,
        max_entry_mc_sol: maxMc,
        funder_blacklist: parseList(funderBlacklistText),
      },
      targeted: {
        ...cfg.targeted,
        dev_wallets: targetedDevWallets,
        bypass_filters: bypassFilters,
      },
      exit: {
        ...cfg.exit,
        take_profit_pct: tp,
        stop_loss_pct: sl,
        max_hold_seconds: hold,
      },
    };
    setBusy(true);
    try {
      await ipc.saveConfig(next);
      setCfg(next);
      setSavedAt(Date.now());
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <Card>
        <CardBody className="text-fg-subtle text-sm">Loading config…</CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Sniper config</h2>
      </CardHeader>
      <CardBody className="space-y-5">
        <p className="text-xs text-fg-muted">
          Which wallets fire on each auto-match, and how much each spends.
          Restart-free — the engine reads these on the next trigger.
        </p>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">
              Active wallets ({picked.length}/5)
            </h3>
            <span className="text-xs text-fg-subtle font-mono">
              of {wallets.length} snipers
            </span>
          </div>
          {wallets.length === 0 ? (
            <p className="text-sm text-fg-subtle">
              No sniper wallets yet. Add some in the Wallets tab.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {wallets.map((w) => {
                const isSel = picked.includes(w.pubkey);
                const atCap = !isSel && picked.length >= 5;
                return (
                  <button
                    key={w.pubkey}
                    type="button"
                    disabled={atCap}
                    onClick={() => toggle(w.pubkey)}
                    className={cn(
                      "w-full rounded-lg border bg-bg-subtle p-2 text-left transition-colors",
                      isSel
                        ? "border-accent bg-accent/5"
                        : atCap
                          ? "border-border opacity-40 cursor-not-allowed"
                          : "border-border hover:border-border-strong",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs uppercase tracking-wider text-fg-muted">
                        {w.label}
                      </span>
                      <code className="font-mono text-[10px] text-fg-subtle truncate">
                        {w.pubkey.slice(0, 16)}…
                      </code>
                      {isSel && (
                        <span className="font-mono text-xs text-accent shrink-0">
                          ✓
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Buy strategy per snipe</h3>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {(["uniform", "per_wallet", "random"] as StrategyKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setStrategy(k)}
                className={cn(
                  "rounded-lg border bg-bg-subtle p-2 text-xs capitalize transition-colors",
                  strategy === k
                    ? "border-accent text-accent"
                    : "border-border text-fg-muted hover:border-border-strong",
                )}
              >
                {k.replace("_", "-")}
              </button>
            ))}
          </div>

          {strategy === "uniform" && (
            <div>
              <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                SOL per wallet
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={uniformSol}
                onChange={(e) => setUniformSol(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          )}

          {strategy === "per_wallet" && (
            <div className="space-y-2">
              {picked.length === 0 ? (
                <p className="text-xs text-fg-subtle">
                  Pick wallets above first.
                </p>
              ) : (
                picked.map((pk) => {
                  const w = wallets.find((x) => x.pubkey === pk);
                  return (
                    <div
                      key={pk}
                      className="flex items-center gap-2 rounded-lg border border-border bg-bg-raised px-2 py-1.5"
                    >
                      <span className="font-mono text-xs text-fg-muted w-20 shrink-0">
                        {w?.label ?? "?"}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={perWalletAmounts[pk] ?? ""}
                        onChange={(e) =>
                          setPerWalletAmounts({
                            ...perWalletAmounts,
                            [pk]: e.target.value,
                          })
                        }
                        className="flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-right focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                      <span className="text-xs text-fg-subtle">SOL</span>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {strategy === "random" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                  Min SOL
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={randomMin}
                  onChange={(e) => setRandomMin(e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                  Max SOL
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={randomMax}
                  onChange={(e) => setRandomMax(e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>
          )}

          <p className="mt-2 text-xs text-fg-subtle font-mono">
            ~{totalEstimate.toFixed(4)} SOL per fire across {picked.length}{" "}
            wallets
          </p>
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <CollapseHeader
            open={showFilters}
            onToggle={() => setShowFilters(!showFilters)}
            label="Auto filters"
            sub="What counts as a match"
          />
          {showFilters && (
            <div className="space-y-3 pt-1">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Min dev buy %">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={minDevBuyPct}
                    onChange={(e) => setMinDevBuyPct(e.target.value)}
                    className="w-full rounded-md border border-border bg-bg-raised px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </Field>
                <Field label="Max entry MC (SOL)">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={maxEntryMcSol}
                    onChange={(e) => setMaxEntryMcSol(e.target.value)}
                    className="w-full rounded-md border border-border bg-bg-raised px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={requireSocials}
                  onChange={(e) => setRequireSocials(e.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                <span>Require at least one social link (twitter/telegram/website)</span>
              </label>
              <Field label="Funder blacklist (one pubkey per line)">
                <textarea
                  rows={3}
                  value={funderBlacklistText}
                  onChange={(e) => setFunderBlacklistText(e.target.value)}
                  placeholder="paste creator pubkeys to skip"
                  className="w-full rounded-md border border-border bg-bg-raised px-2 py-1.5 font-mono text-[10px] focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
            </div>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <CollapseHeader
            open={showTargeted}
            onToggle={() => setShowTargeted(!showTargeted)}
            label="Targeted dev wallets"
            sub="Always-fire list"
          />
          {showTargeted && (
            <div className="space-y-3 pt-1">
              <DevWalletPicker
                value={targetedDevWallets}
                onChange={setTargetedDevWallets}
              />
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={bypassFilters}
                  onChange={(e) => setBypassFilters(e.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                <span>Bypass auto filters when a targeted dev mints</span>
              </label>
            </div>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <CollapseHeader
            open={showExit}
            onToggle={() => setShowExit(!showExit)}
            label="Exit"
            sub="TP / SL / max hold"
          />
          {showExit && (
            <div className="grid grid-cols-3 gap-2 pt-1">
              <Field label="Take profit %">
                <input
                  type="text"
                  inputMode="decimal"
                  value={takeProfitPct}
                  onChange={(e) => setTakeProfitPct(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg-raised px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
              <Field label="Stop loss %">
                <input
                  type="text"
                  inputMode="decimal"
                  value={stopLossPct}
                  onChange={(e) => setStopLossPct(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg-raised px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
              <Field label="Max hold (s)">
                <input
                  type="text"
                  inputMode="numeric"
                  value={maxHoldSeconds}
                  onChange={(e) => setMaxHoldSeconds(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg-raised px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-subtle">
            {savedAt
              ? `saved ${new Date(savedAt).toLocaleTimeString()}`
              : "unsaved changes will not affect a running engine until next match"}
          </span>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// Solana pubkeys are base58, decode to 32 bytes — encoded length 32-44 chars,
// alphabet excludes 0/O/I/l. We do a lightweight check; the engine re-validates
// on use.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
function isValidPubkey(s: string): boolean {
  const t = s.trim();
  return t.length >= 32 && t.length <= 44 && BASE58.test(t);
}

function DevWalletPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{
    kind: "added" | "rejected";
    msg: string;
  } | null>(null);

  function add() {
    const tokens = input
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (tokens.length === 0) return;
    const valid: string[] = [];
    const invalid: string[] = [];
    const dupe: string[] = [];
    for (const t of tokens) {
      if (!isValidPubkey(t)) {
        invalid.push(t);
        continue;
      }
      if (value.includes(t) || valid.includes(t)) {
        dupe.push(t);
        continue;
      }
      valid.push(t);
    }
    if (valid.length > 0) {
      onChange([...value, ...valid]);
    }
    const parts: string[] = [];
    if (valid.length > 0) parts.push(`+${valid.length} added`);
    if (dupe.length > 0) parts.push(`${dupe.length} duplicate`);
    if (invalid.length > 0) parts.push(`${invalid.length} invalid`);
    setFeedback(
      parts.length > 0
        ? {
            kind: invalid.length > 0 || dupe.length > 0 ? "rejected" : "added",
            msg: parts.join(" · "),
          }
        : null,
    );
    setInput(valid.length > 0 ? "" : input);
  }

  function remove(pk: string) {
    onChange(value.filter((x) => x !== pk));
  }

  function clear() {
    onChange([]);
    setFeedback({ kind: "added", msg: "cleared" });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs text-fg-subtle uppercase tracking-wider">
          Dev wallets to follow ({value.length})
        </label>
        {value.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="text-[10px] text-fg-subtle hover:text-danger underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="paste pubkey(s) — Enter or click Add"
          className="flex-1 rounded-md border border-border bg-bg-raised px-2 py-1.5 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={add}
          disabled={input.trim().length === 0}
        >
          Add
        </Button>
      </div>

      {feedback && (
        <div
          className={cn(
            "text-[10px] font-mono",
            feedback.kind === "added" ? "text-accent" : "text-warn",
          )}
        >
          {feedback.msg}
        </div>
      )}

      <p className="text-[10px] text-fg-subtle">
        Paste a single pubkey or many separated by spaces, commas, or newlines.
        Invalid base58 / wrong length / duplicates are skipped.
      </p>

      {value.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-bg-raised/40 p-3 text-center text-xs text-fg-subtle">
          No tracked devs yet. Add one above.
        </div>
      ) : (
        <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
          {value.map((pk) => (
            <li
              key={pk}
              className="flex items-center gap-2 rounded-md border border-border bg-bg-raised px-2 py-1.5 group"
            >
              <span className="font-mono text-[10px] text-accent shrink-0">
                ▸
              </span>
              <code className="flex-1 break-all font-mono text-[10px] text-fg">
                {pk}
              </code>
              <button
                type="button"
                onClick={() => remove(pk)}
                className="shrink-0 text-fg-subtle hover:text-danger text-xs px-1 opacity-60 group-hover:opacity-100 transition-opacity"
                title="Remove"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CollapseHeader({
  open,
  onToggle,
  label,
  sub,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between text-left"
    >
      <div>
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-[10px] text-fg-subtle uppercase tracking-wider">
          {sub}
        </div>
      </div>
      <span className="font-mono text-fg-subtle">{open ? "▾" : "▸"}</span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
