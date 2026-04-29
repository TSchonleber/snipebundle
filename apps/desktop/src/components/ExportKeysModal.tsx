import { useState } from "react";
import { Button, Card, CardBody, cn } from "@snipebundle/ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { ipc } from "../lib/ipc";

interface RevealedWallet {
  label: string;
  pubkey: string;
  secret_b58: string;
}

export function ExportKeysModal({ onClose }: { onClose: () => void }) {
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<RevealedWallet[] | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [copiedPubkey, setCopiedPubkey] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  async function unlock() {
    setError(null);
    if (pass.length < 12) return setError("Enter your keystore passphrase.");
    setBusy(true);
    try {
      const wallets = await ipc.revealWallets(pass);
      setRevealed(wallets);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await writeText(text);
      setCopiedPubkey(key);
      window.setTimeout(() => setCopiedPubkey(null), 1200);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedPubkey(key);
        window.setTimeout(() => setCopiedPubkey(null), 1200);
      } catch {}
    }
  }

  function buildBackupText(wallets: RevealedWallet[]): string {
    const now = new Date().toISOString();
    const lines = [
      "# snipebundle wallet backup",
      `# Generated: ${now}`,
      "#",
      "# KEEP THIS FILE SAFE. Anyone with these private keys can drain the",
      "# wallets. Store it offline (USB drive, paper, password manager).",
      "#",
      "# Format: <label>,<pubkey>,<base58 private key>",
      "# To restore in Phantom/Solflare: 'Import private key' → paste the",
      "# base58 secret column for that wallet.",
      "",
      ...wallets.map((w) => `${w.label},${w.pubkey},${w.secret_b58}`),
      "",
    ];
    return lines.join("\n");
  }

  async function saveAsFile() {
    if (!revealed) return;
    setError(null);
    try {
      const path = await save({
        defaultPath: `snipebundle-backup-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}.txt`,
        filters: [{ name: "Backup", extensions: ["txt"] }],
      });
      if (!path) return;
      await writeTextFile(path, buildBackupText(revealed));
      setSavedPath(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function copyAll() {
    if (!revealed) return;
    await copy(buildBackupText(revealed), "__all__");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl border border-warn/40 bg-bg-subtle shadow-xl max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border bg-warn/5">
          <h2 className="text-lg font-bold text-warn">Export wallet keys</h2>
          <p className="mt-1 text-xs text-fg-muted">
            For backup purposes. Anyone with these keys can drain the
            corresponding wallets — handle exactly like cash.
          </p>
        </div>

        {!revealed && (
          <div className="p-5 space-y-4">
            <div className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn space-y-1.5">
              <p>
                <strong>Before you click reveal:</strong>
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-fg-muted">
                <li>Make sure no one's looking at your screen.</li>
                <li>Disable screen sharing if a meeting is running.</li>
                <li>
                  Save the backup to encrypted storage (encrypted USB,
                  password manager, encrypted cloud archive). Plain text in
                  Downloads is the worst option.
                </li>
                <li>
                  Phantom/Solflare/most Solana wallets accept the base58
                  private key directly via "Import private key".
                </li>
              </ul>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2">
                Keystore passphrase
              </label>
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlock()}
                autoFocus
                className="w-full rounded-lg border border-border bg-bg-raised px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={unlock} disabled={busy}>
                {busy ? "Unlocking…" : "Reveal keys"}
              </Button>
            </div>
          </div>
        )}

        {revealed && (
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <span className="font-mono text-accent">{revealed.length}</span>{" "}
                wallet{revealed.length === 1 ? "" : "s"} unlocked
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={showSecrets ? "secondary" : "primary"}
                  onClick={() => setShowSecrets((s) => !s)}
                >
                  {showSecrets ? "Hide secrets" : "Show secrets"}
                </Button>
                <Button size="sm" variant="secondary" onClick={copyAll}>
                  {copiedPubkey === "__all__" ? "copied all" : "Copy all"}
                </Button>
                <Button size="sm" onClick={saveAsFile}>
                  Save as file
                </Button>
              </div>
            </div>

            {savedPath && (
              <div className="border-l-2 border-accent bg-accent/5 px-3 py-2">
                <div className="font-mono text-2xs text-accent uppercase tracking-tight2">
                  backup written
                </div>
                <code className="mt-0.5 block break-all font-mono text-xs text-fg-muted">
                  {savedPath}
                </code>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="space-y-2">
              {revealed.map((w) => (
                <div
                  key={w.pubkey}
                  className="rounded-lg border border-border bg-bg-raised p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded bg-bg-subtle px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      {w.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => copy(w.pubkey, `pub:${w.pubkey}`)}
                      className="text-[10px] text-fg-subtle hover:text-fg"
                    >
                      {copiedPubkey === `pub:${w.pubkey}` ? "copied" : "copy pubkey"}
                    </button>
                  </div>
                  <code className="block break-all font-mono text-[11px] text-fg">
                    {w.pubkey}
                  </code>
                  <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/50">
                    <span className="text-[10px] uppercase tracking-wider text-warn">
                      Private key (base58)
                    </span>
                    <button
                      type="button"
                      onClick={() => copy(w.secret_b58, `sec:${w.pubkey}`)}
                      className="text-[10px] text-fg-subtle hover:text-fg"
                    >
                      {copiedPubkey === `sec:${w.pubkey}` ? "copied" : "copy secret"}
                    </button>
                  </div>
                  <code
                    className={cn(
                      "block break-all font-mono text-[11px]",
                      showSecrets ? "text-warn" : "text-fg-subtle select-none",
                    )}
                  >
                    {showSecrets ? w.secret_b58 : "•".repeat(64)}
                  </code>
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-2 border-t border-border">
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
