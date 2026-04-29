import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@snipebundle/ui";
import { ipc, type PumpChartData, type PumpTrade } from "../lib/ipc";

const REFRESH_MS = 4_000;

interface Props {
  mint: string;
  height: number;
}

/**
 * Custom SVG line chart for pre-migration pump.fun coins. Polls
 * `/trades/all/<mint>` and plots SOL-per-token over time. Used as the
 * fallback when DexScreener has no pair (which is true for any token still
 * on the bonding curve).
 */
export function PumpfunChart({ mint, height }: Props) {
  const [data, setData] = useState<PumpChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    async function tick() {
      try {
        const next = await ipc.getPumpfunChart(mint);
        if (!mounted) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (mounted) setError(String(e));
      }
      if (mounted) timer = window.setTimeout(tick, REFRESH_MS);
    }
    tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [mint]);

  // ResizeObserver so the SVG width tracks the column.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(200, e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chart = useMemo(
    () => buildChart(data?.trades ?? [], width, height - 56),
    [data, width, height],
  );

  const last = data?.trades.length ? data.trades[data.trades.length - 1] : null;
  const first = data?.trades.length ? data.trades[0] : null;
  const change =
    last && first && first.price_sol > 0
      ? ((last.price_sol - first.price_sol) / first.price_sol) * 100
      : null;
  const coin = data?.coin ?? null;

  return (
    <div ref={wrapRef} className="flex flex-col h-full">
      {/* Stat strip — last price, MC, change %, # trades */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 gap-3 flex-wrap">
        <div className="flex items-center gap-3 font-mono text-2xs">
          {coin?.symbol && (
            <span className="text-fg font-semibold">
              {coin.symbol.toUpperCase()}
            </span>
          )}
          <Stat
            label="price"
            value={last ? formatPrice(last.price_sol) : "—"}
            unit="SOL"
          />
          <Stat
            label="mc"
            value={
              last?.usd_market_cap
                ? formatUsd(last.usd_market_cap)
                : coin?.usd_market_cap
                  ? formatUsd(coin.usd_market_cap)
                  : "—"
            }
          />
          <Stat
            label="24h"
            value={
              change == null
                ? "—"
                : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`
            }
            valueClass={
              change == null
                ? "text-fg-subtle"
                : change >= 0
                  ? "text-accent"
                  : "text-danger"
            }
          />
          <Stat
            label="trades"
            value={String(data?.trades.length ?? 0)}
          />
          {coin?.bonding_curve_progress_pct != null && (
            <Stat
              label="curve"
              value={`${coin.bonding_curve_progress_pct.toFixed(1)}%`}
              valueClass={
                coin.bonding_curve_progress_pct >= 70
                  ? "text-warn"
                  : "text-fg"
              }
            />
          )}
        </div>
        <div className="font-mono text-2xs text-fg-subtle">
          {data?.is_pre_migration === false
            ? "graduated · raydium"
            : "live · pump.fun bonding curve"}
        </div>
      </div>

      {/* SVG canvas */}
      <div className="flex-1 min-h-0 relative bg-bg-subtle/20">
        {error && !data && (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-2xs text-danger">
            {error}
          </div>
        )}
        {!error && (data?.trades.length ?? 0) === 0 && (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-2xs text-fg-subtle">
            no trades yet — waiting for the first buy…
          </div>
        )}
        {chart && (
          <svg
            width={width}
            height={height - 56}
            className="block"
            preserveAspectRatio="none"
          >
            {/* Subtle horizontal gridlines */}
            <g stroke="#1c1d24" strokeWidth="1">
              {[0.25, 0.5, 0.75].map((f) => (
                <line
                  key={f}
                  x1="0"
                  x2={width}
                  y1={(height - 56) * f}
                  y2={(height - 56) * f}
                />
              ))}
            </g>
            {/* Filled area under the line */}
            <path
              d={chart.areaPath}
              fill="rgba(95,227,154,0.10)"
              stroke="none"
            />
            {/* Price line */}
            <path
              d={chart.linePath}
              fill="none"
              stroke="#5fe39a"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Buy / sell trade markers */}
            {chart.markers.map((m, i) => (
              <circle
                key={i}
                cx={m.x}
                cy={m.y}
                r="1.6"
                fill={m.isBuy ? "#5fe39a" : "#ef6f7d"}
                opacity="0.7"
              />
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  valueClass,
}: {
  label: string;
  value: string;
  unit?: string;
  valueClass?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-2xs">
      <span className="text-fg-subtle">{label}</span>
      <span className={cn("text-fg tabular-nums", valueClass)}>{value}</span>
      {unit && <span className="text-fg-subtle text-[9px]">{unit}</span>}
    </span>
  );
}

function buildChart(trades: PumpTrade[], width: number, height: number) {
  if (trades.length < 2) return null;
  const prices = trades.map((t) => t.price_sol).filter((p) => p > 0);
  if (prices.length < 2) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const xs = trades.map((t) => t.timestamp_ms);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xRange = xMax - xMin || 1;

  const project = (t: PumpTrade) => {
    const x = ((t.timestamp_ms - xMin) / xRange) * width;
    // Pad the y-axis a touch so highs and lows aren't pinned to the edge.
    const yPct = (t.price_sol - min) / range;
    const y = height - yPct * height * 0.94 - height * 0.03;
    return { x, y };
  };

  let linePath = "";
  let areaPath = "";
  const markers: { x: number; y: number; isBuy: boolean }[] = [];

  trades.forEach((t, i) => {
    if (t.price_sol <= 0) return;
    const { x, y } = project(t);
    linePath += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    if (i === 0) areaPath += `M ${x.toFixed(1)} ${height}`;
    areaPath += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    if (i === trades.length - 1) areaPath += ` L ${x.toFixed(1)} ${height} Z`;
    if (i % Math.max(1, Math.floor(trades.length / 30)) === 0) {
      markers.push({ x, y, isBuy: t.is_buy });
    }
  });

  return { linePath, areaPath, markers };
}

function formatUsd(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function formatPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(8);
  return v.toExponential(2);
}
