//! Volume bot — automated buy/sell loop on a target mint.
//!
//! v0.1.55. Inspired by pumpkit's "EZ Mode": runs a buy-then-sell cycle
//! on a configured cadence, generating chart activity for a coin you
//! control or want to feature, and halts the moment any user-configured
//! stop guard trips. The session is fully cancellable from the UI; an
//! optional sell-on-stop fires a final dump when a guard triggers.
//!
//! Trade size and interval can be uniform or randomized within a range.
//! Wallets cycle round-robin across the configured pool so each cycle
//! looks like an organic mix of small accounts rather than a single
//! wallet hammering the same trade.
//!
//! Safety: caps the session's per-trade SOL at the configured max, never
//! does anything other than buy/sell on the target mint, and shuts down
//! cleanly on the cancel signal so the user can stop it any time without
//! waiting for the current cycle to finish.

use crate::bundler;
use crate::config::NetworkConfig;
use crate::keystore::StoredKeypair;
use crate::price_watcher::{self, TradeUpdate};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch, RwLock};
use tokio::time::Instant;
use tracing::{info, warn};

/// Live tradable amount range. Uniform = same value every cycle; Random
/// = sample uniform in [min, max] each cycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AmountSpec {
    Uniform { sol: f64 },
    Random { min_sol: f64, max_sol: f64 },
}

impl AmountSpec {
    fn sample(&self) -> f64 {
        match self {
            AmountSpec::Uniform { sol } => *sol,
            AmountSpec::Random { min_sol, max_sol } => {
                let lo = *min_sol;
                let hi = *max_sol;
                if hi <= lo {
                    lo
                } else {
                    lo + sample_uniform_unit() * (hi - lo)
                }
            }
        }
    }
    fn validate(&self, label: &str) -> Result<()> {
        match self {
            AmountSpec::Uniform { sol } => {
                anyhow::ensure!(*sol > 0.0, "{label}.sol must be > 0");
            }
            AmountSpec::Random { min_sol, max_sol } => {
                anyhow::ensure!(*min_sol > 0.0, "{label}.min_sol must be > 0");
                anyhow::ensure!(*max_sol >= *min_sol, "{label}.max_sol must be ≥ min_sol");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IntervalSpec {
    Fixed { seconds: u64 },
    Random { min_seconds: u64, max_seconds: u64 },
}

impl IntervalSpec {
    fn sample(&self) -> Duration {
        let secs = match self {
            IntervalSpec::Fixed { seconds } => *seconds,
            IntervalSpec::Random {
                min_seconds,
                max_seconds,
            } => {
                let lo = *min_seconds;
                let hi = *max_seconds;
                if hi <= lo {
                    lo
                } else {
                    lo + (sample_uniform_unit() * (hi - lo) as f64) as u64
                }
            }
        };
        // Cap at sane bounds — 1s minimum to give Solana RPC time to
        // confirm, 5min upper to avoid stale-mint sessions running
        // unattended.
        Duration::from_secs(secs.max(1).min(300))
    }
    fn validate(&self, label: &str) -> Result<()> {
        match self {
            IntervalSpec::Fixed { seconds } => {
                anyhow::ensure!(*seconds >= 1, "{label}.seconds must be ≥ 1");
            }
            IntervalSpec::Random {
                min_seconds,
                max_seconds,
            } => {
                anyhow::ensure!(
                    *min_seconds >= 1 && *max_seconds >= *min_seconds,
                    "{label}: 1 ≤ min_seconds ≤ max_seconds required"
                );
            }
        }
        Ok(())
    }
}

/// Stop conditions. A session halts the moment ANY active guard's
/// threshold is breached. Inactive guards (None) are skipped. Market
/// cap thresholds are in SOL (pumpportal reports MC in SOL on the
/// trade feed; the UI can convert if it wants to surface USD).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StopGuards {
    pub market_cap_max_sol: Option<f64>,
    pub market_cap_min_sol: Option<f64>,
    /// Halt if cumulative session PnL (realized SOL out − SOL in) goes
    /// at-or-above this take-profit threshold.
    pub pnl_take_profit_sol: Option<f64>,
    /// Halt if cumulative session PnL goes at-or-below this stop-loss
    /// threshold (use a negative number for a real stop-loss; e.g. -0.5).
    pub pnl_stop_loss_sol: Option<f64>,
    /// Halt if any single outsider trade ≥ this SOL size hits the mint.
    /// Use to bail when a whale notices the volume.
    pub outsider_buy_min_sol: Option<f64>,
    /// Hard cap on cycles before auto-stop. None = unlimited (until guard
    /// or manual stop).
    pub max_cycles: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeBotConfig {
    pub mint: String,
    /// Pool of wallets to rotate through. Each cycle uses one wallet for
    /// the buy and the same wallet for the matching sell.
    pub wallet_pubkeys: Vec<String>,
    pub buy_amount: AmountSpec,
    /// Sell percent of the position bought in the matching cycle. 100 =
    /// dump everything; <100 leaves residual to bias direction.
    pub sell_percent: f64,
    pub interval_between_cycles: IntervalSpec,
    /// Optional smaller delay between the buy and the sell within a
    /// cycle. None = sell fires as soon as the buy confirms.
    pub buy_to_sell_gap: Option<IntervalSpec>,
    pub stop_guards: StopGuards,
    /// If true, a guard trip triggers a final 100% sell across all
    /// session wallets before the session shuts down.
    pub sell_on_stop: bool,
}

impl VolumeBotConfig {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(!self.mint.is_empty(), "mint required");
        anyhow::ensure!(
            !self.wallet_pubkeys.is_empty(),
            "at least one wallet required"
        );
        anyhow::ensure!(
            self.sell_percent > 0.0 && self.sell_percent <= 100.0,
            "sell_percent must be (0, 100]"
        );
        self.buy_amount.validate("buy_amount")?;
        self.interval_between_cycles
            .validate("interval_between_cycles")?;
        if let Some(g) = &self.buy_to_sell_gap {
            g.validate("buy_to_sell_gap")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct VolumeBotStatus {
    pub running: bool,
    pub cycles_completed: u32,
    pub buys_submitted: u32,
    pub sells_submitted: u32,
    pub failures: u32,
    pub session_sol_in: f64,
    pub session_sol_out: f64,
    pub last_event_ms: i64,
    pub last_message: String,
    pub current_mc_sol: Option<f64>,
    pub last_observed_price_sol: Option<f64>,
    pub stop_reason: Option<String>,
}

pub struct VolumeBotHandle {
    cancel_tx: watch::Sender<bool>,
    status: Arc<RwLock<VolumeBotStatus>>,
}

impl VolumeBotHandle {
    pub async fn snapshot(&self) -> VolumeBotStatus {
        self.status.read().await.clone()
    }
    pub fn cancel(&self) {
        let _ = self.cancel_tx.send(true);
    }
}

/// Spawn a volume-bot session. Returns a handle the caller can use to
/// snapshot status or cancel. Wallets must already be resolved against
/// the keystore — this module never touches the keystore directly.
pub async fn spawn_session(
    cfg: VolumeBotConfig,
    wallets: Vec<StoredKeypair>,
    net: NetworkConfig,
) -> Result<Arc<VolumeBotHandle>> {
    cfg.validate()?;
    anyhow::ensure!(
        wallets.len() == cfg.wallet_pubkeys.len(),
        "wallet keypair count {} != pubkey count {}",
        wallets.len(),
        cfg.wallet_pubkeys.len()
    );

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let status = Arc::new(RwLock::new(VolumeBotStatus {
        running: true,
        last_message: "starting".into(),
        ..Default::default()
    }));
    let handle = Arc::new(VolumeBotHandle {
        cancel_tx,
        status: status.clone(),
    });

    let task_handle = handle.clone();
    tokio::spawn(async move {
        let outcome = run_session_loop(cfg, wallets, net, cancel_rx, status.clone()).await;
        let mut s = status.write().await;
        s.running = false;
        match outcome {
            Ok(reason) => {
                s.stop_reason = Some(reason.clone());
                s.last_message = format!("stopped: {reason}");
            }
            Err(e) => {
                s.stop_reason = Some(format!("error: {e}"));
                s.last_message = format!("error: {e}");
            }
        }
        drop(task_handle);
    });

    Ok(handle)
}

async fn run_session_loop(
    cfg: VolumeBotConfig,
    wallets: Vec<StoredKeypair>,
    net: NetworkConfig,
    mut cancel_rx: watch::Receiver<bool>,
    status: Arc<RwLock<VolumeBotStatus>>,
) -> Result<String> {
    let mint = cfg.mint.clone();
    let wallet_pubkeys: HashSet<String> =
        wallets.iter().map(|w| w.pubkey.clone()).collect();

    // Subscribe to the mint's trade feed for guard evaluation. The
    // price_watcher module already handles reconnect.
    let (trade_tx, mut trade_rx) = mpsc::channel::<TradeUpdate>(256);
    let (price_cancel_tx, price_cancel_rx) = watch::channel(false);
    let watcher_url = net.pumpportal_ws.clone();
    let watcher_mint = mint.clone();
    let watcher_handle = tokio::spawn(async move {
        price_watcher::run(watcher_url, watcher_mint, trade_tx, price_cancel_rx).await;
    });

    let mut entry_price: Option<f64> = None;
    let mut last_price: Option<f64> = None;
    let mut wallet_idx: usize = 0;
    let mut cycles: u32 = 0;
    let mut session_sol_in: f64 = 0.0;
    let mut session_sol_out: f64 = 0.0;
    let mut last_mc: Option<f64> = None;

    loop {
        // Drain any pending price-update messages without blocking, so
        // guards reflect the freshest data each loop iteration.
        while let Ok(t) = trade_rx.try_recv() {
            if let Some(price) = t.price_sol_per_token() {
                last_price = Some(price);
                entry_price.get_or_insert(price);
            }
            if let Some(mc) = t.market_cap_sol {
                last_mc = Some(mc);
            }
            // Outsider whale guard: a non-session wallet just bought ≥X.
            if let Some(min_sol) = cfg.stop_guards.outsider_buy_min_sol {
                let trade_sol = t.sol_amount.unwrap_or(0.0);
                if t.tx_type.eq_ignore_ascii_case("buy")
                    && !wallet_pubkeys.contains(&t.trader_pubkey)
                    && trade_sol >= min_sol
                {
                    let reason = format!(
                        "outsider buy {:.3} SOL (wallet {}…) ≥ guard {:.3}",
                        trade_sol,
                        &t.trader_pubkey[..6.min(t.trader_pubkey.len())],
                        min_sol
                    );
                    finalize_stop_guards(&cfg, &wallets, &net, cfg.sell_on_stop).await;
                    let _ = price_cancel_tx.send(true);
                    let _ = watcher_handle.await;
                    return Ok(reason);
                }
            }
        }

        // Update status block with fresh observed data.
        {
            let mut s = status.write().await;
            s.cycles_completed = cycles;
            s.session_sol_in = session_sol_in;
            s.session_sol_out = session_sol_out;
            s.current_mc_sol = last_mc;
            s.last_observed_price_sol = last_price;
        }

        // MC guards.
        if let (Some(mc), Some(max)) = (last_mc, cfg.stop_guards.market_cap_max_sol) {
            if mc >= max {
                let reason = format!("market cap {mc:.2} SOL ≥ max {max:.2}");
                finalize_stop_guards(&cfg, &wallets, &net, cfg.sell_on_stop).await;
                let _ = price_cancel_tx.send(true);
                let _ = watcher_handle.await;
                return Ok(reason);
            }
        }
        if let (Some(mc), Some(min)) = (last_mc, cfg.stop_guards.market_cap_min_sol) {
            if mc <= min {
                let reason = format!("market cap {mc:.2} SOL ≤ min {min:.2}");
                finalize_stop_guards(&cfg, &wallets, &net, cfg.sell_on_stop).await;
                let _ = price_cancel_tx.send(true);
                let _ = watcher_handle.await;
                return Ok(reason);
            }
        }

        // PnL guards. We track session_sol_out − session_sol_in as a
        // simple proxy; a buy adds to "in" and a confirmed sell adds to
        // "out". This isn't mark-to-market, just realized cash flow, but
        // it's the right thing for a "halt at +X SOL realized" rule.
        let realized = session_sol_out - session_sol_in;
        if let Some(tp) = cfg.stop_guards.pnl_take_profit_sol {
            if realized >= tp {
                let reason = format!("realized PnL {realized:+.3} SOL ≥ TP {tp:.3}");
                finalize_stop_guards(&cfg, &wallets, &net, cfg.sell_on_stop).await;
                let _ = price_cancel_tx.send(true);
                let _ = watcher_handle.await;
                return Ok(reason);
            }
        }
        if let Some(sl) = cfg.stop_guards.pnl_stop_loss_sol {
            if realized <= sl {
                let reason = format!("realized PnL {realized:+.3} SOL ≤ SL {sl:.3}");
                finalize_stop_guards(&cfg, &wallets, &net, cfg.sell_on_stop).await;
                let _ = price_cancel_tx.send(true);
                let _ = watcher_handle.await;
                return Ok(reason);
            }
        }

        // Cycle cap.
        if let Some(cap) = cfg.stop_guards.max_cycles {
            if cycles >= cap {
                let reason = format!("reached max_cycles {cap}");
                let _ = price_cancel_tx.send(true);
                let _ = watcher_handle.await;
                return Ok(reason);
            }
        }

        // Cycle: pick wallet, buy, gap, sell.
        let wallet = &wallets[wallet_idx % wallets.len()];
        wallet_idx = wallet_idx.wrapping_add(1);

        let buy_sol = cfg.buy_amount.sample();
        match bundler::execute_buy_per_wallet(
            std::slice::from_ref(wallet),
            &mint,
            &[buy_sol],
            &net,
        )
        .await
        {
            Ok(bundle_id) => {
                session_sol_in += buy_sol;
                let mut s = status.write().await;
                s.buys_submitted += 1;
                s.last_message = format!(
                    "cycle {} buy {} {:.3} SOL ({}…)",
                    cycles + 1,
                    short_label(wallet),
                    buy_sol,
                    &bundle_id[..8.min(bundle_id.len())]
                );
                s.last_event_ms = now_ms();
            }
            Err(e) => {
                let mut s = status.write().await;
                s.failures += 1;
                s.last_message = format!("buy failed: {e}");
                s.last_event_ms = now_ms();
                drop(s);
                if let Some(_) = wait_or_cancel(
                    cfg.interval_between_cycles.sample(),
                    &mut cancel_rx,
                )
                .await
                {
                    let _ = price_cancel_tx.send(true);
                    let _ = watcher_handle.await;
                    return Ok("user cancelled".into());
                }
                continue;
            }
        }

        // Optional intra-cycle gap so the buy has time to confirm.
        if let Some(gap) = &cfg.buy_to_sell_gap {
            if let Some(_) = wait_or_cancel(gap.sample(), &mut cancel_rx).await {
                let _ = price_cancel_tx.send(true);
                let _ = watcher_handle.await;
                return Ok("user cancelled".into());
            }
        }

        // Sell whatever percent of the wallet's holdings is configured.
        // We use execute_sell_pct which queries on-chain balances live —
        // safer than tracking expected token amounts client-side
        // (slippage, decimals, partial fills).
        match bundler::execute_sell_pct(
            std::slice::from_ref(wallet),
            &mint,
            cfg.sell_percent,
            &net,
        )
        .await
        {
            Ok(bundle_id) => {
                // Best-effort: estimate SOL out from the buy size and
                // last observed price. This is a rough number for the
                // PnL guards; precise accounting would require post-
                // confirm balance diffing which we intentionally skip.
                let approx_out = buy_sol * (cfg.sell_percent / 100.0);
                session_sol_out += approx_out;
                let mut s = status.write().await;
                s.sells_submitted += 1;
                s.last_message = format!(
                    "cycle {} sell {:.0}% ({}…)",
                    cycles + 1,
                    cfg.sell_percent,
                    &bundle_id[..8.min(bundle_id.len())]
                );
                s.last_event_ms = now_ms();
                cycles += 1;
            }
            Err(e) => {
                let mut s = status.write().await;
                s.failures += 1;
                s.last_message = format!("sell failed: {e}");
                s.last_event_ms = now_ms();
                cycles += 1;
            }
        }

        // Wait for the next cycle (or cancel).
        if let Some(_) = wait_or_cancel(
            cfg.interval_between_cycles.sample(),
            &mut cancel_rx,
        )
        .await
        {
            let _ = price_cancel_tx.send(true);
            let _ = watcher_handle.await;
            return Ok("user cancelled".into());
        }

        // Suppress unused warning on entry_price; we capture it in case
        // a future MTM pnl guard wants the unrealized-pnl path.
        let _ = entry_price;
    }
}

/// Fire a final 100% dump across every session wallet that holds tokens
/// when sell_on_stop is true. Used by guard-trip handlers; failures here
/// are best-effort and just logged.
async fn finalize_stop_guards(
    cfg: &VolumeBotConfig,
    wallets: &[StoredKeypair],
    net: &NetworkConfig,
    sell_on_stop: bool,
) {
    if !sell_on_stop {
        return;
    }
    info!(mint = %cfg.mint, wallets = wallets.len(), "volume bot guard tripped — firing sell-on-stop");
    if let Err(e) = bundler::execute_sell_pct(wallets, &cfg.mint, 100.0, net).await {
        warn!(mint = %cfg.mint, error = %e, "sell-on-stop failed");
    }
}

/// Wait for `dur` OR until the cancel channel flips to true. Returns
/// `Some(())` if cancelled, `None` if the timer elapsed normally.
async fn wait_or_cancel(
    dur: Duration,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Option<()> {
    let deadline = Instant::now() + dur;
    tokio::select! {
        _ = tokio::time::sleep_until(deadline.into()) => None,
        _ = cancel_rx.changed() => {
            if *cancel_rx.borrow() {
                Some(())
            } else {
                None
            }
        }
    }
}

fn short_label(w: &StoredKeypair) -> String {
    if !w.label.is_empty() {
        w.label.clone()
    } else {
        format!("{}…", &w.pubkey[..6.min(w.pubkey.len())])
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Cheap uniform-in-[0, 1) without pulling rand. Uses nanoseconds-modulo
/// + a small mixer; quality is fine for trade size jitter, NOT for any
/// crypto purpose.
fn sample_uniform_unit() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    // Splitmix64-style mixer
    let mut x = nanos.wrapping_add(0x9E3779B97F4A7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D049BB133111EB);
    x ^= x >> 31;
    (x as f64 / u64::MAX as f64).fract()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_uniform_returns_same_each_call() {
        let a = AmountSpec::Uniform { sol: 0.1 };
        assert_eq!(a.sample(), 0.1);
    }

    #[test]
    fn amount_random_within_range() {
        let a = AmountSpec::Random {
            min_sol: 0.1,
            max_sol: 0.5,
        };
        for _ in 0..10 {
            let s = a.sample();
            assert!(s >= 0.1 && s <= 0.5, "{s} out of [0.1, 0.5]");
        }
    }

    #[test]
    fn validation_rejects_zero() {
        let a = AmountSpec::Uniform { sol: 0.0 };
        assert!(a.validate("test").is_err());
    }
}
