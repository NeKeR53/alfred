//! Cache des réponses des clients : une page ou une fonction qui relit souvent la même ressource d’un service
//! (liste de projets, profil) peut demander à Alfred de garder la réponse quelques minutes, pour ménager les quotas
//! du service. Seules les lectures réussies (`GET`, `HEAD`, statut 2xx) sont gardées, par module : un module ne
//! reçoit jamais une réponse obtenue par un autre. La clé comprend l’adresse, l’authentification et les en-têtes
//! du client : un client modifié ne sert plus ses anciennes réponses.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::error::AppResult;
use crate::space::Space;

/// Durée de vie maximale d’une réponse gardée : un jour.
pub const MAX_TTL: u64 = 86_400;
/// Une réponse plus grosse n’est pas gardée.
const MAX_SIZE: usize = 2 * 1024 * 1024;

fn open(space: &Space) -> AppResult<Connection> {
    let db = crate::space_db::open(space)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_client_cache (
           key TEXT PRIMARY KEY, module TEXT NOT NULL, client TEXT NOT NULL,
           stored_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, response TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS _alfred_client_cache_owner ON _alfred_client_cache (module, client);",
    )?;
    Ok(db)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or_default()
}

fn sorted(map: Option<&Map<String, Value>>) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> =
        map.into_iter().flatten().map(|(name, value)| (name.to_ascii_lowercase(), value.to_string())).collect();
    pairs.sort();
    pairs
}

/// Clé d’une requête : module, empreinte du client (adresse, authentification, en-têtes fixes), méthode, chemin,
/// paramètres et en-têtes de la requête.
pub fn key(
    module: &str,
    client_fingerprint: &str,
    method: &str,
    path: &str,
    query: Option<&Map<String, Value>>,
    headers: Option<&Map<String, Value>>,
) -> String {
    use sha2::{Digest, Sha256};
    let material = serde_json::json!([module, client_fingerprint, method, path, sorted(query), sorted(headers)]).to_string();
    Sha256::digest(material.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Réponse gardée et encore valable, marquée `cached` avec son âge.
pub fn get(space: &Space, key: &str) -> AppResult<Option<Value>> {
    let db = open(space)?;
    let row: Option<(String, i64)> = db
        .query_row(
            "SELECT response, stored_at FROM _alfred_client_cache WHERE key = ?1 AND expires_at > ?2",
            params![key, now()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(text, stored_at)| {
        let mut response: Value = serde_json::from_str(&text).ok()?;
        if let Some(object) = response.as_object_mut() {
            object.insert("cached".into(), Value::Bool(true));
            object.insert("cacheAge".into(), Value::from((now() - stored_at).max(0)));
        }
        Some(response)
    }))
}

/// Garde une réponse réussie pendant `ttl` secondes.
pub fn put(space: &Space, key: &str, module: &str, client: &str, ttl: u64, response: &Value) -> AppResult<()> {
    let ok = response.get("ok").and_then(Value::as_bool) == Some(true);
    let text = response.to_string();
    if !ok || ttl == 0 || text.len() > MAX_SIZE {
        return Ok(());
    }
    let db = open(space)?;
    let stored = now();
    db.execute(
        "INSERT OR REPLACE INTO _alfred_client_cache (key, module, client, stored_at, expires_at, response)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![key, module, client, stored, stored + ttl.min(MAX_TTL) as i64, text],
    )?;
    db.execute("DELETE FROM _alfred_client_cache WHERE expires_at <= ?1", [stored])?;
    Ok(())
}

/// Oublie les réponses gardées d’un client pour un module.
pub fn clear(space: &Space, module: &str, client: &str) -> AppResult<usize> {
    Ok(open(space)?.execute("DELETE FROM _alfred_client_cache WHERE module = ?1 AND client = ?2", params![module, client])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_response_is_kept_for_its_module_until_it_expires() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let query = json!({ "b": 2, "a": 1 });
        let same_query = json!({ "a": 1, "b": 2 });
        let first = key("notes", "jira@1", "GET", "/projets", query.as_object(), None);
        assert_eq!(first, key("notes", "jira@1", "GET", "/projets", same_query.as_object(), None), "ordre indifférent");
        assert_ne!(first, key("suivi", "jira@1", "GET", "/projets", query.as_object(), None), "par module");
        assert_ne!(first, key("notes", "jira@2", "GET", "/projets", query.as_object(), None), "client modifié");

        let response = json!({ "status": 200, "ok": true, "headers": {}, "body": [1, 2] });
        put(&space, &first, "notes", "jira", 60, &response).unwrap();
        let cached = get(&space, &first).unwrap().unwrap();
        assert_eq!(cached["body"], json!([1, 2]));
        assert_eq!(cached["cached"], true);

        // Un échec n’est pas gardé ; une réponse expirée n’est plus servie.
        let failed = key("notes", "jira@1", "GET", "/erreur", None, None);
        put(&space, &failed, "notes", "jira", 60, &json!({ "status": 500, "ok": false })).unwrap();
        assert!(get(&space, &failed).unwrap().is_none());
        let expired = key("notes", "jira@1", "GET", "/vieux", None, None);
        open(&space)
            .unwrap()
            .execute(
                "INSERT INTO _alfred_client_cache VALUES (?1, 'notes', 'jira', 0, 1, '{}')",
                [&expired],
            )
            .unwrap();
        assert!(get(&space, &expired).unwrap().is_none());

        assert_eq!(clear(&space, "suivi", "jira").unwrap(), 0);
        assert_eq!(clear(&space, "notes", "jira").unwrap(), 2, "la valable et l’expirée");
        assert!(get(&space, &first).unwrap().is_none());
    }
}
