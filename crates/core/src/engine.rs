use crate::bundler;
use crate::config::Config;
use crate::exit;
use crate::filters;
use crate::keystore::Keystore;
use crate::listener;
use crate::types::{MintEvent, TriggerSource};
use anyhow::Result;
use serde::Serialize;
use std::collections::VecDeque;
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

#[derive(Debug, Clone, Serialize)]
pub struct ActivePosition {
    pub mint: String,
    pub trigger: TriggerSource,
    pub entry_total_sol: f64,
    pub wallet_count: usize,
    pub bundle_id: Option<String>,
    pub opened_at_ms: i64,
    pub status: String,
    pub entry_price: Option<f64>,
    pub last_price: Option<f64>,
    pub unrealized_pct: Option<f64>,
}

#[derive(Debug, Default, Serialize)]
pub struct EngineState {
    pub feed: VecDeque<FeedEntry>,
    pub positions: Vec<ActivePosition>,
    pub running: bool,
    pub last_message: String,
    pub mint_count: u64,
    pub matched_count: u64,
    pub bundle_count: u64,
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
            self.note(format!("paused — skipped match {}", short(&ev.mint))).await;
            return;
        }

        if last_snipe_at.elapsed().as_millis() < SNIPE_COOLDOWN_MS as u128 {
            self.note(format!("cooldown — skipped {}", short(&ev.mint))).await;
            return;
        }

        let active = self.state.read().await.positions.len();
        if active >= MAX_CONCURRENT_POSITIONS {
            self.note(format!("max positions reached — skipped {}", short(&ev.mint))).await;
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
        let snipers = self.keystore.snipers.clone();
        let cfg = self.cfg.clone();
        let state = Arc::clone(&self.state);
        let sol = cfg.trigger.sol_per_snipe;
        let total = sol * snipers.len() as f64;

        let pos = ActivePosition {
            mint: mint.clone(),
            trigger,
            entry_total_sol: total,
            wallet_count: snipers.len(),
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
            s.last_message = format!("sniping {} ({:?})", short(&mint), trigger);
        }

        tokio::spawn(async move {
            match bundler::execute_buy(&snipers, &mint, sol, &cfg.network).await {
                Ok(bundle_id) => {
                    {
                        let mut s = state.write().await;
                        s.bundle_count += 1;
                        if let Some(p) = s.positions.iter_mut().find(|p| p.mint == mint) {
                            p.bundle_id = Some(bundle_id.clone());
                            p.status = format!(
                                "buy live ({}…) — TP/SL/time armed",
                                &bundle_id[..8.min(bundle_id.len())]
                            );
                        }
                    }

                    let (_cancel_tx, cancel_rx) = watch::channel(false);
                    let price_state =
                        Arc::new(RwLock::new(exit::PositionPrice::default()));
                    let mint_for_pump = mint.clone();
                    let pump_state = Arc::clone(&state);
                    let pump_price = Arc::clone(&price_state);
                    let pump_handle = tokio::spawn(async move {
                        let mut last_seen: Option<f64> = None;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(500))
                                .await;
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

                    let outcome = exit::watch_with_pricing(
                        snipers.clone(),
                        mint.clone(),
                        cfg.exit.clone(),
                        cfg.network.clone(),
                        cancel_rx,
                        Arc::clone(&price_state),
                    )
                    .await;

                    pump_handle.abort();

                    let mut s = state.write().await;
                    let label = match &outcome {
                        exit::ExitOutcome::TakeProfit { realized_pct } => {
                            format!("take-profit +{:.1}%", realized_pct)
                        }
                        exit::ExitOutcome::StopLoss { realized_pct } => {
                            format!("stop-loss {:.1}%", realized_pct)
                        }
                        exit::ExitOutcome::TimeExit { final_pct } => match final_pct {
                            Some(p) => format!("time-exit ({:+.1}%)", p),
                            None => "time-exit".into(),
                        },
                        exit::ExitOutcome::ManualDump => "manual-dump".into(),
                        exit::ExitOutcome::Failed(e) => format!("exit-failed: {e}"),
                    };
                    if let Some(p) = s.positions.iter_mut().find(|p| p.mint == mint) {
                        p.status = format!("closed: {label}");
                    }
                    s.last_message =
                        format!("position closed {} ({label})", short(&mint));
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

fn short(s: &str) -> String {
    s.chars().take(8).collect::<String>()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
