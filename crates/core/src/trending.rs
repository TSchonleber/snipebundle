//! Multi-source trending Solana token signal feed.
//!
//! Aggregates free public sources to surface "what's pumping right now":
//!   - DexScreener  (`/latest/dex/search` + `/token-boosts/latest/v1`)
//!   - GeckoTerminal (`/networks/solana/trending_pools`)
//!
//! No X API. No paid scrapers. Free endpoints with rate limits — we cache
//! per call and tolerate per-source failures (one source down doesn't kill
//! the feed).

use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use tracing::warn;

const DEXSCREENER_SOLANA_SEARCH: &str =
    "https://api.dexscreener.com/latest/dex/search?q=SOL";
const DEXSCREENER_BOOSTS_LATEST: &str =
    "https://api.dexscreener.com/token-boosts/latest/v1";
const GECKOTERMINAL_TRENDING: &str =
    "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token,quote_token";

#[derive(Debug, Clone, Serialize)]
pub struct TrendingItem {
    pub source: String,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub mint: Option<String>,
    pub price_usd: Option<f64>,
    pub change_pct_24h: Option<f64>,
    pub volume_usd_24h: Option<f64>,
    pub market_cap_usd: Option<f64>,
    pub url: Option<String>,
    pub age_minutes: Option<i64>,
    pub dex_id: Option<String>,
}

/// Fetch from all sources in parallel; deduplicate by mint, prefer the
/// entry with more populated fields.
pub async fn fetch_all() -> Vec<TrendingItem> {
    let (dex, gecko) = tokio::join!(
        fetch_dexscreener_trending(),
        fetch_geckoterminal_trending(),
    );

    let mut out: Vec<TrendingItem> = Vec::new();
    for r in [dex, gecko] {
        match r {
            Ok(items) => out.extend(items),
            Err(e) => warn!(error = %e, "trending source failed"),
        }
    }

    // Dedupe by mint, prefer richer entries.
    let mut by_mint: HashMap<String, TrendingItem> = HashMap::new();
    let mut without_mint: Vec<TrendingItem> = Vec::new();
    for it in out {
        match it.mint.clone() {
            Some(m) => {
                let entry = by_mint.entry(m).or_insert_with(|| it.clone());
                merge_better(entry, &it);
            }
            None => without_mint.push(it),
        }
    }
    let mut combined: Vec<TrendingItem> = by_mint.into_values().collect();
    combined.extend(without_mint);

    // Sort: 24h volume desc, then market cap desc.
    combined.sort_by(|a, b| {
        b.volume_usd_24h
            .unwrap_or(0.0)
            .partial_cmp(&a.volume_usd_24h.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                b.market_cap_usd
                    .unwrap_or(0.0)
                    .partial_cmp(&a.market_cap_usd.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    combined.truncate(100);
    combined
}

fn merge_better(into: &mut TrendingItem, other: &TrendingItem) {
    macro_rules! prefer_some {
        ($field:ident) => {
            if into.$field.is_none() && other.$field.is_some() {
                into.$field = other.$field.clone();
            }
        };
    }
    prefer_some!(name);
    prefer_some!(symbol);
    prefer_some!(price_usd);
    prefer_some!(change_pct_24h);
    prefer_some!(volume_usd_24h);
    prefer_some!(market_cap_usd);
    prefer_some!(url);
    prefer_some!(age_minutes);
    prefer_some!(dex_id);
}

pub async fn fetch_dexscreener_trending() -> Result<Vec<TrendingItem>> {
    let client = reqwest::Client::builder()
        .user_agent("snipebundle/0.1")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .context("build reqwest client")?;

    // 1. Boosted tokens (latest)
    let mut items: Vec<TrendingItem> = Vec::new();
    if let Ok(resp) = client.get(DEXSCREENER_BOOSTS_LATEST).send().await {
        if let Ok(text) = resp.text().await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(arr) = v.as_array() {
                    for entry in arr.iter().take(40) {
                        if let Some(it) = parse_dexscreener_boost(entry) {
                            items.push(it);
                        }
                    }
                }
            }
        }
    }

    // 2. Search-based (active SOL pairs by volume)
    if let Ok(resp) = client.get(DEXSCREENER_SOLANA_SEARCH).send().await {
        if let Ok(text) = resp.text().await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(pairs) = v.get("pairs").and_then(|x| x.as_array()) {
                    for p in pairs.iter().take(60) {
                        if let Some(it) = parse_dexscreener_pair(p) {
                            items.push(it);
                        }
                    }
                }
            }
        }
    }

    Ok(items)
}

fn parse_dexscreener_boost(entry: &serde_json::Value) -> Option<TrendingItem> {
    let chain = entry.get("chainId").and_then(|x| x.as_str())?;
    if chain != "solana" {
        return None;
    }
    let mint = entry.get("tokenAddress").and_then(|x| x.as_str()).map(String::from);
    let url = entry.get("url").and_then(|x| x.as_str()).map(String::from);
    let description = entry
        .get("description")
        .and_then(|x| x.as_str())
        .map(String::from);
    Some(TrendingItem {
        source: "dexscreener-boost".into(),
        name: description,
        symbol: None,
        mint,
        price_usd: None,
        change_pct_24h: None,
        volume_usd_24h: None,
        market_cap_usd: None,
        url,
        age_minutes: None,
        dex_id: None,
    })
}

fn parse_dexscreener_pair(p: &serde_json::Value) -> Option<TrendingItem> {
    let chain = p.get("chainId").and_then(|x| x.as_str())?;
    if chain != "solana" {
        return None;
    }
    let base = p.get("baseToken")?;
    let mint = base
        .get("address")
        .and_then(|x| x.as_str())
        .map(String::from);
    let symbol = base.get("symbol").and_then(|x| x.as_str()).map(String::from);
    let name = base.get("name").and_then(|x| x.as_str()).map(String::from);
    let price_usd = p
        .get("priceUsd")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<f64>().ok());
    let change_pct_24h = p
        .get("priceChange")
        .and_then(|c| c.get("h24"))
        .and_then(|x| x.as_f64());
    let volume_usd_24h = p
        .get("volume")
        .and_then(|c| c.get("h24"))
        .and_then(|x| x.as_f64());
    let market_cap_usd = p
        .get("marketCap")
        .and_then(|x| x.as_f64())
        .or_else(|| p.get("fdv").and_then(|x| x.as_f64()));
    let url = p.get("url").and_then(|x| x.as_str()).map(String::from);
    let dex_id = p.get("dexId").and_then(|x| x.as_str()).map(String::from);
    let age_minutes = p
        .get("pairCreatedAt")
        .and_then(|x| x.as_i64())
        .map(|created| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            ((now - created) / 60_000).max(0)
        });

    Some(TrendingItem {
        source: "dexscreener".into(),
        name,
        symbol,
        mint,
        price_usd,
        change_pct_24h,
        volume_usd_24h,
        market_cap_usd,
        url,
        age_minutes,
        dex_id,
    })
}

pub async fn fetch_geckoterminal_trending() -> Result<Vec<TrendingItem>> {
    let client = reqwest::Client::builder()
        .user_agent("snipebundle/0.1")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .context("build reqwest client")?;
    let resp = client
        .get(GECKOTERMINAL_TRENDING)
        .send()
        .await
        .context("GET geckoterminal")?;
    if !resp.status().is_success() {
        anyhow::bail!("geckoterminal {}", resp.status());
    }
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value =
        serde_json::from_str(&text).context("parse geckoterminal json")?;

    let included: HashMap<String, &serde_json::Value> = v
        .get("included")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let id = e.get("id").and_then(|x| x.as_str())?.to_string();
                    Some((id, e))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut out = Vec::new();
    let pools = v.get("data").and_then(|x| x.as_array());
    let Some(pools) = pools else {
        return Ok(out);
    };
    for pool in pools.iter().take(60) {
        let Some(attr) = pool.get("attributes") else {
            continue;
        };
        let base_id = pool
            .get("relationships")
            .and_then(|r| r.get("base_token"))
            .and_then(|r| r.get("data"))
            .and_then(|r| r.get("id"))
            .and_then(|x| x.as_str());
        let base_token = base_id.and_then(|id| included.get(id));
        let mint = base_token
            .and_then(|t| t.get("attributes"))
            .and_then(|a| a.get("address"))
            .and_then(|x| x.as_str())
            .map(String::from);
        let symbol = base_token
            .and_then(|t| t.get("attributes"))
            .and_then(|a| a.get("symbol"))
            .and_then(|x| x.as_str())
            .map(String::from);
        let name = base_token
            .and_then(|t| t.get("attributes"))
            .and_then(|a| a.get("name"))
            .and_then(|x| x.as_str())
            .map(String::from);
        let price_usd = attr
            .get("base_token_price_usd")
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse::<f64>().ok());
        let change_pct_24h = attr
            .get("price_change_percentage")
            .and_then(|c| c.get("h24"))
            .and_then(|x| match x {
                serde_json::Value::String(s) => s.parse::<f64>().ok(),
                serde_json::Value::Number(n) => n.as_f64(),
                _ => None,
            });
        let volume_usd_24h = attr
            .get("volume_usd")
            .and_then(|c| c.get("h24"))
            .and_then(|x| match x {
                serde_json::Value::String(s) => s.parse::<f64>().ok(),
                serde_json::Value::Number(n) => n.as_f64(),
                _ => None,
            });
        let market_cap_usd = attr
            .get("market_cap_usd")
            .and_then(|x| match x {
                serde_json::Value::String(s) => s.parse::<f64>().ok(),
                serde_json::Value::Number(n) => n.as_f64(),
                _ => None,
            })
            .or_else(|| {
                attr.get("fdv_usd").and_then(|x| match x {
                    serde_json::Value::String(s) => s.parse::<f64>().ok(),
                    serde_json::Value::Number(n) => n.as_f64(),
                    _ => None,
                })
            });

        out.push(TrendingItem {
            source: "geckoterminal".into(),
            name,
            symbol,
            mint,
            price_usd,
            change_pct_24h,
            volume_usd_24h,
            market_cap_usd,
            url: pool
                .get("attributes")
                .and_then(|a| a.get("address"))
                .and_then(|x| x.as_str())
                .map(|addr| format!("https://www.geckoterminal.com/solana/pools/{addr}")),
            age_minutes: None,
            dex_id: None,
        });
    }

    Ok(out)
}
