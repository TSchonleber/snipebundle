// Bundle builder + Jito submitter. Stub for milestone 1.
//
// Hot path:
//   1. POST /api/trade-local with N buy actions (Jito tip on tx[0] only)
//   2. Receive base58-encoded unsigned txs
//   3. Sign each with the corresponding sniper keypair
//   4. POST signed bundle to mainnet.block-engine.jito.wtf/api/v1/bundles via sendBundle JSON-RPC
//
// PumpPortal API contract:
//   - Up to 5 actions per bundle
//   - priorityFee on first tx = Jito tip; subsequent priorityFees ignored
//   - pool="pump" for bonding curve, "pump-amm" post-graduation

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeAction {
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub action: String,
    pub mint: String,
    #[serde(rename = "denominatedInSol")]
    pub denominated_in_sol: String,
    pub amount: f64,
    pub slippage: u32,
    #[serde(rename = "priorityFee")]
    pub priority_fee: f64,
    pub pool: String,
}

pub async fn build_buy_bundle(
    _trade_local_url: &str,
    _actions: Vec<TradeAction>,
) -> Result<Vec<Vec<u8>>> {
    // TODO milestone 2
    anyhow::bail!("bundler::build_buy_bundle not yet implemented")
}

pub async fn submit_jito_bundle(
    _jito_url: &str,
    _signed_txs_b58: Vec<String>,
) -> Result<String> {
    // TODO milestone 2
    anyhow::bail!("bundler::submit_jito_bundle not yet implemented")
}
