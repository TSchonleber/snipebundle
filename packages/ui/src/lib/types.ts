// Shared TypeScript types for IPC + WS payloads.
// Mirrors snipebundle_core::engine::{FeedEntry, ActivePosition, EngineState}.

export type TriggerSource = "Auto" | "TargetedDev" | "Manual";

export interface FeedEntry {
  mint: string;
  creator: string;
  symbol: string | null;
  mc_sol: number | null;
  socials: boolean;
  matched: TriggerSource | null;
  at_ms: number;
}

export interface ActivePosition {
  mint: string;
  trigger: TriggerSource;
  entry_total_sol: number;
  wallet_count: number;
  bundle_id: string | null;
  opened_at_ms: number;
  status: string;
  entry_price: number | null;
  last_price: number | null;
  unrealized_pct: number | null;
}

export interface ClosedPosition {
  mint: string;
  trigger: TriggerSource;
  entry_total_sol: number;
  wallet_count: number;
  bundle_id: string | null;
  opened_at_ms: number;
  closed_at_ms: number;
  exit_kind: string;
  realized_pct: number | null;
  entry_price: number | null;
  last_price: number | null;
  status_label: string;
}

export interface EngineState {
  feed: FeedEntry[];
  positions: ActivePosition[];
  closed_positions: ClosedPosition[];
  running: boolean;
  last_message: string;
  mint_count: number;
  matched_count: number;
  bundle_count: number;
  realized_wins: number;
  realized_losses: number;
  deployed_sol_total: number;
  realized_pnl_sol: number;
}

export interface TrendingItem {
  source: string;
  name: string | null;
  symbol: string | null;
  mint: string | null;
  price_usd: number | null;
  change_pct_24h: number | null;
  volume_usd_24h: number | null;
  market_cap_usd: number | null;
  url: string | null;
  age_minutes: number | null;
  dex_id: string | null;
}

export interface WalletInfo {
  label: string;
  pubkey: string;
}

export interface WalletWithSecret extends WalletInfo {
  secret_b58: string;
}

// Raw pumpportal WS payload for the public live-feed page.
// (Subset of fields we surface; pumpportal sends more.)
export interface PumpportalNewToken {
  signature?: string;
  mint: string;
  traderPublicKey?: string;
  creator?: string;
  txType?: string;
  initialBuy?: number;
  solAmount?: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  pool?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}
