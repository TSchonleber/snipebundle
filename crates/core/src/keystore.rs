use anyhow::{anyhow, Context, Result};
use argon2::{Argon2, Algorithm, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use directories::ProjectDirs;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
struct EncryptedFile {
    version: u8,
    salt: Vec<u8>,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StoredKeypair {
    pub label: String,
    pub pubkey: String,
    pub secret_b58: String,
}

impl Drop for StoredKeypair {
    fn drop(&mut self) {
        self.secret_b58.zeroize();
    }
}

#[derive(Serialize, Deserialize, Default)]
pub struct Keystore {
    pub master: Option<StoredKeypair>,
    pub snipers: Vec<StoredKeypair>,
}

pub fn keystore_path() -> Result<PathBuf> {
    let pd = ProjectDirs::from("fun", "snipebundle", "snipebundle")
        .ok_or_else(|| anyhow!("could not resolve project dirs"))?;
    let dir = pd.data_dir().to_path_buf();
    std::fs::create_dir_all(&dir).context("create keystore dir")?;
    Ok(dir.join("keystore.bin"))
}

pub fn save(path: &Path, ks: &Keystore, passphrase: &str) -> Result<()> {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = serde_json::to_vec(ks).context("serialize keystore")?;
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| anyhow!("encrypt failed: {e}"))?;

    let file = EncryptedFile {
        version: 1,
        salt: salt.to_vec(),
        nonce: nonce_bytes.to_vec(),
        ciphertext,
    };
    let bytes = serde_json::to_vec(&file)?;
    std::fs::write(path, bytes).context("write keystore")?;
    Ok(())
}

pub fn load(path: &Path, passphrase: &str) -> Result<Keystore> {
    let bytes = std::fs::read(path).context("read keystore")?;
    let file: EncryptedFile = serde_json::from_slice(&bytes).context("parse keystore")?;
    anyhow::ensure!(file.version == 1, "unsupported keystore version");

    let key = derive_key(passphrase, &file.salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce = Nonce::from_slice(&file.nonce);
    let plaintext = cipher
        .decrypt(nonce, file.ciphertext.as_ref())
        .map_err(|_| anyhow!("decrypt failed (wrong passphrase?)"))?;
    let ks: Keystore = serde_json::from_slice(&plaintext).context("deserialize keystore")?;
    Ok(ks)
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN]> {
    let params = Params::new(64 * 1024, 3, 4, Some(KEY_LEN))
        .map_err(|e| anyhow!("argon2 params: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("argon2 derive: {e}"))?;
    Ok(out)
}
