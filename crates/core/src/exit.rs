use crate::bundler;
use crate::config::{ExitConfig, NetworkConfig};
use crate::keystore::StoredKeypair;
use anyhow::Result;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub enum ExitOutcome {
    TimeExit,
    ManualDump,
    Failed(String),
}

/// Time-based exit watcher (M3a). Sleeps `max_hold_seconds`, then dumps.
/// TP/SL via price polling lands in a follow-up.
pub async fn watch_and_dump(
    snipers: Vec<StoredKeypair>,
    mint: String,
    cfg: ExitConfig,
    net: NetworkConfig,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> ExitOutcome {
    let hold = Duration::from_secs(cfg.max_hold_seconds);
    info!(mint = %mint, secs = cfg.max_hold_seconds, "exit watcher armed");

    let mut cancel = cancel.clone();
    tokio::select! {
        _ = sleep(hold) => {}
        _ = cancel.changed() => {
            if *cancel.borrow() {
                info!(mint = %mint, "exit watcher cancelled — manual dump");
                return ExitOutcome::ManualDump;
            }
        }
    }

    match bundler::execute_sell(&snipers, &mint, &net).await {
        Ok(bundle_id) => {
            info!(mint = %mint, bundle_id = %bundle_id, "auto-sold at hold timeout");
            ExitOutcome::TimeExit
        }
        Err(e) => {
            warn!(mint = %mint, error = %e, "exit sell failed");
            ExitOutcome::Failed(e.to_string())
        }
    }
}

/// Returns Ok(bundle_id) on submitted dump, used by manual `dump` command.
pub async fn dump_now(
    snipers: &[StoredKeypair],
    mint: &str,
    net: &NetworkConfig,
) -> Result<String> {
    bundler::execute_sell(snipers, mint, net).await
}
