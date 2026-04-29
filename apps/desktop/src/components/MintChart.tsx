import { useState } from "react";
import { cn } from "@snipebundle/ui";

type Source = "dexscreener" | "pumpfun";

const SOURCES: { id: Source; label: string; build: (mint: string) => string }[] = [
  {
    id: "dexscreener",
    label: "dexscreener",
    build: (mint) =>
      `https://dexscreener.com/solana/${mint}?embed=1&theme=dark&info=0&trades=0`,
  },
  {
    id: "pumpfun",
    label: "pump.fun",
    build: (mint) => `https://pump.fun/coin/${mint}`,
  },
];

interface Props {
  mint: string;
  /** Visual height in pixels. Defaults to 360. */
  height?: number;
  /** Called when the user wants to dismiss / close the chart. */
  onClose?: () => void;
}

export function MintChart({ mint, height = 360, onClose }: Props) {
  const [source, setSource] = useState<Source>("dexscreener");
  const trimmed = mint.trim();
  const valid = isValidMint(trimmed);
  const active = SOURCES.find((s) => s.id === source) ?? SOURCES[0];

  return (
    <div className="border border-border bg-bg-subtle/30">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-2xs text-fg-subtle shrink-0">
            chart &gt;
          </span>
          <span className="font-mono text-2xs text-fg-muted truncate">
            {valid ? `${trimmed.slice(0, 8)}..${trimmed.slice(-4)}` : "no mint"}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-0.5">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSource(s.id)}
                className={cn(
                  "font-mono text-2xs px-2 py-0.5 transition-colors",
                  s.id === source
                    ? "text-accent"
                    : "text-fg-subtle hover:text-fg-muted",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          {valid && (
            <a
              href={active.build(trimmed)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-2xs text-fg-subtle hover:text-fg-muted transition-colors"
              title="open in browser"
            >
              ↗
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
      <div style={{ height }} className="relative">
        {valid ? (
          <iframe
            // re-mount on mint or source change so the iframe doesn't carry
            // stale state (and so going from invalid→valid actually loads).
            key={`${source}:${trimmed}`}
            src={active.build(trimmed)}
            title={`chart for ${trimmed}`}
            className="absolute inset-0 h-full w-full bg-bg"
            // Tauri webview won't sandbox these aggressively; allow scripts
            // so the embed is interactive.
            sandbox="allow-scripts allow-same-origin allow-popups"
            loading="lazy"
          />
        ) : (
          <div className="hatch absolute inset-0 flex items-center justify-center font-mono text-2xs text-fg-subtle">
            paste a pump.fun mint to load the chart
          </div>
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
