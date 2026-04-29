use crate::state::{AppState, EngineHandle};
use serde::{Deserialize, Serialize};
use snipebundle_core::{
    balance, bundler, exit,
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
    if args.wallet_count < 1 || args.wallet_count > 50 {
        return Err("wallet_count must be 1..=50".into());
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
        dev_wallets: Vec::new(),
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

/// Idempotent engine starter — succeeds if already running, starts otherwise.
/// Used by the Launch flow so co-buyer positions can be tracked without
/// requiring the user to also click GO LIVE on the Sniper tab.
async fn ensure_engine_running_inner(state: &AppState) -> Result<()> {
    let mut engine_guard = state.engine.lock().await;
    if engine_guard.is_some() {
        return Ok(());
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
pub async fn ensure_engine_running(state: State<'_, AppState>) -> Result<()> {
    ensure_engine_running_inner(&state).await
}

#[derive(Deserialize)]
pub struct RegisterLaunchPositionArgs {
    pub mint: String,
    pub wallet_pubkeys: Vec<String>,
    pub entry_total_sol: f64,
    pub bundle_id: Option<String>,
}

#[tauri::command]
pub async fn register_launch_position(
    args: RegisterLaunchPositionArgs,
    state: State<'_, AppState>,
) -> Result<()> {
    ensure_engine_running_inner(&state).await?;

    let ks = state
        .keystore
        .lock()
        .await
        .clone()
        .ok_or("keystore locked")?;
    let mut snipers = Vec::with_capacity(args.wallet_pubkeys.len());
    for pk in &args.wallet_pubkeys {
        let kp = find_wallet(&ks, pk)
            .ok_or_else(|| format!("co-buyer wallet {pk} not in keystore"))?;
        snipers.push(kp);
    }

    let engine = {
        let guard = state.engine.lock().await;
        let handle = guard.as_ref().ok_or("engine not running")?;
        Arc::clone(&handle.engine)
    };
    engine
        .register_launch_position(
            args.mint,
            snipers,
            args.entry_total_sol,
            args.bundle_id,
        )
        .await;
    Ok(())
}

#[derive(Deserialize)]
pub struct CloseLaunchPositionArgs {
    pub mint: String,
    #[serde(default = "default_close_label")]
    pub label: String,
}

fn default_close_label() -> String {
    "manual sell".into()
}

#[tauri::command]
pub async fn close_launch_position(
    args: CloseLaunchPositionArgs,
    state: State<'_, AppState>,
) -> Result<()> {
    let engine = {
        let guard = state.engine.lock().await;
        match guard.as_ref() {
            Some(h) => Arc::clone(&h.engine),
            None => return Ok(()), // nothing to close, engine never started
        }
    };
    engine.close_launch_position(&args.mint, &args.label).await;
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
        closed_positions: snap.closed_positions.clone(),
        running: snap.running,
        last_message: snap.last_message.clone(),
        mint_count: snap.mint_count,
        matched_count: snap.matched_count,
        bundle_count: snap.bundle_count,
        realized_wins: snap.realized_wins,
        realized_losses: snap.realized_losses,
        deployed_sol_total: snap.deployed_sol_total,
        realized_pnl_sol: snap.realized_pnl_sol,
    }))
}

#[tauri::command]
pub async fn get_trending() -> Result<Vec<snipebundle_core::trending::TrendingItem>> {
    Ok(snipebundle_core::trending::fetch_all().await)
}

#[tauri::command]
pub async fn get_pumpfun_buckets()
-> Result<snipebundle_core::trending::TrenchBuckets> {
    Ok(snipebundle_core::trending::fetch_pumpfun_buckets().await)
}

#[tauri::command]
pub async fn get_pumpfun_chart(
    mint: String,
) -> Result<snipebundle_core::trending::PumpChartData> {
    snipebundle_core::trending::fetch_pumpfun_chart(&mint)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
pub struct ManualBuyArgs {
    pub mint: String,
    /// Wallet pubkeys to buy with. Each must exist in the keystore (master,
    /// snipers, or dev_wallets). Max 5 (Jito/PumpPortal bundle ceiling).
    pub wallet_pubkeys: Vec<String>,
    pub strategy: snipebundle_core::AmountStrategy,
}

#[derive(Deserialize)]
pub struct ManualSellArgs {
    pub mint: String,
    /// Wallet pubkeys to sell from. Sells `percent` of each wallet's
    /// holdings; default 100% (all) when not provided.
    pub wallet_pubkeys: Vec<String>,
    #[serde(default = "default_sell_pct")]
    pub percent: f64,
}

fn default_sell_pct() -> f64 {
    100.0
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

    args.strategy.validate().map_err(err)?;
    let amounts = args
        .strategy
        .resolve(&args.wallet_pubkeys)
        .map_err(err)?;

    let bundle_id = bundler::execute_buy_per_wallet(&selected, &args.mint, &amounts, &cfg.network)
        .await
        .map_err(err)?;
    spawn_universal_wallet_exits(selected, args.mint.clone(), cfg);
    Ok(bundle_id)
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

    bundler::execute_sell_pct(&selected, &args.mint, args.percent, &cfg.network)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
pub struct AddSniperArgs {
    pub passphrase: String,
    pub label: Option<String>,
}

#[tauri::command]
pub async fn add_sniper_wallet(
    args: AddSniperArgs,
    state: State<'_, AppState>,
) -> Result<WalletWithSecret> {
    let mut guard = state.keystore.lock().await;
    let ks = guard.as_mut().ok_or("keystore locked")?;
    if ks.snipers.len() >= 50 {
        return Err("sniper cap reached (50)".into());
    }
    let label = args.label.unwrap_or_else(|| {
        let mut i = ks.snipers.len();
        loop {
            let candidate = format!("sniper-{i}");
            if ks.snipers.iter().all(|w| w.label != candidate) {
                return candidate;
            }
            i += 1;
        }
    });
    let stored = wallet::generate(&label);
    let result = WalletWithSecret {
        label: stored.label.clone(),
        pubkey: stored.pubkey.clone(),
        secret_b58: stored.secret_b58.clone(),
    };
    ks.snipers.push(stored);
    let path = keystore::keystore_path().map_err(err)?;
    keystore::save(&path, ks, &args.passphrase).map_err(err)?;
    Ok(result)
}

#[derive(Deserialize)]
pub struct DeleteWalletArgs {
    pub pubkey: String,
    pub passphrase: String,
}

#[tauri::command]
pub async fn delete_wallet(
    args: DeleteWalletArgs,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut guard = state.keystore.lock().await;
    let ks = guard.as_mut().ok_or("keystore locked")?;
    if let Some(m) = &ks.master {
        if m.pubkey == args.pubkey {
            return Err(
                "master wallet cannot be deleted from the manager (would orphan funds)"
                    .into(),
            );
        }
    }
    let before = ks.snipers.len() + ks.dev_wallets.len();
    ks.snipers.retain(|w| w.pubkey != args.pubkey);
    ks.dev_wallets.retain(|w| w.pubkey != args.pubkey);
    let after = ks.snipers.len() + ks.dev_wallets.len();
    if before == after {
        return Err(format!("no wallet with pubkey {} in keystore", args.pubkey));
    }
    let path = keystore::keystore_path().map_err(err)?;
    keystore::save(&path, ks, &args.passphrase).map_err(err)?;

    let cfg_path = state.config_path.lock().await.clone();
    let mut cfg_guard = state.config.lock().await;
    if let Some(cfg) = cfg_guard.as_mut() {
        if cfg.wallet_exit_rules.remove(&args.pubkey).is_some() {
            save_to_disk(&cfg_path, cfg).map_err(err)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn list_dev_wallets(state: State<'_, AppState>) -> Result<Vec<WalletInfo>> {
    let guard = state.keystore.lock().await;
    let ks = guard.as_ref().ok_or("keystore locked")?;
    Ok(ks
        .dev_wallets
        .iter()
        .map(|w| WalletInfo {
            label: w.label.clone(),
            pubkey: w.pubkey.clone(),
        })
        .collect())
}

#[derive(Deserialize)]
pub struct ImportDevArgs {
    pub label: String,
    pub secret_b58: String,
    pub passphrase: String,
}

#[tauri::command]
pub async fn import_dev_wallet(
    args: ImportDevArgs,
    state: State<'_, AppState>,
) -> Result<WalletInfo> {
    let stored = wallet::from_b58_secret(&args.label, &args.secret_b58).map_err(err)?;
    let info = WalletInfo {
        label: stored.label.clone(),
        pubkey: stored.pubkey.clone(),
    };

    let mut guard = state.keystore.lock().await;
    let ks = guard.as_mut().ok_or("keystore locked")?;
    if ks.dev_wallets.iter().any(|w| w.pubkey == stored.pubkey)
        || ks.snipers.iter().any(|w| w.pubkey == stored.pubkey)
        || ks
            .master
            .as_ref()
            .map(|m| m.pubkey == stored.pubkey)
            .unwrap_or(false)
    {
        return Err("a wallet with that pubkey is already in the keystore".into());
    }
    ks.dev_wallets.push(stored);

    let path = keystore::keystore_path().map_err(err)?;
    keystore::save(&path, ks, &args.passphrase).map_err(err)?;
    Ok(info)
}

#[derive(Deserialize)]
pub struct CoBuyerSpec {
    pub pubkey: String,
    pub sol: f64,
}

#[derive(Deserialize)]
pub struct LaunchArgs {
    pub dev_pubkey: String,
    pub metadata: LaunchMetadata,
    pub metadata_uri: Option<String>,
    pub image_path: Option<String>,
    pub dev_buy_sol: f64,
    #[serde(default)]
    pub co_buyers: Vec<CoBuyerSpec>,
}

#[tauri::command]
pub async fn launch_token(
    args: LaunchArgs,
    state: State<'_, AppState>,
) -> Result<LaunchResult> {
    if args.dev_buy_sol < 0.0 {
        return Err("dev_buy_sol must be non-negative".into());
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
    let dev = find_wallet(&ks, &args.dev_pubkey)
        .ok_or_else(|| format!("no wallet in keystore with pubkey {}", args.dev_pubkey))?;

    let metadata_uri = if let Some(u) = args.metadata_uri.clone() {
        u
    } else {
        let img = args.image_path.as_ref().map(PathBuf::from);
        launch::upload_metadata(&args.metadata, img.as_deref())
            .await
            .map_err(err)?
    };

    let mut co_buyers: Vec<(StoredKeypair, f64)> = Vec::with_capacity(args.co_buyers.len());
    for cb in &args.co_buyers {
        let kp = find_wallet(&ks, &cb.pubkey)
            .ok_or_else(|| format!("co-buyer wallet {} not in keystore", cb.pubkey))?;
        co_buyers.push((kp, cb.sol));
    }

    let result = launch::execute_launch(
        &dev,
        &args.metadata,
        &metadata_uri,
        args.dev_buy_sol,
        &co_buyers,
        &cfg.network,
    )
    .await
    .map_err(err)?;

    let mut exit_wallets = Vec::new();
    if args.dev_buy_sol > 0.0 {
        exit_wallets.push(dev);
    }
    exit_wallets.extend(co_buyers.iter().map(|(wallet, _)| wallet.clone()));
    spawn_universal_wallet_exits(exit_wallets, result.mint.clone(), cfg);

    Ok(result)
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

fn find_wallet(ks: &Keystore, pubkey: &str) -> Option<StoredKeypair> {
    if let Some(m) = &ks.master {
        if m.pubkey == pubkey {
            return Some(m.clone());
        }
    }
    ks.snipers
        .iter()
        .chain(ks.dev_wallets.iter())
        .find(|w| w.pubkey == pubkey)
        .cloned()
}

fn spawn_universal_wallet_exits(wallets: Vec<StoredKeypair>, mint: String, cfg: Config) {
    if wallets.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let wallet_rules = wallets
            .into_iter()
            .map(|wallet| {
                let rule = cfg.resolved_exit_for_wallet(&wallet.pubkey);
                (wallet, rule)
            })
            .collect::<Vec<_>>();
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let price_state = Arc::new(RwLock::new(exit::PositionPrice::default()));
        let outcomes = exit::watch_wallets_with_pricing(
            wallet_rules,
            mint.clone(),
            cfg.network.clone(),
            cancel_rx,
            price_state,
        )
        .await;
        let failed = outcomes
            .iter()
            .filter(|result| matches!(result.outcome, exit::ExitOutcome::Failed(_)))
            .count();
        tracing::info!(
            mint = %mint,
            wallets = outcomes.len(),
            failed,
            "universal wallet exits completed"
        );
    });
}

fn save_to_disk(path: &std::path::Path, cfg: &Config) -> anyhow::Result<()> {
    let toml_str = toml::to_string_pretty(cfg)?;
    std::fs::write(path, toml_str)?;
    Ok(())
}

fn default_config() -> Config {
    let raw = include_str!("../../../../config.example.toml");
    toml::from_str(raw).expect("config.example.toml must parse")
}
