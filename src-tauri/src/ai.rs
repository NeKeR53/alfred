//! Appel unique au modèle.

use std::sync::Arc;

use serde_json::Value;

use crate::error::AppResult;
use crate::state::AppState;

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(_state: &Arc<AppState>, _command: &str, _args: &Value) -> Option<AppResult<Value>> {
    None
}
