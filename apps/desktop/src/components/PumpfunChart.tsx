import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@snipebundle/ui";
import {
  ipc,
  type PumpChartData,
  type PumpTrade,
  type TrenchCoin,
} from "../lib/ipc";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";
const MAX_TRADES = 600; // ring-buffer cap so the SVG path stays cheap

interface Props {
  mint: string;
  height: number;
}

/**
 * Live SVG line chart for pre-migration pump.fun coins.
 *
 * Architecture:
 *   1. On mount, fetch a one-shot history seed via /trades/all (Rust IPC).
 *      Gives us the last ~200 trades so the chart paints something
 *      immediately.
 *   2. Open a WebSocket directly to PumpPortal (`wss://pumpportal.fun/api/data`)
 *      and send `{method: 'subscribeTokenTrade', keys: [mint]}`. This is the
 *      same channel the Rust engine uses for sniping — the protocol is
 *      documented in pump-portal/pumpdev's data-api page.
 *   3. Each WS trade message gets parsed into the same PumpTrade shape as
 *      the seed and appended to a ring buffer. Chart re-renders on the
 *      next React commit, no polling involved.
 *   4. On mint change or unmount, the WS is closed cleanly.
 *
 * Falls back to the seed-only view if the WS can't connect (e.g. user is
 * offline or PumpPortal is down).
 */
export function PumpfunChart({ mint, height }: Props) {
  const [coin, setCoin] = useState<TrenchCoin | null>(null);
  const [trades, setTrades] = useState<PumpTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  // Seed history once per mint via REST. We don't poll this — the WS keeps
  // the buffer fresh. Only re-fires when the user pastes a different mint.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setTrades([]);
    setCoin(null);
    ipc
      .getPumpfunChart(mint)
      .then((data: PumpChartData) => {
        if (cancelled) return;
        setCoin(data.coin);
        setTrades(data.trades);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [mint]);

  // Live trade stream via PumpPortal WS.
  useEffect(() => {
    if (!mint) return;
    let ws: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: number | undefined;

    function connect() {
      if (cancelled) return;
      try {
        ws = new WebSocket(PUMPPORTAL_WS);
      } catch (e) {
        setError(String(e));
        return;
      }
      ws.addEventListener("open", () => {
        if (cancelled) return;
        setStreaming(true);
        ws?.send(
          JSON.stringify({
            method: "subscribeTokenTrade",
            keys: [mint],
          }),
        );
      });
      ws.addEventListener("message", (ev) => {
        if (cancelled) return;
        const trade = parseTradeEvent(mint, ev.data);
        if (trade) appendTrade(trade);
      });
      ws.addEventListener("close", () => {
        if (cancelled) return;
        setStreaming(false);
        // Reconnect with a small backoff so a flaky network doesn't burn
        // the chart permanently.
        reconnectTimer = window.setTimeout(connect, 1500);
      });
      ws.addEventListener("error", () => {
        // Let close handler drive the reconnect; just log it.
        setStreaming(false);
      });
    }

    function appendTrade(t: PumpTrade) {
      setTrades((prev) => {
        // Drop dupes on signature when the seed and the WS overlap on the
        // same trade (the WS sometimes replays a recent one on subscribe).
        if (
          prev.length > 0 &&
          prev[prev.length - 1].timestamp_ms === t.timestamp_ms &&
          prev[prev.length - 1].user === t.user
        ) {
          return prev;
        }
        const next = [...prev, t];
        return next.length > MAX_TRADES
          ? next.slice(next.length - MAX_TRADES)
          : next;
      });
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.send(
          JSON.stringify({
            method: "unsubscribeTokenTrade",
            keys: [mint],
          }),
        );
      } catch {
        /* socket may already be closing */
      }
      ws?.close();
      setStreaming(false);
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
    () => buildChart(trades, width, height - 56),
    [trades, width, height],
  );

  const last = trades.length ? trades[trades.length - 1] : null;
  const first = trades.length ? trades[0] : null;
  const change =
    last && first && first.price_sol > 0
      ? ((last.price_sol - first.price_sol) / first.price_sol) * 100
      : null;

  return (
    <div ref={wrapRef} className="flex flex-col h-full">
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
              last?.usd_market_cap
                ? formatUsd(last.usd_market_cap)
                : coin?.usd_market_cap
                  ? formatUsd(coin.usd_market_cap)
                  : "—"
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
        <StreamPulse on={streaming} />
      </div>

      {/* SVG canvas */}
      <div className="flex-1 min-h-0 relative bg-bg-subtle/20">
        {error && trades.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-2xs text-danger">
            {error}
          </div>
        )}
        {!error && trades.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-2xs text-fg-subtle">
            {streaming
              ? "subscribed · waiting for first trade…"
              : "loading trades…"}
          </div>
        )}
        {chart && (
          <svg
            width={width}
            height={height - 56}
            className="block"
            preserveAspectRatio="none"
          >
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
            <path
              d={chart.areaPath}
              fill="rgba(95,227,154,0.10)"
              stroke="none"
            />
            <path
              d={chart.linePath}
              fill="none"
              stroke="#5fe39a"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
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

function StreamPulse({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-2xs",
        on ? "text-accent" : "text-fg-subtle",
      )}
      title={
        on
          ? "live · subscribed to pumpportal websocket"
          : "reconnecting to pumpportal websocket…"
      }
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
      {on ? "live" : "reconnecting…"}
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
 * Parse a single PumpPortal trade message into the PumpTrade shape we
 * already render in the chart. Returns null for heartbeats, ack messages,
 * and trades for other mints (the WS server occasionally bleeds those
 * across subscriptions).
 */
function parseTradeEvent(targetMint: string, raw: string): PumpTrade | null {
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v?.mint !== targetMint) return null;
  // Lamports → SOL, raw token units → tokens (pump.fun uses 6 decimals).
  const sol_amount =
    typeof v.solAmount === "number" ? v.solAmount : Number(v.solAmount) || 0;
  const token_amount =
    typeof v.tokenAmount === "number"
      ? v.tokenAmount
      : Number(v.tokenAmount) || 0;
  // Curve state gives the most accurate post-trade price.
  const v_sol = Number(v.vSolInBondingCurve);
  const v_tok = Number(v.vTokensInBondingCurve);
  const price_sol =
    Number.isFinite(v_sol) && Number.isFinite(v_tok) && v_tok > 0
      ? v_sol / v_tok
      : token_amount > 0
        ? sol_amount / token_amount
        : 0;
  const usd_market_cap =
    typeof v.usdMarketCap === "number"
      ? v.usdMarketCap
      : typeof v.marketCapUsd === "number"
        ? v.marketCapUsd
        : null;
  return {
    timestamp_ms: Date.now(),
    is_buy: String(v.txType ?? "").toLowerCase() === "buy",
    sol_amount,
    token_amount,
    price_sol,
    usd_market_cap,
    user: v.traderPublicKey ?? v.trader ?? null,
  };
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
    linePath +=
      i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
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
