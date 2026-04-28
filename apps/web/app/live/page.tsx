"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  CardBody,
  MintFeedHeader,
  MintFeedRow,
  type FeedEntry,
  type PumpportalNewToken,
} from "@snipebundle/ui";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";
const MAX_FEED = 100;

export default function LivePage() {
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">(
    "connecting",
  );
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | undefined;

    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(PUMPPORTAL_WS);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        setStatus("live");
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      });

      ws.addEventListener("message", (e) => {
        try {
          const v: PumpportalNewToken = JSON.parse(e.data as string);
          if (!v.mint) return;
          const entry: FeedEntry = {
            mint: v.mint,
            creator: v.traderPublicKey ?? v.creator ?? "?",
            symbol: v.symbol ?? null,
            mc_sol: v.marketCapSol ?? v.vSolInBondingCurve ?? null,
            socials: !!(v.twitter || v.telegram || v.website),
            matched: null,
            at_ms: Date.now(),
          };
          setFeed((prev) => [entry, ...prev].slice(0, MAX_FEED));
        } catch {}
      });

      ws.addEventListener("close", () => {
        setStatus("closed");
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      });

      ws.addEventListener("error", () => {
        ws.close();
      });
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link
            href="/"
            className="font-mono text-sm font-bold tracking-wider"
          >
            ▶ snipebundle
          </Link>
          <Link href="/download">
            <Button size="sm">Download</Button>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Live pump.fun mints
            </h1>
            <p className="mt-2 text-fg-muted">
              Direct firehose from PumpPortal. Public data. No login. Same feed
              the desktop app uses to decide what to snipe.
            </p>
          </div>
          <div className="font-mono text-xs uppercase tracking-wider text-fg-subtle">
            <span
              className={
                status === "live"
                  ? "text-accent"
                  : status === "connecting"
                    ? "text-warn"
                    : "text-danger"
              }
            >
              ● {status}
            </span>{" "}
            · {feed.length} / {MAX_FEED}
          </div>
        </div>

        <Card className="overflow-hidden">
          <MintFeedHeader />
          <div className="max-h-[70vh] overflow-y-auto">
            {feed.length === 0 ? (
              <div className="px-3 py-8 text-center text-fg-subtle">
                Waiting for the next mint…
              </div>
            ) : (
              feed.map((e) => <MintFeedRow key={e.mint + e.at_ms} entry={e} />)
            )}
          </div>
        </Card>

        <Card className="mt-6">
          <CardBody>
            <p className="text-sm text-fg-muted">
              Want to actually snipe these?{" "}
              <Link href="/download" className="text-accent hover:underline">
                Download snipebundle
              </Link>{" "}
              and configure your filters. The desktop app fires Jito bundles the
              moment a match hits the feed.
            </p>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
