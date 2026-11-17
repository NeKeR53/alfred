//! Recherche sémantique : retrouver des lignes par le sens (« facture d’électricité » trouve « note EDF de mars »),
//! sans que les données quittent l’ordinateur. Le module déclare ses index dans `semantic` de `module.json` ;
//! Alfred calcule pour chaque ligne un vecteur avec un modèle local (multilingual-e5-small, français compris, lancé
//! en Rust par candle), le range dans la base de l’espace, et compare la question à toutes les lignes.
//!
//! Le modèle (environ 470 Mo) se télécharge une fois, quand l’utilisateur l’accepte dans Réglages → Général. Des
//! déclencheurs d’Alfred mettent chaque ligne écrite en file ; une boucle de fond calcule les vecteurs en attente.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, IndexDecl, Space};
use crate::space_db::{owned_tables, table_prefix, MigrationProblem};
use crate::state::AppState;

const MODEL: &str = "intfloat/multilingual-e5-small";
const MODEL_DIR: &str = "multilingual-e5-small";
/// Version figée du modèle, et empreinte SHA-256 de chaque fichier : un fichier différent est écarté.
const REVISION: &str = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
const SPEC: crate::model_files::ModelSpec = crate::model_files::ModelSpec {
    repo: MODEL,
    revision: REVISION,
    files: &[
        ("config.json", "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959"),
        ("tokenizer.json", "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
        ("model.safetensors", "1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477"),
    ],
};
/// Taille annoncée à l’utilisateur avant le téléchargement.
pub const MODEL_SIZE_MB: u64 = 470;
const BATCH: usize = 16;
const MAX_TOKENS: usize = 512;
const MAX_RESULTS: usize = 100;

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

// ---------------------------------------------------------------------------------------------------------------
// Modèle
// ---------------------------------------------------------------------------------------------------------------

/// Calcule des vecteurs normalisés. `query` : une question (préfixe « query: ») ; sinon un passage indexé.
pub trait Embedder: Send + Sync {
    fn embed(&self, texts: &[String], query: bool) -> AppResult<Vec<Vec<f32>>>;
}

struct E5 {
    model: candle_transformers::models::bert::BertModel,
    tokenizer: tokenizers::Tokenizer,
}

fn model_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(format!("Modèle de recherche sémantique : {error}"))
}

impl E5 {
    fn load(dir: &Path) -> AppResult<Self> {
        use candle_core::{DType, Device};
        let config: candle_transformers::models::bert::Config =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json"))?).map_err(model_error)?;
        let tokenizer = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json")).map_err(model_error)?;
        let weights = std::fs::read(dir.join("model.safetensors"))?;
        let vb = candle_nn::VarBuilder::from_buffered_safetensors(weights, DType::F32, &Device::Cpu).map_err(model_error)?;
        let model = candle_transformers::models::bert::BertModel::load(vb, &config).map_err(model_error)?;
        Ok(E5 { model, tokenizer })
    }
}

impl Embedder for E5 {
    fn embed(&self, texts: &[String], query: bool) -> AppResult<Vec<Vec<f32>>> {
        use candle_core::{Device, Tensor};
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let prefix = if query { "query: " } else { "passage: " };
        let inputs: Vec<String> = texts.iter().map(|text| format!("{prefix}{text}")).collect();
        let encodings = self.tokenizer.encode_batch(inputs, true).map_err(model_error)?;
        let length = encodings.iter().map(|encoding| encoding.get_ids().len().min(MAX_TOKENS)).max().unwrap_or(1).max(1);
        let mut ids = Vec::with_capacity(texts.len() * length);
        let mut mask = Vec::with_capacity(texts.len() * length);
        for encoding in &encodings {
            let tokens = &encoding.get_ids()[..encoding.get_ids().len().min(MAX_TOKENS)];
            for index in 0..length {
                ids.push(tokens.get(index).copied().unwrap_or(1));
                mask.push(u32::from(index < tokens.len()));
            }
        }
        let shape = (texts.len(), length);
        let ids = Tensor::from_vec(ids, shape, &Device::Cpu).map_err(model_error)?;
        let mask = Tensor::from_vec(mask, shape, &Device::Cpu).map_err(model_error)?;
        let types = ids.zeros_like().map_err(model_error)?;
        let output = self.model.forward(&ids, &types, Some(&mask)).map_err(model_error)?;
        // Moyenne des jetons réels, puis norme 1 : le produit scalaire devient la similarité cosinus.
        let mask = mask.to_dtype(candle_core::DType::F32).map_err(model_error)?.unsqueeze(2).map_err(model_error)?;
        let summed = output.broadcast_mul(&mask).and_then(|masked| masked.sum(1)).map_err(model_error)?;
        let counts = mask.sum(1).map_err(model_error)?;
        let mean = summed.broadcast_div(&counts).map_err(model_error)?;
        let norm = mean.sqr().and_then(|squared| squared.sum_keepdim(1)).and_then(|sum| sum.sqrt()).map_err(model_error)?;
        let normalized = mean.broadcast_div(&norm).map_err(model_error)?;
        normalized.to_vec2::<f32>().map_err(model_error)
    }
}

#[derive(Default)]
struct ModelState {
    loaded: Option<Arc<dyn Embedder>>,
    downloading: Option<(u64, u64)>,
    error: Option<String>,
}

fn model_state() -> &'static Mutex<ModelState> {
    static STATE: OnceLock<Mutex<ModelState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ModelState::default()))
}

fn model_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("models").join(MODEL_DIR)
}

fn installed(state: &AppState) -> bool {
    SPEC.installed(&model_dir(state))
}

/// Remplace le modèle (tests).
#[cfg(test)]
fn use_embedder(embedder: Arc<dyn Embedder>) {
    model_state().lock().unwrap().loaded = Some(embedder);
}

/// Le modèle chargé, s’il est installé ; `None` sinon.
fn embedder(state: &AppState) -> AppResult<Option<Arc<dyn Embedder>>> {
    if let Some(loaded) = model_state().lock().map_err(|_| model_error("indisponible"))?.loaded.clone() {
        return Ok(Some(loaded));
    }
    if !installed(state) {
        return Ok(None);
    }
    let loaded: Arc<dyn Embedder> = Arc::new(E5::load(&model_dir(state))?);
    model_state().lock().map_err(|_| model_error("indisponible"))?.loaded = Some(loaded.clone());
    Ok(Some(loaded))
}

pub fn model_status(state: &AppState) -> Value {
    let current = model_state().lock().ok();
    let downloading = current.as_ref().and_then(|current| current.downloading);
    let error = current.as_ref().and_then(|current| current.error.clone());
    let ready = current.as_ref().is_some_and(|current| current.loaded.is_some()) || installed(state);
    json!({
        "model": MODEL,
        "sizeMb": MODEL_SIZE_MB,
        "status": if downloading.is_some() { "downloading" } else if ready { "ready" } else { "missing" },
        "received": downloading.map(|(received, _)| received),
        "total": downloading.map(|(_, total)| total),
        "error": error,
    })
}

/// Télécharge le modèle depuis Hugging Face, fichier par fichier, à sa version figée et en vérifiant chaque empreinte.
pub fn download(state: Arc<AppState>) -> AppResult<()> {
    {
        let mut current = model_state().lock().map_err(|_| model_error("indisponible"))?;
        if current.downloading.is_some() {
            return Ok(());
        }
        current.downloading = Some((0, MODEL_SIZE_MB * 1024 * 1024));
        current.error = None;
    }
    tokio::spawn(async move {
        let result = fetch_all(&state).await;
        if let Ok(mut current) = model_state().lock() {
            current.downloading = None;
            current.error = result.as_ref().err().map(|error| error.message.clone());
        }
        state.emit("semantic:changed", Value::Null);
        if result.is_ok() {
            kick();
        }
    });
    Ok(())
}

async fn fetch_all(state: &Arc<AppState>) -> AppResult<()> {
    let notified = std::sync::atomic::AtomicU64::new(0);
    crate::model_files::fetch(&SPEC, &model_dir(state), MODEL_SIZE_MB * 1024 * 1024, model_error, |received, total| {
        if let Ok(mut current) = model_state().lock() {
            current.downloading = Some((received, total));
        }
        if received >= notified.load(std::sync::atomic::Ordering::Relaxed) + 8 * 1024 * 1024 {
            notified.store(received, std::sync::atomic::Ordering::Relaxed);
            state.emit("semantic:changed", Value::Null);
        }
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------------------------

fn ensure_tables(db: &Connection) -> AppResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_semantic (
           module TEXT NOT NULL, id TEXT NOT NULL, definition TEXT NOT NULL, PRIMARY KEY (module, id));
         CREATE TABLE IF NOT EXISTS _alfred_vectors (
           module TEXT NOT NULL, idx TEXT NOT NULL, row_id INTEGER NOT NULL, vector BLOB NOT NULL,
           PRIMARY KEY (module, idx, row_id));
         CREATE TABLE IF NOT EXISTS _alfred_vector_queue (
           module TEXT NOT NULL, idx TEXT NOT NULL, row_id INTEGER NOT NULL, PRIMARY KEY (module, idx, row_id));",
    )?;
    Ok(())
}

fn trigger_names(module: &str, index: &str) -> [String; 3] {
    let base = format!("_alfred_sem_{}{}", table_prefix(module), index.replace('-', "_"));
    ["ai", "au", "ad"].map(|suffix| format!("{base}_{suffix}"))
}

fn drop_index(db: &Connection, module: &str, id: &str) -> AppResult<()> {
    for name in trigger_names(module, id) {
        db.execute_batch(&format!("DROP TRIGGER IF EXISTS {};", quoted(&name)))?;
    }
    for table in ["_alfred_vectors", "_alfred_vector_queue"] {
        db.execute(&format!("DELETE FROM {table} WHERE module = ?1 AND idx = ?2"), params![module, id])?;
    }
    db.execute("DELETE FROM _alfred_semantic WHERE module = ?1 AND id = ?2", params![module, id])?;
    Ok(())
}

fn create_index(db: &Connection, module: &str, index: &IndexDecl) -> AppResult<()> {
    let [ai, au, ad] = trigger_names(module, &index.id).map(|name| quoted(&name));
    let target = quoted(&index.table);
    let (module_literal, id_literal) = (literal(module), literal(&index.id));
    let watched = index.columns.iter().map(|column| quoted(column)).collect::<Vec<_>>().join(", ");
    db.execute_batch(&format!(
        "CREATE TRIGGER {ai} AFTER INSERT ON {target} BEGIN
           INSERT OR IGNORE INTO _alfred_vector_queue VALUES ({module_literal}, {id_literal}, new.rowid);
         END;
         CREATE TRIGGER {au} AFTER UPDATE OF {watched} ON {target} BEGIN
           INSERT OR IGNORE INTO _alfred_vector_queue VALUES ({module_literal}, {id_literal}, new.rowid);
         END;
         CREATE TRIGGER {ad} AFTER DELETE ON {target} BEGIN
           DELETE FROM _alfred_vectors WHERE module = {module_literal} AND idx = {id_literal} AND row_id = old.rowid;
           DELETE FROM _alfred_vector_queue WHERE module = {module_literal} AND idx = {id_literal} AND row_id = old.rowid;
         END;
         INSERT OR IGNORE INTO _alfred_vector_queue SELECT {module_literal}, {id_literal}, rowid FROM {target};"
    ))?;
    Ok(())
}

fn intact(db: &Connection, module: &str, id: &str) -> AppResult<bool> {
    let [ai, au, ad] = trigger_names(module, id);
    let count: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?1, ?2, ?3)",
        params![ai, au, ad],
        |row| row.get(0),
    )?;
    Ok(count == 3)
}

fn validate(db: &Connection, space: &Space, module: &str, index: &IndexDecl) -> Result<(), String> {
    if !valid_id(&index.id) {
        return Err(format!("Identifiant d’index invalide : « {} ».", index.id));
    }
    if !owned_tables(db, space, module).map_err(|error| error.message)?.contains(&index.table) {
        return Err(format!("La table « {} » n’existe pas dans le module.", index.table));
    }
    let mut statement = db.prepare("SELECT name FROM pragma_table_info(?1)").map_err(|error| error.to_string())?;
    let existing: Vec<String> =
        statement.query_map([&index.table], |row| row.get(0)).map_err(|error| error.to_string())?.filter_map(Result::ok).collect();
    if index.columns.is_empty() {
        return Err("Un index sémantique nomme au moins une colonne (`columns`).".into());
    }
    for column in index.columns.iter().chain(std::iter::once(&index.key().to_string())) {
        if !existing.contains(column) {
            return Err(format!("La colonne « {column} » n’existe pas dans « {} ».", index.table));
        }
    }
    Ok(())
}

/// Met les index d’un module en accord avec sa déclaration ; une ligne déjà calculée garde son vecteur tant que la
/// déclaration ne change pas.
pub fn sync(space: &Space, module: &str, problems: &mut Vec<MigrationProblem>) -> AppResult<()> {
    let Ok(manifest) = space.module(module) else { return Ok(()) };
    let db = crate::space_db::open(space)?;
    ensure_tables(&db)?;
    let mut statement = db.prepare("SELECT id, definition FROM _alfred_semantic WHERE module = ?1")?;
    let applied: Vec<(String, String)> =
        statement.query_map([module], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    drop(statement);
    for (id, _) in applied.iter().filter(|(id, _)| !manifest.semantic.iter().any(|index| &index.id == id)) {
        drop_index(&db, module, id)?;
    }
    for index in &manifest.semantic {
        let definition = serde_json::to_string(index)?;
        let current = applied.iter().find(|(id, _)| id == &index.id).map(|(_, definition)| definition.as_str());
        let file = format!("module.json (semantic « {} »)", index.id);
        if let Err(message) = validate(&db, space, module, index) {
            problems.push(MigrationProblem { module: module.to_string(), file, message });
            continue;
        }
        if current == Some(definition.as_str()) && intact(&db, module, &index.id)? {
            continue;
        }
        db.execute_batch("BEGIN;")?;
        let result = (|| -> AppResult<()> {
            if current == Some(definition.as_str()) {
                // Même déclaration, déclencheurs emportés (table recréée) : on les repose et on recalcule tout,
                // les numéros de ligne ayant pu changer.
                for name in trigger_names(module, &index.id) {
                    db.execute_batch(&format!("DROP TRIGGER IF EXISTS {};", quoted(&name)))?;
                }
                db.execute("DELETE FROM _alfred_vectors WHERE module = ?1 AND idx = ?2", params![module, index.id])?;
            } else {
                drop_index(&db, module, &index.id)?;
            }
            create_index(&db, module, index)?;
            db.execute(
                "INSERT OR REPLACE INTO _alfred_semantic (module, id, definition) VALUES (?1, ?2, ?3)",
                params![module, index.id, definition],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => db.execute_batch("COMMIT;")?,
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK;");
                problems.push(MigrationProblem { module: module.to_string(), file, message: error.message });
            }
        }
    }
    Ok(())
}

pub fn drop_module(db: &Connection, module: &str) -> AppResult<()> {
    ensure_tables(db)?;
    let mut statement = db.prepare("SELECT id FROM _alfred_semantic WHERE module = ?1")?;
    let ids: Vec<String> = statement.query_map([module], |row| row.get(0))?.filter_map(Result::ok).collect();
    drop(statement);
    for id in ids {
        drop_index(db, module, &id)?;
    }
    Ok(())
}

fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|value| value.to_le_bytes()).collect()
}

fn from_blob(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect()
}

/// Calcule les vecteurs en attente de l’espace, par lots ; rend le nombre de lignes traitées.
pub fn index_pending(space: &Space, model: &dyn Embedder, limit: usize) -> AppResult<usize> {
    let db = crate::space_db::open(space)?;
    ensure_tables(&db)?;
    let mut done = 0;
    while done < limit {
        let batch: Vec<(String, String, i64)> = {
            let mut statement = db.prepare("SELECT module, idx, row_id FROM _alfred_vector_queue LIMIT ?1")?;
            let rows = statement
                .query_map([BATCH as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .filter_map(Result::ok)
                .collect();
            rows
        };
        if batch.is_empty() {
            break;
        }
        let mut texts = Vec::new();
        let mut targets = Vec::new();
        for (module, idx, row_id) in &batch {
            let declaration = space.module(module).ok().and_then(|manifest| manifest.semantic.into_iter().find(|index| &index.id == idx));
            let text: Option<String> = declaration.and_then(|index| {
                let columns = index.columns.iter().map(|column| format!("COALESCE(CAST({} AS TEXT), '')", quoted(column))).collect::<Vec<_>>().join(" || char(10) || ");
                db.query_row(&format!("SELECT {columns} FROM {} WHERE rowid = ?1", quoted(&index.table)), [row_id], |row| row.get(0)).ok()
            });
            match text.map(|text: String| text.trim().chars().take(4_000).collect::<String>()).filter(|text| !text.is_empty()) {
                Some(text) => {
                    texts.push(text);
                    targets.push((module.clone(), idx.clone(), *row_id));
                }
                None => {
                    db.execute("DELETE FROM _alfred_vectors WHERE module = ?1 AND idx = ?2 AND row_id = ?3", params![module, idx, row_id])?;
                }
            }
        }
        let vectors = model.embed(&texts, false)?;
        db.execute_batch("BEGIN;")?;
        for ((module, idx, row_id), vector) in targets.iter().zip(vectors) {
            db.execute(
                "INSERT OR REPLACE INTO _alfred_vectors (module, idx, row_id, vector) VALUES (?1, ?2, ?3, ?4)",
                params![module, idx, row_id, to_blob(&vector)],
            )?;
        }
        for (module, idx, row_id) in &batch {
            db.execute("DELETE FROM _alfred_vector_queue WHERE module = ?1 AND idx = ?2 AND row_id = ?3", params![module, idx, row_id])?;
        }
        db.execute_batch("COMMIT;")?;
        done += batch.len();
    }
    Ok(done)
}

fn counts(db: &Connection, module: &str, index: &str) -> AppResult<(i64, i64)> {
    let indexed = db.query_row("SELECT count(*) FROM _alfred_vectors WHERE module = ?1 AND idx = ?2", params![module, index], |row| row.get(0))?;
    let pending = db.query_row("SELECT count(*) FROM _alfred_vector_queue WHERE module = ?1 AND idx = ?2", params![module, index], |row| row.get(0))?;
    Ok((indexed, pending))
}

fn declared(space: &Space, module: &str, index: &str) -> AppResult<IndexDecl> {
    let mut problems = Vec::new();
    sync(space, module, &mut problems)?;
    let manifest = space.module(module)?;
    let found = manifest.semantic.into_iter().find(|declared| declared.id == index).ok_or_else(|| {
        AppError::new(format!("L’index sémantique « {index} » n’est pas déclaré dans `semantic` du module."))
    })?;
    if let Some(problem) = problems.iter().find(|problem| problem.file.contains(&format!("« {index} »"))) {
        return Err(AppError::new(format!("Index sémantique inutilisable : {}", problem.message)));
    }
    Ok(found)
}

pub fn status(space: &Space, module: &str, index: &str) -> AppResult<Value> {
    declared(space, module, index)?;
    let db = crate::space_db::open(space)?;
    let (indexed, pending) = counts(&db, module, index)?;
    Ok(json!({ "indexed": indexed, "pending": pending }))
}

/// Les lignes les plus proches du sens de `text`, avec leur similarité (de -1 à 1, plus grand = plus proche).
pub fn search(space: &Space, module: &str, index: &str, text: &str, limit: usize, model: &dyn Embedder) -> AppResult<Value> {
    let declaration = declared(space, module, index)?;
    let db = crate::space_db::open(space)?;
    let (_, pending) = counts(&db, module, index)?;
    if text.trim().is_empty() {
        return Ok(json!({ "pending": pending, "results": [] }));
    }
    let query = model.embed(&[text.trim().to_string()], true)?.into_iter().next().unwrap_or_default();
    let mut statement = db.prepare("SELECT row_id, vector FROM _alfred_vectors WHERE module = ?1 AND idx = ?2")?;
    let mut scored: Vec<(i64, f32)> = statement
        .query_map(params![module, index], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))?
        .filter_map(Result::ok)
        .map(|(row_id, blob)| (row_id, from_blob(&blob).iter().zip(&query).map(|(a, b)| a * b).sum()))
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(limit.min(MAX_RESULTS));
    let key_sql = format!("SELECT {} FROM {} WHERE rowid = ?1", quoted(declaration.key()), quoted(&declaration.table));
    let mut results = Vec::new();
    for (row_id, score) in scored {
        let key = db.query_row(&key_sql, [row_id], |row| {
            Ok(match row.get_ref(0)? {
                rusqlite::types::ValueRef::Integer(number) => json!(number),
                rusqlite::types::ValueRef::Real(number) => json!(number),
                rusqlite::types::ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
                _ => Value::Null,
            })
        });
        if let Ok(key) = key {
            results.push(json!({ "key": key, "score": (f64::from(score) * 1000.0).round() / 1000.0 }));
        }
    }
    Ok(json!({ "pending": pending, "results": results }))
}

// ---------------------------------------------------------------------------------------------------------------
// Boucle de fond et commandes
// ---------------------------------------------------------------------------------------------------------------

fn wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

pub fn kick() {
    wake().notify_one();
}

/// Calcule en fond les vecteurs en attente, tant que le modèle est installé.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            let _ = tokio::time::timeout(Duration::from_secs(10), wake().notified()).await;
            let Some(space) = state.try_space() else { continue };
            let worker = state.clone();
            let result = tokio::task::spawn_blocking(move || -> AppResult<usize> {
                match embedder(&worker)? {
                    Some(model) => index_pending(&space, model.as_ref(), 512),
                    None => Ok(0),
                }
            })
            .await;
            match result {
                Ok(Ok(count)) if count > 0 => {
                    state.emit("semantic:changed", Value::Null);
                    kick();
                }
                Ok(Err(error)) => log::error!("recherche sémantique : {}", error.message),
                _ => {}
            }
        }
    });
}

fn missing_model() -> AppError {
    AppError::new(
        "La recherche par le sens n’est pas encore installée : l’utilisateur télécharge son modèle dans Réglages → Général.",
    )
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "semantic.model" => Some(Ok(model_status(state))),
        "semantic.download" => Some(download(state.clone()).map(|()| model_status(state))),
        "frame.semantic.search" | "frame.semantic.status" => {
            let state = state.clone();
            let command = command.to_string();
            let args = args.clone();
            let result = tokio::task::spawn_blocking(move || -> AppResult<Value> {
                let subject: Subject = arg(&args, "subject")?;
                let index: String = arg(&args, "index")?;
                let space = state.space()?;
                if command == "frame.semantic.status" {
                    let mut value = status(&space, &subject.module, &index)?;
                    value["model"] = model_status(&state)["status"].clone();
                    return Ok(value);
                }
                let text: String = arg(&args, "text")?;
                let limit: Option<usize> = opt_arg(&args, "limit")?;
                let model = embedder(&state)?.ok_or_else(missing_model)?;
                search(&space, &subject.module, &index, &text, limit.unwrap_or(10), model.as_ref())
            })
            .await
            .unwrap_or_else(|_| Err(AppError::new("La recherche par le sens a échoué.")));
            kick();
            Some(result)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::ModuleManifest;
    use crate::space_db::{apply_migrations, run};

    /// Vecteurs de test : un sac de mots haché, assez pour vérifier que la ligne qui partage les mots de la question
    /// sort la première.
    struct Words;

    impl Embedder for Words {
        fn embed(&self, texts: &[String], _query: bool) -> AppResult<Vec<Vec<f32>>> {
            Ok(texts
                .iter()
                .map(|text| {
                    let mut vector = vec![0.0f32; 64];
                    for word in text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|word| word.len() > 2) {
                        let hash = word.bytes().fold(7u32, |acc, byte| acc.wrapping_mul(31).wrapping_add(u32::from(byte)));
                        vector[(hash % 64) as usize] += 1.0;
                    }
                    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt().max(1e-6);
                    vector.iter().map(|value| value / norm).collect()
                })
                .collect())
        }
    }

    #[test]
    fn rows_are_queued_indexed_and_ranked_by_meaning() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let manifest = ModuleManifest {
            id: "notes".into(),
            name: "Notes".into(),
            semantic: vec![IndexDecl { id: "sens".into(), table: "notes_n".into(), key: "uid".into(), columns: vec!["titre".into(), "corps".into()] }],
            ..Default::default()
        };
        space.write_module(&manifest).unwrap();
        let migrations = space.module_dir("notes").join("migrations");
        std::fs::create_dir_all(&migrations).unwrap();
        std::fs::write(migrations.join("0001.sql"), "CREATE TABLE notes_n (uid TEXT PRIMARY KEY, titre TEXT, corps TEXT);").unwrap();
        run(&space, "notes", "INSERT INTO notes_n VALUES ('a', 'Facture électricité', 'Montant de la facture électricité de mars')", &[], true).unwrap();
        assert!(apply_migrations(&space).unwrap().is_empty());
        run(&space, "notes", "INSERT INTO notes_n VALUES ('b', 'Vacances', 'Réserver hôtel montagne')", &[], true).unwrap();
        assert_eq!(status(&space, "notes", "sens").unwrap(), json!({ "indexed": 0, "pending": 2 }));

        assert_eq!(index_pending(&space, &Words, 100).unwrap(), 2);
        assert_eq!(status(&space, "notes", "sens").unwrap(), json!({ "indexed": 2, "pending": 0 }));
        let found = search(&space, "notes", "sens", "réserver un hôtel", 5, &Words).unwrap();
        assert_eq!(found["results"][0]["key"], "b", "{found}");

        // Une modification remet la ligne en file ; une suppression retire son vecteur.
        run(&space, "notes", "UPDATE notes_n SET corps = 'Réserver hôtel et facture' WHERE uid = 'b'", &[], true).unwrap();
        assert_eq!(status(&space, "notes", "sens").unwrap()["pending"], 1);
        run(&space, "notes", "DELETE FROM notes_n WHERE uid = 'a'", &[], true).unwrap();
        assert_eq!(status(&space, "notes", "sens").unwrap(), json!({ "indexed": 1, "pending": 1 }));

        // Un autre module ne cherche pas dans cet index et ne lit pas les vecteurs.
        assert!(search(&space, "autre", "sens", "x", 5, &Words).is_err());
        assert!(run(&space, "notes", "SELECT * FROM _alfred_vectors", &[], false).is_err());
    }

    /// Le vrai modèle, s’il est déjà téléchargé dans `ALFRED_E5_DIR` : le sens l’emporte sur les mots.
    #[test]
    #[ignore]
    fn the_local_model_ranks_by_meaning() {
        let Ok(dir) = std::env::var("ALFRED_E5_DIR") else { return };
        let model = E5::load(Path::new(&dir)).unwrap();
        let texts = vec!["Facture EDF du mois de mars".to_string(), "Recette de la tarte aux pommes".to_string()];
        let passages = model.embed(&texts, false).unwrap();
        let query = &model.embed(&["dépenses d’énergie".to_string()], true).unwrap()[0];
        let score = |vector: &Vec<f32>| vector.iter().zip(query).map(|(a, b)| a * b).sum::<f32>();
        assert!(score(&passages[0]) > score(&passages[1]));
        use_embedder(Arc::new(model));
    }
}
