import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import {
  ipc,
  type BundleGroup,
  type LaunchArgs,
  type MultiLaunchOutcome,
} from "../lib/ipc";

interface Props {
  devWallets: WalletInfo[];
  snipers: WalletInfo[];
  onComplete?: () => void;
}

// One token row in the multi-launch wizard. Each row's settings are
// independent but inherit from the shared defaults at the top of the
// panel — the user can override per-token by editing the field directly.
interface TokenDraft {
  id: string;
  name: string;
  symbol: string;
  description: string;
  imagePath: string | null;
  twitter: string;
  telegram: string;
  website: string;
  // Empty string means "use shared default dev wallet".
  devPubkey: string;
  // Empty string means "use shared default dev buy". Can be 0 to skip.
  devBuySol: string;
  // Empty string means "use shared default group". "none" means no
  // co-buyers for this token even if a shared group is set.
  coBuyerGroupId: string;
}

const NEW_TOKEN_ID_PREFIX = "tok-";
let tokenSeq = 0;
function freshToken(): TokenDraft {
  tokenSeq += 1;
  return {
    id: `${NEW_TOKEN_ID_PREFIX}${tokenSeq}`,
    name: "",
    symbol: "",
    description: "",
    imagePath: null,
    twitter: "",
    telegram: "",
    website: "",
    devPubkey: "",
    devBuySol: "",
    coBuyerGroupId: "",
  };
}

export function MultiLaunchPanel({ devWallets, snipers, onComplete }: Props) {
  const navigate = useNavigate();
  // Shared defaults applied to any token whose per-token field is empty.
  const [sharedDev, setSharedDev] = useState<string>("");
  const [sharedDevBuy, setSharedDevBuy] = useState("0.5");
  const [sharedCoGroupId, setSharedCoGroupId] = useState<string>("");

  const [tokens, setTokens] = useState<TokenDraft[]>(() => [freshToken()]);
  const [bundleGroups, setBundleGroups] = useState<BundleGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MultiLaunchOutcome[] | null>(null);

  // Load bundle groups on mount so the per-token co-buyer dropdown has
  // options. Refreshes when devWallets/snipers list changes (a new
  // wallet may have been added).
  useEffect(() => {
    ipc.listBundleGroups().then(setBundleGroups).catch(() => setBundleGroups([]));
  }, [devWallets.length, snipers.length]);

  // Auto-pick the first dev wallet as shared default when one becomes
  // available — saves the user a click in the common single-dev case.
  useEffect(() => {
    if (!sharedDev && devWallets.length > 0) {
      setSharedDev(devWallets[0].pubkey);
    }
  }, [devWallets, sharedDev]);

  function patchToken(id: string, patch: Partial<TokenDraft>) {
    setTokens((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }
  function removeToken(id: string) {
    setTokens((prev) => prev.filter((t) => t.id !== id));
  }
  function addToken() {
    setTokens((prev) => [...prev, freshToken()]);
  }
  function duplicateToken(id: string) {
    setTokens((prev) => {
      if (prev.length >= 10) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      // Fresh id so React keys stay unique; everything else copies
      // verbatim so the user only edits what's actually different
      // (typically just the symbol/name).
      tokenSeq += 1;
      const copy: TokenDraft = { ...src, id: `${NEW_TOKEN_ID_PREFIX}${tokenSeq}` };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }

  async function pickImage(id: string) {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
        ],
      });
      if (typeof path === "string") {
        patchToken(id, { imagePath: path });
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function buildLaunchArgs(): LaunchArgs[] | string {
    const out: LaunchArgs[] = [];
    for (const [i, t] of tokens.entries()) {
      const label = t.name.trim() || `token #${i + 1}`;
      if (!t.name.trim() || !t.symbol.trim()) {
        return `${label}: name and symbol required.`;
      }
      const dev = t.devPubkey || sharedDev;
      if (!dev) return `${label}: pick a dev wallet (per-token or shared).`;

      const devBuyRaw = t.devBuySol || sharedDevBuy;
      const devBuy = parseFloat(devBuyRaw);
      if (!Number.isFinite(devBuy) || devBuy < 0) {
        return `${label}: dev buy must be non-negative (got ${devBuyRaw}).`;
      }

      // Resolve co-buyers from the chosen bundle group. The token's
      // override wins; "none" is an explicit opt-out; "" inherits the
      // shared default.
      const groupChoice = t.coBuyerGroupId || sharedCoGroupId;
      let coBuyers: { pubkey: string; sol: number }[] = [];
      if (groupChoice && groupChoice !== "none") {
        const g = bundleGroups.find((x) => x.id === groupChoice);
        if (!g) return `${label}: co-buyer group '${groupChoice}' not found.`;
        coBuyers = g.wallet_pubkeys.map((pk) => ({
          pubkey: pk,
          sol: g.default_sol_per_wallet,
        }));
      }

      out.push({
        dev_pubkey: dev,
        metadata: {
          name: t.name.trim(),
          symbol: t.symbol.trim(),
          description: t.description.trim(),
          twitter: t.twitter.trim() || null,
          telegram: t.telegram.trim() || null,
          website: t.website.trim() || null,
        },
        metadata_uri: null,
        image_path: t.imagePath,
        dev_buy_sol: devBuy,
        co_buyers: coBuyers.length > 0 ? coBuyers : undefined,
      });
    }
    return out;
  }

  async function launchAll() {
    setError(null);
    setResults(null);
    const built = buildLaunchArgs();
    if (typeof built === "string") return setError(built);
    if (built.length === 0) return setError("No tokens to launch.");
    if (built.length > 10) return setError("Capped at 10 tokens per batch.");

    setBusy(true);
    try {
      const res = await ipc.launchMultipleTokens(built);
      setResults(res);
      onComplete?.();
      // If at least one token landed, hand off to the sniper dashboard
      // for trade management — that's where positions list + exit
      // controls live. 2.5s delay so the per-token result strip is
      // visible long enough to copy any mints.
      const landed = res.filter((r) => !r.error);
      if (landed.length > 0) {
        window.setTimeout(() => {
          navigate("/dashboard");
        }, 2500);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Multi-token launch</h3>
          <span className="font-mono text-2xs text-fg-subtle">
            {tokens.length} / 10 tokens
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        <p className="text-sm text-fg-muted">
          Launch up to 10 pump.fun tokens in parallel. Each token mints
          with its own dev wallet (creator) and optional dev-buy + co-buyer
          bundle. Per-token fields override the shared defaults below; leave
          per-token blank to inherit from shared.
        </p>

        {/* Shared defaults */}
        <div className="rounded-lg border border-border bg-bg-raised p-3 space-y-3">
          <div className="font-mono text-2xs uppercase tracking-wider text-fg-subtle">
            shared defaults
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                Default dev wallet
              </label>
              <select
                value={sharedDev}
                onChange={(e) => setSharedDev(e.target.value)}
                className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">— none —</option>
                {devWallets.map((w) => (
                  <option key={w.pubkey} value={w.pubkey}>
                    {w.label} ({w.pubkey.slice(0, 6)}…)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                Default dev buy SOL
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={sharedDevBuy}
                onChange={(e) => setSharedDevBuy(e.target.value)}
                placeholder="0.5"
                className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
                Default co-buyer group
              </label>
              <select
                value={sharedCoGroupId}
                onChange={(e) => setSharedCoGroupId(e.target.value)}
                className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">— none —</option>
                {bundleGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.wallet_pubkeys.length}w · {g.default_sol_per_wallet} SOL)
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="font-mono text-2xs text-fg-subtle">
            Manage groups on{" "}
            <span className="text-fg-muted">/wallets &gt; groups</span>. Each
            token below inherits these defaults unless its field is set.
          </p>
        </div>

        {/* Token list */}
        <div className="space-y-3">
          {tokens.map((t, i) => (
            <TokenCard
              key={t.id}
              token={t}
              index={i + 1}
              devWallets={devWallets}
              bundleGroups={bundleGroups}
              sharedDev={sharedDev}
              sharedDevBuy={sharedDevBuy}
              sharedCoGroupId={sharedCoGroupId}
              onPatch={(patch) => patchToken(t.id, patch)}
              onRemove={() => removeToken(t.id)}
              onDuplicate={() => duplicateToken(t.id)}
              onPickImage={() => pickImage(t.id)}
              removable={tokens.length > 1}
              duplicable={tokens.length < 10}
            />
          ))}
          <Button
            variant="secondary"
            onClick={addToken}
            disabled={tokens.length >= 10}
          >
            + Add token
          </Button>
        </div>

        {/* Submit + errors + results */}
        {error && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        {results && (
          <div className="rounded-lg border border-border bg-bg-raised p-3 space-y-2">
            <div className="font-mono text-2xs uppercase tracking-wider text-fg-subtle">
              results
            </div>
            {results.map((r) => {
              const t = tokens[r.index];
              const label = t?.name || `token #${r.index + 1}`;
              return (
                <div
                  key={r.index}
                  className={cn(
                    "rounded border px-3 py-2 text-sm",
                    r.error
                      ? "border-danger/40 bg-danger/5"
                      : "border-accent/40 bg-accent/5",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono">{label}</span>
                    {r.error ? (
                      <span className="text-danger font-mono text-2xs">
                        ✗ failed
                      </span>
                    ) : (
                      <span className="text-accent font-mono text-2xs">
                        ✓ live
                      </span>
                    )}
                  </div>
                  {r.error ? (
                    <div className="mt-1 font-mono text-2xs text-danger">
                      {r.error}
                    </div>
                  ) : (
                    <div className="mt-1 space-y-0.5 font-mono text-2xs text-fg-subtle">
                      <div>
                        mint:{" "}
                        <a
                          href={`https://pump.fun/coin/${r.mint}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline"
                        >
                          {r.mint}
                        </a>
                      </div>
                      <div>
                        bundle:{" "}
                        <a
                          href={`https://solscan.io/tx/${r.bundle_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline"
                        >
                          {r.bundle_id}
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={launchAll} disabled={busy || tokens.length === 0}>
            {busy
              ? "Launching…"
              : `Launch all (${tokens.length} token${tokens.length === 1 ? "" : "s"})`}
          </Button>
          <span className="font-mono text-2xs text-fg-subtle">
            launches fire in parallel · auto-exit watchers armed per token
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

interface CardProps {
  token: TokenDraft;
  index: number;
  devWallets: WalletInfo[];
  bundleGroups: BundleGroup[];
  sharedDev: string;
  sharedDevBuy: string;
  sharedCoGroupId: string;
  onPatch: (patch: Partial<TokenDraft>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onPickImage: () => void;
  removable: boolean;
  duplicable: boolean;
}

function TokenCard({
  token,
  index,
  devWallets,
  bundleGroups,
  sharedDev,
  sharedDevBuy,
  sharedCoGroupId,
  onPatch,
  onRemove,
  onDuplicate,
  onPickImage,
  removable,
  duplicable,
}: CardProps) {
  const [expanded, setExpanded] = useState(false);

  const effectiveDev = token.devPubkey || sharedDev;
  const effectiveDevBuy = token.devBuySol || sharedDevBuy;
  const effectiveCoGroupId = token.coBuyerGroupId || sharedCoGroupId;
  const effectiveCoGroup = bundleGroups.find(
    (g) => g.id === effectiveCoGroupId,
  );

  return (
    <div className="rounded-lg border border-border bg-bg-subtle p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-2xs uppercase tracking-wider text-fg-subtle">
          token #{index}
        </div>
        <div className="flex items-center gap-3">
          {duplicable && (
            <button
              type="button"
              onClick={onDuplicate}
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
              title="duplicate this token (copies all fields, fresh id)"
            >
              duplicate
            </button>
          )}
          {removable && (
            <button
              type="button"
              onClick={onRemove}
              className="font-mono text-2xs text-danger/70 hover:text-danger"
            >
              remove
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
        <input
          type="text"
          value={token.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="Token name"
          className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <input
          type="text"
          value={token.symbol}
          onChange={(e) => onPatch({ symbol: e.target.value })}
          placeholder="TICKER"
          className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm uppercase focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onPickImage}>
          {token.imagePath ? "Change image" : "Pick image"}
        </Button>
        {token.imagePath && (
          <span className="font-mono text-2xs text-fg-subtle truncate">
            {token.imagePath.split("/").pop()}
          </span>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
            Dev wallet
          </label>
          <select
            value={token.devPubkey}
            onChange={(e) => onPatch({ devPubkey: e.target.value })}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">
              shared (
              {devWallets.find((w) => w.pubkey === sharedDev)?.label ?? "—"})
            </option>
            {devWallets.map((w) => (
              <option key={w.pubkey} value={w.pubkey}>
                {w.label} ({w.pubkey.slice(0, 6)}…)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
            Dev buy SOL
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={token.devBuySol}
            onChange={(e) => onPatch({ devBuySol: e.target.value })}
            placeholder={`shared (${sharedDevBuy})`}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <p className="mt-1 font-mono text-[9px] text-fg-subtle">
            0 to skip dev buy on this token
          </p>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
            Co-buyer group
          </label>
          <select
            value={token.coBuyerGroupId}
            onChange={(e) => onPatch({ coBuyerGroupId: e.target.value })}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">
              shared (
              {bundleGroups.find((g) => g.id === sharedCoGroupId)?.name ??
                "none"}
              )
            </option>
            <option value="none">none — solo dev buy</option>
            {bundleGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Effective resolution preview — at-a-glance summary of what
          this token will actually fire with after default merging. */}
      <div className="rounded border border-border/60 bg-bg/40 px-2 py-1 font-mono text-[10px] text-fg-subtle">
        will fire as:{" "}
        <span className="text-fg-muted">
          {devWallets.find((w) => w.pubkey === effectiveDev)?.label ?? "?"}
        </span>{" "}
        · dev buy{" "}
        <span className="text-fg-muted">{effectiveDevBuy} SOL</span> ·
        co-buyers{" "}
        <span className="text-fg-muted">
          {effectiveCoGroupId === "none"
            ? "none"
            : effectiveCoGroup
              ? `${effectiveCoGroup.name} (${effectiveCoGroup.wallet_pubkeys.length}w)`
              : "none"}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
      >
        {expanded ? "− hide metadata" : "+ description / socials"}
      </button>
      {expanded && (
        <div className="space-y-2">
          <textarea
            value={token.description}
            onChange={(e) => onPatch({ description: e.target.value })}
            placeholder="Description"
            rows={2}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <input
              type="text"
              value={token.twitter}
              onChange={(e) => onPatch({ twitter: e.target.value })}
              placeholder="twitter"
              className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="text"
              value={token.telegram}
              onChange={(e) => onPatch({ telegram: e.target.value })}
              placeholder="telegram"
              className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="text"
              value={token.website}
              onChange={(e) => onPatch({ website: e.target.value })}
              placeholder="website"
              className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>
      )}
    </div>
  );
}
