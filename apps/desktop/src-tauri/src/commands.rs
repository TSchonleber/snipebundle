use crate::state::{AppState, EngineHandle};
use serde::{Deserialize, Serialize};
use snipebundle_core::{
    balance, bundler,
    funding::{self, FanOutResult},
    keystore::{self, Keystore, StoredKeypair},
    launch::{self, LaunchMetadata, LaunchResult},
    wallet, Config, Engine, EngineState,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::{watch, RwLock};

type Result<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
pub struct WalletInfo {
    pub label: String,
    pub pubkey: String,
}

#[derive(Serialize)]
pub struct WalletWithSecret {
    pub label: String,
    pub pubkey: String,
    pub secret_b58: String,
}

#[derive(Serialize)]
pub struct InitResult {
    pub master: WalletWithSecret,
    pub snipers: Vec<WalletWithSecret>,
    pub keystore_path: String,
}

#[derive(Deserialize)]
pub struct InitArgs {
    pub passphrase: String,
    pub wallet_count: u32,
}

#[tauri::command]
pub async fn keystore_exists() -> Result<bool> {
    let path = keystore::keystore_path().map_err(err)?;
    Ok(path.exists())
}

#[tauri::command]
pub async fn init_keystore(
    args: InitArgs,
    state: State<'_, AppState>,
) -> Result<InitResult> {
    if args.passphrase.len() < 12 {
        return Err("passphrase must be at least 12 characters".into());
    }
    if args.wallet_count < 1 || args.wallet_count > 10 {
        return Err("wallet_count must be 1..=10".into());
    }

    let path = keystore::keystore_path().map_err(err)?;
    if path.exists() {
        return Err(format!(
            "keystore already exists at {}; use unlock instead",
            path.display()
        ));
    }

    let master = wallet::generate("master");
    let snipers = wallet::generate_snipers(args.wallet_count);

    let ks = Keystore {
        master: Some(master.clone()),
        snipers: snipers.clone(),
    };
    keystore::save(&path, &ks, &args.passphrase).map_err(err)?;

    *state.keystore.lock().await = Some(ks);

    Ok(InitResult {
        master: WalletWithSecret {
            label: master.label.clone(),
            pubkey: master.pubkey.clone(),
            secret_b58: master.secret_b58.clone(),
        },
        snipers: snipers
            .iter()
            .map(|s| WalletWithSecret {
                label: s.label.clone(),
                pubkey: s.pubkey.clone(),
                secret_b58: s.secret_b58.clone(),
            })
            .collect(),
        keystore_path: path.display().to_string(),
    })
}

#[tauri::command]
pub async fn unlock_keystore(passphrase: String, state: State<'_, AppState>) -> Result<()> {
    let path = keystore::keystore_path().map_err(err)?;
    let ks = keystore::load(&path, &passphrase).map_err(err)?;
    *state.keystore.lock().await = Some(ks);
    Ok(())
}

#[tauri::command]
pub async fn lock_keystore(state: State<'_, AppState>) -> Result<()> {
    *state.keystore.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn list_wallets(state: State<'_, AppState>) -> Result<Vec<WalletInfo>> {
    let guard = state.keystore.lock().await;
    let ks = guard.as_ref().ok_or("keystore locked")?;
    let mut out = Vec::new();
    if let Some(m) = &ks.master {
        out.push(WalletInfo {
            label: m.label.clone(),
            pubkey: m.pubkey.clone(),
        });
    }
    for s in &ks.snipers {
        out.push(WalletInfo {
            label: s.label.clone(),
            pubkey: s.pubkey.clone(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn reveal_wallets(
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<Vec<WalletWithSecret>> {
    let path = keystore::keystore_path().map_err(err)?;
    let ks = keystore::load(&path, &passphrase).map_err(err)?;
    *state.keystore.lock().await = Some(ks.clone());
    let mut out = Vec::new();
    if let Some(m) = &ks.master {
        out.push(WalletWithSecret {
            label: m.label.clone(),
            pubkey: m.pubkey.clone(),
            secret_b58: m.secret_b58.clone(),
        });
    }
    for s in &ks.snipers {
        out.push(WalletWithSecret {
            label: s.label.clone(),
            pubkey: s.pubkey.clone(),
            secret_b58: s.secret_b58.clone(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn load_config(state: State<'_, AppState>) -> Result<Config> {
    let path = state.config_path.lock().await.clone();
    if !path.exists() {
        let cfg = default_config();
        save_to_disk(&path, &cfg).map_err(err)?;
        *state.config.lock().await = Some(cfg.clone());
        return Ok(cfg);
    }
    let cfg = Config::load(&path).map_err(err)?;
    *state.config.lock().await = Some(cfg.clone());
    Ok(cfg)
}

#[tauri::command]
pub async fn save_config(cfg: Config, state: State<'_, AppState>) -> Result<()> {
    cfg.validate().map_err(err)?;
    let path = state.config_path.lock().await.clone();
    save_to_disk(&path, &cfg).map_err(err)?;
    *state.config.lock().await = Some(cfg);
    Ok(())
}

#[tauri::command]
pub async fn start_engine(state: State<'_, AppState>) -> Result<()> {
    let mut engine_guard = state.engine.lock().await;
    if engine_guard.is_some() {
        return Err("engine already running".into());
    }
    let cfg = state
        .config
        .lock()
        .await
        .clone()
        .ok_or("config not loaded")?;
    let ks = state
        .keystore
        .lock()
        .await
        .clone()
        .ok_or("keystore locked")?;

    let engine = Arc::new(Engine::new(cfg, ks));
    let engine_state: Arc<RwLock<EngineState>> = engine.state_handle();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (paused_tx, paused_rx) = watch::channel(false);

    let engine_clone = Arc::clone(&engine);
    tokio::spawn(async move {
        if let Err(e) = engine_clone.run(cancel_rx, paused_rx).await {
            tracing::warn!(error = %e, "engine exited with error");
        }
    });

    *engine_guard = Some(EngineHandle {
        engine,
        state: engine_state,
        cancel_tx,
        paused_tx,
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_engine(state: State<'_, AppState>) -> Result<()> {
    let mut engine_guard = state.engine.lock().await;
    if let Some(handle) = engine_guard.take() {
        handle.cancel_tx.send(true).ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn set_paused(paused: bool, state: State<'_, AppState>) -> Result<()> {
    let engine_guard = state.engine.lock().await;
    let handle = engine_guard.as_ref().ok_or("engine not running")?;
    handle.paused_tx.send(paused).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn get_state(state: State<'_, AppState>) -> Result<Option<EngineState>> {
    let engine_guard = state.engine.lock().await;
    let Some(handle) = engine_guard.as_ref() else {
        return Ok(None);
    };
    let snap = handle.state.read().await;
    Ok(Some(EngineState {
        feed: snap.feed.clone(),
        positions: snap.positions.clone(),
        running: snap.running,
        last_message: snap.last_message.clone(),
        mint_count: snap.mint_count,
        matched_count: snap.matched_count,
        bundle_count: snap.bundle_count,
    }))
}

#[derive(Deserialize)]
pub struct ManualBuyArgs {
    pub mint: String,
    pub sol: f64,
    /// Wallet pubkeys to buy with. Each must exist in the keystore (master,
    /// snipers, or dev_wallets). Max 5 (Jito/PumpPortal bundle ceiling).
    pub wallet_pubkeys: Vec<String>,
}

#[derive(Deserialize)]
pub struct ManualSellArgs {
    pub mint: String,
    /// Wallet pubkeys to sell from. Each sells 100% of its holdings of `mint`.
    pub wallet_pubkeys: Vec<String>,
}

#[tauri::command]
pub async fn manual_snipe(
    args: ManualBuyArgs,
    state: State<'_, AppState>,
) -> Result<String> {
    if args.wallet_pubkeys.is_empty() {
        return Err("select at least one wallet".into());
    }
    if args.wallet_pubkeys.len() > 5 {
        return Err("max 5 wallets per bundle".into());
    }
    let cfg = state
        .config
        .lock()
        .await
        .clone()
        .ok_or("config not loaded")?;
    let ks = state
        .keystore
        .lock()
        .await
        .clone()
        .ok_or("keystore locked")?;

    let mut selected = Vec::with_capacity(args.wallet_pubkeys.len());
    for pk in &args.wallet_pubkeys {
        let kp = find_wallet(&ks, pk)
            .ok_or_else(|| format!("wallet {pk} not in keystore"))?;
        selected.push(kp);
    }

    bundler::execute_buy(&selected, &args.mint, args.sol, &cfg.network)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn manual_dump(args: ManualSellArgs, state: State<'_, AppState>) -> Result<String> {
    if args.wallet_pubkeys.is_empty() {
        return Err("select at least one wallet".into());
    }
    if args.wallet_pubkeys.len() > 5 {
        return Err("max 5 wallets per bundle".into());
    }
    let cfg = state
        .config
        .lock()
        .await
        .clone()
        .ok_or("config not loaded")?;
    let ks = state
        .keystore
        .lock()
        .await
        .clone()
        .ok_or("keystore locked")?;
    let mut selected = Vec::with_capacity(args.wallet_pubkeys.len());
    for pk in &args.wallet_pubkeys {
        let kp = find_wallet(&ks, pk)
            .ok_or_else(|| format!("wallet {pk} not in keystore"))?;
        selected.push(kp);
    }

    bundler::execute_sell(&selected, &args.mint, &cfg.network)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
pub struct FanOutArgs {
    pub recipients: Vec<String>,
    pub sol_per_wallet: f64,
}

#[tauri::command]
pub async fn fan_out_from_master(
    args: FanOutArgs,
    state: State<'_, AppState>,
) -> Result<FanOutResult> {
    let cfg = state
        .config
        .lock()
        .await
        .clone()
        .ok_or("config not loaded")?;
    let ks = state
        .keystore
        .lock()
        .await
        .clone()
        .ok_or("keystore locked")?;
    let master = ks
        .master
        .ok_or("no master wallet in keystore")?;
    funding::fan_out_from_master(&master, &args.recipients, args.sol_per_wallet, &cfg.network)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_balances(
    pubkeys: Vec<String>,
    state: State<'_, AppState>,
) -> Result<HashMap<String, f64>> {
    let cfg = state
        .config
        .lock()
        .await
        .clone()
        .ok_or("config not loaded")?;
    Ok(balance::get_sol_balances(&cfg.network.rpc_url, &pubkeys).await)
}

fn save_to_disk(path: &std::path::Path, cfg: &Config) -> anyhow::Result<()> {
    let toml_str = toml::to_string_pretty(cfg)?;
    std::fs::write(path, toml_str)?;
    Ok(())
}

fn default_config() -> Config {
    let raw = include_str!("../../../config.example.toml");
    toml::from_str(raw).expect("config.example.toml must parse")
}
