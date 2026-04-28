use crate::config::NetworkConfig;
use crate::keystore::StoredKeypair;
use crate::wallet;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::transaction::VersionedTransaction;
use std::path::Path;
use tracing::{debug, info};

const PUMPFUN_IPFS: &str = "https://pump.fun/api/ipfs";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchMetadata {
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub twitter: Option<String>,
    pub telegram: Option<String>,
    pub website: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchResult {
    pub mint: String,
    pub bundle_id: String,
    pub metadata_uri: String,
    pub dev_pubkey: String,
    pub dev_buy_sol: f64,
}

/// Upload image + metadata to pump.fun's IPFS endpoint, returning the
/// metadata URI used by the create action.
pub async fn upload_metadata(
    meta: &LaunchMetadata,
    image_path: Option<&Path>,
) -> Result<String> {
    let client = reqwest::Client::new();
    let mut form = reqwest::multipart::Form::new()
        .text("name", meta.name.clone())
        .text("symbol", meta.symbol.clone())
        .text("description", meta.description.clone())
        .text("showName", "true");

    if let Some(t) = &meta.twitter {
        form = form.text("twitter", t.clone());
    }
    if let Some(t) = &meta.telegram {
        form = form.text("telegram", t.clone());
    }
    if let Some(w) = &meta.website {
        form = form.text("website", w.clone());
    }

    if let Some(path) = image_path {
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("read image at {}", path.display()))?;
        let filename = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("image")
            .to_string();
        let mime = guess_image_mime(path).unwrap_or("application/octet-stream");
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str(mime)
            .map_err(|e| anyhow!("mime: {e}"))?;
        form = form.part("file", part);
    }

    debug!(endpoint = PUMPFUN_IPFS, "uploading metadata");
    let resp = client
        .post(PUMPFUN_IPFS)
        .multipart(form)
        .send()
        .await
        .context("POST pump.fun ipfs")?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("pump.fun ipfs {status}: {text}");
    }

    let v: serde_json::Value = serde_json::from_str(&text).context("parse ipfs json")?;
    let uri = v
        .get("metadataUri")
        .or_else(|| v.get("metadata_uri"))
        .or_else(|| v.get("uri"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| anyhow!("no metadataUri in pump.fun ipfs response: {text}"))?;
    info!(uri, "metadata uploaded");
    Ok(uri.to_string())
}

fn guess_image_mime(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|e| e.to_str())?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Build, sign, and submit a single-bundle pump.fun launch:
///   tx[0] = create token + dev wallet's opening buy (atomic, both inside one tx)
///
/// Defensive against third-party snipers (Jito tip ensures same-block landing).
/// No additional sniper wallets — this is the legitimate launch flow only.
pub async fn execute_launch(
    dev: &StoredKeypair,
    metadata: &LaunchMetadata,
    metadata_uri: &str,
    dev_buy_sol: f64,
    net: &NetworkConfig,
) -> Result<LaunchResult> {
    anyhow::ensure!(dev_buy_sol >= 0.0, "dev_buy_sol must be non-negative");

    let mint_kp = Keypair::new();
    let mint_pub = mint_kp.pubkey().to_string();

    let action = serde_json::json!({
        "publicKey": dev.pubkey,
        "action": "create",
        "tokenMetadata": {
            "name": metadata.name,
            "symbol": metadata.symbol,
            "uri": metadata_uri,
        },
        "mint": mint_pub,
        "denominatedInSol": "true",
        "amount": dev_buy_sol,
        "slippage": net.slippage_bps,
        "priorityFee": net.jito_tip_sol,
        "pool": "pump",
    });

    debug!(mint = %mint_pub, dev = %dev.pubkey, "submitting create to /api/trade-local");
    let client = reqwest::Client::new();
    let resp = client
        .post(&net.trade_local_url)
        .json(&serde_json::json!([action]))
        .send()
        .await
        .context("POST trade-local create")?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("trade-local create {status}: {text}");
    }

    let unsigned_b58 = parse_unsigned_response(&text)?;
    anyhow::ensure!(
        !unsigned_b58.is_empty(),
        "trade-local returned no transactions"
    );

    let dev_kp = wallet::from_stored(dev)?;
    let mut signed_b58 = Vec::with_capacity(unsigned_b58.len());
    for b58 in &unsigned_b58 {
        let signed = sign_with_keys(b58, &[&dev_kp, &mint_kp])?;
        signed_b58.push(signed);
    }

    let bundle_id = crate::bundler::submit_jito_bundle(&net.jito_block_engine, &signed_b58).await?;

    Ok(LaunchResult {
        mint: mint_pub,
        bundle_id,
        metadata_uri: metadata_uri.to_string(),
        dev_pubkey: dev.pubkey.clone(),
        dev_buy_sol,
    })
}

fn parse_unsigned_response(body: &str) -> Result<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(body).context("parse trade-local json")?;
    let arr = v
        .as_array()
        .or_else(|| v.get("transactions").and_then(|x| x.as_array()))
        .ok_or_else(|| anyhow!("trade-local response not an array: {body}"))?;
    arr.iter()
        .map(|e| {
            e.as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| anyhow!("non-string tx in array: {e:?}"))
        })
        .collect()
}

/// Sign a single base58-encoded VersionedTransaction with whichever of the
/// provided keypairs match each required signer slot.
fn sign_with_keys(unsigned_b58: &str, keys: &[&Keypair]) -> Result<String> {
    let raw = bs58::decode(unsigned_b58)
        .into_vec()
        .map_err(|e| anyhow!("decode tx b58: {e}"))?;
    let mut tx: VersionedTransaction =
        bincode::deserialize(&raw).context("deserialize VersionedTransaction")?;

    let static_keys = tx.message.static_account_keys();
    let header = tx.message.header();
    let num_required = header.num_required_signatures as usize;

    let message_bytes = tx.message.serialize();

    let mut signatures = vec![Signature::default(); num_required];
    for i in 0..num_required {
        let pk = static_keys
            .get(i)
            .ok_or_else(|| anyhow!("static key index {i} out of range"))?;
        let signer = keys
            .iter()
            .find(|k| k.pubkey() == *pk)
            .ok_or_else(|| anyhow!("no keypair matches required signer {pk}"))?;
        signatures[i] = signer.sign_message(&message_bytes);
    }
    tx.signatures = signatures;

    let bytes = bincode::serialize(&tx).context("reserialize signed tx")?;
    Ok(bs58::encode(bytes).into_string())
}
