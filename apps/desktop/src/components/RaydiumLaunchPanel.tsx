import { useMemo, useState } from "react";
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
  type RaydiumCoBuyer,
  type RaydiumLaunchArgs,
  type RaydiumLaunchResult,
} from "../lib/ipc";

interface Props {
  devWallets: WalletInfo[];
  snipers: WalletInfo[];
}

/**
 * Raydium-direct launch tab. v0.1.57 ships the form + IPC wiring; the
 * on-chain instruction-building stub returns "not yet implemented" and
 * the UI surfaces that error gracefully. v0.1.58+ replaces the stub
 * with real Raydium CPMM pool init + Metaplex metadata + bundled
 * first-buy code, after devnet test infra is up.
 *
 * The full plan is in RAYDIUM_LAUNCH_SPEC.md at the repo root.
 */
export function RaydiumLaunchPanel({ devWallets, snipers }: Props) {
  // Token metadata
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [metadataUri, setMetadataUri] = useState("");

  // Token economics
  const [devPubkey, setDevPubkey] = useState<string>("");
  const [tokenSupply, setTokenSupply] = useState("1000000000");
  const [tokenDecimals, setTokenDecimals] = useState("6");
  const [lpTokens, setLpTokens] = useState("800000000");
  const [lpSol, setLpSol] = useState("1.0");
  const [burnLp, setBurnLp] = useState(true);
  const [devBuySol, setDevBuySol] = useState("0.5");

  // Co-buyers
  const [coBuyerPicked, setCoBuyerPicked] = useState<string[]>([]);
  const [coBuyerAmount, setCoBuyerAmount] = useState("0.1");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RaydiumLaunchResult | null>(null);

  // Compute the implied initial price for the user's reference. They
  // care about this because it sets the opening market cap and the
  // first traders' entry price. Same math the Rust validator uses.
  const impliedPrice = useMemo(() => {
    const t = parseFloat(lpTokens);
    const s = parseFloat(lpSol);
    if (!Number.isFinite(t) || !Number.isFinite(s) || t <= 0) return null;
    return s / t;
  }, [lpTokens, lpSol]);
  const impliedMc = useMemo(() => {
    if (impliedPrice == null) return null;
    const supply = parseFloat(tokenSupply);
    if (!Number.isFinite(supply)) return null;
    return impliedPrice * supply;
  }, [impliedPrice, tokenSupply]);

  async function pickImage() {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
        ],
      });
      if (typeof path === "string") setImagePath(path);
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleCoBuyer(pk: string) {
    if (coBuyerPicked.includes(pk)) {
      setCoBuyerPicked(coBuyerPicked.filter((p) => p !== pk));
    } else if (coBuyerPicked.length < 4) {
      setCoBuyerPicked([...coBuyerPicked, pk]);
    }
    // 5-tx Jito bundle - 1 (pool init) = 4 co-buyer slots max.
  }

  function buildArgs(): RaydiumLaunchArgs | string {
    if (!devPubkey) return "Pick a dev wallet.";
    if (!name.trim() || !symbol.trim()) return "Name and symbol required.";
    if (!metadataUri.trim() && !imagePath) {
      return "Provide a metadata URI OR pick an image (we'll upload metadata for you in v0.1.58).";
    }
    if (!metadataUri.trim()) {
      return "v0.1.57 requires a pre-uploaded metadata URI. v0.1.58+ will handle upload from the picked image.";
    }
    const supply = parseFloat(tokenSupply);
    const decimals = parseInt(tokenDecimals, 10);
    const lpT = parseFloat(lpTokens);
    const lpS = parseFloat(lpSol);
    const buy = parseFloat(devBuySol);
    if (!Number.isFinite(supply) || supply <= 0) return "token_supply must be > 0.";
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 9) {
      return "token_decimals must be 0..=9.";
    }
    if (!Number.isFinite(lpT) || lpT <= 0) return "initial_lp_token_amount must be > 0.";
    if (lpT > supply) return "initial_lp_token_amount can't exceed token_supply.";
    if (!Number.isFinite(lpS) || lpS <= 0) return "initial_lp_sol must be > 0.";
    if (!Number.isFinite(buy) || buy < 0) return "dev_buy_sol must be ≥ 0.";

    const coBuyAmount = parseFloat(coBuyerAmount);
    if (
      coBuyerPicked.length > 0 &&
      (!Number.isFinite(coBuyAmount) || coBuyAmount <= 0)
    ) {
      return "Co-buyer SOL must be > 0.";
    }
    const coBuyers: RaydiumCoBuyer[] = coBuyerPicked.map((pk) => ({
      pubkey: pk,
      sol: coBuyAmount,
    }));

    return {
      dev_pubkey: devPubkey,
      metadata: {
        name: name.trim(),
        symbol: symbol.trim(),
        description: description.trim(),
        twitter: twitter.trim() || null,
        telegram: telegram.trim() || null,
        website: website.trim() || null,
      },
      metadata_uri: metadataUri.trim(),
      token_supply: supply,
      token_decimals: decimals,
      initial_lp_token_amount: lpT,
      initial_lp_sol: lpS,
      burn_lp: burnLp,
      dev_buy_sol: buy,
      co_buyers: coBuyers,
    };
  }

  async function submit() {
    setError(null);
    setResult(null);
    const args = buildArgs();
    if (typeof args === "string") return setError(args);
    setBusy(true);
    try {
      const r = await ipc.launchTokenRaydium(args);
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Spec banner — v0.1.57 ships UI only, on-chain in v0.1.58+ */}
      <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
        <div className="font-semibold text-warn">
          v0.1.57 — UI surface ships, on-chain implementation lands in
          v0.1.58+ (devnet testing required first).
        </div>
        <div className="mt-1 font-mono text-2xs text-fg-muted">
          Submitting will currently return a clear "not yet implemented"
          error. The data model + form are wired so we can iterate the
          UX while the Rust ix-building work lands separately. Full plan
          in RAYDIUM_LAUNCH_SPEC.md.
        </div>
      </div>

      <Card>
        <CardHeader>
          <h3 className="font-semibold">Token metadata</h3>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name"
              maxLength={32}
              className="rounded border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="TICKER"
              maxLength={10}
              className="rounded border border-border bg-bg-raised px-3 py-2 font-mono text-sm uppercase focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={2}
            className="w-full rounded border border-border bg-bg-raised px-3 py-2 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              type="text"
              value={twitter}
              onChange={(e) => setTwitter(e.target.value)}
              placeholder="twitter"
              className="rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="text"
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
              placeholder="telegram"
              className="rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="website"
              className="rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={pickImage}>
              {imagePath ? "Change image" : "Pick image"}
            </Button>
            {imagePath && (
              <span className="font-mono text-2xs text-fg-subtle truncate">
                {imagePath.split("/").pop()}
              </span>
            )}
          </div>
          <div>
            <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
              Metadata URI (IPFS)
            </label>
            <input
              type="text"
              value={metadataUri}
              onChange={(e) => setMetadataUri(e.target.value)}
              placeholder="ipfs://… (v0.1.58+ will upload from image automatically)"
              className="w-full rounded border border-border bg-bg-raised px-3 py-2 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="font-semibold">Token economics & pool</h3>
        </CardHeader>
        <CardBody className="space-y-3">
          <div>
            <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
              Dev wallet (token creator)
            </label>
            <select
              value={devPubkey}
              onChange={(e) => setDevPubkey(e.target.value)}
              className="w-full rounded border border-border bg-bg-raised px-3 py-2 font-mono text-2xs focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">— pick —</option>
              {devWallets.map((w) => (
                <option key={w.pubkey} value={w.pubkey}>
                  {w.label} ({w.pubkey.slice(0, 6)}…)
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Token supply">
              <input
                type="text"
                inputMode="numeric"
                value={tokenSupply}
                onChange={(e) => setTokenSupply(e.target.value)}
                className="w-full rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </Field>
            <Field label="Decimals">
              <input
                type="text"
                inputMode="numeric"
                value={tokenDecimals}
                onChange={(e) => setTokenDecimals(e.target.value)}
                className="w-full rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="LP token amount">
              <input
                type="text"
                inputMode="numeric"
                value={lpTokens}
                onChange={(e) => setLpTokens(e.target.value)}
                className="w-full rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </Field>
            <Field label="LP SOL">
              <input
                type="text"
                inputMode="decimal"
                value={lpSol}
                onChange={(e) => setLpSol(e.target.value)}
                className="w-full rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </Field>
          </div>

          {impliedPrice != null && (
            <div className="rounded border border-border/60 bg-bg-raised px-3 py-2 font-mono text-2xs">
              <span className="text-fg-subtle">implied price: </span>
              <span className="text-fg">
                {impliedPrice.toExponential(2)} SOL/token
              </span>
              {impliedMc != null && (
                <>
                  {"  ·  "}
                  <span className="text-fg-subtle">FDV: </span>
                  <span className="text-fg">
                    {impliedMc.toFixed(2)} SOL ({(impliedMc * 200).toFixed(0)} USD @ $200/SOL)
                  </span>
                </>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={burnLp}
              onChange={(e) => setBurnLp(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span className="text-sm font-semibold">Burn LP tokens</span>
            <span className="font-mono text-2xs text-fg-subtle">
              // locks liquidity forever — strongly recommended
            </span>
          </label>

          <Field label="Dev buy SOL (opening trade)">
            <input
              type="text"
              inputMode="decimal"
              value={devBuySol}
              onChange={(e) => setDevBuySol(e.target.value)}
              className="w-full rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="font-semibold">Co-buyers (max 4)</h3>
        </CardHeader>
        <CardBody className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={coBuyerAmount}
              onChange={(e) => setCoBuyerAmount(e.target.value)}
              placeholder="SOL each"
              className="rounded border border-border bg-bg-raised px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <span className="self-center font-mono text-2xs text-fg-subtle">
              same Jito bundle as the pool init + dev buy
            </span>
          </div>
          <div className="max-h-40 overflow-y-auto rounded border border-border bg-bg divide-y divide-border/40">
            {snipers.map((w) => {
              const checked = coBuyerPicked.includes(w.pubkey);
              const disabled = !checked && coBuyerPicked.length >= 4;
              return (
                <label
                  key={w.pubkey}
                  className={cn(
                    "flex items-center gap-3 px-3 py-1.5 hover:bg-fg/5",
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
        </CardBody>
      </Card>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
          <div className="font-semibold text-accent">✓ Launch landed</div>
          <div className="mt-1 font-mono text-2xs space-y-0.5 text-fg-subtle">
            <div>mint: {result.mint}</div>
            <div>pool: {result.pool_id}</div>
            <div>bundle: {result.bundle_id}</div>
            {result.lp_burn_signature && (
              <div>lp burn: {result.lp_burn_signature}</div>
            )}
          </div>
        </div>
      )}

      <Button onClick={submit} disabled={busy} size="lg">
        {busy ? "Submitting…" : "Launch on Raydium"}
      </Button>
    </div>
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
      <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
