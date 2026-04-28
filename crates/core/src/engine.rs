use crate::bundler;
use crate::config::Config;
use crate::exit;
use crate::filters;
use crate::keystore::{Keystore, StoredKeypair};
use crate::listener;
use crate::types::{MintEvent, TriggerSource};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use tokio::sync::{mpsc, watch, RwLock};
use tracing::warn;

const MAX_FEED_ENTRIES: usize = 50;
const MAX_CONCURRENT_POSITIONS: usize = 3;
const SNIPE_COOLDOWN_MS: u64 = 4_000;

#[derive(Debug, Clone, Serialize)]
pub struct FeedEntry {
    pub mint: String,
    pub creator: String,
    pub symbol: Option<String>,
    pub mc_sol: Option<f64>,
    pub socials: bool,
    pub matched: Option<TriggerSource>,
    pub at_ms: i64,
}

/// What initiated a position. Determines display grouping in the Dashboard
/// and (for `Launch`) suppresses script-fired auto-exits per decision 146.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PositionKind {
    Sniper,
    Launch,
    Manual,
}

impl Default for PositionKind {
    fn default() -> Self {
        PositionKind::Sniper
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivePosition {
    pub mint: String,
    pub trigger: TriggerSource,
    #[serde(default)]
    pub kind: PositionKind,
    pub entry_total_sol: f64,
    pub wallet_count: usize,
    /// The wallets that bought into this position. Surfaced so the UI can
    /// pre-fill sell panels and so per-wallet exit rules can be applied.
    #[serde(default)]
    pub wallet_pubkeys: Vec<String>,
    pub bundle_id: Option<String>,
    pub opened_at_ms: i64,
    pub status: String,
    pub entry_price: Option<f64>,
    pub last_price: Option<f64>,
    pub unrealized_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClosedPosition {
    pub mint: String,
    pub trigger: TriggerSource,
    #[serde(default)]
    pub kind: PositionKind,
    pub entry_total_sol: f64,
    pub wallet_count: usize,
    pub bundle_id: Option<String>,
    pub opened_at_ms: i64,
    pub closed_at_ms: i64,
    pub exit_kind: String, // "take-profit" | "stop-loss" | "time-exit" | "manual" | "failed"
    pub realized_pct: Option<f64>,
    pub entry_price: Option<f64>,
    pub last_price: Option<f64>,
    pub status_label: String, // human-readable summary, same as ActivePosition.status had
}

#[derive(Debug, Default, Serialize)]
pub struct EngineState {
    pub feed: VecDeque<FeedEntry>,
    pub positions: Vec<ActivePosition>,
    pub closed_positions: VecDeque<ClosedPosition>,
    pub running: bool,
    pub last_message: String,
    pub mint_count: u64,
    pub matched_count: u64,
    pub bundle_count: u64,
    pub realized_wins: u64,
    pub realized_losses: u64,
    /// Sum of all positions' entry_total_sol (open + closed). Useful for the
    /// dashboard's running "deployed capital" metric.
    pub deployed_sol_total: f64,
    /// Sum of (entry_total_sol × realized_pct/100) across closed positions.
    pub realized_pnl_sol: f64,
}

pub struct Engine {
    cfg: Config,
    keystore: Keystore,
    pub state: Arc<RwLock<EngineState>>,
}

impl Engine {
    pub fn new(cfg: Config, keystore: Keystore) -> Self {
        Self {
            cfg,
            keystore,
            state: Arc::new(RwLock::new(EngineState {
                running: false,
                ..Default::default()
            })),
        }
    }

    pub fn state_handle(&self) -> Arc<RwLock<EngineState>> {
        Arc::clone(&self.state)
    }

    /// Spawn listener + filter/executor + position lifecycle. Returns when
    /// `cancel_rx` flips true. `paused_rx` true = drop new triggers (still
    /// stream feed).
    pub async fn run(
        self: Arc<Self>,
        mut cancel_rx: watch::Receiver<bool>,
        paused_rx: watch::Receiver<bool>,
    ) -> Result<()> {
        {
            let mut s = self.state.write().await;
            s.running = true;
            s.last_message = "engine started".into();
        }

        let (mint_tx, mut mint_rx) = mpsc::channel::<MintEvent>(2048);
        let ws_url = self.cfg.network.pumpportal_ws.clone();

        let listener_handle = tokio::spawn(async move {
            if let Err(e) = listener::run(ws_url, mint_tx).await {
                warn!(error = %e, "listener exited");
            }
        });

        let mut last_snipe_at = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(60))
            .unwrap_or_else(std::time::Instant::now);

        loop {
            tokio::select! {
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() { break; }
                }
                Some(ev) = mint_rx.recv() => {
                    self.handle_mint(ev, &paused_rx, &mut last_snipe_at).await;
                }
                else => break,
            }
        }

        listener_handle.abort();
        let mut s = self.state.write().await;
        s.running = false;
        s.last_message = "engine stopped".into();
        Ok(())
    }

    async fn handle_mint(
        &self,
        ev: MintEvent,
        paused_rx: &watch::Receiver<bool>,
        last_snipe_at: &mut std::time::Instant,
    ) {
        let trigger = filters::evaluate(
            &ev,
            self.cfg.trigger.auto_enabled,
            &self.cfg.auto,
            self.cfg.trigger.targeted_enabled,
            &self.cfg.targeted,
        );

        let entry = FeedEntry {
            mint: ev.mint.clone(),
            creator: ev.creator.clone(),
            symbol: ev.symbol.clone(),
            mc_sol: ev.market_cap_sol,
            socials: ev.has_socials(),
            matched: trigger,
            at_ms: ev.received_at,
        };

        {
            let mut s = self.state.write().await;
            s.mint_count += 1;
            if trigger.is_some() {
                s.matched_count += 1;
            }
            s.feed.push_front(entry);
            if s.feed.len() > MAX_FEED_ENTRIES {
                s.feed.truncate(MAX_FEED_ENTRIES);
            }
        }

        let Some(trigger) = trigger else { return };

        if *paused_rx.borrow() {
            self.note(format!("paused — skipped match {}", short(&ev.mint)))
                .await;
            return;
        }

        if last_snipe_at.elapsed().as_millis() < SNIPE_COOLDOWN_MS as u128 {
            self.note(format!("cooldown — skipped {}", short(&ev.mint)))
                .await;
            return;
        }

        let active = self.state.read().await.positions.len();
        if active >= MAX_CONCURRENT_POSITIONS {
            self.note(format!(
                "max positions reached — skipped {}",
                short(&ev.mint)
            ))
            .await;
            return;
        }

        *last_snipe_at = std::time::Instant::now();
        self.spawn_snipe(ev.mint.clone(), trigger).await;
    }

    async fn note(&self, msg: String) {
        let mut s = self.state.write().await;
        s.last_message = msg;
    }

    async fn spawn_snipe(&self, mint: String, trigger: TriggerSource) {
        let cfg = self.cfg.clone();
        let state = Arc::clone(&self.state);

        // Resolve which wallets fire on this snipe.
        let snipers: Vec<crate::keystore::StoredKeypair> =
            if cfg.trigger.auto_snipe_wallets.is_empty() {
                // Legacy: first 5 snipers in keystore order.
                self.keystore.snipers.iter().take(5).cloned().collect()
            } else {
                let allow: std::collections::HashSet<&String> =
                    cfg.trigger.auto_snipe_wallets.iter().collect();
                self.keystore
                    .snipers
                    .iter()
                    .filter(|w| allow.contains(&w.pubkey))
                    .take(5)
                    .cloned()
                    .collect()
            };
        if snipers.is_empty() {
            self.note(format!(
                "no active sniper wallets configured — skipped {}",
                short(&mint)
            ))
            .await;
            return;
        }

        // Resolve per-wallet amounts.
        let pubkeys: Vec<String> = snipers.iter().map(|s| s.pubkey.clone()).collect();
        let amounts: Vec<f64> = match &cfg.trigger.amount_strategy {
            Some(strat) => match strat.resolve(&pubkeys) {
                Ok(v) => v,
                Err(e) => {
                    self.note(format!("strategy error: {e}")).await;
                    return;
                }
            },
            None => vec![cfg.trigger.sol_per_snipe; snipers.len()],
        };
        let total = amounts.iter().sum::<f64>();

        let wallet_pubkeys: Vec<String> =
            snipers.iter().map(|s| s.pubkey.clone()).collect();
        let pos = ActivePosition {
            mint: mint.clone(),
            trigger,
            kind: PositionKind::Sniper,
            entry_total_sol: total,
            wallet_count: snipers.len(),
            wallet_pubkeys,
            bundle_id: None,
            opened_at_ms: now_ms(),
            status: "firing buy bundle…".into(),
            entry_price: None,
            last_price: None,
            unrealized_pct: None,
        };
        {
            let mut s = state.write().await;
            s.positions.push(pos);
            s.deployed_sol_total += total;
            s.last_message = format!("sniping {} ({:?})", short(&mint), trigger);
        }

        tokio::spawn(async move {
            match bundler::execute_buy_per_wallet(&snipers, &mint, &amounts, &cfg.network).await {
                Ok(bundle_id) => {
                    {
                        let mut s = state.write().await;
                        s.bundle_count += 1;
                        if let Some(p) = s.positions.iter_mut().find(|p| p.mint == mint) {
                            p.bundle_id = Some(bundle_id.clone());
                            p.status = format!(
                                "buy live ({}…) — wallet exits armed",
                                &bundle_id[..8.min(bundle_id.len())]
                            );
                        }
                    }

                    let (_cancel_tx, cancel_rx) = watch::channel(false);
                    let price_state = Arc::new(RwLock::new(exit::PositionPrice::default()));
                    let mint_for_pump = mint.clone();
                    let pump_state = Arc::clone(&state);
                    let pump_price = Arc::clone(&price_state);
                    let pump_handle = tokio::spawn(async move {
                        let mut last_seen: Option<f64> = None;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            let snap = pump_price.read().await.clone();
                            if snap.unrealized_pct == last_seen {
                                continue;
                            }
                            last_seen = snap.unrealized_pct;
                            let mut s = pump_state.write().await;
                            if let Some(p) =
                                s.positions.iter_mut().find(|p| p.mint == mint_for_pump)
                            {
                                p.entry_price = snap.entry_price;
                                p.last_price = snap.last_price;
                                p.unrealized_pct = snap.unrealized_pct;
                            } else {
                                break;
                            }
                        }
                    });

                    let wallet_rules = snipers
                        .iter()
                        .cloned()
                        .map(|wallet| {
                            let rule = cfg.resolved_exit_for_wallet(&wallet.pubkey);
                            (wallet, rule)
                        })
                        .collect::<Vec<_>>();
                    let amounts_by_wallet = snipers
                        .iter()
                        .zip(amounts.iter())
                        .map(|(wallet, amount)| (wallet.pubkey.clone(), *amount))
                        .collect::<HashMap<_, _>>();

                    let wallet_outcomes = exit::watch_wallets_with_pricing(
                        wallet_rules,
                        mint.clone(),
                        cfg.network.clone(),
                        cancel_rx,
                        Arc::clone(&price_state),
                    )
                    .await;

                    pump_handle.abort();

                    let (label, kind, realized_pct) =
                        summarize_wallet_exits(&wallet_outcomes, &amounts_by_wallet);

                    let mut s = state.write().await;

                    // Snapshot the active position so we can move it to closed.
                    let snapshot = s.positions.iter().find(|p| p.mint == mint).cloned();

                    if let Some(active) = snapshot {
                        let realized_sol =
                            realized_pct.map(|pct| active.entry_total_sol * pct / 100.0);
                        if let Some(pct) = realized_pct {
                            if pct >= 0.0 {
                                s.realized_wins += 1;
                            } else {
                                s.realized_losses += 1;
                            }
                            if let Some(rs) = realized_sol {
                                s.realized_pnl_sol += rs;
                            }
                        }
                        let closed = ClosedPosition {
                            mint: active.mint.clone(),
                            trigger: active.trigger,
                            kind: active.kind,
                            entry_total_sol: active.entry_total_sol,
                            wallet_count: active.wallet_count,
                            bundle_id: active.bundle_id.clone(),
                            opened_at_ms: active.opened_at_ms,
                            closed_at_ms: now_ms(),
                            exit_kind: kind.into(),
                            realized_pct,
                            entry_price: active.entry_price,
                            last_price: active.last_price,
                            status_label: format!("closed: {label}"),
                        };
                        s.closed_positions.push_front(closed);
                        if s.closed_positions.len() > 100 {
                            s.closed_positions.truncate(100);
                        }
                        s.positions.retain(|p| p.mint != mint);
                    }

                    s.last_message = format!("position closed {} ({label})", short(&mint));
                }
                Err(e) => {
                    let mut s = state.write().await;
                    if let Some(p) = s.positions.iter_mut().find(|p| p.mint == mint) {
                        p.status = format!("FAILED: {e}");
                    }
                    s.last_message = format!("snipe failed {}: {e}", short(&mint));
                }
            }
        });
    }
}

impl Engine {
    /// Track a position created by the Launch flow (co-buyer wallets).
    /// The engine streams price updates so the Sniper dashboard sees live
    /// P&L on the launch — but per decision 146, NO auto-exit fires from
    /// here. Exits remain manual via the Launch sell panel or the Trade tab.
    pub async fn register_launch_position(
        self: &Arc<Self>,
        mint: String,
        snipers: Vec<StoredKeypair>,
        entry_total_sol: f64,
        bundle_id: Option<String>,
    ) {
        if snipers.is_empty() {
            return;
        }
        let wallet_pubkeys: Vec<String> =
            snipers.iter().map(|s| s.pubkey.clone()).collect();
        let bundle_short = bundle_id
            .as_deref()
            .map(|b| b[..8.min(b.len())].to_string())
            .unwrap_or_else(|| "?".into());
        let pos = ActivePosition {
            mint: mint.clone(),
            trigger: TriggerSource::Manual,
            kind: PositionKind::Launch,
            entry_total_sol,
            wallet_count: snipers.len(),
            wallet_pubkeys: wallet_pubkeys.clone(),
            bundle_id: bundle_id.clone(),
            opened_at_ms: now_ms(),
            status: format!(
                "launch live ({bundle_short}…) — manual exit only"
            ),
            entry_price: None,
            last_price: None,
            unrealized_pct: None,
        };
        {
            let mut s = self.state.write().await;
            if s.positions.iter().any(|p| p.mint == mint) {
                return; // already tracked
            }
            s.positions.push(pos);
            s.deployed_sol_total += entry_total_sol;
            s.last_message = format!("tracking launch {}", short(&mint));
        }

        // Price tracker — feeds live price/P&L into the position. NO exit
        // logic; manual sell only for launch-kind positions.
        let state = Arc::clone(&self.state);
        let ws_url = self.cfg.network.pumpportal_ws.clone();
        let snipe_set: HashSet<String> = wallet_pubkeys.into_iter().collect();
        let mint_for_task = mint.clone();
        tokio::spawn(async move {
            let (trade_tx, mut trade_rx) = mpsc::channel(256);
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let watcher = tokio::spawn({
                let url = ws_url.clone();
                let m = mint_for_task.clone();
                async move {
                    crate::price_watcher::run(url, m, trade_tx, cancel_rx).await;
                }
            });
            let mut entry_price: Option<f64> = None;
            while let Some(t) = trade_rx.recv().await {
                {
                    let s = state.read().await;
                    if !s.positions.iter().any(|p| p.mint == mint_for_task) {
                        let _ = cancel_tx.send(true);
                        break;
                    }
                }
                let Some(price) = t.price_sol_per_token() else {
                    continue;
                };
                if entry_price.is_none()
                    && snipe_set.contains(&t.trader_pubkey)
                    && t.tx_type.eq_ignore_ascii_case("buy")
                {
                    entry_price = Some(price);
                }
                let mut s = state.write().await;
                if let Some(p) = s
                    .positions
                    .iter_mut()
                    .find(|p| p.mint == mint_for_task && p.kind == PositionKind::Launch)
                {
                    if entry_price.is_some() && p.entry_price.is_none() {
                        p.entry_price = entry_price;
                    }
                    p.last_price = Some(price);
                    if let Some(e) = p.entry_price {
                        if e > 0.0 {
                            p.unrealized_pct = Some((price - e) / e * 100.0);
                        }
                    }
                }
            }
            let _ = watcher.await;
        });
    }

    /// Move a launch position from active → closed (called by the manual
    /// sell flow once the user fires their dump bundles).
    pub async fn close_launch_position(
        &self,
        mint: &str,
        exit_label: &str,
    ) {
        let mut s = self.state.write().await;
        let snapshot = s
            .positions
            .iter()
            .find(|p| p.mint == mint && p.kind == PositionKind::Launch)
            .cloned();
        let Some(active) = snapshot else { return };

        let realized_pct = active.unrealized_pct;
        let realized_sol = realized_pct
            .map(|pct| active.entry_total_sol * pct / 100.0);
        if let Some(pct) = realized_pct {
            if pct >= 0.0 {
                s.realized_wins += 1;
            } else {
                s.realized_losses += 1;
            }
            if let Some(rs) = realized_sol {
                s.realized_pnl_sol += rs;
            }
        }
        let closed = ClosedPosition {
            mint: active.mint.clone(),
            trigger: active.trigger,
            kind: active.kind,
            entry_total_sol: active.entry_total_sol,
            wallet_count: active.wallet_count,
            bundle_id: active.bundle_id.clone(),
            opened_at_ms: active.opened_at_ms,
            closed_at_ms: now_ms(),
            exit_kind: "manual".into(),
            realized_pct,
            entry_price: active.entry_price,
            last_price: active.last_price,
            status_label: format!("closed: {exit_label}"),
        };
        s.closed_positions.push_front(closed);
        if s.closed_positions.len() > 100 {
            s.closed_positions.truncate(100);
        }
        s.positions.retain(|p| p.mint != mint);
        s.last_message = format!("launch position closed {} ({exit_label})", short(mint));
    }
}

fn short(s: &str) -> String {
    s.chars().take(8).collect::<String>()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn summarize_wallet_exits(
    results: &[exit::WalletExitResult],
    amounts_by_wallet: &HashMap<String, f64>,
) -> (String, &'static str, Option<f64>) {
    if results.is_empty() {
        return ("exit-failed: no wallet results".into(), "failed", None);
    }

    let mut take_profit = 0usize;
    let mut stop_loss = 0usize;
    let mut trailing_stop = 0usize;
    let mut time_exit = 0usize;
    let mut manual = 0usize;
    let mut failed = 0usize;
    let mut weighted_pct = 0.0;
    let mut realized_weight = 0.0;

    for result in results {
        match result.outcome.kind() {
            "take-profit" => take_profit += 1,
            "stop-loss" => stop_loss += 1,
            "trailing-stop" => trailing_stop += 1,
            "time-exit" => time_exit += 1,
            "manual" => manual += 1,
            "failed" => failed += 1,
            _ => {}
        }
        if let Some(pct) = result.outcome.realized_pct() {
            let weight = amounts_by_wallet
                .get(&result.wallet_pubkey)
                .copied()
                .unwrap_or(1.0)
                .max(0.0);
            weighted_pct += pct * weight;
            realized_weight += weight;
        }
    }

    let realized_pct = if realized_weight > 0.0 {
        Some(weighted_pct / realized_weight)
    } else {
        None
    };

    let mut parts = Vec::new();
    if take_profit > 0 {
        parts.push(format!("{take_profit} TP"));
    }
    if stop_loss > 0 {
        parts.push(format!("{stop_loss} SL"));
    }
    if trailing_stop > 0 {
        parts.push(format!("{trailing_stop} TS"));
    }
    if time_exit > 0 {
        parts.push(format!("{time_exit} hold"));
    }
    if manual > 0 {
        parts.push(format!("{manual} manual"));
    }
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }

    let nonzero_kinds = [take_profit, stop_loss, trailing_stop, time_exit, manual, failed]
        .iter()
        .filter(|count| **count > 0)
        .count();
    let kind = if nonzero_kinds == 1 {
        results[0].outcome.kind()
    } else if failed == results.len() {
        "failed"
    } else {
        "mixed"
    };

    let label = match realized_pct {
        Some(pct) => format!("wallet exits: {} ({:+.1}% avg)", parts.join(", "), pct),
        None => format!("wallet exits: {}", parts.join(", ")),
    };

    (label, kind, realized_pct)
}
