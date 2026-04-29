import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  cn,
  type WalletInfo,
} from "@snipebundle/ui";
import { ipc, type BundleGroup } from "../lib/ipc";

interface Props {
  wallets: WalletInfo[];
}

/**
 * CRUD UI for saved bundle groups. A group is a reusable
 * (wallets[], default_sol_per_wallet) pair that other features (Trade
 * rebuy, Snipe rebuy via wallet binding, Launch rebuy) reference by id.
 *
 * Capped at 5 wallets per group because that's the Jito bundle limit —
 * anything bigger can't be a single bundle. The validator on the Rust
 * side enforces the cap; the UI surfaces it as a hard "Save disabled"
 * state instead of letting the user submit something that'll bounce.
 */
export function BundleGroupsManager({ wallets }: Props) {
  const [groups, setGroups] = useState<BundleGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<BundleGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const list = await ipc.listBundleGroups();
      setGroups(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function newGroup() {
    setEditing({
      id: "",
      name: "",
      wallet_pubkeys: [],
      default_sol_per_wallet: 0.05,
    });
  }

  async function save(group: BundleGroup) {
    setError(null);
    try {
      await ipc.saveBundleGroup(group);
      setEditing(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await ipc.deleteBundleGroup(id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Bundle groups</h3>
          <Button size="sm" variant="secondary" onClick={newGroup}>
            + New group
          </Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-fg-muted">
          Reusable named sets of wallets + default SOL amount. Reference a
          group from the Trade rebuy chain or per-wallet auto-exit binding to
          have one group sell and a different group buy back automatically.
        </p>

        {error && (
          <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {loading ? (
          <div className="font-mono text-2xs text-fg-subtle">loading…</div>
        ) : groups.length === 0 ? (
          <div className="hatch border border-dashed border-border px-4 py-6 text-center font-mono text-2xs text-fg-subtle">
            no groups yet — create one to chain rebuys
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                wallets={wallets}
                onEdit={() => setEditing(g)}
                onDelete={() => remove(g.id)}
              />
            ))}
          </div>
        )}

        {editing && (
          <GroupEditor
            initial={editing}
            wallets={wallets}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        )}
      </CardBody>
    </Card>
  );
}

function GroupRow({
  group,
  wallets,
  onEdit,
  onDelete,
}: {
  group: BundleGroup;
  wallets: WalletInfo[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const labels = group.wallet_pubkeys.map((pk) => {
    const w = wallets.find((x) => x.pubkey === pk);
    return w?.label ?? pk.slice(0, 6);
  });
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-raised px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm text-fg">{group.name}</div>
        <div className="font-mono text-2xs text-fg-subtle truncate">
          {labels.join(" + ") || "no wallets"} ·{" "}
          <span className="text-fg-muted">
            {group.default_sol_per_wallet} SOL each
          </span>
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        edit
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete}>
        delete
      </Button>
    </div>
  );
}

function GroupEditor({
  initial,
  wallets,
  onCancel,
  onSave,
}: {
  initial: BundleGroup;
  wallets: WalletInfo[];
  onCancel: () => void;
  onSave: (g: BundleGroup) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [picked, setPicked] = useState<Set<string>>(
    new Set(initial.wallet_pubkeys),
  );
  const [amount, setAmount] = useState(String(initial.default_sol_per_wallet));

  function toggle(pk: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else if (next.size < 5) next.add(pk);
      return next;
    });
  }

  const amountValid = (() => {
    const v = parseFloat(amount);
    return Number.isFinite(v) && v > 0;
  })();
  const canSave =
    name.trim().length > 0 && picked.size > 0 && picked.size <= 5 && amountValid;

  function submit() {
    onSave({
      id: initial.id,
      name: name.trim(),
      wallet_pubkeys: Array.from(picked),
      default_sol_per_wallet: parseFloat(amount),
    });
  }

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">
          {initial.id ? "Edit group" : "New group"}
        </h4>
      </div>

      <div>
        <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Team Alpha"
          className="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-fg-subtle uppercase tracking-wider">
            Wallets ({picked.size}/5)
          </label>
          <span className="font-mono text-2xs text-fg-subtle">
            max 5 — Jito bundle limit
          </span>
        </div>
        <div className="max-h-44 overflow-y-auto rounded border border-border bg-bg divide-y divide-border/40">
          {wallets.map((w) => {
            const checked = picked.has(w.pubkey);
            const disabled = !checked && picked.size >= 5;
            return (
              <label
                key={w.pubkey}
                className={cn(
                  "flex items-center gap-3 px-3 py-1.5 hover:bg-fg/5",
                  disabled && "opacity-40 cursor-not-allowed",
                  !disabled && "cursor-pointer",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(w.pubkey)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                <span className="font-mono text-2xs text-fg shrink-0 w-20 truncate">
                  {w.label}
                </span>
                <span className="font-mono text-2xs text-fg-subtle truncate">
                  {w.pubkey.slice(0, 8)}…{w.pubkey.slice(-6)}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-xs text-fg-subtle uppercase tracking-wider mb-1">
          Default SOL per wallet
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={submit} disabled={!canSave}>
          {initial.id ? "Save" : "Create"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
