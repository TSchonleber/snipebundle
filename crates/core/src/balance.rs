//! Solana RPC balance helpers. Read-only — never sends transactions.
//!
//! Snipebundle is non-custodial; funding wallets is the user's job.
//! This module only *observes* on-chain balances so the UI can show whether
//! a sniper wallet is funded.

use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::collections::HashMap;

const LAMPORTS_PER_SOL: f64 = 1_000_000_000.0;

/// SPL token program ID (Tokenkeg... — the original SPL Token program).
const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// Fetch SOL balance for one pubkey via JSON-RPC.
pub async fn get_sol_balance(rpc_url: &str, pubkey: &str) -> Result<f64> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getBalance",
        "params": [pubkey]
    });
    let client = reqwest::Client::new();
    let resp = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .context("getBalance request")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("rpc {status}: {text}");
    }
    let v: serde_json::Value = serde_json::from_str(&text).context("parse rpc json")?;
    if let Some(err) = v.get("error") {
        anyhow::bail!("rpc error: {err}");
    }
    let lamports = v
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow!("no result.value in rpc response: {text}"))?;
    Ok(lamports as f64 / LAMPORTS_PER_SOL)
}

/// Fetch the SPL token balance (in human-readable units, accounting for the
/// mint's decimals) that `owner_pubkey` holds for `mint_pubkey`.
///
/// Returns 0.0 if the owner has no associated token account for that mint.
/// This is the function that determines "how much can wallet X actually sell."
pub async fn get_token_balance(
    rpc_url: &str,
    owner_pubkey: &str,
    mint_pubkey: &str,
) -> Result<f64> {
    // getTokenAccountsByOwner returns parsed accounts including uiAmount, which
    // is decimals-aware and human-readable. Filter by mint to get exactly the
    // accounts holding this token.
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTokenAccountsByOwner",
        "params": [
            owner_pubkey,
            { "mint": mint_pubkey },
            { "encoding": "jsonParsed" }
        ]
    });
    let client = reqwest::Client::new();
    let resp = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .context("getTokenAccountsByOwner request")?;
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).context("parse rpc json")?;
    if let Some(err) = v.get("error") {
        anyhow::bail!("rpc error: {err}");
    }
    let accounts = v
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|x| x.as_array())
        .ok_or_else(|| anyhow!("no result.value: {text}"))?;

    let mut total = 0.0;
    for acc in accounts {
        if let Some(amt) = acc
            .get("account")
            .and_then(|a| a.get("data"))
            .and_then(|d| d.get("parsed"))
            .and_then(|p| p.get("info"))
            .and_then(|i| i.get("tokenAmount"))
            .and_then(|t| t.get("uiAmount"))
            .and_then(|x| x.as_f64())
        {
            total += amt;
        }
    }
    Ok(total)
}

/// Batch-fetch SOL balances for many pubkeys. Runs in parallel; failures on
/// individual pubkeys are logged but don't abort the batch — those entries
/// just don't appear in the returned map.
pub async fn get_sol_balances(
    rpc_url: &str,
    pubkeys: &[String],
) -> HashMap<String, f64> {
    let mut futures = Vec::with_capacity(pubkeys.len());
    for pk in pubkeys {
        let pk = pk.clone();
        let url = rpc_url.to_string();
        futures.push(async move {
            match get_sol_balance(&url, &pk).await {
                Ok(sol) => Some((pk, sol)),
                Err(e) => {
                    tracing::warn!(pubkey = %pk, error = %e, "balance fetch failed");
                    None
                }
            }
        });
    }
    let results = futures_util::future::join_all(futures).await;
    results.into_iter().flatten().collect()
}

/// Token-balance batch sibling of get_sol_balances.
pub async fn get_token_balances(
    rpc_url: &str,
    owners: &[String],
    mint: &str,
) -> HashMap<String, f64> {
    let mut futures = Vec::with_capacity(owners.len());
    for o in owners {
        let owner = o.clone();
        let url = rpc_url.to_string();
        let m = mint.to_string();
        futures.push(async move {
            match get_token_balance(&url, &owner, &m).await {
                Ok(amt) => Some((owner, amt)),
                Err(e) => {
                    tracing::warn!(owner = %owner, mint = %m, error = %e, "token balance failed");
                    None
                }
            }
        });
    }
    let results = futures_util::future::join_all(futures).await;
    results.into_iter().flatten().collect()
}

/// Avoid using the deprecated import elsewhere.
pub fn token_program_id() -> &'static str {
    TOKEN_PROGRAM_ID
}
