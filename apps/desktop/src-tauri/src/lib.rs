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
        .plugin(tauri_plugin_fs::init())
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
            commands::create_dev_wallet,
            commands::launch_token,
            commands::launch_multiple_tokens,
            commands::start_volume_session,
            commands::stop_volume_session,
            commands::list_volume_sessions,
            commands::get_balances,
            commands::fan_out_from_master,
            commands::fan_out_from_master_per_wallet,
            commands::send_sol,
            commands::list_bundle_groups,
            commands::save_bundle_group,
            commands::delete_bundle_group,
            commands::add_sniper_wallet,
            commands::delete_wallet,
            commands::reassign_wallet_role,
            commands::get_trending,
            commands::get_pumpfun_buckets,
            commands::get_pumpfun_chart,
            commands::ensure_engine_running,
            commands::register_launch_position,
            commands::close_launch_position,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
