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
// system_instruction has been moved to the solana_system_interface crate in
// newer Solana SDKs, but pulling that in is a dependency-graph headache for
// a single transfer call. Keep the SDK re-export until we do a wider deps
// refresh.
#[allow(deprecated)]
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
/// Send `sol` from a single source wallet to an arbitrary destination
/// pubkey. The dual of fan-out: lets the user consolidate sniper funds
/// back to the master, ship profits to a CEX deposit address, or move
/// SOL to a separate cold wallet — all from inside the app instead of
/// having to fire up Phantom for every transfer.
pub async fn send_sol(
    source: &StoredKeypair,
    destination: &str,
    sol: f64,
    net: &NetworkConfig,
) -> Result<String> {
    anyhow::ensure!(sol > 0.0, "amount must be positive");
    let lamports = (sol * LAMPORTS_PER_SOL as f64).round() as u64;
    anyhow::ensure!(lamports > 0, "amount {sol} rounds to zero lamports");

    let source_kp = wallet::from_stored(source)?;
    let source_pub = source_kp.pubkey();
    let dest = Pubkey::from_str(destination)
        .map_err(|e| anyhow!("invalid destination {destination}: {e}"))?;
    anyhow::ensure!(
        dest != source_pub,
        "destination is the same as the source wallet"
    );

    #[allow(deprecated)]
    let ix = system_instruction::transfer(&source_pub, &dest, lamports);

    let client =
        RpcClient::new_with_commitment(net.rpc_url.clone(), CommitmentConfig::confirmed());
    let recent_blockhash = client
        .get_latest_blockhash()
        .await
        .context("get latest blockhash")?;
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&source_pub),
        &[&source_kp],
        recent_blockhash,
    );
    let signature = client
        .send_and_confirm_transaction(&tx)
        .await
        .context("send and confirm send-sol tx")?;

    info!(
        sig = %signature,
        from = %source_pub,
        to = %dest,
        sol,
        "send sol submitted"
    );

    Ok(signature.to_string())
}

pub async fn fan_out_from_master(
    master: &StoredKeypair,
    recipients: &[String],
    sol_per_wallet: f64,
    net: &NetworkConfig,
) -> Result<FanOutResult> {
    let amounts = vec![sol_per_wallet; recipients.len()];
    fan_out_from_master_per_wallet(master, recipients, &amounts, net).await
}

/// Same as `fan_out_from_master` but each recipient receives its own
/// SOL amount. Lets the UI offer per-wallet input or randomized
/// distribution without needing multiple round-trips. Still a single
/// on-chain tx — one transfer instruction per recipient.
pub async fn fan_out_from_master_per_wallet(
    master: &StoredKeypair,
    recipients: &[String],
    amounts_sol: &[f64],
    net: &NetworkConfig,
) -> Result<FanOutResult> {
    anyhow::ensure!(!recipients.is_empty(), "no recipients");
    anyhow::ensure!(
        recipients.len() == amounts_sol.len(),
        "recipients.len() {} != amounts.len() {}",
        recipients.len(),
        amounts_sol.len()
    );
    anyhow::ensure!(
        recipients.len() <= 20,
        "fan-out capped at 20 recipients per tx for safety"
    );
    for (r, a) in recipients.iter().zip(amounts_sol) {
        anyhow::ensure!(*a > 0.0, "amount for {r} must be positive (got {a})");
    }

    let master_kp = wallet::from_stored(master)?;
    let master_pub = master_kp.pubkey();

    let mut instructions = Vec::with_capacity(recipients.len());
    for (r, amt) in recipients.iter().zip(amounts_sol) {
        let to = Pubkey::from_str(r).map_err(|e| anyhow!("invalid recipient {r}: {e}"))?;
        anyhow::ensure!(to != master_pub, "recipient {r} is the master wallet");
        let lamports = (*amt * LAMPORTS_PER_SOL as f64).round() as u64;
        anyhow::ensure!(
            lamports > 0,
            "amount {amt} for {r} rounds to zero lamports"
        );
        #[allow(deprecated)]
        instructions.push(system_instruction::transfer(&master_pub, &to, lamports));
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

    let total = amounts_sol.iter().sum::<f64>();
    let avg = if recipients.is_empty() {
        0.0
    } else {
        total / recipients.len() as f64
    };
    info!(
        sig = %signature,
        master = %master_pub,
        recipients = recipients.len(),
        total_sol = total,
        avg_sol_per_wallet = avg,
        "fan-out submitted"
    );

    Ok(FanOutResult {
        signature: signature.to_string(),
        master_pubkey: master_pub.to_string(),
        recipients: recipients.to_vec(),
        sol_per_wallet: avg,
        total_sol: total,
    })
}
