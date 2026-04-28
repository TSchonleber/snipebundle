use crate::config::NetworkConfig;
use crate::keystore::StoredKeypair;
use crate::wallet;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::transaction::VersionedTransaction;
use std::path::Path;
use tracing::{debug, info, warn};

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
    /// Bundle id for the launch tx itself (create + first up-to-4 co-buyers).
    pub bundle_id: String,
    /// Bundle ids for any follow-on co-buyer chunks (5 wallets each).
    /// Empty if all co-buyers fit in the launch bundle.
    #[serde(default)]
    pub follow_on_bundle_ids: Vec<String>,
    /// Errors from any follow-on bundles that failed (created token still
    /// succeeded if `bundle_id` is non-empty).
    #[serde(default)]
    pub follow_on_errors: Vec<String>,
    pub metadata_uri: String,
    pub dev_pubkey: String,
    pub dev_buy_sol: f64,
    pub co_buyer_count: usize,
    pub co_buyer_total_sol: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoBuyer {
    pub pubkey: String,
    pub sol: f64,
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

/// Build, sign, and submit a pump.fun launch with optional co-buyer wallets.
///
/// Bundle layout (Jito's 5-tx-per-bundle hard cap forces chunking):
///   Bundle 1 (the launch): tx[0]=create+dev_buy, tx[1..]=first 4 co-buyers
///   Bundle 2..N (follow-on): tx[0..5]=co-buyers, 5 wallets per bundle
///
/// The create lands in Bundle 1, so only the first 4 co-buyers land
/// same-block as the launch. Co-buyers 5+ land 1-2 blocks later, after
/// the curve has advanced slightly. Each bundle pays its own Jito tip.
///
/// Hard cap: 25 total co-buyers (= 1 launch + 5 follow-on bundles).
pub async fn execute_launch(
    dev: &StoredKeypair,
    metadata: &LaunchMetadata,
    metadata_uri: &str,
    dev_buy_sol: f64,
    co_buyers: &[(StoredKeypair, f64)],
    net: &NetworkConfig,
) -> Result<LaunchResult> {
    anyhow::ensure!(dev_buy_sol >= 0.0, "dev_buy_sol must be non-negative");
    anyhow::ensure!(
        co_buyers.len() <= 25,
        "co-buyers capped at 25 (chunked into 6 Jito bundles max)"
    );
    for (sk, sol) in co_buyers {
        anyhow::ensure!(*sol > 0.0, "co-buyer {} amount must be > 0", sk.pubkey);
        anyhow::ensure!(
            sk.pubkey != dev.pubkey,
            "co-buyer {} duplicates the dev wallet — drop it",
            sk.pubkey
        );
    }
    let mut seen = std::collections::HashSet::new();
    for (sk, _) in co_buyers {
        anyhow::ensure!(
            seen.insert(sk.pubkey.clone()),
            "duplicate co-buyer pubkey {}",
            sk.pubkey
        );
    }

    // Split: launch bundle gets first 4 co-buyers, rest split into chunks of 5.
    let (in_launch, follow_on) = co_buyers.split_at(co_buyers.len().min(4));

    let mint_kp = Keypair::new();
    let mint_pub = mint_kp.pubkey().to_string();

    // ---------- Bundle 1: launch ----------
    let mut actions = vec![serde_json::json!({
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
    })];
    for (sk, sol) in in_launch {
        actions.push(serde_json::json!({
            "publicKey": sk.pubkey,
            "action": "buy",
            "mint": mint_pub,
            "denominatedInSol": "true",
            "amount": sol,
            "slippage": net.slippage_bps,
            "priorityFee": net.priority_fee_sol,
            "pool": "pump",
        }));
    }

    debug!(
        mint = %mint_pub,
        dev = %dev.pubkey,
        in_launch = in_launch.len(),
        follow_on = follow_on.len(),
        "submitting launch bundle 1 to /api/trade-local"
    );
    let client = reqwest::Client::new();
    let resp = client
        .post(&net.trade_local_url)
        .json(&actions)
        .send()
        .await
        .context("POST trade-local launch bundle")?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("trade-local launch {status}: {text}");
    }

    let unsigned_b58 = parse_unsigned_response(&text)?;
    anyhow::ensure!(
        unsigned_b58.len() == 1 + in_launch.len(),
        "expected {} txs, got {}",
        1 + in_launch.len(),
        unsigned_b58.len()
    );

    let dev_kp = wallet::from_stored(dev)?;
    let in_launch_kps: Vec<Keypair> = in_launch
        .iter()
        .map(|(sk, _)| wallet::from_stored(sk))
        .collect::<Result<Vec<_>>>()?;

    let mut signed_b58 = Vec::with_capacity(unsigned_b58.len());
    signed_b58.push(sign_with_keys(&unsigned_b58[0], &[&dev_kp, &mint_kp])?);
    for (i, b58) in unsigned_b58.iter().enumerate().skip(1) {
        let kp = &in_launch_kps[i - 1];
        verify_signer(b58, kp.pubkey(), i)?;
        signed_b58.push(sign_with_keys(b58, &[kp])?);
    }

    let bundle_id =
        crate::bundler::submit_jito_bundle(&net.jito_block_engine, &signed_b58).await?;
    info!(
        mint = %mint_pub,
        %bundle_id,
        "launch bundle submitted; firing follow-on chunks shortly"
    );

    // ---------- Follow-on bundles ----------
    // Wait briefly so the launch bundle has a chance to land (otherwise
    // follow-on buys reference a mint that doesn't exist yet).
    let mut follow_on_bundle_ids: Vec<String> = Vec::new();
    let mut follow_on_errors: Vec<String> = Vec::new();
    if !follow_on.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;

        for (chunk_idx, chunk) in follow_on.chunks(5).enumerate() {
            match submit_followon_chunk(&client, &mint_pub, chunk, net).await {
                Ok(bid) => {
                    info!(chunk = chunk_idx + 1, bundle_id = %bid, "follow-on chunk submitted");
                    follow_on_bundle_ids.push(bid);
                }
                Err(e) => {
                    let msg = format!("chunk {}: {e}", chunk_idx + 1);
                    warn!(error = %e, "follow-on chunk failed");
                    follow_on_errors.push(msg);
                }
            }
        }
    }

    let total_co = co_buyers.iter().map(|(_, s)| *s).sum::<f64>();
    Ok(LaunchResult {
        mint: mint_pub,
        bundle_id,
        follow_on_bundle_ids,
        follow_on_errors,
        metadata_uri: metadata_uri.to_string(),
        dev_pubkey: dev.pubkey.clone(),
        dev_buy_sol,
        co_buyer_count: co_buyers.len(),
        co_buyer_total_sol: total_co,
    })
}

async fn submit_followon_chunk(
    client: &reqwest::Client,
    mint: &str,
    chunk: &[(StoredKeypair, f64)],
    net: &NetworkConfig,
) -> Result<String> {
    let mut actions = Vec::with_capacity(chunk.len());
    for (i, (sk, sol)) in chunk.iter().enumerate() {
        let priority_fee = if i == 0 {
            net.jito_tip_sol
        } else {
            net.priority_fee_sol
        };
        actions.push(serde_json::json!({
            "publicKey": sk.pubkey,
            "action": "buy",
            "mint": mint,
            "denominatedInSol": "true",
            "amount": sol,
            "slippage": net.slippage_bps,
            "priorityFee": priority_fee,
            "pool": "pump",
        }));
    }
    let resp = client
        .post(&net.trade_local_url)
        .json(&actions)
        .send()
        .await
        .context("POST trade-local follow-on chunk")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("trade-local follow-on {status}: {text}");
    }
    let unsigned_b58 = parse_unsigned_response(&text)?;
    anyhow::ensure!(
        unsigned_b58.len() == chunk.len(),
        "follow-on tx count mismatch: expected {}, got {}",
        chunk.len(),
        unsigned_b58.len()
    );
    let kps: Vec<Keypair> = chunk
        .iter()
        .map(|(sk, _)| wallet::from_stored(sk))
        .collect::<Result<Vec<_>>>()?;
    let mut signed = Vec::with_capacity(chunk.len());
    for (i, b58) in unsigned_b58.iter().enumerate() {
        verify_signer(b58, kps[i].pubkey(), i)?;
        signed.push(sign_with_keys(b58, &[&kps[i]])?);
    }
    crate::bundler::submit_jito_bundle(&net.jito_block_engine, &signed).await
}

fn verify_signer(unsigned_b58: &str, expected: solana_sdk::pubkey::Pubkey, idx: usize) -> Result<()> {
    let raw = bs58::decode(unsigned_b58)
        .into_vec()
        .map_err(|e| anyhow!("decode tx b58: {e}"))?;
    let tx: VersionedTransaction =
        bincode::deserialize(&raw).context("deserialize tx")?;
    let static_keys = tx.message.static_account_keys();
    let actual = *static_keys
        .first()
        .ok_or_else(|| anyhow!("tx[{idx}] missing static_account_keys[0]"))?;
    anyhow::ensure!(
        actual == expected,
        "signer mismatch at tx[{idx}]: expected {expected}, got {actual}"
    );
    Ok(())
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
