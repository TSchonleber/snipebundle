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
  launchToken: (args: LaunchArgs) =>
    invoke<LaunchResult>("launch_token", { args }),
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
  addSniperWallet: (passphrase: string, label?: string) =>
    invoke<WalletWithSecret>("add_sniper_wallet", {
      args: { passphrase, label },
    }),
  deleteWallet: (pubkey: string, passphrase: string) =>
    invoke<void>("delete_wallet", { args: { pubkey, passphrase } }),
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
