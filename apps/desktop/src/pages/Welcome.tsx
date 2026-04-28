import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, CardBody } from "@snipebundle/ui";
import { ipc } from "../lib/ipc";

export function Welcome() {
  const nav = useNavigate();
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    ipc.keystoreExists().then(setExists).catch(() => setExists(false));
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight">
        Welcome to snipebundle.
      </h1>
      <p className="mt-3 text-lg text-fg-muted">
        A pump.fun launch sniper that runs entirely on your machine. Your keys,
        your funds, never ours.
      </p>

      <Card className="mt-10">
        <CardBody>
          <h2 className="font-semibold">Before you start</h2>
          <ul className="mt-3 space-y-2 text-sm text-fg-muted list-disc list-inside">
            <li>You'll set a passphrase. Forget it = lose your wallets.</li>
            <li>You'll generate sniper wallets. Save the keys when shown.</li>
            <li>You'll fund those wallets. Start with what you can lose.</li>
            <li>Sniping is risky. Most launches fail. Size accordingly.</li>
          </ul>
        </CardBody>
      </Card>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        {exists === null ? (
          <Button size="lg" disabled>
            …
          </Button>
        ) : exists ? (
          <>
            <Button size="lg" onClick={() => nav("/unlock")}>
              Unlock keystore
            </Button>
            <span className="text-sm text-fg-subtle">
              keystore already exists on this machine
            </span>
          </>
        ) : (
          <Button size="lg" onClick={() => nav("/wallets")}>
            Get started
          </Button>
        )}
      </div>
    </div>
  );
}
