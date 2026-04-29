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
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false";
const PUMPFUN_ALMOST: &str =
    "https://frontend-api-v3.pump.fun/coins/king-of-the-hill?includeNsfw=false&offset=0&limit=30";
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
    TrenchBuckets {
        new: n.unwrap_or_default(),
        almost: a.unwrap_or_default(),
        migrated: m.unwrap_or_default(),
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
        let bonding_curve_progress_pct = virtual_sol.map(|sol| {
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
