import Link from "next/link";
import { Button, Card, CardBody, StatusBadge } from "@snipebundle/ui";

export default function HomePage() {
  return (
    <main className="min-h-screen">
      <Nav />
      <Hero />
      <FeatureGrid />
      <HowItWorks />
      <Cta />
      <Footer />
    </main>
  );
}

function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-border/60 bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="font-mono text-sm font-bold tracking-wider text-fg"
        >
          ▶ snipebundle
        </Link>
        <div className="flex items-center gap-6 text-sm text-fg-muted">
          <Link href="/live" className="hover:text-fg">
            Live mints
          </Link>
          <Link href="/demo" className="hover:text-fg">
            Demo
          </Link>
          <Link href="/docs" className="hover:text-fg">
            Docs
          </Link>
          <Link href="/download">
            <Button size="sm">Download</Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,242,160,0.08),transparent_60%)]" />
      <div className="relative mx-auto max-w-6xl px-6 py-24 sm:py-32">
        <div className="flex flex-col items-start gap-6">
          <StatusBadge status="live" />
          <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
            Snipe pump.fun launches.
            <br />
            <span className="text-accent">Same block as the dev.</span>
          </h1>
          <p className="max-w-2xl text-lg text-fg-muted">
            A desktop sniper for pump.fun. Watch any dev wallet, fire Jito
            bundles the moment they mint, exit in 60 seconds. Runs on your
            machine. Your keys, your funds, never ours.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href="/download">
              <Button size="lg">Download for Windows</Button>
            </Link>
            <Link href="/live">
              <Button size="lg" variant="secondary">
                Watch live mints →
              </Button>
            </Link>
          </div>
          <p className="mt-4 text-xs font-mono text-fg-subtle">
            also available for macOS · Linux · open source on GitHub
          </p>
        </div>
      </div>
    </section>
  );
}

function FeatureGrid() {
  const features = [
    {
      title: "Same-block sniping",
      body: "Jito bundles drop your buy in the same block as the dev's mint. No race against retail.",
    },
    {
      title: "Targeted dev tracking",
      body: "Paste a list of dev wallets you trust. Snipe instantly when any of them launches.",
    },
    {
      title: "Auto-filter mode",
      body: "Filter every new mint by dev buy %, socials, market cap. Set it and forget it.",
    },
    {
      title: "60-second exits",
      body: "Time-based exit by default. Take profit, stop loss, hold time — all configurable.",
    },
    {
      title: "Self-custody",
      body: "Keys live encrypted on your disk. Argon2id + ChaCha20-Poly1305. We never see them.",
    },
    {
      title: "Multi-wallet bundles",
      body: "Up to 10 sniper wallets per session. Spread your size, dodge anti-sniper penalties.",
    },
  ];
  return (
    <section className="border-y border-border/60 bg-bg-subtle">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-12 text-3xl font-bold tracking-tight">
          Everything a sniper needs.
          <br />
          <span className="text-fg-muted">Nothing it doesn't.</span>
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <Card key={f.title}>
              <CardBody>
                <div className="mb-2 font-mono text-xs uppercase tracking-wider text-accent">
                  ▸ {f.title}
                </div>
                <p className="text-fg-muted">{f.body}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      t: "Install",
      b: "Download the installer for your OS. One double-click. No terminal.",
    },
    {
      n: "02",
      t: "Generate wallets",
      b: "Set a passphrase, pick how many sniper wallets, save the keys. Encrypted on disk.",
    },
    {
      n: "03",
      t: "Fund",
      b: "Send SOL from your CEX or main wallet. App fan-outs it to snipers in one batch.",
    },
    {
      n: "04",
      t: "Go live",
      b: "Pick auto mode or paste targeted devs. Hit GO LIVE. Watch the feed.",
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <h2 className="mb-12 text-3xl font-bold tracking-tight">
        From install to live in under 5 minutes.
      </h2>
      <ol className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <li
            key={s.n}
            className="rounded-xl border border-border bg-bg-subtle p-6"
          >
            <div className="font-mono text-sm text-accent">{s.n}</div>
            <div className="mt-3 text-lg font-semibold">{s.t}</div>
            <p className="mt-2 text-sm text-fg-muted">{s.b}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Cta() {
  return (
    <section className="border-t border-border/60 bg-bg-subtle">
      <div className="mx-auto max-w-3xl px-6 py-24 text-center">
        <h2 className="text-4xl font-bold tracking-tight">
          Stop missing launches.
        </h2>
        <p className="mt-4 text-lg text-fg-muted">
          Download once, configure once, snipe forever.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/download">
            <Button size="lg">Get snipebundle</Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-8 text-sm text-fg-subtle sm:flex-row sm:justify-between">
        <span>© snipebundle. Self-custody only. Never trades on your behalf.</span>
        <div className="flex gap-6">
          <Link href="/docs" className="hover:text-fg">
            Docs
          </Link>
          <Link href="/disclaimer" className="hover:text-fg">
            Disclaimer
          </Link>
          <a
            href="https://github.com/TSchonleber/snipebundle"
            target="_blank"
            rel="noreferrer"
            className="hover:text-fg"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
