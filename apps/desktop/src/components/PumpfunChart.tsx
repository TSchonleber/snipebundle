import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { cn } from "@snipebundle/ui";
import {
  ipc,
  type PumpChartData,
  type PumpTrade,
  type TrenchCoin,
} from "../lib/ipc";
import {
  onStreamEvent,
  subscribeTokenTrade,
  type TokenTradeEvent,
} from "../lib/pumpportal-stream";

interface Props {
  mint: string;
  height: number;
}

type IntervalKey = "1s" | "5s" | "30s" | "1m" | "5m";
const INTERVALS: { key: IntervalKey; label: string; seconds: number }[] = [
  { key: "1s", label: "1s", seconds: 1 },
  { key: "5s", label: "5s", seconds: 5 },
  { key: "30s", label: "30s", seconds: 30 },
  { key: "1m", label: "1m", seconds: 60 },
  { key: "5m", label: "5m", seconds: 300 },
];

interface Candle {
  time: number; // unix seconds, bucketed
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // SOL
  buys: number;
  sells: number;
}

/**
 * Real OHLC candlestick chart for pump.fun coins, regardless of how many
 * trades have happened. Powered by TradingView's lightweight-charts (free,
 * battle-tested) instead of hand-rolling SVG.
 *
 *   - Seed: pump.fun /trades/all/<mint> (last ~200 trades) bucketed into
 *     candles at the chosen interval.
 *   - Live: PumpPortal WS subscribeTokenTrade — every trade updates the
 *     current bucket (or rolls a new one if the timestamp crosses the
 *     interval boundary).
 *   - Volume histogram pinned to the bottom 25% of the chart.
 */
export function PumpfunChart({ mint, height }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [coin, setCoin] = useState<TrenchCoin | null>(null);
  const [trades, setTrades] = useState<PumpTrade[]>([]);
  const [intervalKey, setIntervalKey] = useState<IntervalKey>("5s");
  // Until the user picks an interval explicitly, snap to whatever bucket
  // size produces a useful candlestick view for the trade density we
  // actually have. 1s on a coin with 8 trades over 3 minutes makes every
  // candle a flat horizontal line; 1m on a 30-second-old launch gives one
  // giant blob. Auto-fit avoids both.
  const [intervalAuto, setIntervalAuto] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const intervalSeconds =
    INTERVALS.find((i) => i.key === intervalKey)?.seconds ?? 5;

  // ---------------- Seed (REST) -----------------
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    ipc
      .getPumpfunChart(mint)
      .then((data: PumpChartData) => {
        if (cancelled) return;
        setCoin(data.coin);
        setTrades(data.trades);
      })
      .catch(() => {
        if (cancelled) return;
        setTrades([]);
        setCoin(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mint]);

  // ---------------- Live (WS) -----------------
  useEffect(() => {
    if (!mint) return;
    const offSub = subscribeTokenTrade(mint);
    const offEv = onStreamEvent((ev) => {
      if (ev.kind !== "token_trade") return;
      const tev = ev as TokenTradeEvent;
      if (tev.mint !== mint) return;
      setStreaming(true);
      const price =
        tev.v_sol_in_curve != null &&
        tev.v_tokens_in_curve != null &&
        tev.v_tokens_in_curve > 0
          ? tev.v_sol_in_curve / tev.v_tokens_in_curve
          : tev.token_amount > 0
            ? tev.sol_amount / tev.token_amount
            : 0;
      const trade: PumpTrade = {
        timestamp_ms: tev.received_at_ms,
        is_buy: tev.tx_type === "buy",
        sol_amount: tev.sol_amount,
        token_amount: tev.token_amount,
        price_sol: price,
        usd_market_cap: null,
        user: tev.trader ?? null,
      };
      setTrades((prev) => {
        const next = [...prev, trade];
        return next.length > 1500 ? next.slice(next.length - 1500) : next;
      });
    });
    return () => {
      offEv();
      offSub();
    };
  }, [mint]);

  // ---------------- Auto-pick interval based on data density -----------------
  useEffect(() => {
    if (!intervalAuto || trades.length < 2) return;
    const span =
      (trades[trades.length - 1].timestamp_ms - trades[0].timestamp_ms) / 1000;
    let next: IntervalKey;
    if (span < 60) next = "1s";
    else if (span < 600) next = "5s";
    else if (span < 1800) next = "30s";
    else if (span < 7200) next = "1m";
    else next = "5m";
    setIntervalKey((prev) => (prev === next ? prev : next));
  }, [trades, intervalAuto]);

  // ---------------- Bucket trades → candles -----------------
  const candles = useMemo<Candle[]>(
    () => bucketTrades(trades, intervalSeconds),
    [trades, intervalSeconds],
  );

  // ---------------- Mount + size lightweight-charts -----------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "#0e0f12" },
        textColor: "#9094a0",
        fontSize: 11,
        fontFamily:
          "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "#1c1d24" },
        horzLines: { color: "#1c1d24" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        borderColor: "#1c1d24",
        // Keep candles at a fixed visual width so a chart with 8 trades
        // doesn't blow up to 1/8-of-the-screen-wide bars. Lightweight-
        // charts will scroll horizontally instead — same UX as GMGN.
        barSpacing: 8,
        minBarSpacing: 2,
        rightOffset: 6,
      },
      rightPriceScale: {
        borderColor: "#1c1d24",
        scaleMargins: { top: 0.05, bottom: 0.18 },
      },
      crosshair: {
        vertLine: { color: "#2a2c36" },
        horzLine: { color: "#2a2c36" },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#5fe39a",
      downColor: "#ef6f7d",
      wickUpColor: "#5fe39a",
      wickDownColor: "#ef6f7d",
      borderVisible: false,
      priceFormat: {
        type: "price",
        precision: 9,
        minMove: 0.000000001,
      },
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      // Volume ribbon ~12% tall (was 22%), pinned to the bottom — matches
      // GMGN proportions where the price action gets the lion's share.
      scaleMargins: { top: 0.88, bottom: 0 },
      borderVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Push candle data into the chart whenever it changes.
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries) return;
    if (candles.length === 0) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
      return;
    }
    candleSeries.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volumeSeries.setData(
      candles.map((c) => ({
        time: c.time as Time,
        value: c.volume,
        color:
          c.close >= c.open
            ? "rgba(95, 227, 154, 0.4)"
            : "rgba(239, 111, 125, 0.4)",
      })),
    );
    // Don't fitContent — that re-stretches all candles to fill the
    // viewport and produces the giant-bars effect on sparse data. Scroll
    // to the right edge so live trades stay visible at the configured
    // bar width instead.
    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles]);

  // Stat strip at the top
  const last = trades.length ? trades[trades.length - 1] : null;
  const first = trades.length ? trades[0] : null;
  const change =
    last && first && first.price_sol > 0
      ? ((last.price_sol - first.price_sol) / first.price_sol) * 100
      : null;

  return (
    <div className="flex flex-col h-full">
      {/* Stat strip */}
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
              coin?.usd_market_cap ? formatUsd(coin.usd_market_cap) : "—"
            }
          />
          <Stat
            label="window"
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
          <Stat label="trades" value={String(trades.length)} />
          <Stat label="candles" value={String(candles.length)} />
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
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0.5">
            {INTERVALS.map((iv) => (
              <button
                key={iv.key}
                type="button"
                onClick={() => {
                  setIntervalAuto(false);
                  setIntervalKey(iv.key);
                }}
                className={cn(
                  "font-mono text-2xs px-2 py-0.5 transition-colors border",
                  iv.key === intervalKey
                    ? "border-accent text-accent bg-accent/5"
                    : "border-transparent text-fg-subtle hover:text-fg-muted",
                )}
              >
                {iv.label}
              </button>
            ))}
          </div>
          <StreamPulse on={streaming} />
        </div>
      </div>

      {/* Chart canvas */}
      <div className="flex-1 min-h-0 relative">
        {trades.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-2xs text-fg-subtle pointer-events-none">
            {streaming
              ? "subscribed · waiting for first trade…"
              : "loading trades…"}
          </div>
        )}
        <div
          ref={containerRef}
          className="absolute inset-0"
          style={{ minHeight: Math.max(0, height - 40) }}
        />
      </div>
    </div>
  );
}

function StreamPulse({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-2xs",
        on ? "text-accent" : "text-fg-subtle",
      )}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {on && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
        )}
        <span
          className={cn(
            "relative inline-flex h-1.5 w-1.5 rounded-full",
            on ? "bg-accent" : "bg-fg-subtle/60",
          )}
        />
      </span>
      {on ? "live" : "buffering…"}
    </span>
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

/**
 * Bucket trades into OHLC candles. lightweight-charts requires `time` in
 * unix seconds, ascending, with no duplicates — we ensure both. Each
 * bucket's volume is the sum of trade SOL amounts; buys/sells track count
 * for color cues even though we color the whole candle by close vs open.
 */
function bucketTrades(trades: PumpTrade[], intervalSec: number): Candle[] {
  if (trades.length === 0) return [];
  const buckets = new Map<number, Candle>();
  // Sort by ts ascending — pump.fun /trades/all returns newest-first; the
  // Rust side reverses it, but be defensive.
  const sorted = [...trades].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  for (const t of sorted) {
    if (t.price_sol <= 0) continue;
    const bucketSec =
      Math.floor(t.timestamp_ms / 1000 / intervalSec) * intervalSec;
    const existing = buckets.get(bucketSec);
    if (!existing) {
      buckets.set(bucketSec, {
        time: bucketSec,
        open: t.price_sol,
        high: t.price_sol,
        low: t.price_sol,
        close: t.price_sol,
        volume: t.sol_amount,
        buys: t.is_buy ? 1 : 0,
        sells: t.is_buy ? 0 : 1,
      });
    } else {
      existing.high = Math.max(existing.high, t.price_sol);
      existing.low = Math.min(existing.low, t.price_sol);
      existing.close = t.price_sol;
      existing.volume += t.sol_amount;
      if (t.is_buy) existing.buys++;
      else existing.sells++;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
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
