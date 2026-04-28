import { useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

interface Props {
  wallets: WalletInfo[];
  onChanged: () => void;
}

type Mode = null | "add" | "delete";

export function WalletManager({ wallets, onChanged }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [target, setTarget] = useState<WalletInfo | null>(null);
  const [pass, setPass] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{
    label: string;
    pubkey: string;
    secret_b58: string;
  } | null>(null);

  async function doAdd() {
    setError(null);
    if (pass.length < 12) return setError("Enter your keystore passphrase.");
    setBusy(true);
    try {
      const w = await ipc.addSniperWallet(pass, label.trim() || undefined);
      setRevealed(w);
      setLabel("");
      setPass("");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!target) return;
    setError(null);
    if (pass.length < 12) return setError("Enter your keystore passphrase.");
    setBusy(true);
    try {
      await ipc.deleteWallet(target.pubkey, pass);
      setMode(null);
      setTarget(null);
      setPass("");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Manage wallets</h3>
          <Button
            size="sm"
            onClick={() => {
              setMode("add");
              setError(null);
              setRevealed(null);
            }}
            disabled={mode === "add"}
          >
            + Add sniper
          </Button>
        </div>
      </CardHeader>

      {mode === "add" && !revealed && (
        <CardBody className="space-y-3">
          <p className="text-sm text-fg-muted">
            Generates a new sniper wallet, saves it to your encrypted keystore
            in addition to existing ones, and shows you the secret once. Up to
            50 sniper wallets total in the keystore.
          </p>
          <Field label="Label (optional, defaults to next sniper-N)">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="sniper-5"
              className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
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
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={doAdd} disabled={busy}>
              {busy ? "Generating…" : "Generate + save"}
            </Button>
          </div>
        </CardBody>
      )}

      {revealed && (
        <CardBody className="space-y-3">
          <div className="rounded-lg border border-accent/40 bg-accent/5 p-4">
            <div className="text-sm font-semibold text-accent">
              ✓ {revealed.label} created. Save the secret NOW.
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              This secret will not be shown again. Copy it somewhere safe.
            </p>
          </div>
          <div>
            <div className="text-xs text-fg-subtle">public</div>
            <code className="block break-all font-mono text-xs">
              {revealed.pubkey}
            </code>
          </div>
          <div>
            <div className="text-xs text-fg-subtle">secret (one-time)</div>
            <code className="block break-all font-mono text-xs text-warn">
              {revealed.secret_b58}
            </code>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setRevealed(null);
                setMode(null);
              }}
            >
              I've saved it
            </Button>
          </div>
        </CardBody>
      )}

      {mode === "delete" && target && (
        <CardBody className="space-y-3">
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            Deleting <span className="font-mono">{target.label}</span> removes
            its key from the keystore. <strong>Any SOL or tokens still in
            this wallet will be unrecoverable</strong> unless you copied the
            secret elsewhere. Withdraw everything before deleting.
          </div>
          <code className="block break-all font-mono text-xs">
            {target.pubkey}
          </code>
          <Field label="Keystore passphrase to confirm">
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
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setMode(null);
                setTarget(null);
                setPass("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={doDelete} disabled={busy}>
              {busy ? "Deleting…" : "Confirm delete"}
            </Button>
          </div>
        </CardBody>
      )}

      <CardBody>
        <ul className="space-y-1.5">
          {wallets.map((w) => {
            const deletable = w.label !== "master";
            return (
              <li
                key={w.pubkey}
                className="flex items-center gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2"
              >
                <span className="font-mono text-xs uppercase tracking-wider text-fg-muted w-24 shrink-0">
                  {w.label}
                </span>
                <code className="flex-1 truncate font-mono text-[11px] text-fg-subtle">
                  {w.pubkey}
                </code>
                {deletable ? (
                  <button
                    onClick={() => {
                      setMode("delete");
                      setTarget(w);
                      setError(null);
                    }}
                    className="text-xs text-danger/70 hover:text-danger px-2 py-1"
                    disabled={mode !== null}
                  >
                    delete
                  </button>
                ) : (
                  <span className="text-xs text-fg-subtle px-2 py-1">
                    (master)
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
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
