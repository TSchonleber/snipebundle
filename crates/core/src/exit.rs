use crate::bundler;
use crate::config::{ExitConfig, NetworkConfig};
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
    TimeExit { final_pct: Option<f64> },
    ManualDump,
    Failed(String),
}

/// Per-position price tracker. Updated by the watcher, read by the engine
/// for live P&L surfacing.
#[derive(Debug, Default, Clone)]
pub struct PositionPrice {
    pub entry_price: Option<f64>,
    pub last_price: Option<f64>,
    pub unrealized_pct: Option<f64>,
}

/// Watch a position's price feed and fire the sell bundle when whichever of
/// the following hits first:
///   - take_profit_pct reached
///   - stop_loss_pct breached
///   - max_hold_seconds elapsed
///   - manual cancel via `cancel`
pub async fn watch_with_pricing(
    snipers: Vec<StoredKeypair>,
    mint: String,
    cfg: ExitConfig,
    net: NetworkConfig,
    cancel: watch::Receiver<bool>,
    price_state: Arc<RwLock<PositionPrice>>,
) -> ExitOutcome {
    info!(
        mint = %mint,
        tp = cfg.take_profit_pct,
        sl = cfg.stop_loss_pct,
        secs = cfg.max_hold_seconds,
        "exit watcher armed (TP/SL/time)"
    );

    let snipe_set: HashSet<String> =
        snipers.iter().map(|s| s.pubkey.clone()).collect();

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
                    if pct <= -cfg.stop_loss_pct {
                        break ExitOutcome::StopLoss { realized_pct: pct };
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
