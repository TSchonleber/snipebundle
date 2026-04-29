import { invoke } from "@tauri-apps/api/core";
import type {
  EngineState,
  TrendingItem,
  WalletInfo,
  WalletWithSecret,
} from "@snipebundle/ui";

export interface InitArgs {
  passphrase: string;
  wallet_count: number;
}

export interface InitResult {
  master: WalletWithSecret;
  snipers: WalletWithSecret[];
  keystore_path: string;
}

export interface LaunchMetadata {
  name: string;
  symbol: string;
  description: string;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

export interface CoBuyerSpec {
  pubkey: string;
  sol: number;
}

// --- Config (mirrors crates/core/src/config.rs) ----------------------------

/**
 * GMGN-style trenches bucket. Sourced from pump.fun's frontend API; richer
 * than TrendingItem because we want bonding-curve progress, holders, age etc.
 */
export interface TrenchCoin {
  mint: string;
  name: string | null;
  symbol: string | null;
  image_url: string | null;
  creator: string | null;
  created_at_ms: number | null;
  age_minutes: number | null;
  usd_market_cap: number | null;
  volume_usd_24h: number | null;
  virtual_sol_reserves: number | null;
  virtual_token_reserves: number | null;
  bonding_curve_progress_pct: number | null;
  complete: boolean | null;
  is_currently_live: boolean | null;
  raydium_pool: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  reply_count: number | null;
  last_trade_at_ms: number | null;
}

export interface TrenchBuckets {
  new: TrenchCoin[];
  almost: TrenchCoin[];
  migrated: TrenchCoin[];
}

export interface PumpTrade {
  timestamp_ms: number;
  is_buy: boolean;
  sol_amount: number;
  token_amount: number;
  /** SOL per token at trade time. */
  price_sol: number;
  usd_market_cap: number | null;
  user: string | null;
}

export interface PumpChartData {
  mint: string;
  coin: TrenchCoin | null;
  trades: PumpTrade[];
  /** True until the bonding curve graduates to Raydium. UI uses this to
   *  decide between custom SVG chart (true) and DexScreener iframe (false). */
  is_pre_migration: boolean;
}

export interface ExitRule {
  take_profit_pct: number;
  stop_loss_pct: number;
  max_hold_seconds: number;
}

export interface ExitProfile {
  label: string | null;
  take_profit_pct: number;
  stop_loss_pct: number;
  max_hold_seconds: number;
}

export interface WalletExitProfiles {
  profiles: ExitProfile[];
  selected: number;
  stop_loss_enabled: boolean;
  trailing_stop_pct: number | null;
  buy_presets_sol: number[];
  sell_presets_pct: number[];
}

/**
 * v0.1.17 per-wallet binding. `selected_template = i` resolves to
 * `AppConfig.profile_templates[i]`; `null` means use this wallet's own
 * `custom` profile. Editing a template updates every wallet bound to it.
 */
export interface WalletProfileBinding {
  selected_template: number | null;
  custom: ExitProfile;
  stop_loss_enabled: boolean;
  trailing_stop_pct: number | null;
  buy_presets_sol: number[];
  sell_presets_pct: number[];
  /** v0.1.52: id into Config.bundle_groups; auto-rebuy after exit. */
  rebuy_group_id: string | null;
}

/** v0.1.52: named, saved sets of wallets+amounts for chained rebuys. */
export interface BundleGroup {
  /** Empty string on create — backend assigns. */
  id: string;
  name: string;
  wallet_pubkeys: string[];
  default_sol_per_wallet: number;
}

export interface AppConfig {
  wallets: {
    count: number;
    max_sol_per_wallet: number;
    master_reserve_sol: number;
  };
  trigger: {
    auto_enabled: boolean;
    targeted_enabled: boolean;
    sol_per_snipe: number;
    auto_snipe_wallets: string[];
    amount_strategy: AmountStrategy | null;
  };
  auto: {
    min_dev_buy_pct: number;
    require_socials: boolean;
    max_entry_mc_sol: number;
    funder_blacklist: string[];
  };
  targeted: {
    dev_wallets: string[];
    bypass_filters: boolean;
  };
  exit: ExitRule;
  wallet_exit_rules: Record<string, ExitRule>;
  /** v0.1.12 legacy. Read-only — UI writes to `wallet_bindings`. */
  wallet_profiles: Record<string, WalletExitProfiles>;
  /** v0.1.17: shared exit-rule templates referenced by wallet bindings. */
  profile_templates: ExitProfile[];
  /** v0.1.17: per-wallet binding (template idx OR custom) + UI presets. */
  wallet_bindings: Record<string, WalletProfileBinding>;
  presets: {
    buy_presets_sol: number[];
    sell_presets_pct: number[];
  };
  /** v0.1.52: saved bundle groups for chained rebuys. */
  bundle_groups: BundleGroup[];
  network: {
    rpc_url: string;
    pumpportal_ws: string;
    trade_local_url: string;
    jito_block_engine: string;
    jito_tip_sol: number;
    priority_fee_sol: number;
    slippage_bps: number;
  };
}

export interface LaunchArgs {
  dev_pubkey: string;
  metadata: LaunchMetadata;
  metadata_uri: string | null;
  image_path: string | null;
  dev_buy_sol: number;
  co_buyers?: CoBuyerSpec[];
}

export interface LaunchResult {
  mint: string;
  bundle_id: string;
  follow_on_bundle_ids?: string[];
  follow_on_errors?: string[];
  metadata_uri: string;
  dev_pubkey: string;
  dev_buy_sol: number;
  co_buyer_count: number;
  co_buyer_total_sol: number;
}

/** v0.1.57: Raydium-direct launch (skip pump.fun). On-chain stub
 *  returns "not yet implemented" until the CPMM pool init lands in
 *  v0.1.58+. The data model + UI surface are wired now. */
export interface RaydiumCoBuyer {
  pubkey: string;
  sol: number;
}
export interface RaydiumLaunchArgs {
  dev_pubkey: string;
  metadata: LaunchArgs["metadata"];
  metadata_uri: string;
  token_supply: number;
  token_decimals: number;
  initial_lp_token_amount: number;
  initial_lp_sol: number;
  burn_lp: boolean;
  dev_buy_sol: number;
  co_buyers: RaydiumCoBuyer[];
}
export interface RaydiumLaunchResult {
  mint: string;
  pool_id: string;
  bundle_id: string;
  lp_burn_signature: string | null;
}

/** v0.1.54: per-token result of a launch_multiple_tokens batch. */
export interface MultiLaunchOutcome {
  index: number;
  mint: string | null;
  bundle_id: string | null;
  error: string | null;
}

/** v0.1.55: volume bot config + status. */
export type VolumeAmountSpec =
  | { kind: "uniform"; sol: number }
  | { kind: "random"; min_sol: number; max_sol: number };

export type VolumeIntervalSpec =
  | { kind: "fixed"; seconds: number }
  | { kind: "random"; min_seconds: number; max_seconds: number };

export interface VolumeStopGuards {
  market_cap_max_sol?: number | null;
  market_cap_min_sol?: number | null;
  pnl_take_profit_sol?: number | null;
  pnl_stop_loss_sol?: number | null;
  outsider_buy_min_sol?: number | null;
  max_cycles?: number | null;
}

export interface VolumeBotConfig {
  mint: string;
  wallet_pubkeys: string[];
  buy_amount: VolumeAmountSpec;
  sell_percent: number;
  interval_between_cycles: VolumeIntervalSpec;
  buy_to_sell_gap: VolumeIntervalSpec | null;
  stop_guards: VolumeStopGuards;
  sell_on_stop: boolean;
}

export interface VolumeBotStatus {
  running: boolean;
  cycles_completed: number;
  buys_submitted: number;
  sells_submitted: number;
  failures: number;
  session_sol_in: number;
  session_sol_out: number;
  last_event_ms: number;
  last_message: string;
  current_mc_sol: number | null;
  last_observed_price_sol: number | null;
  stop_reason: string | null;
}

export interface VolumeSessionInfo {
  id: string;
  mint: string;
  status: VolumeBotStatus;
}

export interface ImportDevArgs {
  label: string;
  secret_b58: string;
  passphrase: string;
}

export type AmountStrategy =
  | { kind: "uniform"; sol: number }
  | { kind: "per_wallet"; sol_per_wallet: Record<string, number> }
  | { kind: "random"; min_sol: number; max_sol: number };

export interface ManualBuyArgs {
  mint: string;
  wallet_pubkeys: string[];
  strategy: AmountStrategy;
}

export interface ManualSellArgs {
  mint: string;
  wallet_pubkeys: string[];
  /** Percentage of each wallet's holdings to sell (1..=100). */
  percent?: number;
}

export const ipc = {
  keystoreExists: () => invoke<boolean>("keystore_exists"),
  initKeystore: (args: InitArgs) =>
    invoke<InitResult>("init_keystore", { args }),
  unlockKeystore: (passphrase: string) =>
    invoke<void>("unlock_keystore", { passphrase }),
  lockKeystore: () => invoke<void>("lock_keystore"),
  listWallets: () => invoke<WalletInfo[]>("list_wallets"),
  revealWallets: (passphrase: string) =>
    invoke<WalletWithSecret[]>("reveal_wallets", { passphrase }),
  loadConfig: () => invoke<AppConfig>("load_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config", { cfg }),
  startEngine: () => invoke<void>("start_engine"),
  stopEngine: () => invoke<void>("stop_engine"),
  setPaused: (paused: boolean) => invoke<void>("set_paused", { paused }),
  getState: () => invoke<EngineState | null>("get_state"),
  manualSnipe: (args: ManualBuyArgs) =>
    invoke<string>("manual_snipe", { args }),
  manualDump: (args: ManualSellArgs) =>
    invoke<string>("manual_dump", { args }),
  listDevWallets: () => invoke<WalletInfo[]>("list_dev_wallets"),
  importDevWallet: (args: ImportDevArgs) =>
    invoke<WalletInfo>("import_dev_wallet", { args }),
  createDevWallet: (passphrase: string, label?: string) =>
    invoke<WalletWithSecret>("create_dev_wallet", {
      args: { passphrase, label },
    }),
  launchToken: (args: LaunchArgs) =>
    invoke<LaunchResult>("launch_token", { args }),
  launchMultipleTokens: (launches: LaunchArgs[]) =>
    invoke<MultiLaunchOutcome[]>("launch_multiple_tokens", {
      args: { launches },
    }),
  launchTokenRaydium: (args: RaydiumLaunchArgs) =>
    invoke<RaydiumLaunchResult>("launch_token_raydium", {
      args: { args },
    }),
  startVolumeSession: (config: VolumeBotConfig) =>
    invoke<string>("start_volume_session", { args: { config } }),
  stopVolumeSession: (id: string) =>
    invoke<null>("stop_volume_session", { args: { id } }),
  listVolumeSessions: () =>
    invoke<VolumeSessionInfo[]>("list_volume_sessions"),
  getBalances: (pubkeys: string[]) =>
    invoke<Record<string, number>>("get_balances", { pubkeys }),
  fanOutFromMaster: (recipients: string[], solPerWallet: number) =>
    invoke<{
      signature: string;
      master_pubkey: string;
      recipients: string[];
      sol_per_wallet: number;
      total_sol: number;
    }>("fan_out_from_master", {
      args: { recipients, sol_per_wallet: solPerWallet },
    }),
  listBundleGroups: () =>
    invoke<BundleGroup[]>("list_bundle_groups"),
  saveBundleGroup: (group: BundleGroup) =>
    invoke<BundleGroup>("save_bundle_group", { args: { group } }),
  deleteBundleGroup: (id: string) =>
    invoke<null>("delete_bundle_group", { args: { id } }),
  sendSol: (sourcePubkey: string, destination: string, sol: number) =>
    invoke<string>("send_sol", {
      args: { source_pubkey: sourcePubkey, destination, sol },
    }),
  fanOutFromMasterPerWallet: (recipients: string[], amountsSol: number[]) =>
    invoke<{
      signature: string;
      master_pubkey: string;
      recipients: string[];
      sol_per_wallet: number;
      total_sol: number;
    }>("fan_out_from_master_per_wallet", {
      args: { recipients, amounts_sol: amountsSol },
    }),
  addSniperWallet: (passphrase: string, label?: string) =>
    invoke<WalletWithSecret>("add_sniper_wallet", {
      args: { passphrase, label },
    }),
  deleteWallet: (pubkey: string, passphrase: string) =>
    invoke<void>("delete_wallet", { args: { pubkey, passphrase } }),
  reassignWalletRole: (
    pubkey: string,
    targetRole: "sniper" | "dev" | "volume",
    passphrase: string,
  ) =>
    invoke<void>("reassign_wallet_role", {
      args: { pubkey, target_role: targetRole, passphrase },
    }),
  listVolumeWallets: () =>
    invoke<WalletInfo[]>("list_volume_wallets"),
  createVolumeWallet: (passphrase: string, label?: string) =>
    invoke<WalletWithSecret>("create_volume_wallet", {
      args: { passphrase, label },
    }),
  importVolumeWallet: (label: string, secretB58: string, passphrase: string) =>
    invoke<WalletInfo>("import_volume_wallet", {
      args: { label, secret_b58: secretB58, passphrase },
    }),
  getTrending: () => invoke<TrendingItem[]>("get_trending"),
  getPumpfunBuckets: () =>
    invoke<TrenchBuckets>("get_pumpfun_buckets"),
  getPumpfunChart: (mint: string) =>
    invoke<PumpChartData>("get_pumpfun_chart", { mint }),
  ensureEngineRunning: () => invoke<void>("ensure_engine_running"),
  registerLaunchPosition: (args: {
    mint: string;
    wallet_pubkeys: string[];
    entry_total_sol: number;
    bundle_id: string | null;
  }) => invoke<void>("register_launch_position", { args }),
  closeLaunchPosition: (mint: string, label?: string) =>
    invoke<void>("close_launch_position", {
      args: { mint, label: label ?? "manual sell" },
    }),
};
