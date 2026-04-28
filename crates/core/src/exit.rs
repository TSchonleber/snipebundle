// Exit watcher. Stub for milestone 1.
//
// Per open Position, poll bonding-curve price (via Pumpportal or RPC),
// SELL via Jito bundle when first of:
//   - unrealized gain >= take_profit_pct
//   - elapsed >= max_hold_seconds (default 60)
//   - unrealized loss >= stop_loss_pct

use crate::config::ExitConfig;
use crate::types::Position;
use anyhow::Result;

pub async fn watch(_pos: Position, _cfg: ExitConfig) -> Result<ExitOutcome> {
    anyhow::bail!("exit::watch not yet implemented")
}

#[derive(Debug, Clone)]
pub enum ExitOutcome {
    TakeProfit { realized_pct: f64 },
    StopLoss { realized_pct: f64 },
    TimeExit { realized_pct: f64 },
    Failed { reason: String },
}
