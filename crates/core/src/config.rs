use crate::amounts::AmountStrategy;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub wallets: WalletConfig,
    pub trigger: TriggerConfig,
    pub auto: AutoFilters,
    pub targeted: TargetedConfig,
    pub exit: ExitConfig,
    #[serde(default)]
    pub wallet_exit_rules: HashMap<String, ExitConfig>,
    pub network: NetworkConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletConfig {
    #[serde(default = "default_wallet_count")]
    pub count: u32,
    #[serde(default = "default_max_sol_per_wallet")]
    pub max_sol_per_wallet: f64,
    #[serde(default = "default_master_reserve")]
    pub master_reserve_sol: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerConfig {
    #[serde(default = "default_true")]
    pub auto_enabled: bool,
    #[serde(default = "default_true")]
    pub targeted_enabled: bool,
    #[serde(default = "default_sol_per_snipe")]
    pub sol_per_snipe: f64,
    /// Pubkeys of sniper wallets to use in each auto-snipe bundle.
    /// Empty = use the first 5 snipers from the keystore (legacy behavior).
    /// Capped at 5 by the bundler regardless.
    #[serde(default)]
    pub auto_snipe_wallets: Vec<String>,
    /// Override amount allocation per snipe. None = uniform with sol_per_snipe.
    #[serde(default)]
    pub amount_strategy: Option<AmountStrategy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoFilters {
    #[serde(default = "default_min_dev_buy")]
    pub min_dev_buy_pct: f64,
    #[serde(default = "default_true")]
    pub require_socials: bool,
    #[serde(default = "default_max_entry_mc")]
    pub max_entry_mc_sol: f64,
    #[serde(default)]
    pub funder_blacklist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetedConfig {
    #[serde(default)]
    pub dev_wallets: Vec<String>,
    #[serde(default = "default_true")]
    pub bypass_filters: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitConfig {
    #[serde(default = "default_take_profit")]
    pub take_profit_pct: f64,
    #[serde(default = "default_stop_loss")]
    pub stop_loss_pct: f64,
    #[serde(default = "default_max_hold")]
    pub max_hold_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    #[serde(default = "default_rpc")]
    pub rpc_url: String,
    #[serde(default = "default_ws")]
    pub pumpportal_ws: String,
    #[serde(default = "default_trade_local")]
    pub trade_local_url: String,
    #[serde(default = "default_jito")]
    pub jito_block_engine: String,
    #[serde(default = "default_jito_tip")]
    pub jito_tip_sol: f64,
    #[serde(default = "default_priority_fee")]
    pub priority_fee_sol: f64,
    #[serde(default = "default_slippage")]
    pub slippage_bps: u32,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read config: {}", path.display()))?;
        let cfg: Self = toml::from_str(&raw).context("parse config toml")?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.wallets.count >= 1 && self.wallets.count <= 50,
            "wallets.count must be 1..=50 (per-bundle cap is 5; keystore holds up to 50)"
        );
        anyhow::ensure!(
            self.wallets.max_sol_per_wallet > 0.0 && self.wallets.max_sol_per_wallet <= 5.0,
            "wallets.max_sol_per_wallet must be 0 < x <= 5.0"
        );
        self.exit.validate("exit")?;
        for (pubkey, rule) in &self.wallet_exit_rules {
            rule.validate(&format!("wallet_exit_rules.{pubkey}"))?;
        }
        anyhow::ensure!(
            self.trigger.sol_per_snipe <= self.wallets.max_sol_per_wallet,
            "trigger.sol_per_snipe cannot exceed wallets.max_sol_per_wallet"
        );
        Ok(())
    }

    pub fn exit_for_wallet(&self, pubkey: &str) -> ExitConfig {
        self.wallet_exit_rules
            .get(pubkey)
            .cloned()
            .unwrap_or_else(|| self.exit.clone())
    }
}

impl ExitConfig {
    pub fn validate(&self, label: &str) -> Result<()> {
        anyhow::ensure!(
            self.take_profit_pct > 0.0,
            "{label}.take_profit_pct must be > 0"
        );
        anyhow::ensure!(
            self.stop_loss_pct > 0.0,
            "{label}.stop_loss_pct must be > 0"
        );
        anyhow::ensure!(
            self.max_hold_seconds >= 1 && self.max_hold_seconds <= 600,
            "{label}.max_hold_seconds must be 1..=600"
        );
        Ok(())
    }
}

fn default_wallet_count() -> u32 {
    5
}
fn default_max_sol_per_wallet() -> f64 {
    1.0
}
fn default_master_reserve() -> f64 {
    0.05
}
fn default_true() -> bool {
    true
}
fn default_sol_per_snipe() -> f64 {
    0.5
}
fn default_min_dev_buy() -> f64 {
    5.0
}
fn default_max_entry_mc() -> f64 {
    50.0
}
fn default_take_profit() -> f64 {
    50.0
}
fn default_stop_loss() -> f64 {
    30.0
}
fn default_max_hold() -> u64 {
    60
}
fn default_rpc() -> String {
    "https://api.mainnet-beta.solana.com".into()
}
fn default_ws() -> String {
    "wss://pumpportal.fun/api/data".into()
}
fn default_trade_local() -> String {
    "https://pumpportal.fun/api/trade-local".into()
}
fn default_jito() -> String {
    "https://mainnet.block-engine.jito.wtf/api/v1/bundles".into()
}
fn default_jito_tip() -> f64 {
    0.001
}
fn default_priority_fee() -> f64 {
    0.0001
}
fn default_slippage() -> u32 {
    5000
}
