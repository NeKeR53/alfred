use serde::Serialize;
use serde_json::Value;

/// Événement poussé vers l’interface : fenêtre Tauri et, en développement, navigateur relié par le pont HTTP.
#[derive(Debug, Clone, Serialize)]
pub struct AppEvent {
    pub name: String,
    pub payload: Value,
}
