use crate::types::MintEvent;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

pub async fn run(ws_url: String, tx: mpsc::Sender<MintEvent>) -> Result<()> {
    loop {
        match connect_and_stream(&ws_url, &tx).await {
            Ok(()) => warn!("ws closed cleanly, reconnecting in 2s"),
            Err(e) => error!(error = %e, "ws error, reconnecting in 2s"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn connect_and_stream(ws_url: &str, tx: &mpsc::Sender<MintEvent>) -> Result<()> {
    info!(ws_url, "connecting to pumpportal");
    let (mut stream, _) = connect_async(ws_url).await.context("ws connect")?;

    let sub = json!({ "method": "subscribeNewToken" }).to_string();
    stream.send(Message::Text(sub)).await.context("send subscribe")?;
    info!("subscribed to new tokens");

    while let Some(msg) = stream.next().await {
        match msg? {
            Message::Text(text) => {
                if let Some(ev) = parse_mint(&text) {
                    if tx.send(ev).await.is_err() {
                        return Ok(());
                    }
                } else {
                    debug!(text, "non-mint message");
                }
            }
            Message::Ping(p) => {
                stream.send(Message::Pong(p)).await.ok();
            }
            Message::Close(_) => return Ok(()),
            _ => {}
        }
    }
    Ok(())
}

fn parse_mint(text: &str) -> Option<MintEvent> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let mint = v.get("mint")?.as_str()?.to_string();
    let creator = v
        .get("traderPublicKey")
        .or_else(|| v.get("creator"))?
        .as_str()?
        .to_string();
    Some(MintEvent {
        mint,
        creator,
        name: v.get("name").and_then(|x| x.as_str()).map(String::from),
        symbol: v.get("symbol").and_then(|x| x.as_str()).map(String::from),
        uri: v.get("uri").and_then(|x| x.as_str()).map(String::from),
        initial_buy_sol: v.get("solAmount").and_then(|x| x.as_f64()),
        market_cap_sol: v
            .get("marketCapSol")
            .and_then(|x| x.as_f64())
            .or_else(|| v.get("vSolInBondingCurve").and_then(|x| x.as_f64())),
        twitter: v.get("twitter").and_then(|x| x.as_str()).map(String::from),
        telegram: v.get("telegram").and_then(|x| x.as_str()).map(String::from),
        website: v.get("website").and_then(|x| x.as_str()).map(String::from),
        received_at: chrono_now_unix(),
    })
}

fn chrono_now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
