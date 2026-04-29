import { useEffect, useState } from "react";
import { cn } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { PumpfunChart } from "./PumpfunChart";

const dexscreenerEmbed = (mint: string) =>
  `https://dexscreener.com/solana/${mint}?embed=1&theme=dark&info=0&trades=0`;
const dexscreenerExternal = (mint: string) =>
  `https://dexscreener.com/solana/${mint}`;
const pumpfunExternal = (mint: string) => `https://pump.fun/coin/${mint}`;

interface Props {
  mint: string;
  /**
   * Visual height in pixels. Pass `undefined` (or 0) to fill the parent —
   * the dedicated /chart page uses this to take the full screen.
   */
  height?: number;
  /** Called when the user wants to dismiss / close the chart. */
  onClose?: () => void;
  /**
   * If provided, the header's mint cell becomes an editable input — the
   * user can paste a new mint right on the chart instead of hunting for
   * the wallet panel's mint field. Pages that own a single shared mint
   * pass their setter here.
   */
  onMintChange?: (next: string) => void;
}

export function MintChart({ mint, height, onClose, onMintChange }: Props) {
  const fill = !height;
  const resolvedHeight = height ?? 360;
  const editable = !!onMintChange;
  const trimmed = mint.trim();
  const valid = isValidMint(trimmed);

  // Decide chart source by mint shape, no roundtrip required:
  //   - 'pump' vanity suffix → PumpfunChart (pre-migration trades + WS)
  //   - anything else → DexScreener iframe
  // The previous probe-then-route approach added a 500-1500ms delay
  // before any chart rendered, plus a duplicate /coins call (PumpfunChart
  // fetches its own seed). For pump-suffix mints, even a graduated coin
  // works fine in PumpfunChart (the historical pre-migration trades show
  // up immediately, and the dexscreener ↗ link in the header is one click
  // away if the user wants Raydium candles).
  const [usePumpChart, setUsePumpChart] = useState<boolean | null>(null);
  useEffect(() => {
    if (!valid) {
      setUsePumpChart(null);
      return;
    }
    setUsePumpChart(trimmed.toLowerCase().endsWith("pump"));
  }, [trimmed, valid]);

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
        <div className="flex items-center gap-3 shrink-0">
          {/* Open in external browser. pump.fun blocks iframe embedding
              via X-Frame-Options:DENY, so we link out instead of trying
              to render it inside our app. DexScreener supports embedding
              and is what powers the live iframe below. */}
          {valid && (
            <a
              href={pumpfunExternal(trimmed)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted transition-colors"
              title="open on pump.fun (external browser)"
            >
              pump.fun ↗
            </a>
          )}
          {valid && (
            <a
              href={dexscreenerExternal(trimmed)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted transition-colors"
              title="open on dexscreener (external browser)"
            >
              dexscreener ↗
            </a>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted"
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
        ) : usePumpChart === null ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-2xs text-fg-subtle">
            resolving pair…
          </div>
        ) : usePumpChart ? (
          // Pre-migration pump.fun coin — DexScreener has no pair yet.
          // Render our own SVG chart from pump.fun's trades feed.
          <div className="absolute inset-0">
            <PumpfunChart mint={trimmed} height={resolvedHeight} />
          </div>
        ) : (
          <iframe
            // Re-mount on mint change so the iframe doesn't carry stale
            // state (and so going from invalid→valid actually loads).
            key={trimmed}
            src={dexscreenerEmbed(trimmed)}
            title={`chart for ${trimmed}`}
            className="absolute inset-0 h-full w-full bg-bg"
            // Tauri webview won't sandbox these aggressively; allow
            // scripts so the embed is interactive.
            sandbox="allow-scripts allow-same-origin allow-popups"
            loading="lazy"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Solana addresses are base58, 32-44 chars. Reject obviously bogus input
 * (whitespace, too short/long) so we don't waste an iframe load that'd just
 * 404 inside DexScreener.
 */
function isValidMint(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
