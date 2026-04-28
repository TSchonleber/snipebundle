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
  manualSnipe: (mint: string, sol?: number) =>
    invoke<string>("manual_snipe", { mint, sol }),
  manualDump: (mint: string) => invoke<string>("manual_dump", { mint }),
};
