import { useState } from "react";
import { cn } from "@snipebundle/ui";

interface Props {
  src?: string | null;
  symbol?: string | null;
  size?: number;
  className?: string;
}

/**
 * Token icon with graceful fallback. Tries the provided URL; on error or
 * when src is missing, renders a 2-letter symbol stub on a flat tile.
 * Used in Trending rows + the chart-page sidebar mini-tracker.
 */
export function TokenIcon({ src, symbol, size = 28, className }: Props) {
  const [errored, setErrored] = useState(false);
  const showImg = src && !errored;
  const initials = (symbol ?? "?").slice(0, 2).toUpperCase();

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden bg-bg-raised border border-border font-mono text-[10px] text-fg-subtle",
        className,
      )}
      style={{ width: size, height: size, borderRadius: 4 }}
    >
      {showImg ? (
        <img
          src={src}
          alt={symbol ?? "token"}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}
