import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, CardBody } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

export function Unlock() {
  const nav = useNavigate();
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setError(null);
    setBusy(true);
    try {
      await ipc.unlockKeystore(pass);
      nav("/dashboard");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">Unlock keystore</h1>
      <p className="mt-3 text-fg-muted">
        Enter the passphrase you set when you generated your wallets.
      </p>
      <Card className="mt-8">
        <CardBody className="space-y-4">
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
            className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="passphrase"
            autoFocus
          />
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          )}
        </CardBody>
      </Card>
      <div className="mt-4 flex justify-end">
        <Button size="lg" onClick={unlock} disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </div>
    </div>
  );
}
