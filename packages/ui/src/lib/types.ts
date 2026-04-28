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
}

export interface EngineState {
  feed: FeedEntry[];
  positions: ActivePosition[];
  running: boolean;
  last_message: string;
  mint_count: number;
  matched_count: number;
  bundle_count: number;
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
