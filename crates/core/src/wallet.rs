use crate::keystore::StoredKeypair;
use anyhow::Result;
use solana_sdk::signature::{Keypair, Signer};

pub fn generate(label: &str) -> StoredKeypair {
    let kp = Keypair::new();
    StoredKeypair {
        label: label.to_string(),
        pubkey: kp.pubkey().to_string(),
        secret_b58: bs58::encode(kp.to_bytes()).into_string(),
    }
}

pub fn from_stored(stored: &StoredKeypair) -> Result<Keypair> {
    let bytes = bs58::decode(&stored.secret_b58)
        .into_vec()
        .map_err(|e| anyhow::anyhow!("decode b58 secret: {e}"))?;
    Keypair::try_from(bytes.as_slice()).map_err(|e| anyhow::anyhow!("keypair from bytes: {e}"))
}

pub fn from_b58_secret(label: &str, secret_b58: &str) -> Result<StoredKeypair> {
    let bytes = bs58::decode(secret_b58)
        .into_vec()
        .map_err(|e| anyhow::anyhow!("decode b58 secret: {e}"))?;
    let kp = Keypair::try_from(bytes.as_slice())
        .map_err(|e| anyhow::anyhow!("keypair from bytes: {e}"))?;
    Ok(StoredKeypair {
        label: label.to_string(),
        pubkey: kp.pubkey().to_string(),
        secret_b58: secret_b58.to_string(),
    })
}

pub fn generate_snipers(n: u32) -> Vec<StoredKeypair> {
    (0..n).map(|i| generate(&format!("sniper-{i}"))).collect()
}
