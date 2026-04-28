use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MintEvent {
    pub mint: String,
    pub creator: String,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub uri: Option<String>,
    pub initial_buy_sol: Option<f64>,
    pub market_cap_sol: Option<f64>,
    pub twitter: Option<String>,
    pub telegram: Option<String>,
    pub website: Option<String>,
    pub received_at: i64,
}

impl MintEvent {
    pub fn has_socials(&self) -> bool {
        self.twitter.is_some() || self.telegram.is_some() || self.website.is_some()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TriggerSource {
    Auto,
    TargetedDev,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub mint: String,
    pub wallet_pubkey: String,
    pub entry_sol: f64,
    pub tokens_bought: f64,
    pub entry_price: f64,
    pub opened_at: i64,
    pub trigger: TriggerSource,
    pub bundle_id: Option<String>,
}
