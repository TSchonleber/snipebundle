use crate::config::NetworkConfig;
use crate::keystore::StoredKeypair;
use crate::wallet;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use solana_sdk::signer::Signer;
use solana_sdk::transaction::VersionedTransaction;
use tracing::{debug, info};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeAction {
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub action: String,
    pub mint: String,
    #[serde(rename = "denominatedInSol")]
    pub denominated_in_sol: String,
    pub amount: f64,
    pub slippage: u32,
    #[serde(rename = "priorityFee")]
    pub priority_fee: f64,
    pub pool: String,
}

impl TradeAction {
    pub fn buy(pubkey: &str, mint: &str, sol_amount: f64, slippage_bps: u32, priority_fee: f64) -> Self {
        Self {
            public_key: pubkey.to_string(),
            action: "buy".into(),
            mint: mint.to_string(),
            denominated_in_sol: "true".into(),
            amount: sol_amount,
            slippage: slippage_bps,
            priority_fee,
            pool: "pump".into(),
        }
    }

    /// Sell exactly `tokens` of `mint` from the wallet's holdings. Use this
    /// after querying the wallet's token balance via balance::get_token_balance
    /// to avoid PumpPortal's "amount" being interpreted as raw token count.
    pub fn sell_tokens(
        pubkey: &str,
        mint: &str,
        tokens: f64,
        slippage_bps: u32,
        priority_fee: f64,
    ) -> Self {
        Self {
            public_key: pubkey.to_string(),
            action: "sell".into(),
            mint: mint.to_string(),
            denominated_in_sol: "false".into(),
            amount: tokens,
            slippage: slippage_bps,
            priority_fee,
            pool: "pump".into(),
        }
    }
}

pub fn build_actions_for_buy(
    snipers: &[StoredKeypair],
    mint: &str,
    sol_per_wallet: f64,
    net: &NetworkConfig,
) -> Result<Vec<TradeAction>> {
    let amounts = vec![sol_per_wallet; snipers.len()];
    build_actions_for_buy_per_wallet(snipers, mint, &amounts, net)
}

pub fn build_actions_for_buy_per_wallet(
    snipers: &[StoredKeypair],
    mint: &str,
    amounts_sol: &[f64],
    net: &NetworkConfig,
) -> Result<Vec<TradeAction>> {
    anyhow::ensure!(!snipers.is_empty(), "no sniper wallets selected");
    anyhow::ensure!(
        snipers.len() <= 5,
        "Jito/Pumpportal bundle limit is 5 transactions"
    );
    anyhow::ensure!(
        amounts_sol.len() == snipers.len(),
        "amounts.len() {} != snipers.len() {}",
        amounts_sol.len(),
        snipers.len()
    );
    for (kp, amt) in snipers.iter().zip(amounts_sol) {
        anyhow::ensure!(*amt > 0.0, "wallet {} amount must be > 0 SOL", kp.pubkey);
    }

    Ok(snipers
        .iter()
        .zip(amounts_sol)
        .enumerate()
        .map(|(i, (kp, amt))| {
            let priority_fee = if i == 0 {
                net.jito_tip_sol
            } else {
                net.priority_fee_sol
            };
            TradeAction::buy(&kp.pubkey, mint, *amt, net.slippage_bps, priority_fee)
        })
        .collect())
}

/// Build sell actions where each entry sells the wallet's exact computed token
/// amount. Caller is responsible for computing those (typically via
/// `balance::get_token_balance` × percent).
pub fn build_actions_for_sell_tokens(
    snipers: &[StoredKeypair],
    mint: &str,
    token_amounts: &[f64],
    net: &NetworkConfig,
) -> Result<Vec<TradeAction>> {
    anyhow::ensure!(!snipers.is_empty(), "no sniper wallets selected");
    anyhow::ensure!(
        snipers.len() <= 5,
        "Jito/Pumpportal bundle limit is 5 transactions"
    );
    anyhow::ensure!(
        token_amounts.len() == snipers.len(),
        "token_amounts.len() {} != snipers.len() {}",
        token_amounts.len(),
        snipers.len()
    );

    Ok(snipers
        .iter()
        .zip(token_amounts)
        .enumerate()
        .map(|(i, (kp, tokens))| {
            let priority_fee = if i == 0 {
                net.jito_tip_sol
            } else {
                net.priority_fee_sol
            };
            TradeAction::sell_tokens(&kp.pubkey, mint, *tokens, net.slippage_bps, priority_fee)
        })
        .collect())
}

pub async fn fetch_unsigned_txs(
    trade_local_url: &str,
    actions: &[TradeAction],
) -> Result<Vec<String>> {
    let client = reqwest::Client::new();
    let resp = client
        .post(trade_local_url)
        .json(actions)
        .send()
        .await
        .context("POST trade-local")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("trade-local {status}: {body}");
    }

    let body = resp.text().await.context("read trade-local body")?;
    let v: serde_json::Value = serde_json::from_str(&body).context("parse trade-local json")?;

    let arr = v
        .as_array()
        .or_else(|| v.get("transactions").and_then(|x| x.as_array()))
        .ok_or_else(|| anyhow!("trade-local response not an array: {body}"))?;

    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        let s = entry
            .as_str()
            .ok_or_else(|| anyhow!("non-string tx in array: {entry:?}"))?;
        out.push(s.to_string());
    }
    debug!(count = out.len(), "received unsigned txs");
    Ok(out)
}

/// Sign N unsigned transactions returned by /api/trade-local with N sniper
/// keypairs. **Crucially:** verifies each tx's required-signer pubkey
/// matches the expected sniper before signing. If PumpPortal ever returns
/// txs in a different order than the actions sent, this fails loudly
/// instead of silently signing the wrong wallet's tx.
pub fn sign_txs(unsigned_b58: &[String], snipers: &[StoredKeypair]) -> Result<Vec<String>> {
    anyhow::ensure!(
        unsigned_b58.len() == snipers.len(),
        "tx count {} != sniper count {}",
        unsigned_b58.len(),
        snipers.len()
    );

    use solana_sdk::pubkey::Pubkey;
    use std::str::FromStr;

    let mut signed = Vec::with_capacity(unsigned_b58.len());
    for (b58, sk) in unsigned_b58.iter().zip(snipers) {
        let raw = bs58::decode(b58)
            .into_vec()
            .map_err(|e| anyhow!("decode tx b58: {e}"))?;
        let mut tx: VersionedTransaction =
            bincode::deserialize(&raw).context("deserialize VersionedTransaction")?;

        let static_keys = tx.message.static_account_keys();
        let header = tx.message.header();
        anyhow::ensure!(
            header.num_required_signatures >= 1,
            "tx requires no signers"
        );
        let expected = Pubkey::from_str(&sk.pubkey)
            .map_err(|e| anyhow!("bad stored pubkey {}: {e}", sk.pubkey))?;
        let actual = *static_keys
            .first()
            .ok_or_else(|| anyhow!("tx missing static_account_keys[0]"))?;
        anyhow::ensure!(
            actual == expected,
            "bundle order mismatch: expected signer {} for slot, got {}. Refusing to sign.",
            expected,
            actual
        );

        let kp = wallet::from_stored(sk)?;
        let message_bytes = tx.message.serialize();
        let sig = kp.sign_message(&message_bytes);

        anyhow::ensure!(
            !tx.signatures.is_empty(),
            "tx has no signature slots — unexpected"
        );
        tx.signatures[0] = sig;

        let signed_bytes = bincode::serialize(&tx).context("reserialize tx")?;
        signed.push(bs58::encode(signed_bytes).into_string());
    }
    Ok(signed)
}

pub async fn submit_jito_bundle(jito_url: &str, signed_b58: &[String]) -> Result<String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendBundle",
        "params": [signed_b58],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(jito_url)
        .json(&body)
        .send()
        .await
        .context("POST sendBundle")?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("jito {status}: {text}");
    }

    let v: serde_json::Value = serde_json::from_str(&text).context("parse jito response")?;
    if let Some(err) = v.get("error") {
        anyhow::bail!("jito rpc error: {err}");
    }
    let bundle_id = v
        .get("result")
        .and_then(|x| x.as_str())
        .ok_or_else(|| anyhow!("no result in jito response: {text}"))?
        .to_string();

    info!(bundle_id, "submitted Jito bundle");
    Ok(bundle_id)
}

pub async fn execute_buy(
    snipers: &[StoredKeypair],
    mint: &str,
    sol_per_wallet: f64,
    net: &NetworkConfig,
) -> Result<String> {
    let actions = build_actions_for_buy(snipers, mint, sol_per_wallet, net)?;
    let unsigned = fetch_unsigned_txs(&net.trade_local_url, &actions).await?;
    let signed = sign_txs(&unsigned, snipers)?;
    submit_jito_bundle(&net.jito_block_engine, &signed).await
}

pub async fn execute_buy_per_wallet(
    snipers: &[StoredKeypair],
    mint: &str,
    amounts_sol: &[f64],
    net: &NetworkConfig,
) -> Result<String> {
    let actions = build_actions_for_buy_per_wallet(snipers, mint, amounts_sol, net)?;
    let unsigned = fetch_unsigned_txs(&net.trade_local_url, &actions).await?;
    let signed = sign_txs(&unsigned, snipers)?;
    submit_jito_bundle(&net.jito_block_engine, &signed).await
}

/// Sell 100% of each sniper's holdings of `mint`.
pub async fn execute_sell(
    snipers: &[StoredKeypair],
    mint: &str,
    net: &NetworkConfig,
) -> Result<String> {
    execute_sell_pct(snipers, mint, 100.0, net).await
}

/// Sell `percent` (1..=100) of each sniper's holdings.
///
/// Queries each wallet's actual token balance via Solana RPC, then submits a
/// bundle with the precise token amount per wallet. Wallets with zero balance
/// are dropped (they can't sell what they don't have, and including them would
/// cause the whole bundle to bounce).
pub async fn execute_sell_pct(
    snipers: &[StoredKeypair],
    mint: &str,
    percent: f64,
    net: &NetworkConfig,
) -> Result<String> {
    anyhow::ensure!(
        percent > 0.0 && percent <= 100.0,
        "sell percent must be in (0, 100]"
    );
    let owners: Vec<String> = snipers.iter().map(|s| s.pubkey.clone()).collect();
    let balances = crate::balance::get_token_balances(&net.rpc_url, &owners, mint).await;

    let mut active_snipers = Vec::with_capacity(snipers.len());
    let mut amounts = Vec::with_capacity(snipers.len());
    for sk in snipers {
        let bal = *balances.get(&sk.pubkey).unwrap_or(&0.0);
        if bal <= 0.0 {
            tracing::warn!(wallet = %sk.pubkey, mint = %mint, "skipping wallet with zero token balance");
            continue;
        }
        let to_sell = bal * (percent / 100.0);
        if to_sell <= 0.0 {
            continue;
        }
        active_snipers.push(sk.clone());
        amounts.push(to_sell);
    }

    anyhow::ensure!(
        !active_snipers.is_empty(),
        "no wallets hold any of {mint}; nothing to sell"
    );

    tracing::info!(
        mint = %mint,
        active = active_snipers.len(),
        skipped = snipers.len() - active_snipers.len(),
        percent,
        "computed sell amounts"
    );

    let actions = build_actions_for_sell_tokens(&active_snipers, mint, &amounts, net)?;
    let unsigned = fetch_unsigned_txs(&net.trade_local_url, &actions).await?;
    let signed = sign_txs(&unsigned, &active_snipers)?;
    submit_jito_bundle(&net.jito_block_engine, &signed).await
}
