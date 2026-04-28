import { useEffect, useState } from "react";
import { Button, Card, CardBody, CardHeader } from "@snipebundle/ui";
import type { WalletInfo } from "@snipebundle/ui";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc, type LaunchResult } from "../lib/ipc";
import { AppNav } from "../components/AppNav";

export function Launch() {
  const [devWallets, setDevWallets] = useState<WalletInfo[]>([]);
  const [selectedDev, setSelectedDev] = useState<string>("");

  // form
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const [devBuy, setDevBuy] = useState("0.5");

  // import-dev modal
  const [showImport, setShowImport] = useState(false);

  // result
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);

  async function refresh() {
    const [base, devs] = await Promise.all([
      ipc.listWallets(),
      ipc.listDevWallets(),
    ]);
    const master = base.filter((w) => w.label === "master");
    const all = [...master, ...devs];
    setDevWallets(all);
    if (all.length > 0 && !selectedDev) setSelectedDev(all[0].pubkey);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickImage() {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      if (typeof path === "string") setImagePath(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function launch() {
    setError(null);
    if (!selectedDev) return setError("Pick a dev wallet.");
    if (!name.trim() || !symbol.trim()) return setError("Name and symbol required.");
    const amount = parseFloat(devBuy);
    if (!Number.isFinite(amount) || amount < 0) {
      return setError("Dev buy SOL must be a non-negative number.");
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await ipc.launchToken({
        dev_pubkey: selectedDev,
        metadata: {
          name: name.trim(),
          symbol: symbol.trim(),
          description: description.trim(),
          twitter: twitter.trim() || null,
          telegram: telegram.trim() || null,
          website: website.trim() || null,
        },
        metadata_uri: null,
        image_path: imagePath,
        dev_buy_sol: amount,
      });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <AppNav status="stopped" />
      <div className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-3xl font-bold tracking-tight">Launch a token</h1>
        <p className="mt-2 text-fg-muted">
          Atomic single-bundle pump.fun launch. Your dev wallet creates the
          token + makes its opening buy in the same Jito bundle. Defensive
          against third-party snipers.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Token metadata</h2>
              </CardHeader>
              <CardBody className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Name (e.g. Doge Coin)">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={32}
                      className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </Field>
                  <Field label="Symbol (e.g. DOGE)">
                    <input
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                      maxLength={10}
                      className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </Field>
                </div>
                <Field label="Description">
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </Field>
                <Field label="Image">
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={pickImage}
                    >
                      {imagePath ? "Change image" : "Pick image…"}
                    </Button>
                    <span className="truncate text-xs text-fg-subtle">
                      {imagePath ?? "no image selected"}
                    </span>
                  </div>
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Twitter">
                    <input
                      value={twitter}
                      onChange={(e) => setTwitter(e.target.value)}
                      placeholder="https://x.com/…"
                      className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </Field>
                  <Field label="Telegram">
                    <input
                      value={telegram}
                      onChange={(e) => setTelegram(e.target.value)}
                      placeholder="https://t.me/…"
                      className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </Field>
                  <Field label="Website">
                    <input
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      placeholder="https://…"
                      className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </Field>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <h2 className="font-semibold">Opening buy</h2>
              </CardHeader>
              <CardBody>
                <Field label="Dev buy (SOL)">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={devBuy}
                    onChange={(e) => setDevBuy(e.target.value)}
                    className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <p className="mt-1 text-xs text-fg-subtle">
                    The dev wallet's opening buy lands in the same bundle as
                    the create. Set 0 for create-only.
                  </p>
                </Field>
              </CardBody>
            </Card>

            {error && (
              <Card className="border-danger/40">
                <CardBody className="text-sm text-danger">{error}</CardBody>
              </Card>
            )}

            {result && <LaunchResultCard result={result} />}

            <div className="flex justify-end">
              <Button size="lg" onClick={launch} disabled={busy}>
                {busy ? "Launching…" : "Launch token"}
              </Button>
            </div>
          </div>

          <aside className="space-y-3">
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Dev wallet</h2>
              </CardHeader>
              <CardBody>
                {devWallets.length === 0 ? (
                  <p className="text-sm text-fg-subtle">
                    No wallets in keystore yet.
                  </p>
                ) : (
                  <select
                    value={selectedDev}
                    onChange={(e) => setSelectedDev(e.target.value)}
                    className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    {devWallets.map((w) => (
                      <option key={w.pubkey} value={w.pubkey}>
                        {w.label} — {w.pubkey.slice(0, 8)}…
                      </option>
                    ))}
                  </select>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-3 w-full"
                  onClick={() => setShowImport(true)}
                >
                  + Import dev wallet
                </Button>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <h3 className="font-semibold text-sm">Heads up</h3>
                <ul className="mt-2 space-y-1.5 text-xs text-fg-muted list-disc list-inside">
                  <li>Mint pubkey is generated fresh per launch.</li>
                  <li>Dev wallet pays for the create + opening buy.</li>
                  <li>
                    No other wallets are added to this bundle. To buy alongside
                    with multiple wallets, that's the Sniper feature, not this.
                  </li>
                </ul>
              </CardBody>
            </Card>
          </aside>
        </div>

        {showImport && (
          <ImportDevModal
            onClose={() => setShowImport(false)}
            onImported={() => {
              setShowImport(false);
              refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-semibold mb-2">{label}</label>
      {children}
    </div>
  );
}

function LaunchResultCard({ result }: { result: LaunchResult }) {
  return (
    <Card className="shadow-glow">
      <CardHeader>
        <h2 className="font-semibold text-accent">✓ Launch submitted</h2>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <Row label="Mint">
          <code className="break-all font-mono text-xs">{result.mint}</code>
        </Row>
        <Row label="Bundle">
          <a
            href={`https://explorer.jito.wtf/bundle/${result.bundle_id}`}
            target="_blank"
            rel="noreferrer"
            className="break-all font-mono text-xs text-accent hover:underline"
          >
            {result.bundle_id}
          </a>
        </Row>
        <Row label="Dev buy">{result.dev_buy_sol} SOL</Row>
        <Row label="Metadata">
          <a
            href={result.metadata_uri}
            target="_blank"
            rel="noreferrer"
            className="break-all font-mono text-xs text-fg-muted hover:text-fg"
          >
            {result.metadata_uri}
          </a>
        </Row>
        <a
          href={`https://pump.fun/coin/${result.mint}`}
          target="_blank"
          rel="noreferrer"
          className="block pt-2"
        >
          <Button size="md" className="w-full">
            View on pump.fun →
          </Button>
        </a>
      </CardBody>
    </Card>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ImportDevModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [label, setLabel] = useState("dev");
  const [secret, setSecret] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (!secret.trim()) return setError("Paste a base58 secret key.");
    if (!pass) return setError("Enter your keystore passphrase.");
    setBusy(true);
    try {
      await ipc.importDevWallet({
        label: label.trim() || "dev",
        secret_b58: secret.trim(),
        passphrase: pass,
      });
      onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-bg-subtle p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-semibold">Import dev wallet</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Paste a base58-encoded private key. It will be encrypted and stored
          alongside your sniper wallets.
        </p>
        <div className="mt-4 space-y-3">
          <Field label="Label">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          <Field label="Secret key (base58)">
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          <Field label="Keystore passphrase">
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? "Importing…" : "Import"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
