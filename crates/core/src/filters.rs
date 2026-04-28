use crate::config::{AutoFilters, TargetedConfig};
use crate::types::{MintEvent, TriggerSource};

pub fn evaluate(
    ev: &MintEvent,
    auto_enabled: bool,
    auto: &AutoFilters,
    targeted_enabled: bool,
    targeted: &TargetedConfig,
) -> Option<TriggerSource> {
    if targeted_enabled && targeted.dev_wallets.iter().any(|w| w == &ev.creator) {
        return Some(TriggerSource::TargetedDev);
    }
    if !auto_enabled {
        return None;
    }
    if auto.funder_blacklist.iter().any(|w| w == &ev.creator) {
        return None;
    }
    if auto.require_socials && !ev.has_socials() {
        return None;
    }
    if let Some(mc) = ev.market_cap_sol {
        if mc > auto.max_entry_mc_sol {
            return None;
        }
    }
    if let Some(initial) = ev.initial_buy_sol {
        if let Some(mc) = ev.market_cap_sol {
            if mc > 0.0 {
                let pct = (initial / mc) * 100.0;
                if pct < auto.min_dev_buy_pct {
                    return None;
                }
            }
        }
    }
    Some(TriggerSource::Auto)
}
