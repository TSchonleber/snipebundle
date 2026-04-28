//! Solana RPC balance helpers. Read-only — never sends transactions.
//!
//! Snipebundle is non-custodial; funding wallets is the user's job.
//! This module only *observes* on-chain balances so the UI can show whether
//! a sniper wallet is funded.

use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::collections::HashMap;

const LAMPORTS_PER_SOL: f64 = 1_000_000_000.0;

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
