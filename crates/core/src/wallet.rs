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
    Keypair::from_bytes(&bytes).map_err(|e| anyhow::anyhow!("keypair from bytes: {e}"))
}

pub fn generate_snipers(n: u32) -> Vec<StoredKeypair> {
    (0..n).map(|i| generate(&format!("sniper-{i}"))).collect()
}
