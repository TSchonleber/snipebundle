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
    /// Legacy single-rule-per-wallet (v0.1.10). Read for backwards compat.
    #[serde(default)]
    pub wallet_exit_rules: HashMap<String, ExitConfig>,
    /// Legacy v0.1.12: per-wallet copy of all 5 profiles. Read for backwards
    /// compat; new UI writes to `wallet_bindings` instead.
    #[serde(default)]
    pub wallet_profiles: HashMap<String, WalletExitProfiles>,
    /// v0.1.17: shared exit-rule templates referenced by wallet bindings.
    /// Editing one here updates every wallet bound to it.
    #[serde(default = "default_profiles")]
    pub profile_templates: Vec<ExitProfile>,
    /// v0.1.17: per-wallet binding into `profile_templates` plus a per-wallet
    /// `custom` override slot, SL/TS toggles, and quick-action presets.
    #[serde(default)]
    pub wallet_bindings: HashMap<String, WalletProfileBinding>,
    /// Default buy SOL / sell % preset arrays for new wallets. Per-wallet
    /// presets live on `wallet_bindings[pubkey]`.
    #[serde(default)]
    pub presets: GlobalPresets,
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
pub struct ExitProfile {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "default_take_profit")]
    pub take_profit_pct: f64,
    #[serde(default = "default_stop_loss")]
    pub stop_loss_pct: f64,
    #[serde(default = "default_max_hold")]
    pub max_hold_seconds: u64,
}

impl ExitProfile {
    pub fn to_exit_config(&self) -> ExitConfig {
        ExitConfig {
            take_profit_pct: self.take_profit_pct,
            stop_loss_pct: self.stop_loss_pct,
            max_hold_seconds: self.max_hold_seconds,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletExitProfiles {
    /// Up to 5 named profiles. `default_profiles()` seeds 5 sensible defaults
    /// (Conservative / Standard / Aggressive / Moonshot / Manual).
    #[serde(default = "default_profiles")]
    pub profiles: Vec<ExitProfile>,
    /// Index into `profiles` for the currently active rule.
    #[serde(default = "default_selected_profile")]
    pub selected: usize,
    #[serde(default = "default_true")]
    pub stop_loss_enabled: bool,
    /// None = trailing stop disabled. Engine support lands in v0.1.13.
    #[serde(default)]
    pub trailing_stop_pct: Option<f64>,
    /// Quick-action SOL amounts shown as buttons in the Wallets row.
    #[serde(default = "default_buy_presets")]
    pub buy_presets_sol: Vec<f64>,
    /// Quick-action sell percentages shown as buttons in the Wallets row.
    #[serde(default = "default_sell_presets")]
    pub sell_presets_pct: Vec<f64>,
}

impl WalletExitProfiles {
    pub fn active(&self) -> ExitConfig {
        self.profiles
            .get(self.selected)
            .map(|p| p.to_exit_config())
            .unwrap_or_else(|| ExitConfig {
                take_profit_pct: default_take_profit(),
                stop_loss_pct: default_stop_loss(),
                max_hold_seconds: default_max_hold(),
            })
    }

    pub fn validate(&self, label: &str) -> Result<()> {
        anyhow::ensure!(
            !self.profiles.is_empty() && self.profiles.len() <= 5,
            "{label}.profiles must have 1..=5 entries (got {})",
            self.profiles.len()
        );
        anyhow::ensure!(
            self.selected < self.profiles.len(),
            "{label}.selected ({}) out of range 0..{}",
            self.selected,
            self.profiles.len()
        );
        for (i, p) in self.profiles.iter().enumerate() {
            p.to_exit_config()
                .validate(&format!("{label}.profiles[{i}]"))?;
        }
        if let Some(ts) = self.trailing_stop_pct {
            anyhow::ensure!(
                ts > 0.0 && ts < 100.0,
                "{label}.trailing_stop_pct must be 0 < x < 100"
            );
        }
        Ok(())
    }
}

impl Default for WalletExitProfiles {
    fn default() -> Self {
        Self {
            profiles: default_profiles(),
            selected: default_selected_profile(),
            stop_loss_enabled: true,
            trailing_stop_pct: None,
            buy_presets_sol: default_buy_presets(),
            sell_presets_pct: default_sell_presets(),
        }
    }
}

/// v0.1.17 per-wallet binding. `selected_template = Some(i)` resolves to
/// `Config.profile_templates[i]`; `None` means use this wallet's own `custom`
/// profile. Editing a template updates every wallet bound to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletProfileBinding {
    /// `Some(i)` = use `Config.profile_templates[i]`. `None` = use `custom`.
    #[serde(default = "default_selected_template")]
    pub selected_template: Option<usize>,
    /// Wallet-specific override profile, used when `selected_template` is None.
    /// Always present so the user can flip to Custom without losing settings.
    #[serde(default = "default_custom_profile")]
    pub custom: ExitProfile,
    #[serde(default = "default_true")]
    pub stop_loss_enabled: bool,
    #[serde(default)]
    pub trailing_stop_pct: Option<f64>,
    #[serde(default = "default_buy_presets")]
    pub buy_presets_sol: Vec<f64>,
    #[serde(default = "default_sell_presets")]
    pub sell_presets_pct: Vec<f64>,
}

impl WalletProfileBinding {
    pub fn resolve(&self, templates: &[ExitProfile]) -> ExitConfig {
        match self.selected_template {
            Some(idx) => templates
                .get(idx)
                .map(|t| t.to_exit_config())
                .unwrap_or_else(|| self.custom.to_exit_config()),
            None => self.custom.to_exit_config(),
        }
    }

    pub fn validate(&self, label: &str, template_count: usize) -> Result<()> {
        if let Some(idx) = self.selected_template {
            anyhow::ensure!(
                idx < template_count,
                "{label}.selected_template ({}) out of range 0..{}",
                idx,
                template_count
            );
        }
        self.custom
            .to_exit_config()
            .validate(&format!("{label}.custom"))?;
        if let Some(ts) = self.trailing_stop_pct {
            anyhow::ensure!(
                ts > 0.0 && ts < 100.0,
                "{label}.trailing_stop_pct must be 0 < x < 100"
            );
        }
        anyhow::ensure!(
            !self.buy_presets_sol.is_empty() && self.buy_presets_sol.len() <= 8,
            "{label}.buy_presets_sol must have 1..=8 entries"
        );
        anyhow::ensure!(
            !self.sell_presets_pct.is_empty() && self.sell_presets_pct.len() <= 8,
            "{label}.sell_presets_pct must have 1..=8 entries"
        );
        for v in &self.buy_presets_sol {
            anyhow::ensure!(*v > 0.0, "{label}.buy_presets_sol values must be > 0");
        }
        for v in &self.sell_presets_pct {
            anyhow::ensure!(
                *v > 0.0 && *v <= 100.0,
                "{label}.sell_presets_pct values must be 0 < x <= 100"
            );
        }
        Ok(())
    }
}

impl Default for WalletProfileBinding {
    fn default() -> Self {
        Self {
            selected_template: default_selected_template(),
            custom: default_custom_profile(),
            stop_loss_enabled: true,
            trailing_stop_pct: None,
            buy_presets_sol: default_buy_presets(),
            sell_presets_pct: default_sell_presets(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalPresets {
    #[serde(default = "default_buy_presets")]
    pub buy_presets_sol: Vec<f64>,
    #[serde(default = "default_sell_presets")]
    pub sell_presets_pct: Vec<f64>,
}

impl Default for GlobalPresets {
    fn default() -> Self {
        Self {
            buy_presets_sol: default_buy_presets(),
            sell_presets_pct: default_sell_presets(),
        }
    }
}

impl GlobalPresets {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            !self.buy_presets_sol.is_empty() && self.buy_presets_sol.len() <= 8,
            "presets.buy_presets_sol must have 1..=8 entries"
        );
        anyhow::ensure!(
            !self.sell_presets_pct.is_empty() && self.sell_presets_pct.len() <= 8,
            "presets.sell_presets_pct must have 1..=8 entries"
        );
        for v in &self.buy_presets_sol {
            anyhow::ensure!(*v > 0.0, "presets.buy_presets_sol values must be > 0");
        }
        for v in &self.sell_presets_pct {
            anyhow::ensure!(
                *v > 0.0 && *v <= 100.0,
                "presets.sell_presets_pct values must be 0 < x <= 100"
            );
        }
        Ok(())
    }
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
        for (pubkey, profiles) in &self.wallet_profiles {
            profiles.validate(&format!("wallet_profiles.{pubkey}"))?;
        }
        anyhow::ensure!(
            !self.profile_templates.is_empty() && self.profile_templates.len() <= 12,
            "profile_templates must have 1..=12 entries (got {})",
            self.profile_templates.len()
        );
        for (i, t) in self.profile_templates.iter().enumerate() {
            t.to_exit_config()
                .validate(&format!("profile_templates[{i}]"))?;
        }
        for (pubkey, binding) in &self.wallet_bindings {
            binding.validate(
                &format!("wallet_bindings.{pubkey}"),
                self.profile_templates.len(),
            )?;
        }
        self.presets.validate()?;
        anyhow::ensure!(
            self.trigger.sol_per_snipe <= self.wallets.max_sol_per_wallet,
            "trigger.sol_per_snipe cannot exceed wallets.max_sol_per_wallet"
        );
        Ok(())
    }

    pub fn exit_for_wallet(&self, pubkey: &str) -> ExitConfig {
        // v0.1.17 shared templates + per-wallet binding wins
        if let Some(binding) = self.wallet_bindings.get(pubkey) {
            return binding.resolve(&self.profile_templates);
        }
        // v0.1.12 per-wallet profile bundle (legacy)
        if let Some(profiles) = self.wallet_profiles.get(pubkey) {
            return profiles.active();
        }
        // v0.1.10 single-rule (legacy)
        if let Some(rule) = self.wallet_exit_rules.get(pubkey) {
            return rule.clone();
        }
        // global fallback
        self.exit.clone()
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

fn default_wallet_count() -> u32 { 5 }
fn default_max_sol_per_wallet() -> f64 { 1.0 }
fn default_master_reserve() -> f64 { 0.05 }
fn default_true() -> bool { true }
fn default_sol_per_snipe() -> f64 { 0.5 }
fn default_min_dev_buy() -> f64 { 5.0 }
fn default_max_entry_mc() -> f64 { 50.0 }
fn default_take_profit() -> f64 { 50.0 }
fn default_stop_loss() -> f64 { 30.0 }
fn default_max_hold() -> u64 { 60 }
fn default_selected_profile() -> usize { 1 } // "Standard" by default
fn default_selected_template() -> Option<usize> { Some(1) } // "Standard" by default
fn default_custom_profile() -> ExitProfile {
    ExitProfile {
        label: Some("Custom".into()),
        take_profit_pct: default_take_profit(),
        stop_loss_pct: default_stop_loss(),
        max_hold_seconds: default_max_hold(),
    }
}
fn default_rpc() -> String { "https://api.mainnet-beta.solana.com".into() }
fn default_ws() -> String { "wss://pumpportal.fun/api/data".into() }
fn default_trade_local() -> String { "https://pumpportal.fun/api/trade-local".into() }
fn default_jito() -> String { "https://mainnet.block-engine.jito.wtf/api/v1/bundles".into() }
fn default_jito_tip() -> f64 { 0.001 }
fn default_priority_fee() -> f64 { 0.0001 }
fn default_slippage() -> u32 { 5000 }

fn default_profiles() -> Vec<ExitProfile> {
    vec![
        ExitProfile {
            label: Some("Conservative".into()),
            take_profit_pct: 25.0,
            stop_loss_pct: 15.0,
            max_hold_seconds: 60,
        },
        ExitProfile {
            label: Some("Standard".into()),
            take_profit_pct: 50.0,
            stop_loss_pct: 30.0,
            max_hold_seconds: 60,
        },
        ExitProfile {
            label: Some("Aggressive".into()),
            take_profit_pct: 100.0,
            stop_loss_pct: 50.0,
            max_hold_seconds: 120,
        },
        ExitProfile {
            label: Some("Moonshot".into()),
            take_profit_pct: 500.0,
            stop_loss_pct: 70.0,
            max_hold_seconds: 300,
        },
        ExitProfile {
            label: Some("Manual".into()),
            take_profit_pct: 9999.0,
            stop_loss_pct: 99.0,
            max_hold_seconds: 600,
        },
    ]
}

fn default_buy_presets() -> Vec<f64> {
    vec![0.01, 0.05, 0.25, 0.5, 2.0]
}

fn default_sell_presets() -> Vec<f64> {
    vec![25.0, 50.0, 75.0, 100.0]
}
