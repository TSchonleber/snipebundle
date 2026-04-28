import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type TrendingItem,
} from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { AppNav } from "../components/AppNav";

const REFRESH_MS = 30_000;

export function Trending() {
  const nav = useNavigate();
  const [items, setItems] = useState<TrendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "dexscreener" | "geckoterminal">(
    "all",
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await ipc.getTrending();
      setItems(list);
      setLastFetch(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  const filtered = items.filter((i) =>
    filter === "all"
      ? true
      : filter === "dexscreener"
        ? i.source.startsWith("dexscreener")
        : i.source === filter,
  );

  function handleLaunch(item: TrendingItem) {
    const sym = item.symbol ?? "";
    const name = item.name ?? "";
    const params = new URLSearchParams();
    if (sym) params.set("symbol", sym);
    if (name) params.set("name", name);
    nav(`/launch?${params.toString()}`);
  }

  function handleSnipe(item: TrendingItem) {
    if (!item.mint) return;
    nav(`/trade?mint=${encodeURIComponent(item.mint)}`);
  }

  return (
    <div className="min-h-screen">
      <AppNav status="stopped" />
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Trending</h1>
            <p className="mt-2 text-fg-muted text-sm">
              Free aggregated signal feed: DexScreener boosts + Solana pairs and
              GeckoTerminal trending pools. No X API. Refreshes every 30s. Launch a
              token from the symbol or snipe the mint with one click.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-fg-subtle">
              {lastFetch
                ? `updated ${new Date(lastFetch).toLocaleTimeString()}`
                : "—"}
            </span>
            <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          {(
            [
              ["all", "All"],
              ["dexscreener", "DexScreener"],
              ["geckoterminal", "GeckoTerminal"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-md border px-3 py-1 text-xs transition-colors",
                filter === key
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-fg-muted hover:border-border-strong",
              )}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto text-xs text-fg-subtle font-mono self-center">
            {filtered.length} / {items.length}
          </span>
        </div>

        {error && (
          <Card className="mt-4 border-danger/40">
            <CardBody className="text-sm text-danger">{error}</CardBody>
          </Card>
        )}

        <Card className="mt-4 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 border-b border-border bg-bg-raised px-4 py-2 text-xs font-mono uppercase tracking-wider text-fg-subtle">
            <span>Token</span>
            <span className="w-20 text-right">Price</span>
            <span className="w-16 text-right">24h %</span>
            <span className="w-24 text-right">Vol 24h</span>
            <span className="w-24 text-right">MC</span>
            <span className="w-40 text-right">Actions</span>
          </div>
          {filtered.length === 0 && !loading ? (
            <CardBody className="text-center text-fg-subtle">
              No trending tokens — refresh in a few seconds.
            </CardBody>
          ) : (
            <div className="max-h-[68vh] overflow-y-auto">
              {filtered.map((item, idx) => (
                <TrendingRow
                  key={(item.mint ?? "no-mint") + "-" + idx}
                  item={item}
                  onLaunch={() => handleLaunch(item)}
                  onSnipe={() => handleSnipe(item)}
                />
              ))}
            </div>
          )}
        </Card>

        <Card className="mt-4">
          <CardBody className="text-xs text-fg-subtle space-y-1.5">
            <p>
              <strong className="text-fg">Sources</strong>:{" "}
              <code>api.dexscreener.com</code> (search + boosts) +{" "}
              <code>api.geckoterminal.com</code> (trending pools).
              No login, no API key, no X scraping.
            </p>
            <p>
              <strong className="text-fg">Launch</strong> opens the Launch page
              pre-filled with the token's name and symbol — fresh mint, your dev
              wallet, no token reuse.
            </p>
            <p>
              <strong className="text-fg">Snipe</strong> opens the Trade page
              with the existing mint pre-filled so you can buy that specific
              token, not launch a new one.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function TrendingRow({
  item,
  onLaunch,
  onSnipe,
}: {
  item: TrendingItem;
  onLaunch: () => void;
  onSnipe: () => void;
}) {
  const change = item.change_pct_24h;
  const changeStr =
    change == null
      ? "—"
      : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
  const changeColor =
    change == null
      ? "text-fg-subtle"
      : change >= 0
        ? "text-accent"
        : "text-danger";
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 items-center border-b border-border/40 px-4 py-2.5 text-sm hover:bg-bg-subtle/40">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-fg">
            {item.symbol ?? "—"}
          </span>
          {item.name && (
            <span className="text-xs text-fg-muted truncate">
              {item.name}
            </span>
          )}
          <SourceBadge source={item.source} />
          {item.age_minutes != null && item.age_minutes < 60 * 24 && (
            <span className="text-[10px] font-mono text-fg-subtle uppercase tracking-wider">
              {formatAge(item.age_minutes)}
            </span>
          )}
        </div>
        {item.mint && (
          <code className="mt-0.5 block break-all font-mono text-[10px] text-fg-subtle">
            {item.mint}
          </code>
        )}
      </div>
      <span className="w-20 text-right font-mono text-xs tabular-nums">
        {item.price_usd != null ? `$${formatPrice(item.price_usd)}` : "—"}
      </span>
      <span
        className={cn(
          "w-16 text-right font-mono text-xs tabular-nums",
          changeColor,
        )}
      >
        {changeStr}
      </span>
      <span className="w-24 text-right font-mono text-xs tabular-nums text-fg-muted">
        {item.volume_usd_24h != null ? `$${formatBig(item.volume_usd_24h)}` : "—"}
      </span>
      <span className="w-24 text-right font-mono text-xs tabular-nums text-fg-muted">
        {item.market_cap_usd != null ? `$${formatBig(item.market_cap_usd)}` : "—"}
      </span>
      <div className="w-40 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onLaunch}>
          Launch
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onSnipe}
          disabled={!item.mint}
          title={item.mint ? "" : "no mint address available"}
        >
          Snipe
        </Button>
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, { label: string; color: string }> = {
    dexscreener: { label: "DEX", color: "text-fg-muted border-border" },
    "dexscreener-boost": { label: "BOOST", color: "text-warn border-warn/40" },
    geckoterminal: { label: "GECKO", color: "text-accent/70 border-accent/30" },
  };
  const meta = map[source] ?? { label: source, color: "text-fg-subtle border-border" };
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider",
        meta.color,
      )}
    >
      {meta.label}
    </span>
  );
}

function formatPrice(v: number): string {
  if (v >= 1) return v.toFixed(3);
  if (v >= 0.01) return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(6);
  return v.toExponential(2);
}

function formatBig(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

function formatAge(min: number): string {
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / (60 * 24))}d`;
}
