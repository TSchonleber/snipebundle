import Link from "next/link";
import { Button, Card, CardBody } from "@snipebundle/ui";

const REPO = "TSchonleber/snipebundle";

export default function DownloadPage() {
  const releases = `https://github.com/${REPO}/releases/latest`;
  const platforms = [
    {
      name: "Windows",
      detail: "Windows 10 1809+ / 11. WebView2 included.",
      file: "snipebundle-setup.msi",
      url: `${releases}/download/snipebundle-setup.msi`,
      featured: true,
    },
    {
      name: "macOS",
      detail: "Apple Silicon or Intel. macOS 11+.",
      file: "snipebundle.dmg",
      url: `${releases}/download/snipebundle.dmg`,
    },
    {
      name: "Linux",
      detail: "AppImage. Most distros.",
      file: "snipebundle.AppImage",
      url: `${releases}/download/snipebundle.AppImage`,
    },
  ];

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
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl font-bold tracking-tight">Download</h1>
        <p className="mt-3 text-fg-muted">
          One installer. No terminal. Updates ship in-app.
        </p>

        <div className="mt-10 space-y-4">
          {platforms.map((p) => (
            <Card key={p.name} className={p.featured ? "shadow-glow" : ""}>
              <CardBody className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xl font-semibold">{p.name}</div>
                  <div className="mt-1 text-sm text-fg-muted">{p.detail}</div>
                  <div className="mt-2 font-mono text-xs text-fg-subtle">
                    {p.file}
                  </div>
                </div>
                <a href={p.url} target="_blank" rel="noreferrer">
                  <Button size="lg" variant={p.featured ? "primary" : "secondary"}>
                    Download
                  </Button>
                </a>
              </CardBody>
            </Card>
          ))}
        </div>

        <Card className="mt-10">
          <CardBody>
            <h3 className="font-semibold">After install</h3>
            <ol className="mt-3 space-y-2 text-sm text-fg-muted list-decimal list-inside">
              <li>Open snipebundle. Walk through the wizard.</li>
              <li>
                Set a passphrase you'll remember. It encrypts your keys on disk.
              </li>
              <li>
                Save the wallet keys it shows you. They're shown once. Print
                them, write them down, vault them — your choice.
              </li>
              <li>
                Send SOL to the master wallet. The app splits it to your
                snipers.
              </li>
              <li>
                Pick auto mode or paste targeted dev wallets. Hit GO LIVE.
              </li>
            </ol>
          </CardBody>
        </Card>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          Source on{" "}
          <a
            href={`https://github.com/${REPO}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-fg"
          >
            GitHub
          </a>
          . Built locally, runs locally. Never custodial.
        </p>
      </div>
    </main>
  );
}
