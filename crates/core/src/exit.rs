use crate::bundler;
use crate::config::{NetworkConfig, ResolvedExit};
use crate::keystore::StoredKeypair;
use crate::price_watcher::{self, TradeUpdate};
use anyhow::Result;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, RwLock};
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub enum ExitOutcome {
    TakeProfit { realized_pct: f64 },
    StopLoss { realized_pct: f64 },
    /// Trailing-stop fired: `peak_pct` is the highest unrealized P&L the
    /// position reached, `realized_pct` is the P&L at exit. v0.1.18.
    TrailingStop { realized_pct: f64, peak_pct: f64 },
    TimeExit { final_pct: Option<f64> },
    ManualDump,
    Failed(String),
}

impl ExitOutcome {
    pub fn kind(&self) -> &'static str {
        match self {
            ExitOutcome::TakeProfit { .. } => "take-profit",
            ExitOutcome::StopLoss { .. } => "stop-loss",
            ExitOutcome::TrailingStop { .. } => "trailing-stop",
            ExitOutcome::TimeExit { .. } => "time-exit",
            ExitOutcome::ManualDump => "manual",
            ExitOutcome::Failed(_) => "failed",
        }
    }

    pub fn realized_pct(&self) -> Option<f64> {
        match self {
            ExitOutcome::TakeProfit { realized_pct } => Some(*realized_pct),
            ExitOutcome::StopLoss { realized_pct } => Some(*realized_pct),
            ExitOutcome::TrailingStop { realized_pct, .. } => Some(*realized_pct),
            ExitOutcome::TimeExit { final_pct } => *final_pct,
            ExitOutcome::ManualDump | ExitOutcome::Failed(_) => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WalletExitResult {
    pub wallet_pubkey: String,
    pub outcome: ExitOutcome,
}

/// Per-position price tracker. Updated by the watcher, read by the engine
/// for live P&L surfacing.
#[derive(Debug, Default, Clone)]
pub struct PositionPrice {
    pub entry_price: Option<f64>,
    pub last_price: Option<f64>,
    pub unrealized_pct: Option<f64>,
}

/// Arm each wallet with its own TP/SL/max-hold config + per-wallet toggles
/// (SL on/off, optional trailing-stop %). One watcher per wallet because each
/// wallet may have a different rule and exit time.
pub async fn watch_wallets_with_pricing(
    wallets: Vec<(StoredKeypair, ResolvedExit)>,
    mint: String,
    net: NetworkConfig,
    cancel: watch::Receiver<bool>,
    price_state: Arc<RwLock<PositionPrice>>,
) -> Vec<WalletExitResult> {
    let mut handles = Vec::with_capacity(wallets.len());
    for (wallet, cfg) in wallets {
        let wallet_pubkey = wallet.pubkey.clone();
        let wallet_mint = mint.clone();
        let wallet_net = net.clone();
        let wallet_cancel = cancel.clone();
        let wallet_price = Arc::clone(&price_state);
        handles.push(tokio::spawn(async move {
            let outcome = watch_with_pricing(
                vec![wallet],
                wallet_mint,
                cfg,
                wallet_net,
                wallet_cancel,
                wallet_price,
            )
            .await;
            WalletExitResult {
                wallet_pubkey,
                outcome,
            }
        }));
    }

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(e) => results.push(WalletExitResult {
                wallet_pubkey: "unknown".into(),
                outcome: ExitOutcome::Failed(format!("wallet exit task failed: {e}")),
            }),
        }
    }
    results
}

/// Watch a position's price feed and fire the sell bundle when whichever of
/// the following hits first:
///   - take_profit_pct reached
///   - stop_loss_pct breached (only when `stop_loss_enabled` is true)
///   - trailing_stop_pct drop from peak (when `trailing_stop_pct` is Some)
///   - max_hold_seconds elapsed
///   - manual cancel via `cancel`
pub async fn watch_with_pricing(
    snipers: Vec<StoredKeypair>,
    mint: String,
    resolved: ResolvedExit,
    net: NetworkConfig,
    cancel: watch::Receiver<bool>,
    price_state: Arc<RwLock<PositionPrice>>,
) -> ExitOutcome {
    let cfg = &resolved.rule;
    info!(
        mint = %mint,
        tp = cfg.take_profit_pct,
        sl = cfg.stop_loss_pct,
        sl_on = resolved.stop_loss_enabled,
        ts = ?resolved.trailing_stop_pct,
        secs = cfg.max_hold_seconds,
        "exit watcher armed"
    );

    let snipe_set: HashSet<String> = snipers.iter().map(|s| s.pubkey.clone()).collect();

    let (trade_tx, mut trade_rx) = mpsc::channel::<TradeUpdate>(256);
    let (price_cancel_tx, price_cancel_rx) = watch::channel(false);
    let watcher_mint = mint.clone();
    let watcher_url = net.pumpportal_ws.clone();
    let watcher_handle = tokio::spawn(async move {
        price_watcher::run(watcher_url, watcher_mint, trade_tx, price_cancel_rx).await;
    });

    let deadline = Instant::now() + Duration::from_secs(cfg.max_hold_seconds);
    let mut entry: Option<f64> = None;
    let mut last_pct: Option<f64> = None;
    // Highest unrealized P&L seen — only tracked when trailing-stop is on.
    // Seeded at 0 so a position must move into profit before the trailing
    // stop can arm; otherwise a slight initial dip would trip it instantly.
    let mut peak_pct: f64 = 0.0;
    let mut cancel_rx = cancel.clone();

    let outcome = loop {
        tokio::select! {
            biased;
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    break ExitOutcome::ManualDump;
                }
            }
            _ = tokio::time::sleep_until(deadline.into()) => {
                break ExitOutcome::TimeExit { final_pct: last_pct };
            }
            Some(t) = trade_rx.recv() => {
                let Some(price) = t.price_sol_per_token() else { continue };

                {
                    let mut s = price_state.write().await;
                    s.last_price = Some(price);
                    if s.entry_price.is_none()
                        && snipe_set.contains(&t.trader_pubkey)
                        && t.tx_type.eq_ignore_ascii_case("buy")
                    {
                        s.entry_price = Some(price);
                        entry = Some(price);
                    } else if s.entry_price.is_none() && entry.is_none() {
                        // Manual/launch watchers can arm after the wallet's
                        // buy print has already passed. Use the first price
                        // we see as the risk-rule reference instead of
                        // leaving TP/SL inactive until the hold timer fires.
                        s.entry_price = Some(price);
                        entry = Some(price);
                    } else if entry.is_none() {
                        entry = s.entry_price;
                    }
                    if let Some(e) = entry {
                        if e > 0.0 {
                            let pct = ((price - e) / e) * 100.0;
                            s.unrealized_pct = Some(pct);
                            last_pct = Some(pct);
                        }
                    }
                }

                if let Some(pct) = last_pct {
                    if pct >= cfg.take_profit_pct {
                        break ExitOutcome::TakeProfit { realized_pct: pct };
                    }
                    if resolved.stop_loss_enabled && pct <= -cfg.stop_loss_pct {
                        break ExitOutcome::StopLoss { realized_pct: pct };
                    }
                    if let Some(ts) = resolved.trailing_stop_pct {
                        if pct > peak_pct {
                            peak_pct = pct;
                        }
                        // Only arm once we've actually been in profit.
                        // `peak_pct - ts` would be negative for a never-up
                        // position and could fire on routine entry slippage.
                        if peak_pct > 0.0 && pct <= peak_pct - ts {
                            break ExitOutcome::TrailingStop {
                                realized_pct: pct,
                                peak_pct,
                            };
                        }
                    }
                }
            }
        }
    };

    let _ = price_cancel_tx.send(true);
    let _ = watcher_handle.await;

    if matches!(outcome, ExitOutcome::ManualDump) {
        info!(mint = %mint, "manual dump path; engine fires sell separately");
        return outcome;
    }

    match bundler::execute_sell(&snipers, &mint, &net).await {
        Ok(bundle_id) => {
            info!(mint = %mint, %bundle_id, ?outcome, "exit sell submitted");
            outcome
        }
        Err(e) => {
            warn!(mint = %mint, error = %e, "exit sell failed");
            ExitOutcome::Failed(e.to_string())
        }
    }
}

/// Manual immediate dump (used by the Trade page and dashboard buttons).
pub async fn dump_now(
    snipers: &[StoredKeypair],
    mint: &str,
    net: &NetworkConfig,
) -> Result<String> {
    bundler::execute_sell(snipers, mint, net).await
}
