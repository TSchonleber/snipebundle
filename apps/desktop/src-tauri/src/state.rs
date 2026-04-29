use snipebundle_core::volume::VolumeBotHandle;
use snipebundle_core::{keystore::Keystore, Config, Engine, EngineState};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{watch, Mutex, RwLock};

pub struct AppState {
    pub keystore: Mutex<Option<Keystore>>,
    pub config: Mutex<Option<Config>>,
    pub config_path: Mutex<PathBuf>,
    pub engine: Mutex<Option<EngineHandle>>,
    /// v0.1.55: live volume-bot sessions keyed by their assigned id.
    /// One handle per session; cancelling it stops the loop and the
    /// task self-removes from this map on shutdown.
    pub volume_sessions: Mutex<HashMap<String, Arc<VolumeBotHandle>>>,
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
            volume_sessions: Mutex::new(HashMap::new()),
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
