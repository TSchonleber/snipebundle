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
    pub metadata_uri: String,
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
            !self.metadata_uri.is_empty(),
            "metadata_uri required (upload to IPFS first)"
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

/// **NOT YET IMPLEMENTED.** v0.1.57 ships only the data model + stub.
///
/// The on-chain implementation needs:
///   - Raydium CPMM IDL + ix discriminators
///   - PDA derivations (pool, vaults, authority)
///   - Metaplex metadata account creation
///   - LP-token burn ix
///   - Bundled first-buy swap ix
///   - Devnet test infrastructure to validate before mainnet
///
/// See `RAYDIUM_LAUNCH_SPEC.md` for the full plan. Lands in v0.1.58+.
pub async fn execute_raydium_launch(
    _args: &RaydiumLaunchArgs,
    _net: &NetworkConfig,
    _dev: &StoredKeypair,
    _co_buyers: &[(StoredKeypair, f64)],
) -> Result<RaydiumLaunchResult> {
    anyhow::bail!(
        "Raydium-direct launch not yet implemented — v0.1.57 ships the UI surface and data model only. \
         On-chain ix building lands in v0.1.58+ after devnet testing infra is up. \
         See RAYDIUM_LAUNCH_SPEC.md for the full plan."
    )
}

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
