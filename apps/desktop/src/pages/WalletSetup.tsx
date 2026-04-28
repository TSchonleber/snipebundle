import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  CardBody,
  type WalletWithSecret,
} from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

export function WalletSetup() {
  const nav = useNavigate();
  const [step, setStep] = useState<"form" | "show">("form");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [count, setCount] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [master, setMaster] = useState<WalletWithSecret | null>(null);
  const [snipers, setSnipers] = useState<WalletWithSecret[]>([]);
  const [reveal, setReveal] = useState(false);
  const [acked, setAcked] = useState(false);

  async function handleCreate() {
    setError(null);
    if (pass1.length < 12) {
      setError("Passphrase must be at least 12 characters.");
      return;
    }
    if (pass1 !== pass2) {
      setError("Passphrases don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await ipc.initKeystore({
        passphrase: pass1,
        wallet_count: count,
      });
      setMaster(res.master);
      setSnipers(res.snipers);
      setStep("show");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === "show" && master) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">
          Save these keys now.
        </h1>
        <p className="mt-3 text-fg-muted">
          They will <span className="text-warn font-semibold">not</span> be
          shown again. Print them, write them down, store them in a password
          manager — your call. Anyone with the secret key can drain that
          wallet.
        </p>

        <div className="mt-6 flex items-center gap-3">
          <Button
            variant={reveal ? "secondary" : "primary"}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? "Hide secrets" : "Reveal secrets"}
          </Button>
          <span className="text-xs text-fg-subtle">
            stored encrypted on disk · argon2id + chacha20-poly1305
          </span>
        </div>

        <KeyRow label="MASTER" wallet={master} reveal={reveal} />
        {snipers.map((s) => (
          <KeyRow key={s.pubkey} label={s.label.toUpperCase()} wallet={s} reveal={reveal} />
        ))}

        <Card className="mt-6">
          <CardBody>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={acked}
                onChange={(e) => setAcked(e.target.checked)}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span className="text-sm">
                I have saved these keys somewhere safe. I understand they will
                not be shown again, and that losing them means losing the
                wallets.
              </span>
            </label>
          </CardBody>
        </Card>

        <div className="mt-6 flex justify-end">
          <Button size="lg" disabled={!acked} onClick={() => nav("/funding")}>
            Continue to funding →
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">
        Step 1: Create your keystore.
      </h1>
      <p className="mt-3 text-fg-muted">
        Sets a passphrase that encrypts your wallet keys on this machine.
      </p>

      <Card className="mt-8">
        <CardBody className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-2">
              Passphrase (minimum 12 characters)
            </label>
            <input
              type="password"
              value={pass1}
              onChange={(e) => setPass1(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">
              Confirm passphrase
            </label>
            <input
              type="password"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">
              Sniper wallets ({count})
            </label>
            <input
              type="range"
              min={1}
              max={10}
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value, 10))}
              className="w-full accent-accent"
            />
            <div className="mt-1 flex justify-between text-xs text-fg-subtle font-mono">
              <span>1</span>
              <span>10</span>
            </div>
          </div>
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="mt-6 flex justify-end">
        <Button size="lg" onClick={handleCreate} disabled={busy}>
          {busy ? "Generating…" : "Generate wallets"}
        </Button>
      </div>
    </div>
  );
}

function KeyRow({
  label,
  wallet,
  reveal,
}: {
  label: string;
  wallet: WalletWithSecret;
  reveal: boolean;
}) {
  return (
    <Card className="mt-3">
      <CardBody className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wider text-accent">
            {label}
          </span>
        </div>
        <div>
          <div className="text-xs text-fg-subtle">public</div>
          <code className="block break-all font-mono text-xs text-fg">
            {wallet.pubkey}
          </code>
        </div>
        <div>
          <div className="text-xs text-fg-subtle">secret (one-time)</div>
          <code className="block break-all font-mono text-xs">
            {reveal ? wallet.secret_b58 : "•".repeat(64)}
          </code>
        </div>
      </CardBody>
    </Card>
  );
}
