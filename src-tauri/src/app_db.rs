//! Base d’Alfred, hors de l’espace : ce que l’agent ne doit pas pouvoir modifier en éditant un fichier (accords de
//! permission), et ce qui est propre au poste (réglages, journal, index des conversations).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::error::AppResult;

pub fn migrate(db: &Connection) -> AppResult<()> {
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS grants (
           space TEXT NOT NULL, subject TEXT NOT NULL, resource TEXT NOT NULL, granted_at TEXT NOT NULL,
           PRIMARY KEY (space, subject, resource));
         CREATE TABLE IF NOT EXISTS journal (
           id INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
           subject TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER, summary TEXT NOT NULL, detail TEXT);
         CREATE INDEX IF NOT EXISTS journal_space_at ON journal (space, id DESC);
         CREATE TABLE IF NOT EXISTS conversations (
           id TEXT PRIMARY KEY, space TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS conversations_space ON conversations (space, updated_at DESC);
         CREATE TABLE IF NOT EXISTS agent_scopes (
           conversation TEXT PRIMARY KEY, module TEXT NOT NULL, functions TEXT NOT NULL);",
    )?;
    Ok(())
}

pub fn get_setting(db: &Connection, key: &str) -> AppResult<Option<Value>> {
    let text: Option<String> =
        db.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get(0)).optional()?;
    Ok(text.and_then(|text| serde_json::from_str(&text).ok()))
}

pub fn set_setting(db: &Connection, key: &str, value: &Value) -> AppResult<()> {
    if value.is_null() {
        db.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    } else {
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
    }
    Ok(())
}

/// Horodatage ISO 8601 en UTC, sans dépendance de date.
pub fn now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default();
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Algorithme civil de Howard Hinnant.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3_600, rest % 3_600 / 60, rest % 60)
}

/// Entrée du journal d’exécution : appels de fonctions, webhooks reçus, requêtes des clients, appels IA.
pub struct JournalEntry<'a> {
    pub space: &'a str,
    /// `function`, `webhook`, `client`, `ai`, `schedule`, `module`.
    pub kind: &'a str,
    /// Ce qui a été exécuté : `module/fonction`, identifiant du client…
    pub subject: &'a str,
    /// `ok` ou `error`.
    pub status: &'a str,
    pub duration_ms: Option<u64>,
    pub summary: &'a str,
    /// Détail technique en JSON ; ne doit contenir aucun secret.
    pub detail: Option<&'a Value>,
}

pub fn record_journal(db: &Connection, entry: &JournalEntry<'_>) -> AppResult<i64> {
    db.execute(
        "INSERT INTO journal (space, at, kind, subject, status, duration_ms, summary, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entry.space,
            now(),
            entry.kind,
            entry.subject,
            entry.status,
            entry.duration_ms.map(|value| value as i64),
            entry.summary,
            entry.detail.map(Value::to_string),
        ],
    )?;
    // Le journal reste borné : seules les 5 000 dernières entrées de l’espace sont gardées.
    db.execute(
        "DELETE FROM journal WHERE space = ?1 AND id <= (SELECT id FROM journal WHERE space = ?1 ORDER BY id DESC LIMIT 1 OFFSET 5000)",
        params![entry.space],
    )?;
    Ok(db.last_insert_rowid())
}

pub fn read_journal(db: &Connection, space: &str, kind: Option<&str>, limit: u32) -> AppResult<Vec<Value>> {
    let mut statement = db.prepare(
        "SELECT id, at, kind, subject, status, duration_ms, summary, detail FROM journal
         WHERE space = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY id DESC LIMIT ?3",
    )?;
    let rows = statement.query_map(params![space, kind, limit], |row| {
        let detail: Option<String> = row.get(7)?;
        Ok(serde_json::json!({
            "id": row.get::<_, i64>(0)?,
            "at": row.get::<_, String>(1)?,
            "kind": row.get::<_, String>(2)?,
            "subject": row.get::<_, String>(3)?,
            "status": row.get::<_, String>(4)?,
            "durationMs": row.get::<_, Option<i64>>(5)?,
            "summary": row.get::<_, String>(6)?,
            "detail": detail.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
        }))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn is_granted(db: &Connection, space: &str, subject: &str, resource: &str) -> AppResult<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM grants WHERE space = ?1 AND subject = ?2 AND resource = ?3",
            params![space, subject, resource],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub fn grant(db: &Connection, space: &str, subject: &str, resource: &str) -> AppResult<()> {
    db.execute(
        "INSERT OR IGNORE INTO grants (space, subject, resource, granted_at) VALUES (?1, ?2, ?3, ?4)",
        params![space, subject, resource, now()],
    )?;
    Ok(())
}

pub fn revoke(db: &Connection, space: &str, subject: &str, resource: &str) -> AppResult<()> {
    db.execute(
        "DELETE FROM grants WHERE space = ?1 AND subject = ?2 AND resource = ?3",
        params![space, subject, resource],
    )?;
    Ok(())
}

/// Retire tous les accords d’un module : ceux de ses pages, de ses panneaux et de ses fonctions. Un module installé
/// plus tard sous le même identifiant repart de zéro.
pub fn revoke_module(db: &Connection, space: &str, module: &str) -> AppResult<()> {
    let escaped = like_escape(module);
    // Les accords que le module a reçus (ses pages, ses fonctions)… et ceux que d’autres ont reçus sur ses
    // fonctions : un module recréé sous le même identifiant ne doit hériter d’aucun des deux.
    db.execute(
        "DELETE FROM grants WHERE space = ?1
           AND (subject LIKE ?2 ESCAPE '\\' OR subject = ?3 OR resource LIKE ?4 ESCAPE '\\')",
        params![space, format!("page:{escaped}/%"), format!("function:{module}/*"), format!("function:{escaped}/%")],
    )?;
    Ok(())
}

/// Oublie les accords portant sur une ressource retirée (une fonction supprimée) : celle qui reprendrait son nom
/// redemandera.
pub fn revoke_resource(db: &Connection, space: &str, resource: &str) -> AppResult<()> {
    db.execute("DELETE FROM grants WHERE space = ?1 AND resource = ?2", params![space, resource])?;
    Ok(())
}

/// Retire les accords d’une page (et de son panneau, qui les partage).
pub fn revoke_subject(db: &Connection, space: &str, subject: &str) -> AppResult<()> {
    db.execute("DELETE FROM grants WHERE space = ?1 AND subject = ?2", params![space, subject])?;
    Ok(())
}

fn like_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Périmètre d’une conversation lancée par une page ou par les fonctions d’un module : l’agent n’agit que sur ce
/// module, et sur les fonctions d’autres modules que l’utilisateur a accordées au demandeur.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentScope {
    pub module: String,
    pub functions: Vec<String>,
    /// Entrées imposées par le demandeur, par fonction (« module/fonction ») : le modèle ne peut pas les changer.
    pub inputs: std::collections::BTreeMap<String, serde_json::Value>,
}

pub fn set_agent_scope(db: &Connection, conversation: &str, scope: &AgentScope) -> AppResult<()> {
    db.execute(
        "INSERT INTO agent_scopes (conversation, module, functions) VALUES (?1, ?2, ?3)
         ON CONFLICT (conversation) DO UPDATE SET module = excluded.module, functions = excluded.functions",
        params![conversation, scope.module, scoped_functions(scope).to_string()],
    )?;
    Ok(())
}

pub fn agent_scope(db: &Connection, conversation: &str) -> AppResult<Option<AgentScope>> {
    let row: Option<(String, String)> = db
        .query_row("SELECT module, functions FROM agent_scopes WHERE conversation = ?1", params![conversation], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    Ok(row.map(|(module, functions)| {
        let mut scope = AgentScope { module, ..AgentScope::default() };
        // Chaque fonction est son nom, ou `{ name, input }` quand le demandeur impose des entrées.
        let listed: Vec<serde_json::Value> = serde_json::from_str(&functions).unwrap_or_default();
        for item in listed {
            match item {
                serde_json::Value::String(name) => scope.functions.push(name),
                serde_json::Value::Object(mut object) => {
                    let Some(serde_json::Value::String(name)) = object.remove("name") else { continue };
                    if let Some(input) = object.remove("input").filter(serde_json::Value::is_object) {
                        scope.inputs.insert(name.clone(), input);
                    }
                    scope.functions.push(name);
                }
                _ => {}
            }
        }
        scope
    }))
}

/// Colonne `functions` d’un périmètre : les noms, avec leurs entrées imposées.
fn scoped_functions(scope: &AgentScope) -> serde_json::Value {
    serde_json::Value::Array(
        scope
            .functions
            .iter()
            .map(|name| match scope.inputs.get(name) {
                Some(input) => serde_json::json!({ "name": name, "input": input }),
                None => serde_json::Value::String(name.clone()),
            })
            .collect(),
    )
}

pub fn list_grants(db: &Connection, space: &str) -> AppResult<Vec<Value>> {
    let mut statement =
        db.prepare("SELECT subject, resource, granted_at FROM grants WHERE space = ?1 ORDER BY subject, resource")?;
    let rows = statement.query_map(params![space], |row| {
        Ok(serde_json::json!({
            "subject": row.get::<_, String>(0)?,
            "resource": row.get::<_, String>(1)?,
            "grantedAt": row.get::<_, String>(2)?,
        }))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un module retiré emporte les accords qu’il a reçus et ceux donnés sur ses fonctions ; une fonction retirée,
    /// ceux donnés sur elle. Les modules voisins (même préfixe) ne sont pas touchés.
    #[test]
    fn removing_a_module_or_a_function_forgets_the_grants_about_it() {
        let db = Connection::open_in_memory().unwrap();
        migrate(&db).unwrap();
        let space = "/espace";
        for (subject, resource) in [
            ("page:recettes/carnet", "client:jira"),
            ("function:recettes/*", "client:jira"),
            ("page:semaine/menu", "function:recettes/compter"),
            ("page:semaine/menu", "function:recettes-ajouts/compter"),
            ("page:semaine/menu", "function:semaine/total"),
        ] {
            grant(&db, space, subject, resource).unwrap();
        }
        revoke_module(&db, space, "recettes").unwrap();
        assert!(!is_granted(&db, space, "page:recettes/carnet", "client:jira").unwrap());
        assert!(!is_granted(&db, space, "function:recettes/*", "client:jira").unwrap());
        assert!(!is_granted(&db, space, "page:semaine/menu", "function:recettes/compter").unwrap());
        assert!(is_granted(&db, space, "page:semaine/menu", "function:recettes-ajouts/compter").unwrap());

        revoke_resource(&db, space, "function:semaine/total").unwrap();
        assert!(!is_granted(&db, space, "page:semaine/menu", "function:semaine/total").unwrap());
        assert!(is_granted(&db, space, "page:semaine/menu", "function:recettes-ajouts/compter").unwrap());
    }
}
