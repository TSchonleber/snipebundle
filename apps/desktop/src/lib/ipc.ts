import { invoke } from "@tauri-apps/api/core";
import type {
  EngineState,
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

export interface LaunchArgs {
  dev_pubkey: string;
  metadata: LaunchMetadata;
  metadata_uri: string | null;
  image_path: string | null;
  dev_buy_sol: number;
}

export interface LaunchResult {
  mint: string;
  bundle_id: string;
  metadata_uri: string;
  dev_pubkey: string;
  dev_buy_sol: number;
}

export interface ImportDevArgs {
  label: string;
  secret_b58: string;
  passphrase: string;
}

export interface ManualBuyArgs {
  mint: string;
  sol: number;
  wallet_pubkeys: string[];
}

export interface ManualSellArgs {
  mint: string;
  wallet_pubkeys: string[];
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
  loadConfig: () => invoke<unknown>("load_config"),
  saveConfig: (cfg: unknown) => invoke<void>("save_config", { cfg }),
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
};
