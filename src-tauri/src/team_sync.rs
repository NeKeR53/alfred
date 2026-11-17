//! Partage des données d’un module entre les membres d’une équipe, par un dépôt git.
//!
//! Le module nomme dans `sync.tables` de son `module.json` les tables à partager. Chaque membre relie le module au
//! même dépôt git (une adresse, réglée dans la fiche du module) ; Alfred y range une ligne par fichier
//! (`<module>/<table>/<clé>.json`) et synchronise régulièrement, dans les deux sens :
//!
//! - ce qui a changé ici depuis la dernière synchronisation part dans le dépôt ;
//! - ce qui a changé dans le dépôt arrive dans la base ;
//! - une même ligne changée des deux côtés : la version de l’équipe (déjà partagée) l’emporte, et la version locale
//!   est gardée au journal pour qu’on puisse la retrouver.
//!
//! L’état de la dernière synchronisation (une empreinte par ligne) est gardé dans la base de l’espace de travail
//! (`_alfred_sync_rows`) : c’est lui qui dit de quel côté une ligne a changé. Le dépôt est cloné dans les données
//! d’Alfred ; les identifiants git déjà réglés sur le poste servent, comme pour les marketplaces.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{arg, AppError, AppResult};
use crate::marketplace::{
    clone_into, commit_clone, explain_remote, fetch_and_align, remote_advanced, remote_branch, remote_git, remove_tree,
};
use crate::space::{valid_id, ModuleManifest, Space};
use crate::state::AppState;
use crate::{app_db, git, space_db};

const SETTING: &str = "teamSync";
/// Synchronisation automatique, tant qu’Alfred est ouvert.
const EVERY: Duration = Duration::from_secs(120);
/// Un envoi refusé parce que le dépôt a avancé entre-temps est rejoué quelques fois.
const ATTEMPTS: usize = 3;

/// Réglage d’un module partagé, propre à ce poste et à cet espace de travail.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Link {
    pub url: String,
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
    /// Lignes reçues et envoyées à la dernière synchronisation, et conflits résolus.
    pub received: usize,
    pub sent: usize,
    pub conflicts: usize,
}

/// Une ligne telle qu’elle est rangée dans le dépôt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedRow {
    key: String,
    modified_at: String,
    row: Map<String, Value>,
}

fn link_key(space: &Space, module: &str) -> String {
    format!("{}|{module}", space.root.to_string_lossy())
}

fn links(state: &AppState) -> AppResult<BTreeMap<String, Link>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    Ok(app_db::get_setting(&db, SETTING)?.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default())
}

fn save_links(state: &AppState, links: &BTreeMap<String, Link>) -> AppResult<()> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::set_setting(&db, SETTING, &serde_json::to_value(links)?)
}

pub fn link(state: &AppState, space: &Space, module: &str) -> AppResult<Option<Link>> {
    Ok(links(state)?.remove(&link_key(space, module)))
}

fn update_link(state: &AppState, space: &Space, module: &str, change: impl FnOnce(&mut Link)) -> AppResult<()> {
    let mut all = links(state)?;
    if let Some(link) = all.get_mut(&link_key(space, module)) {
        change(link);
        save_links(state, &all)?;
    }
    Ok(())
}

fn clone_dir(state: &AppState, space: &Space, module: &str) -> PathBuf {
    let digest: String =
        Sha256::digest(link_key(space, module).as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    state.data_dir.join("team-sync").join(digest)
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Valeur SQL vers JSON, sans perte : un BLOB devient `{ "$blob": "<base64>" }`.
fn to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => json!(number),
        ValueRef::Real(number) => json!(number),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).to_string()),
        ValueRef::Blob(bytes) => json!({ "$blob": base64::engine::general_purpose::STANDARD.encode(bytes) }),
    }
}

fn to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(number.as_f64().unwrap_or_default())),
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(object) => match object.get("$blob").and_then(Value::as_str) {
            Some(encoded) => {
                SqlValue::Blob(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap_or_default())
            }
            None => SqlValue::Text(value.to_string()),
        },
        Value::Array(_) => SqlValue::Text(value.to_string()),
    }
}

fn digest(row: &Map<String, Value>) -> String {
    // `serde_json::Map` est trié par clé : la même ligne donne toujours la même empreinte.
    Sha256::digest(Value::Object(row.clone()).to_string().as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Nom de fichier sûr et stable pour une clé de ligne, quelle qu’elle soit.
fn file_name(key: &str) -> String {
    let readable: String =
        key.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(40).collect();
    let hash: String = Sha256::digest(key.as_bytes()).iter().take(6).map(|byte| format!("{byte:02x}")).collect();
    format!("{readable}-{hash}.json")
}

/// Colonne de clé primaire d’une table partagée ; une table sans clé sur une seule colonne ne se partage pas.
fn key_column(db: &Connection, table: &str) -> AppResult<String> {
    let mut statement = db.prepare("SELECT name, pk FROM pragma_table_info(?1)")?;
    let columns: Vec<(String, i64)> =
        statement.query_map([table], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    if columns.is_empty() {
        return Err(AppError::new(format!("La table partagée « {table} » n’existe pas.")));
    }
    let keys: Vec<&String> = columns.iter().filter(|(_, pk)| *pk > 0).map(|(name, _)| name).collect();
    match keys.as_slice() {
        [key] => Ok((*key).clone()),
        _ => Err(AppError::new(format!(
            "La table partagée « {table} » doit avoir une clé primaire sur une seule colonne (un identifiant texte généré, `crypto.randomUUID()`)."
        ))),
    }
}

/// Problèmes de déclaration du partage, pour `check` : table absente, hors du module, sans clé simple, ou clé
/// entière (deux membres créeraient la même).
pub fn problems(space: &Space, manifest: &ModuleManifest) -> Vec<String> {
    if manifest.sync.tables.is_empty() {
        return Vec::new();
    }
    let Ok(db) = space_db::open(space) else { return Vec::new() };
    let prefix = space_db::table_prefix(&manifest.id);
    let mut found = Vec::new();
    for table in &manifest.sync.tables {
        if !table.starts_with(&prefix) {
            found.push(format!("`sync.tables` : « {table} » n’est pas une table du module (préfixe « {prefix} »)."));
            continue;
        }
        match key_column(&db, table) {
            Err(error) => found.push(error.message),
            Ok(key) => {
                let declared: String = db
                    .query_row("SELECT type FROM pragma_table_info(?1) WHERE name = ?2", params![table, key], |row| row.get(0))
                    .unwrap_or_default();
                if declared.to_ascii_uppercase().contains("INT") {
                    found.push(format!(
                        "La table partagée « {table} » a une clé entière (« {key} ») : deux membres de l’équipe créeraient la même. Utiliser une clé texte générée (`crypto.randomUUID()`)."
                    ));
                }
            }
        }
    }
    found
}

fn ensure_state_table(db: &Connection) -> AppResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_sync_rows (
           module TEXT NOT NULL, tbl TEXT NOT NULL, row_key TEXT NOT NULL, hash TEXT NOT NULL,
           PRIMARY KEY (module, tbl, row_key));",
    )?;
    Ok(())
}

fn local_rows(db: &Connection, table: &str, key: &str) -> AppResult<BTreeMap<String, Map<String, Value>>> {
    let mut statement = db.prepare(&format!("SELECT * FROM {}", quoted(table)))?;
    let names: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
    let mut rows = statement.query([])?;
    let mut found = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            object.insert(name.clone(), to_json(row.get_ref(index)?));
        }
        let Some(id) = object.get(key).map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }) else {
            continue;
        };
        found.insert(id, object);
    }
    Ok(found)
}

fn remote_rows(dir: &Path) -> BTreeMap<String, (PathBuf, SharedRow)> {
    let mut found = BTreeMap::new();
    let Ok(entries) = fs::read_dir(dir) else { return found };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Some(shared) = fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<SharedRow>(&text).ok()) {
            found.insert(shared.key.clone(), (path, shared));
        }
    }
    found
}

fn base_rows(db: &Connection, module: &str, table: &str) -> AppResult<BTreeMap<String, String>> {
    let mut statement = db.prepare("SELECT row_key, hash FROM _alfred_sync_rows WHERE module = ?1 AND tbl = ?2")?;
    let rows = statement.query_map(params![module, table], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Écrit une ligne venue de l’équipe dans la base (ses seules colonnes connues ici), ou la supprime.
fn apply(db: &Connection, table: &str, key: &str, id: &str, row: Option<&Map<String, Value>>) -> AppResult<()> {
    match row {
        None => {
            db.execute(&format!("DELETE FROM {} WHERE {} = ?1", quoted(table), quoted(key)), [id])?;
        }
        Some(row) => {
            let mut statement = db.prepare("SELECT name FROM pragma_table_info(?1)")?;
            let known: BTreeSet<String> = statement.query_map([table], |row| row.get(0))?.filter_map(Result::ok).collect();
            let columns: Vec<&String> = row.keys().filter(|name| known.contains(*name)).collect();
            let values: Vec<SqlValue> = columns.iter().map(|name| to_sql(&row[*name])).collect();
            let names = columns.iter().map(|name| quoted(name)).collect::<Vec<_>>().join(", ");
            let marks = (1..=columns.len()).map(|index| format!("?{index}")).collect::<Vec<_>>().join(", ");
            db.execute(
                &format!("INSERT OR REPLACE INTO {} ({names}) VALUES ({marks})", quoted(table)),
                rusqlite::params_from_iter(values.iter()),
            )?;
        }
    }
    Ok(())
}

/// Bilan d’une synchronisation.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub received: usize,
    pub sent: usize,
    pub conflicts: usize,
    /// Versions locales écartées par un conflit : table, clé, ligne.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub replaced: Vec<Value>,
}

/// Un passage : fusion dans les deux sens entre la base et le clone (déjà aligné sur le dépôt), écriture des
/// lignes locales dans le clone et mise à jour de l’état de référence. N’envoie rien.
fn merge(space: &Space, manifest: &ModuleManifest, clone: &Path) -> AppResult<Outcome> {
    let mut db = space_db::open(space)?;
    ensure_state_table(&db)?;
    space_db::set_actor(&db, "partage")?;
    let transaction = db.transaction()?;
    let mut outcome = Outcome::default();
    for table in &manifest.sync.tables {
        let key = key_column(&transaction, table)?;
        let dir = clone.join(&manifest.id).join(table);
        let local = local_rows(&transaction, table, &key)?;
        let remote = remote_rows(&dir);
        let base = base_rows(&transaction, &manifest.id, table)?;
        let ids: BTreeSet<&String> = local.keys().chain(remote.keys()).chain(base.keys()).collect();
        for id in ids {
            let mine = local.get(id);
            let theirs = remote.get(id).map(|(_, shared)| &shared.row);
            let (mine_hash, theirs_hash) = (mine.map(digest), theirs.map(digest));
            let before = base.get(id).cloned();
            let local_changed = mine_hash != before;
            let remote_changed = theirs_hash != before;
            let settled = match (local_changed, remote_changed) {
                (false, false) => before,
                // Changé ici seulement : la ligne part dans le dépôt (ou en sort).
                (true, false) => {
                    let path = remote.get(id).map(|(path, _)| path.clone()).unwrap_or_else(|| dir.join(file_name(id)));
                    match mine {
                        Some(row) => {
                            fs::create_dir_all(&dir)?;
                            let shared = SharedRow { key: id.clone(), modified_at: now(), row: row.clone() };
                            fs::write(&path, serde_json::to_string_pretty(&shared)? + "\n")?;
                        }
                        None => {
                            let _ = fs::remove_file(&path);
                        }
                    }
                    outcome.sent += 1;
                    mine_hash
                }
                // Changé dans le dépôt seulement : la ligne arrive dans la base.
                (false, true) => {
                    apply(&transaction, table, &key, id, theirs)?;
                    outcome.received += 1;
                    theirs_hash
                }
                // Changé des deux côtés : la version de l’équipe l’emporte, la locale est gardée au journal.
                (true, true) => {
                    if mine_hash != theirs_hash {
                        apply(&transaction, table, &key, id, theirs)?;
                        outcome.conflicts += 1;
                        outcome.replaced.push(json!({ "table": table, "key": id, "local": mine, "team": theirs }));
                    }
                    theirs_hash
                }
            };
            match settled {
                Some(hash) => {
                    transaction.execute(
                        "INSERT OR REPLACE INTO _alfred_sync_rows (module, tbl, row_key, hash) VALUES (?1, ?2, ?3, ?4)",
                        params![manifest.id, table, id, hash],
                    )?;
                }
                None => {
                    transaction.execute(
                        "DELETE FROM _alfred_sync_rows WHERE module = ?1 AND tbl = ?2 AND row_key = ?3",
                        params![manifest.id, table, id],
                    )?;
                }
            }
        }
    }
    transaction.commit()?;
    Ok(outcome)
}

/// Synchronise un module avec le dépôt de son équipe : récupère, fusionne, envoie. Bloquant (git, disque).
pub fn sync_module(state: &AppState, space: &Space, module: &str) -> AppResult<Outcome> {
    let manifest = space.module(module)?;
    if manifest.sync.tables.is_empty() {
        return Err(AppError::new(format!("Le module « {} » ne déclare aucune table à partager.", manifest.name)));
    }
    let Some(link) = link(state, space, module)? else {
        return Err(AppError::new("Ce module n’est relié à aucun dépôt d’équipe."));
    };
    let clone = clone_dir(state, space, module);
    let started = Instant::now();
    let result = (|| -> AppResult<Outcome> {
        if !clone.join(".git").exists() {
            remove_tree(&clone)?;
            clone_into(&link.url, &clone)?;
        }
        let mut total = Outcome::default();
        for attempt in 0..ATTEMPTS {
            fetch_and_align(&clone)?;
            let outcome = merge(space, &manifest, &clone)?;
            total.received += outcome.received;
            total.conflicts += outcome.conflicts;
            total.replaced.extend(outcome.replaced);
            let label = if manifest.name.is_empty() { &manifest.id } else { &manifest.name };
            let Some(_) = commit_clone(&clone, &format!("Données de {label} : {} ligne(s)", outcome.sent))? else {
                return Ok(total);
            };
            let branch = remote_branch(&clone)
                .or_else(|| git::run(&clone, &["symbolic-ref", "-q", "--short", "HEAD"]).ok())
                .unwrap_or_else(|| "main".to_string());
            match remote_git(&clone, &["push", "--quiet", "origin", &format!("HEAD:refs/heads/{branch}")]) {
                Ok(_) => {
                    total.sent += outcome.sent;
                    return Ok(total);
                }
                // Le dépôt a avancé : on récupère et on refait la fusion par-dessus.
                Err(error) if remote_advanced(&error) && attempt + 1 < ATTEMPTS => continue,
                Err(error) => return Err(explain_remote(error, "envoi des données")),
            }
        }
        Err(AppError::new("Le dépôt de l’équipe change trop vite : réessayer dans un instant."))
    })();
    let duration = started.elapsed().as_millis() as u64;
    match &result {
        Ok(outcome) => {
            update_link(state, space, module, |link| {
                link.last_sync = Some(now());
                link.last_error = None;
                link.received = outcome.received;
                link.sent = outcome.sent;
                link.conflicts = outcome.conflicts;
            })?;
            if outcome.received > 0 || outcome.conflicts > 0 {
                state.emit("space:dataChanged", json!({ "module": module }));
            }
        }
        Err(error) => {
            let message = error.message.clone();
            update_link(state, space, module, |link| link.last_error = Some(message))?;
        }
    }
    if let Ok(db) = state.app_db.lock() {
        let summary = match &result {
            Ok(outcome) => format!(
                "{} reçue(s), {} envoyée(s){}",
                outcome.received,
                outcome.sent,
                if outcome.conflicts > 0 { format!(", {} conflit(s) : version de l’équipe gardée", outcome.conflicts) } else { String::new() }
            ),
            Err(error) => error.message.clone(),
        };
        let detail = match &result {
            Ok(outcome) if !outcome.replaced.is_empty() => Some(json!({ "remplacées": outcome.replaced })),
            Err(error) => error.detail.clone(),
            _ => None,
        };
        let _ = app_db::record_journal(
            &db,
            &app_db::JournalEntry {
                space: &space.root.to_string_lossy(),
                kind: "sync",
                subject: module,
                status: if result.is_ok() { "ok" } else { "error" },
                duration_ms: Some(duration),
                summary: &summary,
                detail: detail.as_ref(),
            },
        );
    }
    state.emit("teamSync:changed", json!({ "module": module }));
    result
}

/// Synchronise tous les modules partagés de l’espace de travail ouvert.
fn sync_all(state: &AppState) {
    let Ok(space) = state.space() else { return };
    let Ok(all) = links(state) else { return };
    let prefix = format!("{}|", space.root.to_string_lossy());
    for key in all.keys().filter(|key| key.starts_with(&prefix)) {
        let module = &key[prefix.len()..];
        if space.module(module).is_ok_and(|manifest| !manifest.sync.tables.is_empty()) {
            let Ok(_guard) = RUNNING.lock() else { return };
            let _ = sync_module(state, &space, module);
        }
    }
}

/// Synchronisation régulière tant qu’Alfred est ouvert.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut wake = tokio::time::interval(EVERY);
        wake.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            wake.tick().await;
            let state = state.clone();
            let _ = tokio::task::spawn_blocking(move || sync_all(&state)).await;
        }
    });
}

/// Une seule synchronisation à la fois : deux passages ne doivent pas écrire le même clone.
static RUNNING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn status(state: &AppState, space: &Space, module: &str) -> AppResult<Value> {
    let manifest = space.module(module)?;
    let link = link(state, space, module)?;
    Ok(json!({
        "module": module,
        "tables": manifest.sync.tables,
        "problems": problems(space, &manifest),
        "link": link,
    }))
}

/// Commandes `teamSync.*` de l’interface.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("teamSync.") {
        return None;
    }
    let (state, command, args) = (state.clone(), command.to_string(), args.clone());
    let outcome = tokio::task::spawn_blocking(move || -> AppResult<Value> {
        let space = state.space()?;
        let module: String = arg(&args, "module")?;
        if !valid_id(&module) {
            return Err(AppError::new("Module inconnu."));
        }
        match command.as_str() {
            "teamSync.status" => status(&state, &space, &module),
            "teamSync.link" => {
                let url: String = arg(&args, "url")?;
                let url = url.trim().to_string();
                if url.is_empty() {
                    return Err(AppError::new("Indiquer l’adresse git du dépôt de l’équipe."));
                }
                let manifest = space.module(&module)?;
                if manifest.sync.tables.is_empty() {
                    return Err(AppError::new("Ce module ne déclare aucune table à partager."));
                }
                let mut all = links(&state)?;
                all.insert(link_key(&space, &module), Link { url, ..Link::default() });
                save_links(&state, &all)?;
                let _ = remove_tree(&clone_dir(&state, &space, &module));
                // La première synchronisation dit tout de suite si l’adresse et les accès sont bons.
                let _guard = RUNNING.lock().map_err(|_| AppError::new("Synchronisation indisponible."))?;
                let first = sync_module(&state, &space, &module);
                let mut current = status(&state, &space, &module)?;
                if let Ok(outcome) = first {
                    current["outcome"] = serde_json::to_value(outcome)?;
                }
                Ok(current)
            }
            "teamSync.unlink" => {
                let mut all = links(&state)?;
                all.remove(&link_key(&space, &module));
                save_links(&state, &all)?;
                let _ = remove_tree(&clone_dir(&state, &space, &module));
                // Sans dépôt, l’état de référence n’a plus de sens : il repartira de zéro au prochain lien.
                if let Ok(db) = space_db::open(&space) {
                    let _ = ensure_state_table(&db);
                    let _ = db.execute("DELETE FROM _alfred_sync_rows WHERE module = ?1", [&module]);
                }
                status(&state, &space, &module)
            }
            "teamSync.run" => {
                let _guard = RUNNING.lock().map_err(|_| AppError::new("Synchronisation indisponible."))?;
                let outcome = sync_module(&state, &space, &module)?;
                let mut current = status(&state, &space, &module)?;
                current["outcome"] = serde_json::to_value(outcome)?;
                Ok(current)
            }
            _ => Err(AppError::new("Commande de partage inconnue.")),
        }
    })
    .await;
    Some(outcome.unwrap_or_else(|_| Err(AppError::new("La synchronisation a été interrompue."))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::testing::{invoke, test_state};
    use crate::space::SyncDecl;

    /// Un poste : un espace de travail avec le module « carnet » et sa table partagée.
    fn member(key_type: &str) -> (Arc<AppState>, tempfile::TempDir) {
        let (state, dir) = test_state();
        let space = state.space().unwrap();
        space
            .write_module(&ModuleManifest {
                id: "carnet".into(),
                name: "Carnet".into(),
                version: "1.0.0".into(),
                sync: SyncDecl { tables: vec!["carnet_notes".into()] },
                ..ModuleManifest::default()
            })
            .unwrap();
        let migrations = space.module_dir("carnet").join("migrations");
        fs::create_dir_all(&migrations).unwrap();
        fs::write(
            migrations.join("0001_notes.sql"),
            format!("CREATE TABLE carnet_notes (id {key_type} PRIMARY KEY, texte TEXT NOT NULL, fait INTEGER NOT NULL DEFAULT 0);"),
        )
        .unwrap();
        assert!(space_db::apply_migrations(&space).unwrap().is_empty());
        (state, dir)
    }

    fn sql(state: &Arc<AppState>, statement: &str, values: &[&str]) -> Value {
        let parameters: Vec<SqlValue> = values.iter().map(|value| SqlValue::Text(value.to_string())).collect();
        space_db::run(&state.space().unwrap(), "carnet", statement, &parameters, true).unwrap()
    }

    fn notes(state: &Arc<AppState>) -> Vec<(String, String)> {
        sql(state, "SELECT id, texte FROM carnet_notes ORDER BY id", &[])
            .as_array()
            .unwrap()
            .iter()
            .map(|row| (row["id"].as_str().unwrap().to_string(), row["texte"].as_str().unwrap().to_string()))
            .collect()
    }

    async fn sync(state: &Arc<AppState>) -> Value {
        invoke(state, "teamSync.run", json!({ "module": "carnet" })).await.unwrap()["outcome"].clone()
    }

    #[tokio::test]
    async fn two_members_share_a_table_through_a_git_repository() {
        let remote = tempfile::tempdir().unwrap();
        git::run(remote.path(), &["init", "--bare", "-q"]).unwrap();
        let url = remote.path().to_string_lossy().to_string();
        let (lea, _lea_dir) = member("TEXT");
        let (paul, _paul_dir) = member("TEXT");

        // Léa relie le module et y a déjà une note : elle part à la première synchronisation.
        sql(&lea, "INSERT INTO carnet_notes (id, texte) VALUES (?1, ?2)", &["a1", "Appeler le fournisseur"]);
        let linked = invoke(&lea, "teamSync.link", json!({ "module": "carnet", "url": url })).await.unwrap();
        assert_eq!(linked["outcome"]["sent"], json!(1));
        assert_eq!(linked["link"]["lastError"], Value::Null);

        // Paul relie le même dépôt : il reçoit la note.
        let linked = invoke(&paul, "teamSync.link", json!({ "module": "carnet", "url": url })).await.unwrap();
        assert_eq!(linked["outcome"]["received"], json!(1));
        assert_eq!(notes(&paul), vec![("a1".into(), "Appeler le fournisseur".into())]);

        // Paul modifie et ajoute ; Léa reçoit les deux.
        sql(&paul, "UPDATE carnet_notes SET texte = ?1 WHERE id = ?2", &["Appeler le fournisseur avant midi", "a1"]);
        sql(&paul, "INSERT INTO carnet_notes (id, texte) VALUES (?1, ?2)", &["b2", "Relancer la facture"]);
        assert_eq!(sync(&paul).await["sent"], json!(2));
        assert_eq!(sync(&lea).await["received"], json!(2));
        assert_eq!(
            notes(&lea),
            vec![("a1".into(), "Appeler le fournisseur avant midi".into()), ("b2".into(), "Relancer la facture".into())]
        );

        // Une suppression circule aussi.
        sql(&lea, "DELETE FROM carnet_notes WHERE id = ?1", &["b2"]);
        assert_eq!(sync(&lea).await["sent"], json!(1));
        sync(&paul).await;
        assert_eq!(notes(&paul).len(), 1);

        // Conflit : les deux modifient la même note ; la version déjà partagée (Léa, synchronisée la première)
        // l’emporte chez Paul, et la sienne est gardée au journal.
        sql(&lea, "UPDATE carnet_notes SET texte = ?1 WHERE id = ?2", &["Version de Léa", "a1"]);
        sql(&paul, "UPDATE carnet_notes SET texte = ?1 WHERE id = ?2", &["Version de Paul", "a1"]);
        sync(&lea).await;
        let outcome = sync(&paul).await;
        assert_eq!(outcome["conflicts"], json!(1));
        assert_eq!(outcome["replaced"][0]["local"]["texte"], json!("Version de Paul"));
        assert_eq!(notes(&paul), vec![("a1".into(), "Version de Léa".into())]);
        let journal = {
            let db = paul.app_db.lock().unwrap();
            app_db::read_journal(&db, &paul.space().unwrap().root.to_string_lossy(), Some("sync"), 1).unwrap()
        };
        assert!(journal[0]["summary"].as_str().unwrap().contains("1 conflit"));
        // Puis tout le monde est d’accord : plus rien à échanger.
        assert_eq!(sync(&lea).await["received"], json!(0));
        assert_eq!(sync(&paul).await["sent"], json!(0));
    }

    #[tokio::test]
    async fn a_shared_table_needs_a_text_key() {
        let (state, _dir) = member("INTEGER");
        let space = state.space().unwrap();
        let found = problems(&space, &space.module("carnet").unwrap());
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("clé entière"), "{found:?}");
        // Sans dépôt relié, la synchronisation le dit.
        let error = invoke(&state, "teamSync.run", json!({ "module": "carnet" })).await.unwrap_err();
        assert!(error.message.contains("aucun dépôt"), "{}", error.message);
    }
}
