import { useState } from "react";
import { Button, Card, CardBody, CardHeader } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";
import { WalletPicker } from "../components/WalletPicker";
import { AppNav } from "../components/AppNav";

interface BundleRecord {
  kind: "buy" | "sell";
  bundle_id: string;
  mint: string;
  ts: number;
}

export function Trade() {
  const [mint, setMint] = useState("");
  const [sol, setSol] = useState("0.05");
  const [wallets, setWallets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BundleRecord[]>([]);

  function valid(): string | null {
    if (!mint.trim()) return "Enter a mint address.";
    if (mint.length < 32) return "Mint address looks too short.";
    if (wallets.length === 0) return "Pick at least one wallet.";
    return null;
  }

  async function buy() {
    const v = valid();
    if (v) return setError(v);
    const amt = parseFloat(sol);
    if (!Number.isFinite(amt) || amt <= 0) {
      return setError("SOL amount must be positive.");
    }
    setError(null);
    setBusy(true);
    try {
      const id = await ipc.manualSnipe({
        mint: mint.trim(),
        sol: amt,
        wallet_pubkeys: wallets,
      });
      setHistory((prev) => [
        { kind: "buy", bundle_id: id, mint: mint.trim(), ts: Date.now() },
        ...prev,
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sell() {
    if (!mint.trim()) return setError("Enter a mint address.");
    if (wallets.length === 0) return setError("Pick at least one wallet.");
    setError(null);
    setBusy(true);
    try {
      const id = await ipc.manualDump({
        mint: mint.trim(),
        wallet_pubkeys: wallets,
      });
      setHistory((prev) => [
        { kind: "sell", bundle_id: id, mint: mint.trim(), ts: Date.now() },
        ...prev,
      ]);
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
        <h1 className="text-3xl font-bold tracking-tight">Manual trade</h1>
        <p className="mt-2 text-fg-muted">
          One-click buy or sell on any pump.fun mint with the wallets you pick.
          Up to 5 wallets per bundle.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Trade target</h2>
              </CardHeader>
              <CardBody className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold mb-2">
                    Mint address
                  </label>
                  <input
                    value={mint}
                    onChange={(e) => setMint(e.target.value)}
                    placeholder="paste pump.fun mint address"
                    className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">
                    SOL per wallet (buy only)
                  </label>
                  <input
                    type="text"
                    value={sol}
                    onChange={(e) => setSol(e.target.value)}
                    inputMode="decimal"
                    className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <p className="mt-1 text-xs text-fg-subtle">
                    Sells use 100% of holdings per selected wallet.
                  </p>
                </div>
                {error && (
                  <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                    {error}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    size="lg"
                    onClick={buy}
                    disabled={busy}
                    className="flex-1"
                  >
                    {busy ? "Submitting…" : "BUY"}
                  </Button>
                  <Button
                    size="lg"
                    variant="danger"
                    onClick={sell}
                    disabled={busy}
                    className="flex-1"
                  >
                    {busy ? "Submitting…" : "SELL"}
                  </Button>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <h2 className="font-semibold">Recent bundles</h2>
              </CardHeader>
              <CardBody>
                {history.length === 0 ? (
                  <p className="text-sm text-fg-subtle">
                    No trades this session.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {history.slice(0, 10).map((h) => (
                      <li
                        key={h.bundle_id + h.ts}
                        className="rounded-lg border border-border bg-bg-raised p-3"
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`font-mono text-xs uppercase tracking-wider ${
                              h.kind === "buy" ? "text-accent" : "text-warn"
                            }`}
                          >
                            {h.kind}
                          </span>
                          <span className="text-xs text-fg-subtle">
                            {new Date(h.ts).toLocaleTimeString()}
                          </span>
                        </div>
                        <code className="mt-1 block break-all font-mono text-xs text-fg-muted">
                          {h.mint}
                        </code>
                        <a
                          href={`https://explorer.jito.wtf/bundle/${h.bundle_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block break-all font-mono text-xs text-accent hover:underline"
                        >
                          jito ▸ {h.bundle_id}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>

          <aside>
            <Card>
              <CardHeader>
                <h2 className="font-semibold">Wallets</h2>
              </CardHeader>
              <CardBody>
                <WalletPicker
                  selected={wallets}
                  onChange={setWallets}
                  scope="all"
                  max={5}
                />
              </CardBody>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
