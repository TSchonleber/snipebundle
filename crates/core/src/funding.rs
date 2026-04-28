//! Plain master → snipers fan-out.
//!
//! This is intentionally NOT a privacy feature — it's a convenience for users
//! who don't want to manually fund each sniper wallet. The transfers are
//! ordinary System Program `transfer` instructions, fully visible on-chain,
//! one batched transaction signed by the master keypair.
//!
//! Users who DO want operational privacy should fund each sniper separately
//! from independent sources (CEX accounts, fresh wallets) — that path is
//! always available and described on the Wallets page.

use crate::config::NetworkConfig;
use crate::keystore::StoredKeypair;
use crate::wallet;
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;
use solana_sdk::system_instruction;
use solana_sdk::transaction::Transaction;
use std::str::FromStr;
use tracing::info;

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

#[derive(Debug, Clone, Serialize)]
pub struct FanOutResult {
    pub signature: String,
    pub master_pubkey: String,
    pub recipients: Vec<String>,
    pub sol_per_wallet: f64,
    pub total_sol: f64,
}

/// Build, sign, and submit a single Solana transaction containing one
/// System Program transfer per recipient. Master pays for all of them.
///
/// This is a single tx, not a Jito bundle — there's nothing to compete with
/// here. Just a regular wallet-to-wallet move.
pub async fn fan_out_from_master(
    master: &StoredKeypair,
    recipients: &[String],
    sol_per_wallet: f64,
    net: &NetworkConfig,
) -> Result<FanOutResult> {
    anyhow::ensure!(!recipients.is_empty(), "no recipients");
    anyhow::ensure!(sol_per_wallet > 0.0, "sol_per_wallet must be positive");
    anyhow::ensure!(
        recipients.len() <= 20,
        "fan-out capped at 20 recipients per tx for safety"
    );

    let lamports_each = (sol_per_wallet * LAMPORTS_PER_SOL as f64).round() as u64;
    anyhow::ensure!(lamports_each > 0, "amount rounds to zero lamports");

    let master_kp = wallet::from_stored(master)?;
    let master_pub = master_kp.pubkey();

    let mut instructions = Vec::with_capacity(recipients.len());
    for r in recipients {
        let to = Pubkey::from_str(r).map_err(|e| anyhow!("invalid recipient {r}: {e}"))?;
        anyhow::ensure!(to != master_pub, "recipient {r} is the master wallet");
        instructions.push(system_instruction::transfer(&master_pub, &to, lamports_each));
    }

    let client = RpcClient::new_with_commitment(net.rpc_url.clone(), CommitmentConfig::confirmed());

    let recent_blockhash = client
        .get_latest_blockhash()
        .await
        .context("get latest blockhash")?;

    let tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&master_pub),
        &[&master_kp],
        recent_blockhash,
    );

    let signature = client
        .send_and_confirm_transaction(&tx)
        .await
        .context("send and confirm fan-out tx")?;

    let total = sol_per_wallet * recipients.len() as f64;
    info!(
        sig = %signature,
        master = %master_pub,
        recipients = recipients.len(),
        sol_per_wallet,
        total_sol = total,
        "fan-out submitted"
    );

    Ok(FanOutResult {
        signature: signature.to_string(),
        master_pubkey: master_pub.to_string(),
        recipients: recipients.to_vec(),
        sol_per_wallet,
        total_sol: total,
    })
}
