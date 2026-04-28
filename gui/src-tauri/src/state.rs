use snipebundle_core::{keystore::Keystore, Config, Engine, EngineState};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{watch, Mutex, RwLock};

pub struct AppState {
    pub keystore: Mutex<Option<Keystore>>,
    pub config: Mutex<Option<Config>>,
    pub config_path: Mutex<PathBuf>,
    pub engine: Mutex<Option<EngineHandle>>,
}

pub struct EngineHandle {
    pub engine: Arc<Engine>,
    pub state: Arc<RwLock<EngineState>>,
    pub cancel_tx: watch::Sender<bool>,
    pub paused_tx: watch::Sender<bool>,
}

impl AppState {
    pub fn new() -> Self {
        let cfg_path = default_config_path();
        Self {
            keystore: Mutex::new(None),
            config: Mutex::new(None),
            config_path: Mutex::new(cfg_path),
            engine: Mutex::new(None),
        }
    }
}

fn default_config_path() -> PathBuf {
    if let Some(pd) = directories::ProjectDirs::from("fun", "snipebundle", "snipebundle") {
        let dir = pd.config_dir().to_path_buf();
        std::fs::create_dir_all(&dir).ok();
        return dir.join("config.toml");
    }
    PathBuf::from("config.toml")
}
