//! Per-mint price watcher backed by PumpPortal's `subscribeTokenTrade` WS.
//!
//! Opens a dedicated WS connection scoped to one mint, parses each trade
//! event into a `TradeUpdate`, and pushes onto an mpsc channel. The exit
//! watcher consumes from there.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, warn};

#[derive(Debug, Clone)]
pub struct TradeUpdate {
    pub mint: String,
    pub trader_pubkey: String,
    pub tx_type: String,
    pub sol_amount: Option<f64>,
    pub token_amount: Option<f64>,
    /// Post-trade curve state — best signal for "current price."
    pub v_sol_in_curve: Option<f64>,
    pub v_tokens_in_curve: Option<f64>,
    pub market_cap_sol: Option<f64>,
}

impl TradeUpdate {
    /// Best-effort SOL-per-token price using post-trade curve state, falling
    /// back to the per-trade ratio if curve data isn't present.
    pub fn price_sol_per_token(&self) -> Option<f64> {
        if let (Some(sol), Some(tokens)) = (self.v_sol_in_curve, self.v_tokens_in_curve) {
            if tokens > 0.0 {
                return Some(sol / tokens);
            }
        }
        if let (Some(sol), Some(tokens)) = (self.sol_amount, self.token_amount) {
            if tokens > 0.0 {
                return Some(sol / tokens);
            }
        }
        None
    }
}

/// Run a price watcher until `cancel` flips or the channel is closed.
/// Emits a `TradeUpdate` per trade event for the subscribed mint.
pub async fn run(
    ws_url: String,
    mint: String,
    tx: mpsc::Sender<TradeUpdate>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    loop {
        if *cancel.borrow() {
            return;
        }
        match stream(&ws_url, &mint, &tx, &mut cancel).await {
            Ok(()) => {
                if *cancel.borrow() {
                    return;
                }
                warn!(mint = %mint, "price ws closed, reconnecting in 1s");
            }
            Err(e) => warn!(mint = %mint, error = %e, "price ws error, reconnecting in 1s"),
        }
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            _ = cancel.changed() => return,
        }
    }
}

async fn stream(
    ws_url: &str,
    mint: &str,
    tx: &mpsc::Sender<TradeUpdate>,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let (mut ws, _) = connect_async(ws_url).await.context("price ws connect")?;
    let sub = json!({
        "method": "subscribeTokenTrade",
        "keys": [mint],
    })
    .to_string();
    ws.send(Message::Text(sub)).await.context("price ws subscribe")?;
    debug!(mint, "subscribed to token trades");

    loop {
        tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() { return Ok(()); }
            }
            msg = ws.next() => {
                let Some(msg) = msg else { return Ok(()) };
                match msg? {
                    Message::Text(text) => {
                        if let Some(update) = parse_trade(mint, &text) {
                            if tx.send(update).await.is_err() {
                                return Ok(());
                            }
                        }
                    }
                    Message::Ping(p) => {
                        ws.send(Message::Pong(p)).await.ok();
                    }
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
        }
    }
}

fn parse_trade(target_mint: &str, text: &str) -> Option<TradeUpdate> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    // Filter: only events for our mint (subscribe broadcasts are per-mint
    // but server may include heartbeats / other shapes).
    let mint = v.get("mint")?.as_str()?;
    if mint != target_mint {
        return None;
    }
    let trader = v
        .get("traderPublicKey")
        .or_else(|| v.get("trader"))
        .and_then(|x| x.as_str())?
        .to_string();
    let tx_type = v
        .get("txType")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Some(TradeUpdate {
        mint: mint.to_string(),
        trader_pubkey: trader,
        tx_type,
        sol_amount: v.get("solAmount").and_then(|x| x.as_f64()),
        token_amount: v.get("tokenAmount").and_then(|x| x.as_f64()),
        v_sol_in_curve: v.get("vSolInBondingCurve").and_then(|x| x.as_f64()),
        v_tokens_in_curve: v.get("vTokensInBondingCurve").and_then(|x| x.as_f64()),
        market_cap_sol: v.get("marketCapSol").and_then(|x| x.as_f64()),
    })
}
