//! Code Mode des agents : `alfred api` et `alfred run` (à venir).

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::error::AppResult;
use crate::state::AppState;

/// Commandes de Code Mode : nom, usage, description.
pub const COMMANDS: &[(&str, &str, &str)] = &[];

pub async fn handle(
    _state: &Arc<AppState>,
    _conversation: &str,
    _command: &str,
    _argv: &[String],
    _stdin: Option<&str>,
    _cwd: Option<&Path>,
) -> Option<AppResult<Value>> {
    None
}
