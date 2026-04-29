# Raydium-Direct Launch — Spec & Implementation Plan

## Why

Pump.fun launches lock you into:
- pump.fun's bonding-curve fee schedule (1% per trade ~ish)
- pump.fun's metadata + image hosting
- pump.fun's branding on the listing
- forced graduation flow at $69k MC before the coin becomes a real Raydium pair

Direct-Raydium launches skip all of that. You mint your own SPL token,
upload your own metadata, create a Raydium pool with your own initial
liquidity, and do the first buy yourself — all in one Jito bundle so
no one frontruns the inaugural trade.

Inspired by [Smithii's bundler-launch][smithii] but Smithii uses
Raydium's legacy AMM v4 + OpenBook market (4 SOL+ in fees just for the
market and pool). We're going to use **Raydium CPMM** (constant-product
market-maker, the v2 of their AMM) which **doesn't require an OpenBook
market** — the pool itself stores the orderbook. ~1 SOL flat instead of
4+ SOL.

[smithii]: https://docs.smithii.io/products/dev-bots/bundler-launch

## On-chain flow

The full launch is **5 instructions** that we cram into 1–2 transactions
inside a Jito bundle for atomicity:

1. **Create token mint** (SPL Token program)
   - Mint authority: dev wallet (renounced post-init optional)
   - Freeze authority: null (set up-front so it can never be re-added)
   - Decimals: 6 (matches pump.fun convention; Raydium has no opinion)
   - Initial supply: 1B tokens minted to dev wallet

2. **Create metadata account** (Metaplex Token Metadata program)
   - Name, symbol, URI (IPFS upload happens off-chain first)
   - is_mutable: false — locked so no rug-via-metadata-rewrite
   - seller_fee_basis_points: 0
   - creators: [(dev_pubkey, share=100, verified=true)]

3. **Initialize Raydium CPMM pool** (Raydium CPMM program)
   - Token A: our newly-minted SPL token
   - Token B: WSOL (wrapped SOL)
   - Initial liquidity: dev provides X tokens + Y SOL (configurable)
   - Pool authority: dev wallet (we'll burn LP tokens immediately
     after to lock liquidity — common rug-resistance pattern)

4. **Burn LP tokens** (SPL Token program — burn ix)
   - Locks the liquidity forever. Standard pattern; gives traders
     the safety of "dev can't pull rug" without giving up custody
     of the pool itself.

5. **First buy via Raydium CPMM swap** (Raydium CPMM program)
   - Dev wallet (or a configured "first buyer" wallet) swaps SOL → token
   - This sets the opening trade and primes the pool's price history

Optional sixth instruction: **co-buyers** — additional wallets in the
same Jito bundle each fire a swap, mirroring our pump.fun launch's
co-buyer feature.

## Bundle layout

Jito bundle limit: 5 transactions. Each tx: ~1232 bytes.

**Single-buyer bundle** (no co-buyers): 1 tx with all 5 ixs above.

**Multi-buyer bundle** (N co-buyers): 2 txs — tx[0] does ixs 1-4 (mint,
metadata, pool init, lp burn) signed by dev; tx[1] does ix 5 (dev's
first buy) plus N-1 swap ixs from co-buyer wallets, signed by all
N+1 wallets jointly. Bundle order matters: tx[0] must land before
tx[1] for the pool to exist by swap time. Jito guarantees ordering
within a bundle.

## Backend module skeleton

```rust
// crates/core/src/raydium_launch.rs

pub struct RaydiumLaunchArgs {
    pub dev: StoredKeypair,
    pub metadata: LaunchMetadata,         // reuses existing struct
    pub metadata_uri: String,             // pre-uploaded to IPFS
    pub token_supply: u64,                // default 1_000_000_000
    pub token_decimals: u8,               // default 6
    pub initial_lp_token_amount: u64,     // tokens added to pool
    pub initial_lp_sol: f64,              // SOL added to pool
    pub burn_lp: bool,                    // default true
    pub dev_buy_sol: f64,                 // can be 0
    pub co_buyers: Vec<(StoredKeypair, f64)>,
}

pub struct RaydiumLaunchResult {
    pub mint: String,
    pub pool_id: String,
    pub bundle_id: String,
    pub lp_burn_signature: Option<String>,
}

pub async fn execute_raydium_launch(
    args: &RaydiumLaunchArgs,
    net: &NetworkConfig,
) -> Result<RaydiumLaunchResult> {
    // 1. Build mint create + initialize ixs
    // 2. Build metadata create ix
    // 3. Build CPMM pool init ix
    // 4. Build LP burn ix (conditional)
    // 5. Build first-buy swap ixs
    // 6. Pack into 1-2 txs under bundle size limit
    // 7. Sign with dev (and co-buyers for tx[1])
    // 8. Submit Jito bundle, return mint + pool_id + bundle_id
    todo!("on-chain ixs — multi-session work")
}
```

## Why this is a multi-session implementation

The instruction-building code is delicate:

- **Raydium CPMM IDL**: the program's IDL has been revised twice in the
  past year; we need the current one and the matching ix discriminators.
  Wrong discriminator = transaction fails with no helpful error.
- **PDA derivation**: pool, vault, and authority addresses are all PDAs
  that must be derived correctly with the exact seed order or the pool
  init silently creates an orphan account.
- **Decimals + LP math**: initial price is `lp_sol / lp_tokens`. Getting
  this backwards mints a meme coin at $1B FDV instead of $1k.
- **Metaplex metadata account size**: enum-tagged borsh struct with
  versioning; allocation size depends on fields present.
- **Bundle size budget**: 1232 bytes per tx, 5 txs per bundle. We're
  packing ~600+ bytes of ixs and ~96 bytes per signer. Multi-buyer
  bundles can blow size budget if co-buyer count is too high; need
  validation.
- **Devnet test loop**: every bug above has the failure mode "dev wallet
  loses 0.5–4 SOL of fees and we don't know why". Standing up devnet
  testing infrastructure first is non-negotiable.

Realistic time estimate to ship production: **3–5 dedicated sessions**
of ~3 hours each, plus one session of devnet testing where we
intentionally fire bundles in adverse conditions (low SOL, contested
slots, etc.) and validate the recovery path.

## What ships in v0.1.57 (today)

The data model + UI surface, with the on-chain function returning
`Err("not yet implemented — Raydium-direct launches land in v0.1.58+")`.

This means:

- ✅ `crates/core/src/raydium_launch.rs` module with `RaydiumLaunchArgs`
  + `RaydiumLaunchResult` + `execute_raydium_launch()` stub
- ✅ Tauri command `launch_token_raydium` + IPC binding
- ✅ Launch page gets a third tab `[ Single | Multi | Raydium ]`
- ✅ Form UI in Raydium tab with all the knobs (token supply, decimals,
  LP amounts, burn LP toggle, dev buy, co-buyers)
- ✅ Submit button triggers the IPC, currently surfaces the
  "not yet implemented" error gracefully
- ✅ Tests for input validation only (the on-chain code itself is
  stubbed)

This gives you the surface area to validate the model and design now,
and the on-chain implementation can land in a follow-up where it gets
the careful devnet-first treatment it requires.
