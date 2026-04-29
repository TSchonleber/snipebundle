//! Raydium-direct token launch (skip pump.fun entirely).
//!
//! v0.1.57: data model + validation + stub. The on-chain instruction
//! building is intentionally NOT implemented in this commit — see
//! `RAYDIUM_LAUNCH_SPEC.md` at the repo root for the full plan and
//! reasoning. Implementing Raydium CPMM pool init + Metaplex metadata
//! + bundled first-buy correctly requires devnet test infrastructure
//! we haven't stood up yet, and getting any of the PDA derivations or
//! ix discriminators wrong silently burns the dev wallet's gas.
//!
//! Surface lands in this version so the UI is testable and the data
//! model is locked in. The on-chain function returns a clear "not yet
//! implemented" error; v0.1.58+ replaces the body with real ixs.

use crate::config::NetworkConfig;
use crate::keystore::StoredKeypair;
use crate::launch::LaunchMetadata;
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Default token supply: 1 billion (matches pump.fun convention so
/// charts and "% of supply" metrics look familiar to users coming over
/// from pump.fun launches).
pub const DEFAULT_TOKEN_SUPPLY: u64 = 1_000_000_000;
/// Default token decimals. Pump.fun uses 6; Raydium has no preference.
pub const DEFAULT_TOKEN_DECIMALS: u8 = 6;

/// One co-buyer who joins the bundled first buy with their own SOL
/// amount. Identical shape to the pump.fun launch CoBuyerSpec for
/// frontend code reuse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaydiumCoBuyer {
    pub pubkey: String,
    pub sol: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaydiumLaunchArgs {
    pub dev_pubkey: String,
    pub metadata: LaunchMetadata,
    /// If empty AND `image_path` is set, the backend uploads to pump.fun's
    /// public IPFS endpoint and uses the returned URI. If both are empty,
    /// validation fails up-front.
    #[serde(default)]
    pub metadata_uri: String,
    #[serde(default)]
    pub image_path: Option<String>,
    /// Total token supply minted to dev. Default 1B.
    #[serde(default = "default_supply")]
    pub token_supply: u64,
    /// Token decimals. Default 6.
    #[serde(default = "default_decimals")]
    pub token_decimals: u8,
    /// How many tokens to seed the pool with. Pool's initial price =
    /// initial_lp_sol / initial_lp_token_amount.
    pub initial_lp_token_amount: u64,
    /// SOL deposited as the WSOL side of the pool.
    pub initial_lp_sol: f64,
    /// Lock liquidity by burning the LP tokens after pool init. Strongly
    /// recommended for trader trust; default true.
    #[serde(default = "default_burn_lp")]
    pub burn_lp: bool,
    /// Dev's first buy in the same bundle. 0 to skip (pool exists but
    /// no opening trade).
    pub dev_buy_sol: f64,
    /// Optional co-buyers piling on the same bundle.
    #[serde(default)]
    pub co_buyers: Vec<RaydiumCoBuyer>,
}

fn default_supply() -> u64 {
    DEFAULT_TOKEN_SUPPLY
}
fn default_decimals() -> u8 {
    DEFAULT_TOKEN_DECIMALS
}
fn default_burn_lp() -> bool {
    true
}

impl RaydiumLaunchArgs {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(!self.dev_pubkey.is_empty(), "dev_pubkey required");
        anyhow::ensure!(
            !self.metadata.name.is_empty(),
            "metadata.name required"
        );
        anyhow::ensure!(
            !self.metadata.symbol.is_empty(),
            "metadata.symbol required"
        );
        anyhow::ensure!(
            !self.metadata_uri.is_empty() || self.image_path.is_some(),
            "either metadata_uri or image_path required"
        );
        anyhow::ensure!(self.token_supply > 0, "token_supply must be > 0");
        anyhow::ensure!(
            self.token_decimals <= 9,
            "token_decimals must be 0..=9"
        );
        anyhow::ensure!(
            self.initial_lp_token_amount > 0,
            "initial_lp_token_amount must be > 0"
        );
        anyhow::ensure!(
            self.initial_lp_token_amount <= self.token_supply,
            "initial_lp_token_amount can't exceed total supply"
        );
        anyhow::ensure!(
            self.initial_lp_sol > 0.0,
            "initial_lp_sol must be > 0 (pool needs both sides)"
        );
        anyhow::ensure!(
            self.dev_buy_sol >= 0.0,
            "dev_buy_sol must be ≥ 0 (use 0 to skip the opening buy)"
        );
        for (i, cb) in self.co_buyers.iter().enumerate() {
            anyhow::ensure!(
                !cb.pubkey.is_empty(),
                "co_buyers[{i}]: pubkey required"
            );
            anyhow::ensure!(
                cb.sol > 0.0,
                "co_buyers[{i}]: sol must be > 0"
            );
        }
        // Bundle size budget is the killer for multi-buyer launches.
        // Conservative cap: dev + 4 co-buyers fits within Jito's 5-tx
        // bundle limit even when tx[0] eats up one slot for the pool
        // init.
        anyhow::ensure!(
            self.co_buyers.len() <= 4,
            "co_buyers capped at 4 — Jito bundle has 5 slots and pool init takes one"
        );
        Ok(())
    }

    pub fn implied_initial_price_sol_per_token(&self) -> f64 {
        if self.initial_lp_token_amount == 0 {
            return 0.0;
        }
        self.initial_lp_sol / self.initial_lp_token_amount as f64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaydiumLaunchResult {
    pub mint: String,
    pub pool_id: String,
    pub bundle_id: String,
    pub lp_burn_signature: Option<String>,
}

// =============================================================================
// On-chain program IDs and ix discriminators
// =============================================================================
// We hand-roll the SPL Token and Metaplex Token Metadata ixs rather than
// pulling in `spl-token` / `mpl-token-metadata` crates because those
// transitively depend on a different `solana-pubkey` version than the
// one in our workspace, and the resulting Cargo dep hell is worse than
// constructing 4 ixs by hand.
//
// All discriminators and account orderings below come from the public
// program source:
//   - SPL Token v3:  https://github.com/solana-program/token
//   - Metaplex MPL:  https://github.com/metaplex-foundation/mpl-token-metadata
// They've been stable for 3+ years.

const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const METAPLEX_METADATA_PROGRAM_ID: &str =
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// SPL Token instruction discriminators (single-byte u8 prefix).
const SPL_IX_INITIALIZE_MINT2: u8 = 20;
const SPL_IX_MINT_TO: u8 = 7;

// Metaplex Token Metadata instruction discriminators (single-byte u8).
const MPL_IX_CREATE_METADATA_V3: u8 = 33;

const MINT_ACCOUNT_LEN: u64 = 82;

/// Phase-1 implementation: mint a fresh SPL token, attach Metaplex
/// metadata, and mint the configured initial supply to the dev wallet,
/// all in a single transaction.
///
/// **What this does:**
///   1. createAccount (System Program) for the new mint with rent-exempt lamports
///   2. initializeMint2 (SPL Token) — decimals + mint authority = dev, freeze authority = none
///   3. createAssociatedTokenAccount (ATA) for dev to receive the minted supply
///   4. createMetadataAccountV3 (Metaplex) — name, symbol, URI; immutable
///   5. mintTo (SPL Token) — full token_supply minted to dev's ATA
///
/// **What this does NOT do (deferred):**
///   - Raydium CPMM pool initialization
///   - LP token burn (locks liquidity)
///   - Bundled first-buy + co-buyer swaps
///
/// Why split: the token+metadata side uses well-trodden, decade-old
/// SPL/Metaplex programs whose ix layouts have been frozen since 2022.
/// Raydium CPMM's ix layout has been revised twice in the last year and
/// hand-rolling it without devnet test infra is asking to lose dev SOL
/// to a discriminator typo. After this returns successfully, the UI
/// surfaces a deep-link to Raydium's pool creator with the new mint
/// pre-filled — user finishes pool init via Raydium's tested SDK.
pub async fn execute_raydium_launch(
    args: &RaydiumLaunchArgs,
    net: &NetworkConfig,
    dev: &StoredKeypair,
    _co_buyers: &[(StoredKeypair, f64)],
) -> Result<RaydiumLaunchResult> {
    use solana_sdk::commitment_config::CommitmentConfig;
    use solana_sdk::instruction::{AccountMeta, Instruction};
    use solana_sdk::pubkey::Pubkey;
    use solana_sdk::signer::Signer;
    #[allow(deprecated)]
    use solana_sdk::system_instruction;
    use solana_sdk::transaction::Transaction;
    use std::str::FromStr;

    args.validate()?;

    // Resolve metadata_uri up front. If the user only provided an
    // image_path, route through the existing pump.fun IPFS uploader
    // (already used by pump.fun launches) — saves them having to upload
    // to IPFS separately. The URI is the off-chain pointer that the
    // Metaplex metadata account stores.
    let resolved_uri = if !args.metadata_uri.is_empty() {
        args.metadata_uri.clone()
    } else {
        let img = args
            .image_path
            .as_ref()
            .map(std::path::PathBuf::from);
        crate::launch::upload_metadata(&args.metadata, img.as_deref())
            .await
            .context("upload metadata to ipfs")?
    };

    // Resolve program IDs once.
    let token_program = Pubkey::from_str(SPL_TOKEN_PROGRAM_ID)?;
    let ata_program = Pubkey::from_str(ATA_PROGRAM_ID)?;
    let metadata_program = Pubkey::from_str(METAPLEX_METADATA_PROGRAM_ID)?;
    let dev_kp = crate::wallet::from_stored(dev)?;
    let dev_pubkey = dev_kp.pubkey();

    // Generate a fresh mint keypair. Returned to the caller as the new
    // token's contract address — same role as a pump.fun mint.
    let mint_kp = solana_sdk::signature::Keypair::new();
    let mint_pubkey = mint_kp.pubkey();

    // RPC client + rent calculation. Mint accounts are 82 bytes.
    let rpc = solana_client::nonblocking::rpc_client::RpcClient::new_with_commitment(
        net.rpc_url.clone(),
        CommitmentConfig::confirmed(),
    );
    let rent_lamports = rpc
        .get_minimum_balance_for_rent_exemption(MINT_ACCOUNT_LEN as usize)
        .await
        .context("query rent for mint account")?;

    // Derive the dev's associated token account for the new mint. PDA
    // derivation: ATA = find_program_address(["wallet", token_program,
    // mint"], ATA_PROGRAM_ID).
    let (dev_ata, _bump) = Pubkey::find_program_address(
        &[
            dev_pubkey.as_ref(),
            token_program.as_ref(),
            mint_pubkey.as_ref(),
        ],
        &ata_program,
    );

    // Derive the Metaplex metadata PDA: ["metadata", metadata_program,
    // mint] in metadata_program.
    let (metadata_account, _meta_bump) = Pubkey::find_program_address(
        &[
            b"metadata",
            metadata_program.as_ref(),
            mint_pubkey.as_ref(),
        ],
        &metadata_program,
    );

    // ---------------- Build instructions ----------------

    // 1. createAccount for the mint.
    let create_mint_account_ix = system_instruction::create_account(
        &dev_pubkey,
        &mint_pubkey,
        rent_lamports,
        MINT_ACCOUNT_LEN,
        &token_program,
    );

    // 2. initializeMint2: data = [discriminator | decimals | mint_authority(32) | freeze_authority_option(1) | freeze_authority(0..=32)]
    let mut init_mint_data: Vec<u8> = Vec::with_capacity(35);
    init_mint_data.push(SPL_IX_INITIALIZE_MINT2);
    init_mint_data.push(args.token_decimals);
    init_mint_data.extend_from_slice(dev_pubkey.as_ref());
    init_mint_data.push(0); // freeze authority = None (Option<Pubkey> tag, 0 = None)
    let init_mint_ix = Instruction {
        program_id: token_program,
        accounts: vec![AccountMeta::new(mint_pubkey, false)],
        data: init_mint_data,
    };

    // 3. createAssociatedTokenAccount (idempotent variant, ix data = [1])
    //    — payer, ATA, owner, mint, system, token, rent
    let create_ata_ix = Instruction {
        program_id: ata_program,
        accounts: vec![
            AccountMeta::new(dev_pubkey, true),                                // funding payer
            AccountMeta::new(dev_ata, false),                                  // ata to create
            AccountMeta::new_readonly(dev_pubkey, false),                      // ata owner
            AccountMeta::new_readonly(mint_pubkey, false),                     // mint
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),  // system program
            AccountMeta::new_readonly(token_program, false),                   // token program
        ],
        data: vec![1], // 1 = CreateIdempotent
    };

    // 4. createMetadataAccountV3
    //    Borsh layout for the args:
    //      data: DataV2 {
    //        name: String,
    //        symbol: String,
    //        uri: String,
    //        seller_fee_basis_points: u16,
    //        creators: Option<Vec<Creator>>,
    //        collection: Option<Collection>,
    //        uses: Option<Uses>,
    //      },
    //      is_mutable: bool,
    //      collection_details: Option<CollectionDetails>,
    let mut meta_data: Vec<u8> = Vec::with_capacity(256);
    meta_data.push(MPL_IX_CREATE_METADATA_V3);
    // DataV2.name
    write_borsh_string(&mut meta_data, &args.metadata.name);
    // DataV2.symbol
    write_borsh_string(&mut meta_data, &args.metadata.symbol);
    // DataV2.uri
    write_borsh_string(&mut meta_data, &resolved_uri);
    // DataV2.seller_fee_basis_points (u16 LE)
    meta_data.extend_from_slice(&0u16.to_le_bytes());
    // DataV2.creators: Option<Vec<Creator>> — 1 creator: dev
    //   Some tag = 1
    //   Vec len = 1 (u32 LE)
    //   Creator { address: 32 bytes, verified: bool, share: u8 }
    meta_data.push(1); // Option::Some
    meta_data.extend_from_slice(&1u32.to_le_bytes());
    meta_data.extend_from_slice(dev_pubkey.as_ref());
    meta_data.push(1); // verified = true (dev signs this tx)
    meta_data.push(100); // share = 100%
    // DataV2.collection: None
    meta_data.push(0);
    // DataV2.uses: None
    meta_data.push(0);
    // is_mutable
    meta_data.push(0); // immutable — locks metadata against rug-rewrite
    // collection_details: None
    meta_data.push(0);

    let metadata_ix = Instruction {
        program_id: metadata_program,
        accounts: vec![
            AccountMeta::new(metadata_account, false), // metadata PDA (will be created)
            AccountMeta::new_readonly(mint_pubkey, false), // mint
            AccountMeta::new_readonly(dev_pubkey, true),   // mint authority (signer)
            AccountMeta::new(dev_pubkey, true),            // payer (signer)
            AccountMeta::new_readonly(dev_pubkey, true),   // update authority (signer)
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(
                Pubkey::from_str("SysvarRent111111111111111111111111111111111")?,
                false,
            ),
        ],
        data: meta_data,
    };

    // 5. mintTo: data = [discriminator | amount(u64 LE)]
    //    amount is in raw units (multiplied by 10^decimals).
    let amount_raw = args
        .token_supply
        .checked_mul(10u64.pow(args.token_decimals as u32))
        .ok_or_else(|| anyhow!("token_supply × 10^decimals overflows u64"))?;
    let mut mint_to_data: Vec<u8> = Vec::with_capacity(9);
    mint_to_data.push(SPL_IX_MINT_TO);
    mint_to_data.extend_from_slice(&amount_raw.to_le_bytes());
    let mint_to_ix = Instruction {
        program_id: token_program,
        accounts: vec![
            AccountMeta::new(mint_pubkey, false),         // mint
            AccountMeta::new(dev_ata, false),             // destination
            AccountMeta::new_readonly(dev_pubkey, true),  // mint authority (signer)
        ],
        data: mint_to_data,
    };

    // ---------------- Sign + submit ----------------
    let blockhash = rpc
        .get_latest_blockhash()
        .await
        .context("get latest blockhash")?;

    let tx = Transaction::new_signed_with_payer(
        &[
            create_mint_account_ix,
            init_mint_ix,
            create_ata_ix,
            metadata_ix,
            mint_to_ix,
        ],
        Some(&dev_pubkey),
        &[&dev_kp, &mint_kp],
        blockhash,
    );

    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .context("send and confirm token + metadata tx")?;

    info!(
        sig = %sig,
        mint = %mint_pubkey,
        dev = %dev_pubkey,
        supply = args.token_supply,
        decimals = args.token_decimals,
        "raydium-launch phase 1: token minted with metadata"
    );

    // pool_id is empty for now — phase 2 (pool init) returns a real
    // value once devnet-tested. UI surfaces a "create pool on Raydium"
    // CTA when pool_id is empty.
    Ok(RaydiumLaunchResult {
        mint: mint_pubkey.to_string(),
        pool_id: String::new(),
        bundle_id: sig.to_string(),
        lp_burn_signature: None,
    })
}

/// Borsh string serialization: 4-byte LE length + UTF-8 bytes. The
/// Metaplex DataV2 struct uses borsh, so all string fields go through
/// here.
fn write_borsh_string(buf: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
}

use anyhow::{anyhow, Context};
use tracing::info;

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> LaunchMetadata {
        LaunchMetadata {
            name: "Test".into(),
            symbol: "TST".into(),
            description: String::new(),
            twitter: None,
            telegram: None,
            website: None,
        }
    }

    fn args() -> RaydiumLaunchArgs {
        RaydiumLaunchArgs {
            dev_pubkey: "Dev1111".into(),
            metadata: meta(),
            metadata_uri: "ipfs://x".into(),
            image_path: None,
            token_supply: 1_000_000_000,
            token_decimals: 6,
            initial_lp_token_amount: 800_000_000,
            initial_lp_sol: 1.0,
            burn_lp: true,
            dev_buy_sol: 0.5,
            co_buyers: vec![],
        }
    }

    #[test]
    fn baseline_validates() {
        args().validate().unwrap();
    }

    #[test]
    fn rejects_zero_supply() {
        let mut a = args();
        a.token_supply = 0;
        assert!(a.validate().is_err());
    }

    #[test]
    fn rejects_lp_exceeds_supply() {
        let mut a = args();
        a.initial_lp_token_amount = 2_000_000_000;
        assert!(a.validate().is_err());
    }

    #[test]
    fn rejects_negative_dev_buy() {
        let mut a = args();
        a.dev_buy_sol = -0.1;
        assert!(a.validate().is_err());
    }

    #[test]
    fn caps_co_buyers_at_four() {
        let mut a = args();
        for i in 0..5 {
            a.co_buyers.push(RaydiumCoBuyer {
                pubkey: format!("co{i}"),
                sol: 0.1,
            });
        }
        assert!(a.validate().is_err());
    }

    #[test]
    fn implied_price_math() {
        let mut a = args();
        a.initial_lp_sol = 1.0;
        a.initial_lp_token_amount = 1_000_000_000;
        assert!((a.implied_initial_price_sol_per_token() - 1e-9).abs() < 1e-12);
    }
}
