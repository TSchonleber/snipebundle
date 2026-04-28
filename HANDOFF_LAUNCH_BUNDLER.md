# Handoff — launch bundler co-buyer pipeline

This document is a self-contained brief for any coding agent picking up the
launch-bundle co-buyer code in `snipebundle`. Read this top to bottom before
editing.

## Repo

- **Source (private)**: `git@github.com:TSchonleber/snipebundle.git` — branch
  `main`. Apache-2.0 licensed.
- **Public installers** (auto-published on tag push, not in source repo):
  `github.com/TSchonleber/snipebundle-releases`.
- Local clone in this dev env: `~/.openclaw/workspace/snipebundle`.

## Build & run

Prereqs: Rust ≥ 1.80, Node ≥ 22, pnpm ≥ 9.15, Xcode CLT (macOS).

```bash
pnpm install
pnpm tauri:build           # produces apps/desktop/src-tauri/target/release/bundle/{dmg,macos}/
pnpm tauri:dev             # runs the desktop app in dev mode (Vite + Tauri hot reload)
cargo check --workspace    # full Rust workspace typecheck (~3s incremental)
```

Workspace layout:

```
crates/core/        # Rust core library — keystore, bundler, listener, engine, exit, launch
crates/tui/         # ratatui dev/admin TUI (separate from desktop app)
apps/desktop/
  src-tauri/        # Tauri 2 Rust IPC layer (excluded from the cargo workspace)
    src/lib.rs      # tauri::Builder + invoke_handler!() macro
    src/commands.rs # all #[tauri::command] handlers
    src/state.rs    # AppState (keystore + config + engine handle)
  src/              # React + Vite frontend
    pages/Launch.tsx    # ← the launch UI you'll be editing
    lib/ipc.ts          # invoke() wrappers — all command names + arg types live here
apps/web/           # marketing site (Next.js 15, deploys to Vercel — irrelevant here)
packages/ui/        # shared React component library
```

## Launch bundler — code map

The launch flow lives in three files. Edit these together when changing
co-buyer behavior:

### `crates/core/src/launch.rs`

Where the actual bundle is built, signed, and submitted. Three public entry
points relevant to launches:

- **`upload_metadata(meta, image_path) -> Result<String>`**
  POSTs multipart form to `https://pump.fun/api/ipfs`. Returns metadata URI.

- **`execute_launch(dev, metadata, metadata_uri, dev_buy_sol, co_buyers, net) -> Result<LaunchResult>`**
  The main entry point. `co_buyers: &[(StoredKeypair, f64)]`. Caps at 25.

- **`submit_followon_chunk(client, mint, chunk, net) -> Result<String>`**
  Internal helper that builds + submits one follow-on bundle (5 wallets).

#### Bundle layout produced

```
Bundle 1 (the launch — Jito 5-tx cap = create takes 1, leaves room for 4 buys):
  tx[0] = create + dev_buy   (signed by [dev_kp, mint_kp])
  tx[1..=4] = co-buyers 1-4  (each signed by its own sniper keypair)

Bundles 2..N (follow-on, 5 buys each):
  tx[0..=4] = co-buyers 5-9, 10-14, ...

For 25 co-buyers: 1 launch bundle + 5 follow-on bundles = 6 Jito bundles total.
```

#### Critical invariants (do NOT break these)

1. **Jito hard cap is 5 txs per bundle.** Network-enforced. Don't try to send more.
2. **Each tx's signer must match `static_account_keys[0]`.** `verify_signer()` enforces this. PumpPortal returns txs in the same order as the actions sent, but if it ever didn't, the verifier catches it loudly. Don't remove this check.
3. **The launch bundle must land before follow-on buys execute.** Follow-on tx instructions reference the mint's bonding-curve account, which doesn't exist until the create lands. The current code sleeps 2.5 s before firing follow-on bundles. If you parallelize, follow-on bundles will fail until block N+1.
4. **Sequence of signing keys for `tx[0]` of the launch bundle is `[dev, mint]`.** PumpPortal returns the unsigned tx with two required signers. `sign_with_keys()` matches on pubkey, so order in the slice doesn't matter — but both keypairs must be present.
5. **Mint keypair is generated fresh per call.** It's derived from `Keypair::new()`, used only for the create tx, then dropped. Don't change this without understanding why a non-fresh mint would let other people grief you.

### `apps/desktop/src-tauri/src/commands.rs`

The `launch_token` Tauri command:

```rust
#[derive(Deserialize)]
pub struct CoBuyerSpec { pub pubkey: String, pub sol: f64 }

#[derive(Deserialize)]
pub struct LaunchArgs {
    pub dev_pubkey: String,
    pub metadata: LaunchMetadata,
    pub metadata_uri: Option<String>,
    pub image_path: Option<String>,
    pub dev_buy_sol: f64,
    #[serde(default)]
    pub co_buyers: Vec<CoBuyerSpec>,
}

#[tauri::command]
pub async fn launch_token(args: LaunchArgs, state: State<'_, AppState>) -> Result<LaunchResult>
```

Helper functions:
- `find_wallet(ks, pubkey) -> Option<StoredKeypair>` — looks across master + snipers + dev_wallets.
- `err()` — Display → String for Tauri's serde-friendly error type.

### `apps/desktop/src/pages/Launch.tsx`

The UI. Co-buyer state:

```ts
const [coBuyersEnabled, setCoBuyersEnabled] = useState(false);
const [coBuyerPicked, setCoBuyerPicked] = useState<string[]>([]);     // pubkeys
const [coStrategy, setCoStrategy] = useState<"uniform" | "per_wallet" | "random">("uniform");
const [coUniform, setCoUniform] = useState("0.1");
const [coPerWallet, setCoPerWallet] = useState<Record<string, string>>({});
const [coRandomMin, setCoRandomMin] = useState("0.05");
const [coRandomMax, setCoRandomMax] = useState("0.20");
```

`buildCoBuyers()` resolves the strategy to `[{pubkey, sol}]` before passing to `ipc.launchToken`. Random strategy uses `Math.random()` in the frontend, NOT the Rust `AmountStrategy::Random` (which exists but is wired to the Trade page, not Launch).

The cap of 25 is enforced in 3 places — all must agree:
- `crates/core/src/launch.rs::execute_launch` — `anyhow::ensure!(co_buyers.len() <= 25)`
- `apps/desktop/src/pages/Launch.tsx::toggleCoBuyer` — `>= 25` early return
- `apps/desktop/src/pages/Launch.tsx::buildCoBuyers` — implicit via picked length

If you change the cap, change all three.

## Result type

```rust
pub struct LaunchResult {
    pub mint: String,
    pub bundle_id: String,            // launch bundle (always set on success)
    pub follow_on_bundle_ids: Vec<String>,
    pub follow_on_errors: Vec<String>,
    pub metadata_uri: String,
    pub dev_pubkey: String,
    pub dev_buy_sol: f64,
    pub co_buyer_count: usize,
    pub co_buyer_total_sol: f64,
}
```

`bundle_id` non-empty + `follow_on_errors` non-empty = partial fill. UI surfaces both.

## Network config

`Config::network` (TOML at `~/.config/snipebundle/config.toml` or
platform equivalent):

```toml
[network]
rpc_url = "https://api.mainnet-beta.solana.com"
pumpportal_ws = "wss://pumpportal.fun/api/data"
trade_local_url = "https://pumpportal.fun/api/trade-local"
jito_block_engine = "https://mainnet.block-engine.jito.wtf/api/v1/bundles"
jito_tip_sol = 0.001                     # paid via priorityFee on tx[0] of each bundle
priority_fee_sol = 0.0001                # tx[1..] of each bundle
slippage_bps = 5000                      # 50%
```

Per-bundle Jito tip applies to **each** bundle independently. 25 co-buyers
= 6 bundles = 6× the configured tip.

## Verification commands

```bash
# Type-check everything (Rust core + tui)
cargo check --workspace

# Type-check + sanity-check the Tauri crate
cd apps/desktop/src-tauri && cargo check

# Build the desktop app and produce a fresh .dmg
pnpm tauri:build
# → apps/desktop/src-tauri/target/release/bundle/dmg/snipebundle_X.Y.Z_aarch64.dmg

# Tag a public release (requires RELEASES_REPO_PAT secret on private repo for CI;
# otherwise upload manually):
gh release create vX.Y.Z --repo TSchonleber/snipebundle-releases --latest --notes "..." snipebundle.dmg
```

## Common modifications, by difficulty

### Easy (no architecture change)

- **Adjust the cap** (e.g., 25 → 50): edit the three call sites listed above.
  Note that more co-buyers = more bundles = more tip cost; keep the UI total
  in sync.
- **Change the follow-on delay**: `tokio::time::sleep(Duration::from_millis(N))`
  in `execute_launch`. Lowering below ~1500 ms risks follow-on buys executing
  before the create lands; raising over 5000 ms means third-party snipers can
  cut in front of follow-on buys.
- **Add a per-tx priority fee bump for follow-on bundles**: parameter on
  `submit_followon_chunk`. Currently uses `net.priority_fee_sol`.
- **Surface bundle landing latency**: poll `https://mainnet.block-engine.jito.wtf/api/v1/getInflightBundleStatuses?bundleIds=[...]` after submit.

### Medium (architecture change)

- **Parallelize follow-on bundles** instead of sequential: `tokio::join!` or `futures::future::join_all` inside `execute_launch`. Make sure the launch bundle has confirmed (or you accept the risk that follow-ons may race against the mint's existence).
- **Re-issue failed follow-on bundles**: capture the failed wallets in `follow_on_errors`, expose a "retry" command. Already in scope of the Trade page (manual buy of those wallets) but a one-button retry would be cleaner.
- **Per-bundle Jito tip override**: extend `LaunchArgs` with optional `jito_tips: Vec<f64>` (one per chunk).

### Stop and think before doing this

- **Time-based or price-based automated SELL of co-buyer wallets after launch.**
  This was explicitly requested during this session and refused — see "Decisions
  log" below. The mechanism is the same as a "volume bundler" or "trending bot"
  on every Solana sniper-as-a-service tool, and it's the textbook pump-and-dump
  setup under SEC Rule 10b-5 / pump.fun TOS regardless of how it's framed
  (timer, stop-loss, trailing exit). Manual sells via the Trade page are
  unrestricted and already work — you can pick co-buyer wallets and click SELL
  at any percent.
- **Master-or-other-wallet-funded co-buyers** (sniper buys with master's SOL).
  Currently each co-buyer pays its own SOL — they need to be pre-funded. Don't
  collapse this into "master pays for everyone" because that re-introduces the
  custody problem (master sponsors everyone's trade = master is operating
  trades on behalf of those wallets).

## Decisions log (relevant to launch bundler edits)

Stored in `~/agentmemory/db/brain.db` via brainctl. The last few specifically
about this code:

- **142** — Refused: multi-wallet self-pump on own token launch + auto-dump in
  60s = wash trading + pump-and-dump. Built only the legit launch (dev create
  + dev buy, no others) initially.
- **143** — Refused: third-party mixer integration between master and snipers.
  Tornado Cash precedent applies regardless of who built the mixer.
- **144** — Decision: snipebundle never moves SOL on user's behalf for funding.
  Read-only balance polling instead. Later partially superseded by 145.
- **145** — Refined boundary: plain on-chain transfers between user-owned
  wallets are fine (master fan-out shipped as opt-in). Obfuscation tools
  (mixers, peel chains, time-randomized splits) remain off the table.
- **146** — Refused: timed auto-sell of co-buyer wallets after launch (the
  "rotate on and off" volume-bot ask). Same line as 142, different wrapper.
  Manual sells via Trade page are the supported exit path.

If a future agent is asked to build something resembling these refusals, the
context is in `mcp__brainctl__decision_add` records — query for `project = "snipebundle"`.

## Out of scope / known gaps

- **Code signing**: builds are unsigned. macOS Gatekeeper warns on first launch
  (right-click → Open clears it). Apple Developer ID + Windows EV signing are
  the M9 deferred work.
- **Auto-updater**: not yet wired. Tauri 2 plugin scaffolding lives at task
  v0.1.5 (was v0.1.3 in earlier task numbering). Requires generating an
  Ed25519 keypair, embedding the pubkey in `tauri.conf.json`, and signing each
  release artifact in CI.
- **Linux + Windows + Intel-Mac installers**: only Apple Silicon `.dmg` is
  built locally. CI workflow at `.github/workflows/release.yml` produces all
  four on tag push, but requires `RELEASES_REPO_PAT` secret on the private
  repo (fine-scoped PAT with `contents:write` on `TSchonleber/snipebundle-releases`).

## Contact

Source maintainer: TSchonleber on GitHub. The decisions log above represents
my reasoning at the time of writing — feel free to disagree but make sure
you've actually read the corresponding US/EU statutes (10b-5, MAR Article 12)
before concluding I was being overcautious.
