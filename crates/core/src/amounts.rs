//! Amount strategy for buy bundles.
//!
//! Lets the user specify how SOL is allocated across the snipers in a bundle:
//!   - Uniform: every wallet buys the same amount.
//!   - PerWallet: explicit map (pubkey -> SOL).
//!   - Random: each wallet draws an independent uniform amount in [min, max].
//!
//! Resolves to a Vec<f64> aligned to a given wallet pubkey list, ready to pass
//! into bundler::execute_buy_per_wallet.

use anyhow::{anyhow, Result};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AmountStrategy {
    Uniform { sol: f64 },
    PerWallet { sol_per_wallet: HashMap<String, f64> },
    Random { min_sol: f64, max_sol: f64 },
}

impl AmountStrategy {
    pub fn validate(&self) -> Result<()> {
        match self {
            AmountStrategy::Uniform { sol } => {
                anyhow::ensure!(*sol > 0.0, "uniform sol must be > 0");
            }
            AmountStrategy::PerWallet { sol_per_wallet } => {
                anyhow::ensure!(!sol_per_wallet.is_empty(), "per-wallet map empty");
                for (k, v) in sol_per_wallet {
                    anyhow::ensure!(*v > 0.0, "wallet {k} amount must be > 0");
                }
            }
            AmountStrategy::Random { min_sol, max_sol } => {
                anyhow::ensure!(
                    *min_sol > 0.0 && *max_sol >= *min_sol,
                    "random range must satisfy 0 < min <= max"
                );
            }
        }
        Ok(())
    }

    /// Resolve to amounts aligned to `pubkeys`. Random draws are deterministic
    /// per-call but independent across wallets.
    pub fn resolve(&self, pubkeys: &[String]) -> Result<Vec<f64>> {
        match self {
            AmountStrategy::Uniform { sol } => Ok(vec![*sol; pubkeys.len()]),
            AmountStrategy::PerWallet { sol_per_wallet } => pubkeys
                .iter()
                .map(|pk| {
                    sol_per_wallet
                        .get(pk)
                        .copied()
                        .ok_or_else(|| anyhow!("no per-wallet amount for {pk}"))
                })
                .collect(),
            AmountStrategy::Random { min_sol, max_sol } => {
                let mut rng = rand::thread_rng();
                Ok(pubkeys
                    .iter()
                    .map(|_| rng.gen_range(*min_sol..=*max_sol))
                    .collect())
            }
        }
    }
}
