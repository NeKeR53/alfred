//! Suivis : relancer une conversation d’agent quand un événement de module arrive (fin d’une CI, d’une
//! automatisation…), sur le modèle de l’ADR 0018 de OneApp.
//!
//! Un suivi attend `module/evenement`, éventuellement filtré par `match` (chaque clé doit valoir la même chose dans
//! le contenu de l’événement), jusqu’à une échéance. Il est gardé dans la base de l’espace : il survit à une
//! fermeture d’Alfred, et un événement publié pendant la fermeture est vu au retour (la file des livraisons le
//! garde). Quand l’événement arrive, ou à l’échéance, le suivi passe à « déclenché » ; l’interface dépose alors un
//! message dans la conversation, qui la relance, puis le marque « livré ». Une seule relance par suivi.

use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::Space;
use crate::state::AppState;

/// Échéance par défaut et maximale d’un suivi.
const DEFAULT_MINUTES: i64 = 60;
const MAX_MINUTES: i64 = 7 * 24 * 60;
/// Suivis en attente par conversation.
const MAX_PER_CONVERSATION: i64 = 20;

fn open(space: &Space) -> AppResult<Connection> {
    let db = crate::space_db::open(space)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_agent_watches (
           id TEXT PRIMARY KEY, conversation TEXT NOT NULL, event TEXT NOT NULL, filter TEXT NOT NULL,
           label TEXT NOT NULL, deadline INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, payload TEXT,
           created_at INTEGER NOT NULL, fired_at INTEGER);
         CREATE INDEX IF NOT EXISTS _alfred_agent_watches_event ON _alfred_agent_watches (status, event);",
    )?;
    Ok(db)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Le contenu de l’événement correspond-il au filtre ? Chaque clé du filtre doit valoir la même chose.
pub fn matches(filter: &Value, payload: &Value) -> bool {
    match filter.as_object() {
        None => true,
        Some(filter) => filter.iter().all(|(key, expected)| payload.get(key) == Some(expected)),
    }
}

fn valid_event(event: &str) -> bool {
    event.split_once('/').is_some_and(|(module, id)| crate::space::valid_id(module) && crate::space::valid_id(id))
}

fn row(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let payload: Option<String> = row.get(8)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "conversation": row.get::<_, String>(1)?,
        "event": row.get::<_, String>(2)?,
        "match": serde_json::from_str::<Value>(&row.get::<_, String>(3)?).unwrap_or(Value::Null),
        "label": row.get::<_, String>(4)?,
        "deadline": row.get::<_, i64>(5)?,
        "status": row.get::<_, String>(6)?,
        "reason": row.get::<_, Option<String>>(7)?,
        "payload": payload.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
        "createdAt": row.get::<_, i64>(9)?,
    }))
}

const COLUMNS: &str = "id, conversation, event, filter, label, deadline, status, reason, payload, created_at";

/// Crée un suivi ; rend sa description.
pub fn create(state: &AppState, conversation: &str, args: &Value) -> AppResult<Value> {
    let event: String = arg(args, "event")?;
    if !valid_event(&event) {
        return Err(AppError::new("L’événement à attendre s’écrit « module/evenement »."));
    }
    let filter: Value = opt_arg(args, "match")?.unwrap_or(Value::Null);
    if !(filter.is_null() || filter.is_object()) {
        return Err(AppError::new("`match` est un objet : chaque clé doit valoir la même chose dans l’événement."));
    }
    let minutes = opt_arg::<i64>(args, "timeoutMinutes")?.unwrap_or(DEFAULT_MINUTES);
    if !(1..=MAX_MINUTES).contains(&minutes) {
        return Err(AppError::new("L’échéance d’un suivi va d’une minute à sept jours."));
    }
    let label = opt_arg::<String>(args, "label")?
        .map(|label| label.trim().chars().take(120).collect::<String>())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| event.clone());
    let space = state.space()?;
    let db = open(&space)?;
    let waiting: i64 = db.query_row(
        "SELECT count(*) FROM _alfred_agent_watches WHERE conversation = ?1 AND status = 'waiting'",
        [conversation],
        |row| row.get(0),
    )?;
    if waiting >= MAX_PER_CONVERSATION {
        return Err(AppError::new("Cette conversation attend déjà vingt événements : annulez-en un d’abord."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    db.execute(
        "INSERT INTO _alfred_agent_watches (id, conversation, event, filter, label, deadline, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'waiting', ?7)",
        params![id, conversation, event, filter.to_string(), label, now + minutes * 60_000, now],
    )?;
    state.emit("agent:watches", json!({ "conversation": conversation }));
    get(&db, &id)?.ok_or_else(|| AppError::new("Le suivi n’a pas pu être enregistré."))
}

fn get(db: &Connection, id: &str) -> AppResult<Option<Value>> {
    Ok(db.query_row(&format!("SELECT {COLUMNS} FROM _alfred_agent_watches WHERE id = ?1"), [id], row).optional()?)
}

/// Suivis d’une conversation encore utiles à montrer : en attente, ou déclenchés sans être livrés.
pub fn list(state: &AppState, conversation: Option<&str>) -> AppResult<Vec<Value>> {
    let db = open(&state.space()?)?;
    let mut statement = db.prepare(&format!(
        "SELECT {COLUMNS} FROM _alfred_agent_watches WHERE status IN ('waiting', 'fired') AND (?1 IS NULL OR conversation = ?1) ORDER BY created_at"
    ))?;
    let rows = statement.query_map(params![conversation], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Annule un suivi en attente ; avec `conversation`, seulement s’il lui appartient.
pub fn cancel(state: &AppState, id: &str, conversation: Option<&str>) -> AppResult<()> {
    let db = open(&state.space()?)?;
    let changed = db.execute(
        "UPDATE _alfred_agent_watches SET status = 'cancelled' WHERE id = ?1 AND status = 'waiting' AND (?2 IS NULL OR conversation = ?2)",
        params![id, conversation],
    )?;
    if changed == 0 {
        return Err(AppError::new("Ce suivi n’attend plus rien."));
    }
    state.emit("agent:watches", json!({}));
    Ok(())
}

/// Arrête tous les suivis d’une conversation (archivée, supprimée).
pub fn cancel_conversation(state: &AppState, conversation: &str) -> AppResult<()> {
    let db = open(&state.space()?)?;
    db.execute(
        "UPDATE _alfred_agent_watches SET status = 'cancelled' WHERE conversation = ?1 AND status IN ('waiting', 'fired')",
        [conversation],
    )?;
    state.emit("agent:watches", json!({ "conversation": conversation }));
    Ok(())
}

/// Le message déposé dans la conversation a été envoyé : le suivi ne relancera plus.
pub fn delivered(state: &AppState, id: &str) -> AppResult<()> {
    let db = open(&state.space()?)?;
    db.execute("UPDATE _alfred_agent_watches SET status = 'delivered' WHERE id = ?1 AND status = 'fired'", [id])?;
    Ok(())
}

fn fire(db: &Connection, id: &str, reason: &str, payload: Option<&Value>) -> AppResult<bool> {
    Ok(db.execute(
        "UPDATE _alfred_agent_watches SET status = 'fired', reason = ?2, payload = ?3, fired_at = ?4 WHERE id = ?1 AND status = 'waiting'",
        params![id, reason, payload.map(Value::to_string), now_ms()],
    )? > 0)
}

fn running() -> &'static std::sync::OnceLock<Arc<AppState>> {
    static STATE: std::sync::OnceLock<Arc<AppState>> = std::sync::OnceLock::new();
    &STATE
}

/// Appelé à chaque publication d’un événement de module (`module_events::publish`) : les suivis qui l’attendent
/// sont déclenchés, et l’interface prévenue.
pub fn published(space: &Space, event: &str, payload: &Value) {
    let result = match running().get() {
        Some(state) => on_event(state, space, event, payload),
        None => on_event_quietly(space, event, payload),
    };
    if let Err(error) = result {
        log::warn!("suivis d’agent sur {event} : {error}");
    }
}

fn on_event_quietly(space: &Space, event: &str, payload: &Value) -> AppResult<usize> {
    fire_matching(&open(space)?, event, payload)
}

fn fire_matching(db: &Connection, event: &str, payload: &Value) -> AppResult<usize> {
    let mut statement =
        db.prepare("SELECT id, filter FROM _alfred_agent_watches WHERE status = 'waiting' AND event = ?1 AND deadline > ?2")?;
    let candidates: Vec<(String, String)> = statement
        .query_map(params![event, now_ms()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut fired = 0;
    for (id, filter) in candidates {
        if matches(&serde_json::from_str(&filter).unwrap_or(Value::Null), payload) && fire(db, &id, "event", Some(payload))? {
            fired += 1;
        }
    }
    Ok(fired)
}

/// Un événement de module vient d’être publié : les suivis qui l’attendent sont déclenchés.
pub fn on_event(state: &AppState, space: &Space, event: &str, payload: &Value) -> AppResult<usize> {
    let fired = fire_matching(&open(space)?, event, payload)?;
    if fired > 0 {
        state.emit("agent:watches", json!({ "fired": true }));
    }
    Ok(fired)
}

/// Échéances passées : les suivis expirés sont déclenchés, l’agent apprend que rien n’est arrivé.
pub fn expire(state: &AppState) -> AppResult<usize> {
    let Some(space) = state.try_space() else { return Ok(0) };
    let db = open(&space)?;
    let mut statement = db.prepare("SELECT id FROM _alfred_agent_watches WHERE status = 'waiting' AND deadline <= ?1")?;
    let expired: Vec<String> = statement.query_map([now_ms()], |row| row.get(0))?.collect::<Result<_, _>>()?;
    let mut fired = 0;
    for id in expired {
        if fire(&db, &id, "timeout", None)? {
            fired += 1;
        }
    }
    if fired > 0 {
        state.emit("agent:watches", json!({ "fired": true }));
    }
    Ok(fired)
}

/// Surveille les échéances tant qu’Alfred tourne.
pub fn start(state: Arc<AppState>) {
    let _ = running().set(state.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = expire(&state) {
                log::warn!("échéances des suivis d’agent : {error}");
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

/// Message déposé dans la conversation à la relance.
pub fn wake_message(watch: &Value) -> String {
    let label = watch["label"].as_str().unwrap_or_default();
    let event = watch["event"].as_str().unwrap_or_default();
    if watch["reason"] == "timeout" {
        return format!(
            "Relance automatique (suivi « {label} ») : l’événement {event} n’est pas arrivé avant l’échéance. Fais le point et décide de la suite."
        );
    }
    let payload = serde_json::to_string_pretty(&watch["payload"]).unwrap_or_default();
    format!("Relance automatique (suivi « {label} ») : l’événement {event} est arrivé.\n\n```json\n{payload}\n```\n\nReprends ton travail à partir de ce résultat.")
}

/// Une page (ou une fonction) n’agit que sur les conversations lancées par son module.
pub fn ensure_owned(state: &AppState, args: &Value, conversation: &str) -> AppResult<()> {
    let subject: crate::permissions::Subject = arg(args, "subject")?;
    let scope = state
        .app_db
        .lock()
        .ok()
        .and_then(|db| crate::app_db::agent_scope(&db, conversation).ok().flatten());
    match scope {
        Some(scope) if scope.module == subject.module => Ok(()),
        _ => Err(AppError::new("Cette conversation n’a pas été lancée par ce module.")),
    }
}

/// Commandes de l’interface : la coquille relance les conversations ; une page passe par `frame.agents.*`.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "frame.agents.watch" => arg::<String>(args, "conversationId").and_then(|conversation| {
            ensure_owned(state, args, &conversation)?;
            create(state, &conversation, args)
        }),
        "frame.agents.cancelWatch" => arg::<String>(args, "id").and_then(|id| {
            let db = open(&state.space()?)?;
            let conversation: Option<String> = db
                .query_row("SELECT conversation FROM _alfred_agent_watches WHERE id = ?1", [&id], |row| row.get(0))
                .optional()?;
            let conversation = conversation.ok_or_else(|| AppError::new("Ce suivi n’existe pas."))?;
            ensure_owned(state, args, &conversation)?;
            cancel(state, &id, Some(&conversation)).map(|_| Value::Null)
        }),
        "frame.agents.owns" => arg::<String>(args, "conversationId")
            .and_then(|conversation| ensure_owned(state, args, &conversation))
            .map(|_| Value::Null),
        "agents.watches.list" => {
            opt_arg::<String>(args, "conversation").and_then(|conversation| list(state, conversation.as_deref()).map(Value::from))
        }
        "agents.watches.pending" => list(state, None).map(|watches| {
            Value::Array(
                watches
                    .into_iter()
                    .filter(|watch| watch["status"] == "fired")
                    .map(|mut watch| {
                        watch["message"] = Value::String(wake_message(&watch));
                        watch
                    })
                    .collect(),
            )
        }),
        "agents.watches.delivered" => arg::<String>(args, "id").and_then(|id| delivered(state, &id)).map(|_| Value::Null),
        "agents.watches.cancel" => arg::<String>(args, "id").and_then(|id| cancel(state, &id, None)).map(|_| Value::Null),
        "agents.watches.cancelConversation" => {
            arg::<String>(args, "conversation").and_then(|conversation| cancel_conversation(state, &conversation)).map(|_| Value::Null)
        }
        "agents.watches.create" => arg::<String>(args, "conversation").and_then(|conversation| create(state, &conversation, args)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (Arc<AppState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        state.set_space(Some(space));
        (state, dir)
    }

    #[test]
    fn a_watch_fires_once_on_its_event_and_survives_a_restart() {
        let (state, _dir) = state();
        let watch = create(&state, "conv", &json!({ "event": "ci/fin", "match": { "pipeline": 42 }, "label": "CI 42" })).unwrap();
        assert_eq!(watch["status"], "waiting");
        let space = state.space().unwrap();
        // Un autre pipeline ne la déclenche pas ; le bon, une seule fois.
        assert_eq!(on_event(&state, &space, "ci/fin", &json!({ "pipeline": 7 })).unwrap(), 0);
        assert_eq!(on_event(&state, &space, "ci/fin", &json!({ "pipeline": 42, "statut": "ok" })).unwrap(), 1);
        assert_eq!(on_event(&state, &space, "ci/fin", &json!({ "pipeline": 42 })).unwrap(), 0);
        // Rien n’est gardé en mémoire : une nouvelle lecture de la base retrouve le suivi déclenché.
        let pending = list(&state, None).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["reason"], "event");
        let message = wake_message(&pending[0]);
        assert!(message.contains("CI 42") && message.contains("\"statut\": \"ok\""), "{message}");
        delivered(&state, watch["id"].as_str().unwrap()).unwrap();
        assert!(list(&state, Some("conv")).unwrap().is_empty());
    }

    #[test]
    fn deadlines_cancellation_and_validation() {
        let (state, _dir) = state();
        let watch = create(&state, "conv", &json!({ "event": "ci/fin", "timeoutMinutes": 1 })).unwrap();
        let db = open(&state.space().unwrap()).unwrap();
        db.execute("UPDATE _alfred_agent_watches SET deadline = 0", []).unwrap();
        assert_eq!(expire(&state).unwrap(), 1);
        let fired = list(&state, Some("conv")).unwrap();
        assert_eq!(fired[0]["reason"], "timeout");
        assert!(wake_message(&fired[0]).contains("n’est pas arrivé"));
        assert!(cancel(&state, watch["id"].as_str().unwrap(), None).is_err(), "déjà déclenché");

        let other = create(&state, "autre", &json!({ "event": "ci/fin" })).unwrap();
        assert!(cancel(&state, other["id"].as_str().unwrap(), Some("conv")).is_err(), "pas le sien");
        cancel_conversation(&state, "autre").unwrap();
        assert!(list(&state, Some("autre")).unwrap().is_empty());

        assert!(create(&state, "conv", &json!({ "event": "pas-de-module" })).is_err());
        assert!(create(&state, "conv", &json!({ "event": "ci/fin", "timeoutMinutes": 0 })).is_err());
        assert!(create(&state, "conv", &json!({ "event": "ci/fin", "match": [1] })).is_err());
        assert!(matches(&json!({ "a": 1 }), &json!({ "a": 1, "b": 2 })));
        assert!(!matches(&json!({ "a": 1 }), &json!({ "b": 2 })));
    }
}
