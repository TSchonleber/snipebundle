import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, CardBody } from "@snipebundle/ui";

type Mode = "auto" | "targeted" | "both";
type Preset = "conservative" | "standard" | "aggressive";

export function ModeSelect() {
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("both");
  const [preset, setPreset] = useState<Preset>("standard");
  const [devWallets, setDevWallets] = useState("");

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">
        Step 3: How do you want to snipe?
      </h1>
      <p className="mt-3 text-fg-muted">
        You can change any of this later from the dashboard.
      </p>

      <div className="mt-8 space-y-3">
        <ModeCard
          active={mode === "both"}
          onClick={() => setMode("both")}
          title="Both"
          subtitle="Targeted devs always fire instantly. Auto handles everything else."
          recommended
        />
        <ModeCard
          active={mode === "targeted"}
          onClick={() => setMode("targeted")}
          title="Targeted only"
          subtitle="Only fire when a dev wallet on your list mints. Quietest mode."
        />
        <ModeCard
          active={mode === "auto"}
          onClick={() => setMode("auto")}
          title="Auto only"
          subtitle="Fire on every mint that matches your filters. Highest volume."
        />
      </div>

      {(mode === "auto" || mode === "both") && (
        <Card className="mt-6">
          <CardBody>
            <h3 className="font-semibold">Auto preset</h3>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(["conservative", "standard", "aggressive"] as Preset[]).map(
                (p) => (
                  <button
                    key={p}
                    onClick={() => setPreset(p)}
                    className={`rounded-lg border px-4 py-3 text-sm capitalize transition-colors ${
                      preset === p
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-fg-muted hover:border-border-strong"
                    }`}
                  >
                    {p}
                  </button>
                ),
              )}
            </div>
            <p className="mt-3 text-xs text-fg-subtle">
              {preset === "conservative" &&
                "Higher dev-buy %, requires socials, smaller size. Fewer snipes, higher avg quality."}
              {preset === "standard" &&
                "Balanced. Good default for most users."}
              {preset === "aggressive" &&
                "Lower thresholds, larger size, more snipes. Higher variance."}
            </p>
          </CardBody>
        </Card>
      )}

      {(mode === "targeted" || mode === "both") && (
        <Card className="mt-6">
          <CardBody>
            <h3 className="font-semibold">Targeted dev wallets</h3>
            <p className="mt-1 text-sm text-fg-muted">
              One Solana address per line. We'll fire instantly when any of
              them mints, bypassing the auto filters.
            </p>
            <textarea
              value={devWallets}
              onChange={(e) => setDevWallets(e.target.value)}
              rows={6}
              placeholder="9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
              className="mt-3 w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </CardBody>
        </Card>
      )}

      <div className="mt-8 flex justify-end">
        <Button size="lg" onClick={() => nav("/dashboard")}>
          Continue →
        </Button>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  subtitle,
  recommended,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  recommended?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border bg-bg-subtle p-4 text-left transition-all ${
        active
          ? "border-accent shadow-glow"
          : "border-border hover:border-border-strong"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold">{title}</span>
        {recommended && (
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-mono uppercase tracking-wider text-accent">
            Recommended
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
    </button>
  );
}
