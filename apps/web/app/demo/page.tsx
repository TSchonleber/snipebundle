import Link from "next/link";
import {
  Button,
  Card,
  CardBody,
  MintFeedHeader,
  MintFeedRow,
  StatusBadge,
  type FeedEntry,
  type ActivePosition,
} from "@snipebundle/ui";

const SAMPLE_FEED: FeedEntry[] = [
  {
    mint: "BkXp9mNzD4hQ2sR8WfKv6tEcLpGyJ3UwAVnHm5YbCxQa",
    creator: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    symbol: "DOGGY",
    mc_sol: 12.4,
    socials: true,
    matched: "TargetedDev",
    at_ms: Date.now(),
  },
  {
    mint: "Hk2pQrTuv8NwBcLm3FjZyDxVgKsRtAbJ5oWeYHnUiPq6",
    creator: "FzM7eVHnUjTw1bRkXq8sLpC2vYdJ4uAH3oBxMnP5KeR9",
    symbol: "MOON",
    mc_sol: 28.9,
    socials: true,
    matched: "Auto",
    at_ms: Date.now() - 1500,
  },
  {
    mint: "QrV4tMjL9k7XpWnUeBcK6yHdF2sPxR8oJZmGq3AbY1vN",
    creator: "8vGmKpL3qRtY7XzNcF4BdWeJoHsM2uA9rPkEbT5Vy6Wq",
    symbol: "SCAM",
    mc_sol: 4.2,
    socials: false,
    matched: null,
    at_ms: Date.now() - 3000,
  },
];

const SAMPLE_POSITIONS: ActivePosition[] = [
  {
    mint: "BkXp9mNzD4hQ2sR8WfKv6tEcLpGyJ3UwAVnHm5YbCxQa",
    trigger: "TargetedDev",
    entry_total_sol: 2.5,
    wallet_count: 5,
    bundle_id: "9d3a7f2c1e8b…",
    opened_at_ms: Date.now() - 12000,
    status: "buy live (9d3a7f2c…) — TP/SL/time armed",
    entry_price: 0.0000023,
    last_price: 0.0000031,
    unrealized_pct: 34.8,
  },
];

export default function DemoPage() {
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
            <Button size="sm">Get the real one</Button>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-xs font-mono uppercase tracking-wider text-warn">
          ⚠ DEMO — sample data only · download to use for real
        </div>
        <h1 className="text-3xl font-bold tracking-tight">
          This is what your dashboard looks like.
        </h1>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <Card>
              <CardBody className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <StatusBadge status="live" />
                  <div className="font-mono text-sm text-fg-muted">
                    mints=247 · matched=2 · bundles=1
                  </div>
                </div>
                <Button variant="secondary" size="sm">
                  Pause
                </Button>
              </CardBody>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border bg-bg-raised px-4 py-2 text-xs font-mono uppercase tracking-wider text-fg-subtle">
                Live mint feed
              </div>
              <MintFeedHeader />
              {SAMPLE_FEED.map((e) => (
                <MintFeedRow key={e.mint} entry={e} />
              ))}
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border bg-bg-raised px-4 py-2 text-xs font-mono uppercase tracking-wider text-fg-subtle">
                Active positions
              </div>
              <div className="divide-y divide-border/50">
                {SAMPLE_POSITIONS.map((p) => (
                  <div key={p.mint} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-sm">
                        {p.mint.slice(0, 12)}…
                      </div>
                      <span className="font-mono text-xs uppercase tracking-wider text-accent">
                        {p.trigger}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-4 text-sm text-fg-muted">
                      <span>{p.entry_total_sol} SOL</span>
                      <span>·</span>
                      <span>{p.wallet_count} wallets</span>
                      <span>·</span>
                      <span>
                        {Math.round((Date.now() - p.opened_at_ms) / 1000)}s old
                      </span>
                    </div>
                    <div className="mt-2 font-mono text-xs text-fg-subtle">
                      {p.status}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <aside className="space-y-4">
            <Card>
              <CardBody>
                <h3 className="font-semibold">Mode</h3>
                <p className="mt-1 text-sm text-fg-muted">
                  Auto + Targeted (3 dev wallets)
                </p>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <h3 className="font-semibold">Wallets</h3>
                <ul className="mt-2 space-y-1 font-mono text-xs text-fg-muted">
                  <li>master   1.42 SOL</li>
                  <li>sniper-0 0.50 SOL</li>
                  <li>sniper-1 0.50 SOL</li>
                  <li>sniper-2 0.50 SOL</li>
                  <li>sniper-3 0.50 SOL</li>
                  <li>sniper-4 0.50 SOL</li>
                </ul>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <h3 className="font-semibold">Settings</h3>
                <ul className="mt-2 space-y-1 text-sm text-fg-muted">
                  <li>0.5 SOL per snipe</li>
                  <li>60s max hold</li>
                  <li>+50% take profit</li>
                  <li>-30% stop loss</li>
                </ul>
              </CardBody>
            </Card>
            <Link href="/download" className="block">
              <Button size="lg" className="w-full">
                Download to use
              </Button>
            </Link>
          </aside>
        </div>
      </div>
    </main>
  );
}
