//! Multi-source trending Solana token signal feed.
//!
//! Aggregates free public sources to surface "what's pumping right now":
//!   - DexScreener  (`/latest/dex/search` + `/token-boosts/latest/v1`
//!                   + `/token-profiles/latest/v1`
//!                   + `/latest/dex/tokens/<mints>` for image enrichment)
//!   - GeckoTerminal (`/networks/solana/trending_pools`)
//!   - pump.fun     (`/coins/for-you` for live launches)
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
const DEXSCREENER_PROFILES_LATEST: &str =
    "https://api.dexscreener.com/token-profiles/latest/v1";
const DEXSCREENER_TOKENS_BATCH: &str =
    "https://api.dexscreener.com/latest/dex/tokens/";
const GECKOTERMINAL_TRENDING: &str =
    "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token,quote_token";
const PUMPFUN_FOR_YOU: &str =
    "https://frontend-api-v3.pump.fun/coins/for-you?offset=0&limit=40&includeNsfw=false";
const PUMPFUN_NEW: &str =
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=40&sort=created_timestamp&order=DESC&includeNsfw=false";
// "Almost migrated" = curve >70% but not yet complete. The
// king-of-the-hill endpoint only returns the current single "king" — for a
// real column we fetch the most-active uncompleted list and filter
// client-side in fetch_pumpfun_buckets.
const PUMPFUN_ALMOST: &str =
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=80&sort=last_trade_timestamp&order=DESC&includeNsfw=false";
const PUMPFUN_MIGRATED: &str =
    "https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=30&includeNsfw=false";

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
    /// Token icon URL (DexScreener `info.imageUrl` for pairs, `icon` for boosts).
    /// None when the source doesn't expose one (e.g. GeckoTerminal trending pools).
    pub image_url: Option<String>,
    /// DexScreener boost amount in their internal credits — Some(n>0) means the
    /// project paid to promote this token. UI shows a "BOOSTED" badge for these.
    pub boost_amount: Option<f64>,
}

/// Fetch from all sources in parallel; deduplicate by mint, prefer the
/// entry with more populated fields. Then enrich the survivors via DexScreener
/// tokens batch API so every entry that has a mint also has an image where
/// possible.
pub async fn fetch_all() -> Vec<TrendingItem> {
    let (dex, gecko, profiles, pumpfun) = tokio::join!(
        fetch_dexscreener_trending(),
        fetch_geckoterminal_trending(),
        fetch_dexscreener_profiles(),
        fetch_pumpfun_live(),
    );

    let mut out: Vec<TrendingItem> = Vec::new();
    for r in [dex, gecko, profiles, pumpfun] {
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
    combined.truncate(120);

    // Enrich entries that lack images via DexScreener tokens batch API.
    // GeckoTerminal trending pools don't carry icons; pump.fun gives us
    // image_uri but not always; this fills the gaps.
    enrich_images(&mut combined).await;

    combined
}

/// Best-effort: for entries with a mint but no image_url, batch-query
/// DexScreener `/latest/dex/tokens/<mints>` (up to 30 mints per call) and
/// fill in image_url + boost_amount from `pairs[0].info.imageUrl` /
/// `pairs[0].boosts.active`. Failures are logged and ignored — enrichment
/// is purely additive.
async fn enrich_images(items: &mut Vec<TrendingItem>) {
    let needs: Vec<String> = items
        .iter()
        .filter(|i| i.image_url.is_none() && i.mint.is_some())
        .filter_map(|i| i.mint.clone())
        .take(60) // 2 batches of 30 — cap so we don't hammer the API
        .collect();
    if needs.is_empty() {
        return;
    }

    let client = match reqwest::Client::builder()
        .user_agent("snipebundle/0.1")
        .timeout(std::time::Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "enrich client build failed");
            return;
        }
    };

    let mut enriched: HashMap<String, (Option<String>, Option<f64>)> = HashMap::new();
    for chunk in needs.chunks(30) {
        let url = format!("{}{}", DEXSCREENER_TOKENS_BATCH, chunk.join(","));
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "enrich fetch failed");
                continue;
            }
        };
        let json: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "enrich parse failed");
                continue;
            }
        };
        let Some(pairs) = json.get("pairs").and_then(|x| x.as_array()) else {
            continue;
        };
        for p in pairs {
            let Some(mint) = p
                .get("baseToken")
                .and_then(|b| b.get("address"))
                .and_then(|x| x.as_str())
            else {
                continue;
            };
            let entry = enriched.entry(mint.to_string()).or_insert((None, None));
            if entry.0.is_none() {
                entry.0 = p
                    .get("info")
                    .and_then(|i| i.get("imageUrl"))
                    .and_then(|x| x.as_str())
                    .map(String::from);
            }
            let boost = p
                .get("boosts")
                .and_then(|b| b.get("active"))
                .and_then(|x| x.as_f64());
            if let Some(b) = boost {
                if entry.1.unwrap_or(0.0) < b {
                    entry.1 = Some(b);
                }
            }
        }
    }

    for it in items {
        let Some(mint) = it.mint.as_deref() else {
            continue;
        };
        if let Some((img, boost)) = enriched.get(mint) {
            if it.image_url.is_none() {
                it.image_url = img.clone();
            }
            if it.boost_amount.is_none() && boost.is_some() {
                it.boost_amount = *boost;
            }
        }
    }
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
    prefer_some!(image_url);
    // Boost amount: keep the larger paid signal so a boosted entry wins.
    if other.boost_amount.unwrap_or(0.0) > into.boost_amount.unwrap_or(0.0) {
        into.boost_amount = other.boost_amount;
    }
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
    let image_url = entry
        .get("icon")
        .and_then(|x| x.as_str())
        .map(String::from);
    let boost_amount = entry
        .get("amount")
        .and_then(|x| x.as_f64())
        .filter(|v| *v > 0.0);
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
        image_url,
        boost_amount,
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
    let image_url = p
        .get("info")
        .and_then(|i| i.get("imageUrl"))
        .and_then(|x| x.as_str())
        .map(String::from);
    let boost_amount = p
        .get("boosts")
        .and_then(|b| b.get("active"))
        .and_then(|x| x.as_f64())
        .filter(|v| *v > 0.0);
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
        image_url,
        boost_amount,
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
            image_url: None,
            boost_amount: None,
        });
    }

    Ok(out)
}

/// DexScreener `/token-profiles/latest/v1` — recently profiled (and often
/// boosted) tokens. This catches "live launches" that haven't shown up in
/// search results yet.
pub async fn fetch_dexscreener_profiles() -> Result<Vec<TrendingItem>> {
    let client = reqwest::Client::builder()
        .user_agent("snipebundle/0.1")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .context("dexscreener-profiles client build")?;
    let resp = client
        .get(DEXSCREENER_PROFILES_LATEST)
        .send()
        .await
        .context("dexscreener-profiles fetch")?;
    let json: serde_json::Value = resp
        .json()
        .await
        .context("dexscreener-profiles parse")?;
    // The endpoint returns a JSON array directly.
    let arr = match &json {
        serde_json::Value::Array(a) => a.as_slice(),
        // Some shapes wrap in `{ "items": [...] }` — tolerate both.
        _ => json.get("items").and_then(|x| x.as_array()).map(|v| v.as_slice()).unwrap_or(&[]),
    };

    let mut out = Vec::new();
    for entry in arr {
        let chain = entry.get("chainId").and_then(|x| x.as_str()).unwrap_or("");
        if chain != "solana" {
            continue;
        }
        let mint = entry
            .get("tokenAddress")
            .and_then(|x| x.as_str())
            .map(String::from);
        if mint.is_none() {
            continue;
        }
        let url = entry.get("url").and_then(|x| x.as_str()).map(String::from);
        let description = entry
            .get("description")
            .and_then(|x| x.as_str())
            .map(String::from);
        let image_url = entry
            .get("icon")
            .and_then(|x| x.as_str())
            .map(String::from);
        out.push(TrendingItem {
            source: "dexscreener-latest".into(),
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
            image_url,
            boost_amount: None,
        });
    }
    Ok(out)
}

/// pump.fun frontend API — the actual live launch firehose. Returns the
/// freshest pump.fun coins with name/symbol/image and an approximate market
/// cap. Unofficial endpoint; tolerate failures.
pub async fn fetch_pumpfun_live() -> Result<Vec<TrendingItem>> {
    let client = reqwest::Client::builder()
        // pump.fun's frontend API filters out plain bot UAs; pass a normal
        // browser-shaped UA so the request survives.
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
             AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .context("pumpfun client build")?;
    let resp = client
        .get(PUMPFUN_FOR_YOU)
        .header("accept", "application/json")
        .header("origin", "https://pump.fun")
        .header("referer", "https://pump.fun/")
        .send()
        .await
        .context("pumpfun fetch")?;
    if !resp.status().is_success() {
        anyhow::bail!("pumpfun status {}", resp.status());
    }
    let json: serde_json::Value = resp.json().await.context("pumpfun parse")?;
    let arr = match &json {
        serde_json::Value::Array(a) => a.as_slice(),
        _ => &[],
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut out = Vec::new();
    for entry in arr {
        let mint = entry.get("mint").and_then(|x| x.as_str()).map(String::from);
        if mint.is_none() {
            continue;
        }
        let name = entry.get("name").and_then(|x| x.as_str()).map(String::from);
        let symbol = entry
            .get("symbol")
            .and_then(|x| x.as_str())
            .map(String::from);
        let image_url = entry
            .get("image_uri")
            .and_then(|x| x.as_str())
            .map(String::from);
        let market_cap_usd = entry
            .get("usd_market_cap")
            .and_then(|x| x.as_f64())
            .filter(|v| *v > 0.0);
        let created_ts = entry
            .get("created_timestamp")
            .and_then(|x| x.as_i64());
        let age_minutes = created_ts.map(|t| ((now_ms - t) / 60_000).max(0));
        let url = mint
            .as_ref()
            .map(|m| format!("https://pump.fun/coin/{m}"));
        out.push(TrendingItem {
            source: "pumpfun".into(),
            name,
            symbol,
            mint,
            price_usd: None,
            change_pct_24h: None,
            volume_usd_24h: None,
            market_cap_usd,
            url,
            age_minutes,
            dex_id: Some("pumpfun".into()),
            image_url,
            boost_amount: None,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// GMGN-style trenches: three live buckets sourced from pump.fun's frontend API.
// ---------------------------------------------------------------------------

/// One coin in a trenches bucket. Richer than TrendingItem because we want
/// the bonding-curve progress, holder count, social links etc. that GMGN
/// surfaces. Only populated by the pump.fun frontend API, so all fields are
/// best-effort optional.
#[derive(Debug, Clone, Serialize)]
pub struct TrenchCoin {
    pub mint: String,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub image_url: Option<String>,
    pub creator: Option<String>,
    pub created_at_ms: Option<i64>,
    pub age_minutes: Option<i64>,
    pub usd_market_cap: Option<f64>,
    /// 24h trading volume in USD — populated by DexScreener tokens enrichment
    /// for tokens that have a tracked pair. Pump.fun's API doesn't expose this.
    pub volume_usd_24h: Option<f64>,
    pub virtual_sol_reserves: Option<f64>,
    pub virtual_token_reserves: Option<f64>,
    pub bonding_curve_progress_pct: Option<f64>,
    pub complete: Option<bool>,
    /// Pump.fun "live streaming" flag — token's creator is currently broadcasting.
    /// Surfaced as a LIVE badge in the trenches columns.
    pub is_currently_live: Option<bool>,
    pub raydium_pool: Option<String>,
    pub twitter: Option<String>,
    pub telegram: Option<String>,
    pub website: Option<String>,
    pub reply_count: Option<i64>,
    pub last_trade_at_ms: Option<i64>,
}

/// Three live buckets matching GMGN's "trenches" UX.
#[derive(Debug, Clone, Serialize, Default)]
pub struct TrenchBuckets {
    /// Newly created tokens, sort by created_timestamp desc.
    pub new: Vec<TrenchCoin>,
    /// Bonding curve filling up — close to graduating to Raydium.
    pub almost: Vec<TrenchCoin>,
    /// Already migrated to Raydium (post-graduation).
    pub migrated: Vec<TrenchCoin>,
}

pub async fn fetch_pumpfun_buckets() -> TrenchBuckets {
    let (n, a, m) = tokio::join!(
        fetch_pumpfun_endpoint(PUMPFUN_NEW),
        fetch_pumpfun_endpoint(PUMPFUN_ALMOST),
        fetch_pumpfun_endpoint(PUMPFUN_MIGRATED),
    );
    // Filter the "almost" candidates: bonding curve > 70% AND not yet
    // graduated. Sort by progress descending so the closest-to-migration
    // shows first. We pulled the most-active 80 coins; usually 8-15 land
    // in this bracket at any moment.
    let mut almost = a.unwrap_or_default();
    almost.retain(|c| {
        let progress = c.bonding_curve_progress_pct.unwrap_or(0.0);
        let migrated = c.complete.unwrap_or(false);
        progress >= 70.0 && !migrated
    });
    almost.sort_by(|a, b| {
        b.bonding_curve_progress_pct
            .unwrap_or(0.0)
            .partial_cmp(&a.bonding_curve_progress_pct.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut buckets = TrenchBuckets {
        new: n.unwrap_or_default(),
        almost,
        migrated: m.unwrap_or_default(),
    };

    // Enrich volume_usd_24h via DexScreener tokens batch for the migrated
    // and almost-migrated buckets — those are the buckets where DexScreener
    // actually has a tracked pair. New (still on bonding curve) tokens
    // mostly have no DEX pair, so we skip them to save the API call.
    enrich_trench_volume(&mut buckets.migrated).await;
    enrich_trench_volume(&mut buckets.almost).await;

    buckets
}

/// Pulls 24h USD volume + image fallback for trench coins from DexScreener's
/// tokens batch endpoint. Up to 30 mints per call. Best-effort; failures are
/// silently dropped — the column still renders without volume data.
async fn enrich_trench_volume(coins: &mut [TrenchCoin]) {
    let needs: Vec<String> = coins
        .iter()
        .filter(|c| c.volume_usd_24h.is_none())
        .map(|c| c.mint.clone())
        .take(60)
        .collect();
    if needs.is_empty() {
        return;
    }
    let client = match reqwest::Client::builder()
        .user_agent("snipebundle/0.1")
        .timeout(std::time::Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut by_mint: HashMap<String, (Option<f64>, Option<String>)> =
        HashMap::new();
    for chunk in needs.chunks(30) {
        let url = format!("{}{}", DEXSCREENER_TOKENS_BATCH, chunk.join(","));
        let Ok(resp) = client.get(&url).send().await else {
            continue;
        };
        let Ok(json) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let Some(pairs) = json.get("pairs").and_then(|x| x.as_array()) else {
            continue;
        };
        for p in pairs {
            let Some(mint) = p
                .get("baseToken")
                .and_then(|b| b.get("address"))
                .and_then(|x| x.as_str())
            else {
                continue;
            };
            let entry = by_mint.entry(mint.to_string()).or_insert((None, None));
            // Pick the highest 24h volume across the token's pairs (DEX
            // aggregators sum-of-pairs is the standard "token volume").
            let v = p
                .get("volume")
                .and_then(|c| c.get("h24"))
                .and_then(|x| x.as_f64());
            if let Some(v) = v {
                if entry.0.unwrap_or(0.0) < v {
                    entry.0 = Some(v);
                }
            }
            if entry.1.is_none() {
                entry.1 = p
                    .get("info")
                    .and_then(|i| i.get("imageUrl"))
                    .and_then(|x| x.as_str())
                    .map(String::from);
            }
        }
    }
    for c in coins {
        if let Some((vol, img)) = by_mint.get(&c.mint) {
            if c.volume_usd_24h.is_none() {
                c.volume_usd_24h = *vol;
            }
            if c.image_url.is_none() {
                c.image_url = img.clone();
            }
        }
    }
}

async fn fetch_pumpfun_endpoint(url: &str) -> Result<Vec<TrenchCoin>> {
    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
             AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .context("pumpfun client build")?;
    let resp = client
        .get(url)
        .header("accept", "application/json")
        .header("origin", "https://pump.fun")
        .header("referer", "https://pump.fun/")
        .send()
        .await
        .context("pumpfun fetch")?;
    if !resp.status().is_success() {
        anyhow::bail!("pumpfun status {} for {}", resp.status(), url);
    }
    let json: serde_json::Value = resp.json().await.context("pumpfun parse")?;
    let arr = match &json {
        serde_json::Value::Array(a) => a.as_slice(),
        // king-of-the-hill returns a single object — wrap it.
        serde_json::Value::Object(_) => std::slice::from_ref(&json),
        _ => &[],
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut out = Vec::with_capacity(arr.len());
    for c in arr {
        let Some(mint) = c.get("mint").and_then(|x| x.as_str()) else {
            continue;
        };
        let created_at_ms = c.get("created_timestamp").and_then(|x| x.as_i64());
        let last_trade_at_ms = c.get("last_trade_timestamp").and_then(|x| x.as_i64());
        let age_minutes = created_at_ms.map(|t| ((now_ms - t) / 60_000).max(0));
        let virtual_sol = c.get("virtual_sol_reserves").and_then(|x| x.as_f64());
        let virtual_tok = c.get("virtual_token_reserves").and_then(|x| x.as_f64());

        // pump.fun graduates a coin once ~85 SOL has hit the bonding curve.
        // Translate virtual reserves into a 0-100% completion estimate.
        // Fallback to the explicit `complete` flag for migrated coins.
        // NOTE: virtual_sol_reserves comes from the API in lamports
        // (1 SOL = 1e9 lamports), not SOL — divide before doing math.
        let bonding_curve_progress_pct = virtual_sol.map(|sol_lamports| {
            let sol = sol_lamports / 1_000_000_000.0;
            // virtual_sol_reserves starts ~30 SOL and tops out ~115 SOL.
            // 30..115 → 0..100, clamped.
            let pct = ((sol - 30.0) / 85.0) * 100.0;
            pct.clamp(0.0, 100.0)
        });

        out.push(TrenchCoin {
            mint: mint.to_string(),
            name: c.get("name").and_then(|x| x.as_str()).map(String::from),
            symbol: c.get("symbol").and_then(|x| x.as_str()).map(String::from),
            image_url: c.get("image_uri").and_then(|x| x.as_str()).map(String::from),
            creator: c.get("creator").and_then(|x| x.as_str()).map(String::from),
            created_at_ms,
            age_minutes,
            usd_market_cap: c
                .get("usd_market_cap")
                .and_then(|x| x.as_f64())
                .filter(|v| *v > 0.0),
            volume_usd_24h: None,
            virtual_sol_reserves: virtual_sol,
            virtual_token_reserves: virtual_tok,
            bonding_curve_progress_pct,
            complete: c.get("complete").and_then(|x| x.as_bool()),
            is_currently_live: c
                .get("is_currently_live")
                .and_then(|x| x.as_bool())
                .or_else(|| c.get("currently_live").and_then(|x| x.as_bool())),
            raydium_pool: c
                .get("raydium_pool")
                .and_then(|x| x.as_str())
                .map(String::from),
            twitter: c.get("twitter").and_then(|x| x.as_str()).map(String::from),
            telegram: c.get("telegram").and_then(|x| x.as_str()).map(String::from),
            website: c.get("website").and_then(|x| x.as_str()).map(String::from),
            reply_count: c.get("reply_count").and_then(|x| x.as_i64()),
            last_trade_at_ms,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Pump.fun chart data: trade history + coin status. DexScreener can't render
// pre-migration tokens (no paid pair yet), so we draw our own line chart
// from pump.fun's trade firehose for unmigrated coins.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PumpTrade {
    pub timestamp_ms: i64,
    pub is_buy: bool,
    pub sol_amount: f64,
    pub token_amount: f64,
    /// SOL per token at the time of the trade — UI plots this as price.
    pub price_sol: f64,
    pub usd_market_cap: Option<f64>,
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PumpChartData {
    pub mint: String,
    pub coin: Option<TrenchCoin>,
    pub trades: Vec<PumpTrade>,
    /// Convenience flag: when true the bonding curve is still live and the
    /// frontend should render its own line chart; when false (graduated)
    /// we hand off to DexScreener.
    pub is_pre_migration: bool,
}

pub async fn fetch_pumpfun_chart(mint: &str) -> Result<PumpChartData> {
    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
             AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .context("pumpchart client build")?;

    // Coin metadata first — gives us name/symbol/curve state. If pump.fun
    // doesn't know this mint we still attempt the trades fetch (some non-
    // pump.fun mints have trade history through the same endpoint shape).
    let coin = fetch_pumpfun_coin(&client, mint).await.ok();
    let is_pre_migration = coin
        .as_ref()
        .and_then(|c| c.complete)
        .map(|complete| !complete)
        .unwrap_or(true);

    // Paginate so we get the full available history, not just the most
    // recent 200 trades. pump.fun caps each page at 200; pull up to 5
    // pages (1000 trades) in parallel — covers the coin's full lifetime
    // for everything except a handful of hyperactive launches. Stop early
    // when a page comes back short — that's the tail of available history.
    const PAGE_SIZE: u32 = 200;
    const MAX_PAGES: u32 = 5;

    let mut handles = Vec::with_capacity(MAX_PAGES as usize);
    for page in 0..MAX_PAGES {
        let url = format!(
            "https://frontend-api-v3.pump.fun/trades/all/{}?limit={}&offset={}&minimumSize=0",
            mint,
            PAGE_SIZE,
            page * PAGE_SIZE
        );
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            client
                .get(&url)
                .header("accept", "application/json")
                .header("origin", "https://pump.fun")
                .header("referer", "https://pump.fun/")
                .send()
                .await
        }));
    }

    let mut all_pages: Vec<Vec<PumpTrade>> = Vec::with_capacity(MAX_PAGES as usize);
    for (idx, handle) in handles.into_iter().enumerate() {
        let resp = match handle.await {
            Ok(Ok(r)) => r,
            _ => continue,
        };
        if !resp.status().is_success() {
            continue;
        }
        let json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => continue,
        };
        let arr = match &json {
            serde_json::Value::Array(a) => a.as_slice(),
            _ => &[],
        };
        let mut page = Vec::with_capacity(arr.len());
        for t in arr {
            let sol_amount =
                t.get("sol_amount").and_then(|x| x.as_f64()).unwrap_or(0.0)
                    / 1_000_000_000.0;
            let token_amount =
                t.get("token_amount").and_then(|x| x.as_f64()).unwrap_or(0.0)
                    / 1_000_000.0;
            let price_sol = if token_amount > 0.0 {
                sol_amount / token_amount
            } else {
                0.0
            };
            let timestamp_ms = t
                .get("timestamp")
                .and_then(|x| x.as_i64())
                .map(|s| s * 1000)
                .unwrap_or(0);
            page.push(PumpTrade {
                timestamp_ms,
                is_buy: t.get("is_buy").and_then(|x| x.as_bool()).unwrap_or(true),
                sol_amount,
                token_amount,
                price_sol,
                usd_market_cap: t.get("usd_market_cap").and_then(|x| x.as_f64()),
                user: t.get("user").and_then(|x| x.as_str()).map(String::from),
            });
        }
        // Page ran short → no more history past this offset.
        let last_short = (page.len() as u32) < PAGE_SIZE;
        all_pages.push(page);
        if last_short && idx + 1 < MAX_PAGES as usize {
            break;
        }
    }

    // Each page is newest-first; concatenated they're still newest-first
    // overall. Reverse the merged list so the chart x-axis flows oldest
    // → newest. Dedup defensively by timestamp+user — pagination drift
    // around live trading can cause overlap between pages.
    let mut combined: Vec<PumpTrade> = all_pages.into_iter().flatten().collect();
    combined.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    combined.dedup_by(|a, b| {
        a.timestamp_ms == b.timestamp_ms
            && a.user == b.user
            && a.sol_amount == b.sol_amount
    });
    combined.reverse();
    let trades = combined;

    Ok(PumpChartData {
        mint: mint.to_string(),
        coin,
        trades,
        is_pre_migration,
    })
}

async fn fetch_pumpfun_coin(client: &reqwest::Client, mint: &str) -> Result<TrenchCoin> {
    let url = format!("https://frontend-api-v3.pump.fun/coins/{}", mint);
    let resp = client
        .get(&url)
        .header("accept", "application/json")
        .header("origin", "https://pump.fun")
        .header("referer", "https://pump.fun/")
        .send()
        .await
        .context("pumpcoin fetch")?;
    if !resp.status().is_success() {
        anyhow::bail!("pumpcoin status {}", resp.status());
    }
    let c: serde_json::Value = resp.json().await.context("pumpcoin parse")?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let created_at_ms = c.get("created_timestamp").and_then(|x| x.as_i64());
    let age_minutes = created_at_ms.map(|t| ((now_ms - t) / 60_000).max(0));
    let virtual_sol = c.get("virtual_sol_reserves").and_then(|x| x.as_f64());
    // virtual_sol_reserves is in lamports — convert before applying the
    // 30..115 SOL → 0..100% mapping.
    let bonding_curve_progress_pct = virtual_sol.map(|sol_lamports| {
        let sol = sol_lamports / 1_000_000_000.0;
        let pct = ((sol - 30.0) / 85.0) * 100.0;
        pct.clamp(0.0, 100.0)
    });

    Ok(TrenchCoin {
        mint: mint.to_string(),
        name: c.get("name").and_then(|x| x.as_str()).map(String::from),
        symbol: c.get("symbol").and_then(|x| x.as_str()).map(String::from),
        image_url: c.get("image_uri").and_then(|x| x.as_str()).map(String::from),
        creator: c.get("creator").and_then(|x| x.as_str()).map(String::from),
        created_at_ms,
        age_minutes,
        usd_market_cap: c
            .get("usd_market_cap")
            .and_then(|x| x.as_f64())
            .filter(|v| *v > 0.0),
        volume_usd_24h: None,
        virtual_sol_reserves: virtual_sol,
        virtual_token_reserves: c
            .get("virtual_token_reserves")
            .and_then(|x| x.as_f64()),
        bonding_curve_progress_pct,
        complete: c.get("complete").and_then(|x| x.as_bool()),
        is_currently_live: c
            .get("is_currently_live")
            .and_then(|x| x.as_bool())
            .or_else(|| c.get("currently_live").and_then(|x| x.as_bool())),
        raydium_pool: c.get("raydium_pool").and_then(|x| x.as_str()).map(String::from),
        twitter: c.get("twitter").and_then(|x| x.as_str()).map(String::from),
        telegram: c.get("telegram").and_then(|x| x.as_str()).map(String::from),
        website: c.get("website").and_then(|x| x.as_str()).map(String::from),
        reply_count: c.get("reply_count").and_then(|x| x.as_i64()),
        last_trade_at_ms: c.get("last_trade_timestamp").and_then(|x| x.as_i64()),
    })
}
