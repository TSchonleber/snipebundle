import { useEffect, useRef, useState } from "react";
import { cn } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { PumpfunChart } from "./PumpfunChart";

const dexscreenerEmbed = (mint: string) =>
  `https://dexscreener.com/solana/${mint}?embed=1&theme=dark&info=0&trades=0`;
const dexscreenerExternal = (mint: string) =>
  `https://dexscreener.com/solana/${mint}`;
const pumpfunExternal = (mint: string) => `https://pump.fun/coin/${mint}`;

type ChartSource = "pumpfun" | "dexscreener";

interface Props {
  mint: string;
  /** Visual height in pixels. Pass undefined / 0 to fill parent. */
  height?: number;
  onClose?: () => void;
  /** When provided, header mint cell becomes an editable input. */
  onMintChange?: (next: string) => void;
}

/**
 * Chart shell with a manual source toggle. We render the user's pick
 * immediately and never tear it out from under them. A background probe
 * to pump.fun runs to set a sensible *default* tab and to surface a
 * 'graduated' hint, but the user always has the final say.
 *
 * Why this is a manual toggle and not pure auto-routing: every iteration
 * of "guess the right source from one indirect signal" introduced a
 * regression for some legitimate mint shape. A pump.fun coin without the
 * vanity 'pump' suffix, a graduated coin DexScreener hasn't yet indexed,
 * a coin pump.fun's frontend-api 404'd because of rate limiting — there
 * are too many failure modes for a magic dispatcher to be reliable in
 * <500ms. With a tab the user is always one click from the right view.
 */
export function MintChart({ mint, height, onClose, onMintChange }: Props) {
  const fill = !height;
  const resolvedHeight = height ?? 360;
  const editable = !!onMintChange;
  const trimmed = mint.trim();
  const valid = isValidMint(trimmed);

  // Auto-default source for this mint — the probe might tweak it, the
  // user can override. Pump-suffix mints are pump.fun bonding-curve
  // coins by convention; everything else gets DexScreener as the
  // initial guess until the probe says otherwise.
  const initialSource: ChartSource = trimmed.toLowerCase().endsWith("pump")
    ? "pumpfun"
    : "dexscreener";
  const [source, setSource] = useState<ChartSource>(initialSource);
  const [userPicked, setUserPicked] = useState(false);
  const [coinHint, setCoinHint] = useState<{
    knownToPumpfun: boolean;
    graduated: boolean;
  } | null>(null);

  // Reset override + auto-source when the mint changes.
  const lastMintRef = useRef(trimmed);
  if (lastMintRef.current !== trimmed) {
    lastMintRef.current = trimmed;
    const next: ChartSource = trimmed.toLowerCase().endsWith("pump")
      ? "pumpfun"
      : "dexscreener";
    if (source !== next) setSource(next);
    if (userPicked) setUserPicked(false);
    if (coinHint) setCoinHint(null);
  }

  // Background probe — never blocks the chart. Updates default source
  // and graduation hint once the answer comes back. Runs only when the
  // user hasn't manually picked.
  useEffect(() => {
    if (!valid) {
      setCoinHint(null);
      return;
    }
    let cancelled = false;
    ipc
      .getPumpfunChart(trimmed)
      .then((data) => {
        if (cancelled) return;
        if (data.coin) {
          const graduated =
            data.coin.complete === true ||
            (data.coin.bonding_curve_progress_pct ?? 0) >= 99;
          setCoinHint({ knownToPumpfun: true, graduated });
          // If the user hasn't overridden, prefer pump.fun for active
          // coins and DexScreener for graduated. Skip the update if the
          // current source already matches — avoids a re-render flicker.
          if (!userPicked) {
            const ideal: ChartSource = graduated ? "dexscreener" : "pumpfun";
            setSource((prev) => (prev === ideal ? prev : ideal));
          }
        } else {
          setCoinHint({ knownToPumpfun: false, graduated: false });
        }
      })
      .catch(() => {
        if (!cancelled) setCoinHint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trimmed, valid, userPicked]);

  function pickSource(next: ChartSource) {
    setUserPicked(true);
    setSource(next);
  }

  return (
    <div
      className={cn(
        "border border-border bg-bg-subtle/30",
        fill && "flex flex-col h-full",
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-mono text-2xs text-fg-subtle shrink-0">
            chart &gt;
          </span>
          {editable ? (
            <input
              value={mint}
              onChange={(e) => onMintChange!(e.target.value)}
              placeholder="paste pump.fun mint to load"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent font-mono text-2xs text-fg-muted focus:text-fg focus:outline-none placeholder:text-fg-subtle/60"
            />
          ) : (
            <span className="font-mono text-2xs text-fg-muted truncate">
              {valid
                ? `${trimmed.slice(0, 8)}..${trimmed.slice(-4)}`
                : "no mint"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {valid && (
            <SourceTab
              label="pump.fun"
              active={source === "pumpfun"}
              onClick={() => pickSource("pumpfun")}
              externalHref={pumpfunExternal(trimmed)}
              badge={
                coinHint?.graduated
                  ? "graduated"
                  : coinHint?.knownToPumpfun === false
                    ? "unknown"
                    : null
              }
            />
          )}
          {valid && (
            <SourceTab
              label="dexscreener"
              active={source === "dexscreener"}
              onClick={() => pickSource("dexscreener")}
              externalHref={dexscreenerExternal(trimmed)}
            />
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="ml-1 font-mono text-2xs text-fg-subtle hover:text-fg-muted px-1"
              title="hide chart"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div
        style={fill ? undefined : { height: resolvedHeight }}
        className={cn("relative", fill && "flex-1 min-h-0")}
      >
        {!valid ? (
          <div className="hatch absolute inset-0 flex items-center justify-center font-mono text-2xs text-fg-subtle">
            paste a pump.fun mint to load the chart
          </div>
        ) : source === "pumpfun" ? (
          <div className="absolute inset-0">
            <PumpfunChart
              key={trimmed}
              mint={trimmed}
              height={resolvedHeight}
            />
          </div>
        ) : (
          <iframe
            key={trimmed}
            src={dexscreenerEmbed(trimmed)}
            title={`chart for ${trimmed}`}
            className="absolute inset-0 h-full w-full bg-bg"
            sandbox="allow-scripts allow-same-origin allow-popups"
            loading="lazy"
          />
        )}
      </div>
    </div>
  );
}

interface SourceTabProps {
  label: string;
  active: boolean;
  onClick: () => void;
  externalHref: string;
  badge?: string | null;
}

function SourceTab({
  label,
  active,
  onClick,
  externalHref,
  badge,
}: SourceTabProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-mono text-2xs border transition-colors",
        active
          ? "border-accent text-accent bg-accent/5"
          : "border-transparent text-fg-subtle hover:text-fg-muted",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="px-2 py-0.5"
        title={`view ${label} chart in-app`}
      >
        {label}
        {badge && (
          <span
            className={cn(
              "ml-1 text-[9px] uppercase tracking-wide",
              active ? "text-accent/70" : "text-fg-subtle/60",
            )}
          >
            {badge}
          </span>
        )}
      </button>
      <a
        href={externalHref}
        target="_blank"
        rel="noreferrer"
        className="px-1.5 py-0.5 border-l border-border/40 hover:text-fg-muted"
        title={`open ${label} in browser`}
      >
        ↗
      </a>
    </span>
  );
}

/**
 * Solana addresses are base58, 32-44 chars. Reject obviously bogus input
 * so we don't waste an iframe load that'd just 404.
 */
function isValidMint(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
