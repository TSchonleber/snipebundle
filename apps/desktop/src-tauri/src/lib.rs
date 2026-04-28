mod commands;
mod state;

use state::AppState;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,snipebundle=debug")),
        )
        .init();

    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::keystore_exists,
            commands::init_keystore,
            commands::unlock_keystore,
            commands::lock_keystore,
            commands::list_wallets,
            commands::reveal_wallets,
            commands::load_config,
            commands::save_config,
            commands::start_engine,
            commands::stop_engine,
            commands::set_paused,
            commands::get_state,
            commands::manual_snipe,
            commands::manual_dump,
            commands::list_dev_wallets,
            commands::import_dev_wallet,
            commands::launch_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
