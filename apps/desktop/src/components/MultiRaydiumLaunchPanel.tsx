import { useEffect, useState } from "react";
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
  type MultiRaydiumOutcome,
  type RaydiumLaunchArgs,
} from "../lib/ipc";

interface Props {
  devWallets: WalletInfo[];
  snipers: WalletInfo[];
}

interface RaydiumTokenDraft {
  id: string;
  name: string;
  symbol: string;
  description: string;
  imagePath: string | null;
  metadataUri: string;
  twitter: string;
  telegram: string;
  website: string;
  /** Empty string = inherit shared default. */
  devPubkey: string;
  /** Empty string = inherit shared default. */
  tokenSupply: string;
  tokenDecimals: string;
  lpTokens: string;
  lpSol: string;
  burnLp: boolean;
  devBuySol: string;
  /** Same wallets as the snipers list — picked subset for this token's
   *  co-buyers. Empty = no co-buyers on this token. */
  coBuyerPicked: string[];
  coBuyerSol: string;
}

let seq = 0;
function freshToken(): RaydiumTokenDraft {
  seq += 1;
  return {
    id: `ray-${seq}`,
    name: "",
    symbol: "",
    description: "",
    imagePath: null,
    metadataUri: "",
    twitter: "",
    telegram: "",
    website: "",
    devPubkey: "",
    tokenSupply: "",
    tokenDecimals: "",
    lpTokens: "",
    lpSol: "",
    burnLp: true,
    devBuySol: "",
    coBuyerPicked: [],
    coBuyerSol: "",
  };
}

/**
 * Multi-token Raydium launch wizard. Mirrors MultiLaunchPanel's shape
 * but every per-token card carries Raydium-specific fields (token
 * supply, decimals, LP token amount, LP SOL, burn LP toggle) instead
 * of pump.fun's bonding-curve flow. Up to 10 tokens per batch fired
 * in parallel via launch_multiple_tokens_raydium.
 *
 * Each launch follows the same on-chain pipeline as the single-token
 * Raydium tab: SPL mint + Metaplex metadata + initial supply mint to
 * dev's ATA, in one transaction. Pool init happens via Raydium's UI
 * after the batch lands (deep-link in the per-token result row).
 */
export function MultiRaydiumLaunchPanel({ devWallets, snipers }: Props) {
  // Shared defaults — applied to any token whose per-token field is empty.
  const [sharedDev, setSharedDev] = useState<string>("");
  const [sharedSupply, setSharedSupply] = useState("1000000000");
  const [sharedDecimals, setSharedDecimals] = useState("6");
  const [sharedLpTokens, setSharedLpTokens] = useState("800000000");
  const [sharedLpSol, setSharedLpSol] = useState("1.0");
  const [sharedDevBuy, setSharedDevBuy] = useState("0.5");

  const [tokens, setTokens] = useState<RaydiumTokenDraft[]>(() => [freshToken()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MultiRaydiumOutcome[] | null>(null);

  useEffect(() => {
    if (!sharedDev && devWallets.length > 0) {
      setSharedDev(devWallets[0].pubkey);
    }
  }, [devWallets, sharedDev]);

  function patchToken(id: string, patch: Partial<RaydiumTokenDraft>) {
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
      seq += 1;
      const copy: RaydiumTokenDraft = { ...src, id: `ray-${seq}` };
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

  function buildArgs(): RaydiumLaunchArgs[] | string {
    const out: RaydiumLaunchArgs[] = [];
    for (const [i, t] of tokens.entries()) {
      const label = t.name.trim() || `token #${i + 1}`;
      if (!t.name.trim() || !t.symbol.trim()) {
        return `${label}: name and symbol required.`;
      }
      const dev = t.devPubkey || sharedDev;
      if (!dev) return `${label}: pick a dev wallet (per-token or shared).`;
      if (!t.metadataUri.trim() && !t.imagePath) {
        return `${label}: metadata URI or image required.`;
      }

      const supplyStr = t.tokenSupply || sharedSupply;
      const decimalsStr = t.tokenDecimals || sharedDecimals;
      const lpTokensStr = t.lpTokens || sharedLpTokens;
      const lpSolStr = t.lpSol || sharedLpSol;
      const devBuyStr = t.devBuySol || sharedDevBuy;

      const supply = parseFloat(supplyStr);
      const decimals = parseInt(decimalsStr, 10);
      const lpT = parseFloat(lpTokensStr);
      const lpS = parseFloat(lpSolStr);
      const buy = parseFloat(devBuyStr);

      if (!Number.isFinite(supply) || supply <= 0) {
        return `${label}: token_supply must be > 0.`;
      }
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 9) {
        return `${label}: token_decimals must be 0..=9.`;
      }
      if (!Number.isFinite(lpT) || lpT <= 0)
        return `${label}: lp_token_amount must be > 0.`;
      if (lpT > supply) return `${label}: lp tokens exceeds supply.`;
      if (!Number.isFinite(lpS) || lpS <= 0)
        return `${label}: lp_sol must be > 0.`;
      if (!Number.isFinite(buy) || buy < 0)
        return `${label}: dev_buy_sol must be ≥ 0.`;

      const coAmount = parseFloat(t.coBuyerSol);
      const cobuyers =
        t.coBuyerPicked.length > 0
          ? (() => {
              if (!Number.isFinite(coAmount) || coAmount <= 0) {
                return null;
              }
              return t.coBuyerPicked.map((pk) => ({ pubkey: pk, sol: coAmount }));
            })()
          : [];
      if (cobuyers === null) {
        return `${label}: co-buyer SOL must be > 0.`;
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
        metadata_uri: t.metadataUri.trim(),
        image_path: t.imagePath,
        token_supply: supply,
        token_decimals: decimals,
        initial_lp_token_amount: lpT,
        initial_lp_sol: lpS,
        burn_lp: t.burnLp,
        dev_buy_sol: buy,
        co_buyers: cobuyers,
      });
    }
    return out;
  }

  async function launchAll() {
    setError(null);
    setResults(null);
    const built = buildArgs();
    if (typeof built === "string") return setError(built);
    if (built.length === 0) return setError("No tokens to launch.");

    setBusy(true);
    try {
      const res = await ipc.launchMultipleTokensRaydium(built);
      setResults(res);
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
          <h3 className="font-semibold">Multi-token Raydium launch</h3>
          <span className="font-mono text-2xs text-fg-subtle">
            {tokens.length} / 10 tokens
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
          <div className="font-semibold text-accent">
            Multi-Raydium — token + Metaplex metadata in parallel.
          </div>
          <div className="mt-1 font-mono text-2xs text-fg-muted">
            Each token mints with its own dev wallet, optional dev-buy
            preset, and optional co-buyer set. Pool init still happens
            via Raydium's UI after the batch lands (per-token deep-link
            in the results panel). Bundled first-buy is v0.1.59+.
          </div>
        </div>

        {/* Shared defaults */}
        <div className="rounded-lg border border-border bg-bg-raised p-3 space-y-3">
          <div className="font-mono text-2xs uppercase tracking-wider text-fg-subtle">
            shared defaults
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
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
            <div className="grid grid-cols-3 gap-2">
              <SmallField label="Supply">
                <input
                  type="text"
                  value={sharedSupply}
                  onChange={(e) => setSharedSupply(e.target.value)}
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </SmallField>
              <SmallField label="Decimals">
                <input
                  type="text"
                  value={sharedDecimals}
                  onChange={(e) => setSharedDecimals(e.target.value)}
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </SmallField>
              <SmallField label="Dev buy">
                <input
                  type="text"
                  value={sharedDevBuy}
                  onChange={(e) => setSharedDevBuy(e.target.value)}
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </SmallField>
              <SmallField label="LP tokens">
                <input
                  type="text"
                  value={sharedLpTokens}
                  onChange={(e) => setSharedLpTokens(e.target.value)}
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </SmallField>
              <SmallField label="LP SOL">
                <input
                  type="text"
                  value={sharedLpSol}
                  onChange={(e) => setSharedLpSol(e.target.value)}
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </SmallField>
            </div>
          </div>
          <p className="font-mono text-2xs text-fg-subtle">
            Per-token fields below override these defaults. Leave empty to
            inherit.
          </p>
        </div>

        {/* Token list */}
        <div className="space-y-3">
          {tokens.map((t, i) => (
            <RaydiumTokenCard
              key={t.id}
              token={t}
              index={i + 1}
              devWallets={devWallets}
              snipers={snipers}
              sharedDev={sharedDev}
              sharedSupply={sharedSupply}
              sharedDecimals={sharedDecimals}
              sharedLpTokens={sharedLpTokens}
              sharedLpSol={sharedLpSol}
              sharedDevBuy={sharedDevBuy}
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
                    "rounded border px-3 py-2 text-sm space-y-1",
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
                        ✓ minted
                      </span>
                    )}
                  </div>
                  {r.error ? (
                    <div className="font-mono text-2xs text-danger">
                      {r.error}
                    </div>
                  ) : (
                    <div className="font-mono text-2xs text-fg-subtle space-y-0.5">
                      <div>
                        mint:{" "}
                        <a
                          href={`https://solscan.io/token/${r.mint}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline break-all"
                        >
                          {r.mint}
                        </a>
                      </div>
                      <div>
                        tx:{" "}
                        <a
                          href={`https://solscan.io/tx/${r.tx_signature}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline break-all"
                        >
                          {r.tx_signature}
                        </a>
                      </div>
                      <a
                        href={`https://raydium.io/liquidity/create-pool/?baseMint=${r.mint}&quoteMint=So11111111111111111111111111111111111111112`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block mt-1 rounded border border-warn/60 bg-warn/10 px-2 py-0.5 font-mono text-2xs text-warn hover:bg-warn/20"
                      >
                        open Raydium pool creator ↗
                      </a>
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
            launches fire in parallel · pool init via Raydium UI per token
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

interface CardProps {
  token: RaydiumTokenDraft;
  index: number;
  devWallets: WalletInfo[];
  snipers: WalletInfo[];
  sharedDev: string;
  sharedSupply: string;
  sharedDecimals: string;
  sharedLpTokens: string;
  sharedLpSol: string;
  sharedDevBuy: string;
  onPatch: (patch: Partial<RaydiumTokenDraft>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onPickImage: () => void;
  removable: boolean;
  duplicable: boolean;
}

function RaydiumTokenCard({
  token,
  index,
  devWallets,
  snipers,
  sharedDev,
  sharedSupply,
  sharedDecimals,
  sharedLpTokens,
  sharedLpSol,
  sharedDevBuy,
  onPatch,
  onRemove,
  onDuplicate,
  onPickImage,
  removable,
  duplicable,
}: CardProps) {
  const [expanded, setExpanded] = useState(false);

  function toggleCoBuyer(pk: string) {
    const next = token.coBuyerPicked.includes(pk)
      ? token.coBuyerPicked.filter((p) => p !== pk)
      : token.coBuyerPicked.length < 4
        ? [...token.coBuyerPicked, pk]
        : token.coBuyerPicked;
    onPatch({ coBuyerPicked: next });
  }

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
          onChange={(e) => onPatch({ symbol: e.target.value.toUpperCase() })}
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
        <input
          type="text"
          value={token.metadataUri}
          onChange={(e) => onPatch({ metadataUri: e.target.value })}
          placeholder="or paste metadata URI"
          className="flex-1 min-w-0 rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <SmallField label="Dev wallet">
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
        </SmallField>
        <SmallField label="Token supply">
          <input
            type="text"
            value={token.tokenSupply}
            onChange={(e) => onPatch({ tokenSupply: e.target.value })}
            placeholder={`shared (${sharedSupply})`}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </SmallField>
        <SmallField label="Decimals">
          <input
            type="text"
            value={token.tokenDecimals}
            onChange={(e) => onPatch({ tokenDecimals: e.target.value })}
            placeholder={`shared (${sharedDecimals})`}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </SmallField>
        <SmallField label="LP tokens">
          <input
            type="text"
            value={token.lpTokens}
            onChange={(e) => onPatch({ lpTokens: e.target.value })}
            placeholder={`shared (${sharedLpTokens})`}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </SmallField>
        <SmallField label="LP SOL">
          <input
            type="text"
            value={token.lpSol}
            onChange={(e) => onPatch({ lpSol: e.target.value })}
            placeholder={`shared (${sharedLpSol})`}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </SmallField>
        <SmallField label="Dev buy">
          <input
            type="text"
            value={token.devBuySol}
            onChange={(e) => onPatch({ devBuySol: e.target.value })}
            placeholder={`shared (${sharedDevBuy})`}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </SmallField>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={token.burnLp}
          onChange={(e) => onPatch({ burnLp: e.target.checked })}
          className="h-3.5 w-3.5 accent-accent"
        />
        <span className="text-2xs font-semibold">Burn LP tokens</span>
      </label>

      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
      >
        {expanded ? "− hide socials & co-buyers" : "+ socials & co-buyers"}
      </button>
      {expanded && (
        <div className="space-y-2">
          <textarea
            value={token.description}
            onChange={(e) => onPatch({ description: e.target.value })}
            placeholder="description"
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
          <div className="rounded border border-border/60 bg-bg-raised p-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-2xs font-semibold">Co-buyers</span>
              <input
                type="text"
                value={token.coBuyerSol}
                onChange={(e) => onPatch({ coBuyerSol: e.target.value })}
                placeholder="SOL each"
                className="w-24 rounded border border-border bg-bg px-2 py-1 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <span className="font-mono text-2xs text-fg-subtle">
                {token.coBuyerPicked.length}/4
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto rounded border border-border bg-bg divide-y divide-border/40">
              {snipers.map((w) => {
                const checked = token.coBuyerPicked.includes(w.pubkey);
                const disabled = !checked && token.coBuyerPicked.length >= 4;
                return (
                  <label
                    key={w.pubkey}
                    className={cn(
                      "flex items-center gap-3 px-3 py-1 hover:bg-fg/5",
                      disabled && "opacity-40 cursor-not-allowed",
                      !disabled && "cursor-pointer",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleCoBuyer(w.pubkey)}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <span className="font-mono text-2xs text-fg shrink-0 w-20 truncate">
                      {w.label}
                    </span>
                    <span className="font-mono text-2xs text-fg-subtle truncate">
                      {w.pubkey.slice(0, 8)}…{w.pubkey.slice(-6)}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SmallField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
