//! Sauvegardes des données des modules. La base de l’espace (`.alfred/data.sqlite`) et les fichiers des modules
//! (`.alfred/files/`) ne sont pas dans l’historique git : Alfred en garde des copies datées dans
//! `.alfred/backups/`, chaque jour et avant chaque migration, et sait remettre tout l’espace ou un seul module dans
//! l’état d’une copie. Les données d’un module s’exportent aussi en JSON, pour passer d’un espace ou d’un poste à
//! l’autre.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{valid_id, Space, LOCAL_DIR};
use crate::space_db::{self, owned_tables};
use crate::state::AppState;

const BACKUPS_DIR: &str = "backups";
const FILES_DIR: &str = "files";
const META_FILE: &str = "backup.json";
const SETTINGS_FILE: &str = "backups.json";
pub const EXPORT_FORMAT: &str = "alfred-module-data";
const DEFAULT_KEEP: usize = 14;
/// Copies automatiques autres que quotidiennes (avant migration, restauration, import) gardées.
const KEEP_OTHERS: usize = 10;
/// Deux migrations à moins de ce délai partagent la même copie : la base n’a guère changé entre-temps.
const MIGRATION_GRACE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Quotidienne,
    Migration,
    Manuelle,
    Restauration,
    Import,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Quotidienne => "quotidienne",
            Reason::Migration => "migration",
            Reason::Manuelle => "manuelle",
            Reason::Restauration => "restauration",
            Reason::Import => "import",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSummary {
    pub id: String,
    pub tables: usize,
    pub rows: i64,
    pub files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// Nom du dossier de la copie.
    pub id: String,
    pub created_at: String,
    pub reason: Reason,
    /// Précision : le module dont la migration a déclenché la copie, par exemple.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub size: u64,
    pub modules: Vec<ModuleSummary>,
    /// Échec de la copie vers le dossier choisi par l’utilisateur (la copie locale, elle, existe).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Copies quotidiennes gardées.
    pub keep: usize,
    /// Dossier où chaque copie est aussi recopiée.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_dir: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { keep: DEFAULT_KEEP, copy_dir: None }
    }
}

fn local(space: &Space) -> PathBuf {
    space.root.join(LOCAL_DIR)
}

fn backups_dir(space: &Space) -> PathBuf {
    local(space).join(BACKUPS_DIR)
}

pub fn files_root(space: &Space) -> PathBuf {
    local(space).join(FILES_DIR)
}

pub fn read_settings(space: &Space) -> Settings {
    std::fs::read_to_string(local(space).join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write_settings(space: &Space, settings: &Settings) -> AppResult<()> {
    if settings.keep == 0 || settings.keep > 365 {
        return Err(AppError::new("Le nombre de sauvegardes gardées va de 1 à 365."));
    }
    if let Some(dir) = &settings.copy_dir {
        if !Path::new(dir).is_dir() {
            return Err(AppError::new(format!("Le dossier « {dir} » n’existe pas.")));
        }
    }
    std::fs::create_dir_all(local(space))?;
    std::fs::write(local(space).join(SETTINGS_FILE), serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_size(&entry.path()),
            _ => entry.metadata().map(|meta| meta.len()).unwrap_or(0),
        })
        .sum()
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn count_files(dir: &Path) -> usize {
    std::fs::read_dir(dir).map(|entries| entries.flatten().filter(|entry| entry.path().is_file()).count()).unwrap_or(0)
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Ce que contient la base pour chaque module de l’espace : nombre de tables, de lignes et de fichiers.
fn summarize(db: &Connection, space: &Space, schema: &str, files: &Path) -> AppResult<Vec<ModuleSummary>> {
    let mut summaries = Vec::new();
    for module in space.module_ids() {
        let tables = tables_in(db, space, &module, schema)?;
        let mut rows = 0;
        for table in &tables {
            rows += db
                .query_row(&format!("SELECT count(*) FROM {schema}.{}", quoted(table)), [], |row| row.get::<_, i64>(0))
                .unwrap_or_default();
        }
        let file_count = count_files(&files.join(&module));
        if !tables.is_empty() || file_count > 0 {
            summaries.push(ModuleSummary { id: module, tables: tables.len(), rows, files: file_count });
        }
    }
    Ok(summaries)
}

/// Tables d’un module dans la base `schema` (« main », ou une copie attachée).
fn tables_in(db: &Connection, space: &Space, module: &str, schema: &str) -> AppResult<Vec<String>> {
    if schema == "main" {
        return owned_tables(db, space, module);
    }
    let own = space_db::table_prefix(module);
    let longer: Vec<String> =
        space.module_ids().iter().map(|id| space_db::table_prefix(id)).filter(|prefix| prefix.len() > own.len()).collect();
    let mut statement = db.prepare(&format!("SELECT name FROM {schema}.sqlite_master WHERE type = 'table' ORDER BY rowid"))?;
    let tables: Vec<String> = statement.query_map([], |row| row.get(0))?.filter_map(Result::ok).collect();
    Ok(tables
        .into_iter()
        .filter(|table| {
            table.starts_with(&own) && !longer.iter().any(|other| other.starts_with(&own) && table.starts_with(other.as_str()))
        })
        .collect())
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Fait une copie de la base et des fichiers des modules.
pub fn create(space: &Space, reason: Reason, note: Option<&str>) -> AppResult<BackupInfo> {
    let root = backups_dir(space);
    std::fs::create_dir_all(&root)?;
    let base = format!("{}-{}", stamp(), reason.as_str());
    let mut id = base.clone();
    let mut suffix = 2;
    while root.join(&id).exists() {
        id = format!("{base}-{suffix}");
        suffix += 1;
    }
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir)?;
    let result: AppResult<BackupInfo> = (|| {
        let db = space_db::open(space)?;
        // `VACUUM INTO` écrit une copie cohérente, même pendant que d’autres connexions écrivent.
        db.execute("VACUUM INTO ?1", params![dir.join("data.sqlite").to_string_lossy()])?;
        let files = files_root(space);
        if files.is_dir() {
            copy_dir(&files, &dir.join(FILES_DIR))?;
        }
        let modules = summarize(&db, space, "main", &files)?;
        let mut info = BackupInfo {
            id: id.clone(),
            created_at: crate::app_db::now(),
            reason,
            note: note.map(str::to_string),
            size: dir_size(&dir),
            modules,
            copy_error: None,
        };
        std::fs::write(dir.join(META_FILE), serde_json::to_string_pretty(&info)?)?;
        let settings = read_settings(space);
        prune(&root, &settings);
        if let Some(target) = &settings.copy_dir {
            if let Err(error) = copy_out(space, &dir, &id, target, &settings) {
                info.copy_error = Some(error.message);
            }
        }
        Ok(info)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

/// Recopie une sauvegarde dans le dossier choisi par l’utilisateur, sous un dossier au nom de l’espace.
fn copy_out(space: &Space, dir: &Path, id: &str, target: &str, settings: &Settings) -> AppResult<()> {
    let target = Path::new(target);
    if !target.is_dir() {
        return Err(AppError::new(format!("Le dossier de copie « {} » est introuvable.", target.display())));
    }
    let name = space.manifest().map(|manifest| manifest.name).unwrap_or_else(|_| "Espace".into());
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
    let folder = target.join(format!("Alfred - {}", safe.trim()));
    copy_dir(dir, &folder.join(id)).map_err(|error| AppError::new(format!("Copie vers {} impossible : {error}", folder.display())))?;
    prune(&folder, settings);
    Ok(())
}

pub fn list_in(root: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut backups: Vec<BackupInfo> = entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path().join(META_FILE)).ok())
        .filter_map(|text| serde_json::from_str(&text).ok())
        .collect();
    backups.sort_by(|a, b| b.id.cmp(&a.id));
    backups
}

pub fn list(space: &Space) -> Vec<BackupInfo> {
    list_in(&backups_dir(space))
}

/// Garde les `keep` dernières copies quotidiennes et les dix dernières de chaque autre raison automatique ; les
/// copies manuelles restent jusqu’à ce que l’utilisateur les supprime.
fn prune(root: &Path, settings: &Settings) {
    let backups = list_in(root);
    for reason in [Reason::Quotidienne, Reason::Migration, Reason::Restauration, Reason::Import] {
        let keep = if reason == Reason::Quotidienne { settings.keep } else { KEEP_OTHERS };
        for old in backups.iter().filter(|backup| backup.reason == reason).skip(keep) {
            let _ = std::fs::remove_dir_all(root.join(&old.id));
        }
    }
}

fn backup_dir(space: &Space, id: &str) -> AppResult<PathBuf> {
    let valid = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let dir = backups_dir(space).join(id);
    if !valid || !dir.join("data.sqlite").is_file() {
        return Err(AppError::new("Cette sauvegarde est introuvable."));
    }
    Ok(dir)
}

pub fn delete(space: &Space, id: &str) -> AppResult<()> {
    std::fs::remove_dir_all(backup_dir(space, id)?)?;
    Ok(())
}

/// Copie quotidienne, si la dernière a plus d’un jour.
pub fn ensure_daily(space: &Space) -> AppResult<Option<BackupInfo>> {
    let last = list(space).into_iter().find(|backup| backup.reason == Reason::Quotidienne);
    let due = last.is_none_or(|backup| age(&backup.created_at).is_none_or(|age| age >= Duration::from_secs(86_400)));
    if !due || !has_data(space) {
        return Ok(None);
    }
    create(space, Reason::Quotidienne, None).map(Some)
}

/// Rien à sauvegarder dans un espace sans aucune donnée de module.
fn has_data(space: &Space) -> bool {
    if std::fs::read_dir(files_root(space)).is_ok_and(|mut dirs| dirs.next().is_some()) {
        return true;
    }
    let Ok(db) = space_db::open(space) else { return false };
    space.module_ids().iter().any(|module| owned_tables(&db, space, module).is_ok_and(|tables| !tables.is_empty()))
}

fn age(created_at: &str) -> Option<Duration> {
    let created = chrono::DateTime::parse_from_rfc3339(created_at).ok()?;
    let elapsed = chrono::Utc::now().signed_duration_since(created);
    elapsed.to_std().ok()
}

/// Copie faite juste avant d’appliquer une migration d’un module qui a déjà des tables. Un échec est noté mais
/// n’empêche pas la migration : un disque plein ne doit pas bloquer tous les modules.
pub fn before_migration(space: &Space, module: &str, file: &str) {
    let has_tables = space_db::open(space)
        .ok()
        .is_some_and(|db| owned_tables(&db, space, module).is_ok_and(|tables| !tables.is_empty()));
    if !has_tables {
        return;
    }
    let recent = list(space)
        .into_iter()
        .find(|backup| backup.reason == Reason::Migration)
        .and_then(|backup| age(&backup.created_at))
        .is_some_and(|age| age < MIGRATION_GRACE);
    if recent {
        return;
    }
    if let Err(error) = create(space, Reason::Migration, Some(&format!("{module} : {file}"))) {
        log::error!("sauvegarde avant migration impossible : {}", error.message);
    }
}

/// Remet toute la base et tous les fichiers dans l’état d’une copie, après en avoir fait une de l’état actuel.
pub fn restore_all(space: &Space, id: &str) -> AppResult<BackupInfo> {
    let dir = backup_dir(space, id)?;
    let safety = create(space, Reason::Restauration, Some("tout l’espace"))?;
    let source = Connection::open(dir.join("data.sqlite"))?;
    let mut target = space_db::open(space)?;
    {
        // L’API de sauvegarde de SQLite remplace la base page à page, sous verrou : les autres connexions de
        // l’espace voient l’ancienne base ou la nouvelle, jamais un mélange.
        let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
        backup.run_to_completion(256, Duration::from_millis(5), None)?;
    }
    let files = files_root(space);
    if files.exists() {
        std::fs::remove_dir_all(&files)?;
    }
    if dir.join(FILES_DIR).is_dir() {
        copy_dir(&dir.join(FILES_DIR), &files)?;
    }
    Ok(safety)
}

/// Remet un seul module dans l’état d’une copie : ses tables (structure et lignes), ses migrations appliquées et
/// ses fichiers. Les autres modules ne bougent pas.
pub fn restore_module(space: &Space, id: &str, module: &str) -> AppResult<BackupInfo> {
    if !valid_id(module) {
        return Err(AppError::new("Module inconnu."));
    }
    let dir = backup_dir(space, id)?;
    let safety = create(space, Reason::Restauration, Some(&module_label(space, module)))?;
    let db = space_db::open(space)?;
    db.execute("ATTACH DATABASE ?1 AS copie", params![dir.join("data.sqlite").to_string_lossy()])?;
    let result: AppResult<()> = (|| {
        db.execute_batch("PRAGMA foreign_keys = OFF; BEGIN;")?;
        for table in owned_tables(&db, space, module)? {
            db.execute_batch(&format!("DROP TABLE IF EXISTS main.{};", quoted(&table)))?;
        }
        let tables = tables_in(&db, space, module, "copie")?;
        let objects: Vec<(String, String)> = {
            let mut statement = db.prepare(
                "SELECT type, sql FROM copie.sqlite_master WHERE sql IS NOT NULL AND tbl_name = ?1 ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid",
            )?;
            let mut all = Vec::new();
            for table in &tables {
                all.extend(statement.query_map([table], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok));
            }
            all
        };
        for (_, sql) in objects.iter().filter(|(kind, _)| kind == "table") {
            db.execute_batch(sql)?;
        }
        for table in &tables {
            db.execute_batch(&format!("INSERT INTO main.{0} SELECT * FROM copie.{0};", quoted(table)))?;
        }
        for (_, sql) in objects.iter().filter(|(kind, _)| kind != "table") {
            db.execute_batch(sql)?;
        }
        db.execute("DELETE FROM main._alfred_migrations WHERE module = ?1", params![module])?;
        let has_migrations = db
            .prepare("SELECT 1 FROM copie.sqlite_master WHERE name = '_alfred_migrations'")?
            .exists([])?;
        if has_migrations {
            db.execute(
                "INSERT INTO main._alfred_migrations SELECT * FROM copie._alfred_migrations WHERE module = ?1",
                params![module],
            )?;
        }
        db.execute_batch("COMMIT;")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK;");
    }
    let _ = db.execute_batch("PRAGMA foreign_keys = ON;");
    let _ = db.execute_batch("DETACH DATABASE copie;");
    result?;
    let files = files_root(space).join(module);
    if files.exists() {
        std::fs::remove_dir_all(&files)?;
    }
    let saved = dir.join(FILES_DIR).join(module);
    if saved.is_dir() {
        copy_dir(&saved, &files)?;
    }
    Ok(safety)
}

fn value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => json!(number),
        ValueRef::Real(number) => json!(number),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).to_string()),
        ValueRef::Blob(bytes) => json!({ "$blob": base64::engine::general_purpose::STANDARD.encode(bytes) }),
    }
}

fn json_to_value(value: &Value) -> AppResult<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => {
            number.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(number.as_f64().unwrap_or_default()))
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(object) if object.len() == 1 && object.contains_key("$blob") => {
            let encoded = object["$blob"].as_str().unwrap_or_default();
            SqlValue::Blob(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| AppError::new("Valeur binaire illisible dans le fichier."))?,
            )
        }
        other => SqlValue::Text(other.to_string()),
    })
}

fn applied_migrations(db: &Connection, module: &str) -> AppResult<Vec<(String, Option<String>)>> {
    let mut statement = db.prepare("SELECT name, checksum FROM _alfred_migrations WHERE module = ?1 ORDER BY name")?;
    let rows = statement.query_map([module], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    Ok(rows)
}

/// Les données d’un module en JSON : ses migrations appliquées, chaque table (colonnes et lignes) et ses fichiers.
pub fn export_module(space: &Space, module: &str) -> AppResult<Value> {
    if !valid_id(module) || !space.module_dir(module).is_dir() {
        return Err(AppError::new("Module inconnu."));
    }
    let manifest = space.module(module)?;
    let db = space_db::open(space)?;
    let mut tables = Map::new();
    for table in owned_tables(&db, space, module)? {
        let mut statement = db.prepare(&format!("SELECT * FROM {}", quoted(&table)))?;
        let columns: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
        let mut rows = Vec::new();
        let mut cursor = statement.query([])?;
        while let Some(row) = cursor.next()? {
            rows.push(Value::Array((0..columns.len()).map(|index| value_to_json(row.get_ref(index).unwrap_or(ValueRef::Null))).collect()));
        }
        tables.insert(table, json!({ "columns": columns, "rows": rows }));
    }
    let mut files = Vec::new();
    let file_dir = files_root(space).join(module);
    if let Ok(entries) = std::fs::read_dir(&file_dir) {
        for entry in entries.flatten().filter(|entry| entry.path().is_file()) {
            files.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "data": base64::engine::general_purpose::STANDARD.encode(std::fs::read(entry.path())?),
            }));
        }
    }
    let migrations: Vec<Value> = applied_migrations(&db, module)?
        .into_iter()
        .map(|(name, checksum)| json!({ "name": name, "checksum": checksum }))
        .collect();
    Ok(json!({
        "format": EXPORT_FORMAT,
        "formatVersion": 1,
        "module": module,
        "moduleVersion": manifest.version,
        "exportedAt": crate::app_db::now(),
        "migrations": migrations,
        "tables": tables,
        "files": files,
    }))
}

/// Remplace les données d’un module par celles d’un export. Les migrations appliquées doivent être les mêmes des
/// deux côtés : sinon les tables n’ont pas la même structure, et l’import est refusé sans rien toucher.
pub fn import_module(space: &Space, module: &str, data: &Value) -> AppResult<BackupInfo> {
    if data.get("format").and_then(Value::as_str) != Some(EXPORT_FORMAT) {
        return Err(AppError::new("Ce fichier n’est pas un export de données de module d’Alfred."));
    }
    let source = data.get("module").and_then(Value::as_str).unwrap_or_default();
    if source != module {
        return Err(AppError::new(format!(
            "Ce fichier contient les données du module « {source} », pas de « {module} »."
        )));
    }
    if !valid_id(module) || !space.module_dir(module).is_dir() {
        return Err(AppError::new("Module inconnu."));
    }
    // Les migrations du module qui attendent passent d’abord, pour comparer avec la structure réelle.
    space_db::apply_migrations(space)?;
    let db = space_db::open(space)?;
    let local: Vec<String> = applied_migrations(&db, module)?.into_iter().map(|(name, _)| name).collect();
    let incoming: Vec<String> = data
        .get("migrations")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default();
    if local != incoming {
        return Err(AppError::new(format!(
            "La structure des données ne correspond pas : ce fichier vient d’un module dont les migrations sont {}, celui-ci a {}. Mettez les deux modules à la même version avant d’importer.",
            describe(&incoming),
            describe(&local)
        )));
    }
    let tables = data.get("tables").and_then(Value::as_object).cloned().unwrap_or_default();
    let owned = owned_tables(&db, space, module)?;
    if let Some(unknown) = tables.keys().find(|table| !owned.contains(table)) {
        return Err(AppError::new(format!("La table « {unknown} » n’existe pas dans le module « {module} ».")));
    }
    let safety = create(space, Reason::Import, Some(&module_label(space, module)))?;
    let result: AppResult<()> = (|| {
        db.execute_batch("PRAGMA foreign_keys = OFF; BEGIN;")?;
        for table in &owned {
            db.execute_batch(&format!("DELETE FROM {};", quoted(table)))?;
        }
        for (table, content) in &tables {
            let columns: Vec<String> = content
                .get("columns")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            if columns.is_empty() {
                continue;
            }
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                quoted(table),
                columns.iter().map(|column| quoted(column)).collect::<Vec<_>>().join(", "),
                (1..=columns.len()).map(|index| format!("?{index}")).collect::<Vec<_>>().join(", ")
            );
            let mut statement = db.prepare(&sql).map_err(|error| AppError::new(format!("Table « {table} » : {error}")))?;
            for row in content.get("rows").and_then(Value::as_array).into_iter().flatten() {
                let values: Vec<SqlValue> =
                    row.as_array().into_iter().flatten().map(json_to_value).collect::<AppResult<_>>()?;
                statement
                    .execute(rusqlite::params_from_iter(values.iter()))
                    .map_err(|error| AppError::new(format!("Table « {table} » : {error}")))?;
            }
        }
        let violations = db.prepare("PRAGMA foreign_key_check")?.exists([])?;
        if violations {
            return Err(AppError::new("Les lignes importées ne respectent pas les clés étrangères du module."));
        }
        db.execute_batch("COMMIT;")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK;");
    }
    let _ = db.execute_batch("PRAGMA foreign_keys = ON;");
    result?;
    let file_dir = files_root(space).join(module);
    if let Some(files) = data.get("files").and_then(Value::as_array) {
        if file_dir.exists() {
            std::fs::remove_dir_all(&file_dir)?;
        }
        for file in files {
            let name = file.get("name").and_then(Value::as_str).unwrap_or_default();
            if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
                continue;
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file.get("data").and_then(Value::as_str).unwrap_or_default())
                .map_err(|_| AppError::new(format!("Fichier « {name} » illisible dans l’export.")))?;
            std::fs::create_dir_all(&file_dir)?;
            std::fs::write(file_dir.join(name), bytes)?;
        }
    }
    Ok(safety)
}

/// Nom du module tel que l’utilisateur le voit.
fn module_label(space: &Space, module: &str) -> String {
    space.module(module).map(|manifest| manifest.name).unwrap_or_else(|_| module.to_string())
}

fn describe(migrations: &[String]) -> String {
    if migrations.is_empty() {
        "aucune".into()
    } else {
        migrations.join(", ")
    }
}

/// Copie quotidienne vérifiée à l’ouverture de l’espace puis toutes les heures.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut wake = tokio::time::interval(Duration::from_secs(3_600));
        wake.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            wake.tick().await;
            if let Some(space) = state.try_space() {
                let result = tokio::task::spawn_blocking(move || ensure_daily(&space)).await;
                match result {
                    Ok(Ok(Some(_))) => state.emit("backups:changed", Value::Null),
                    Ok(Err(error)) => log::error!("sauvegarde quotidienne impossible : {}", error.message),
                    _ => {}
                }
            }
        }
    });
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    let changed = |value: AppResult<Value>| {
        if value.is_ok() {
            state.emit("backups:changed", Value::Null);
        }
        value
    };
    Some(match command {
        "backups.list" => (|| Ok(serde_json::to_value(list(&state.space()?))?))(),
        "backups.settings" => (|| Ok(serde_json::to_value(read_settings(&state.space()?))?))(),
        "backups.setSettings" => (|| {
            let space = state.space()?;
            let mut settings = read_settings(&space);
            if let Some(keep) = opt_arg::<usize>(args, "keep")? {
                settings.keep = keep;
            }
            if args.get("copyDir").is_some() {
                settings.copy_dir = opt_arg::<String>(args, "copyDir")?.filter(|dir| !dir.trim().is_empty());
            }
            write_settings(&space, &settings)?;
            Ok(serde_json::to_value(settings)?)
        })(),
        "backups.create" => changed((|| Ok(serde_json::to_value(create(&state.space()?, Reason::Manuelle, None)?)?))()),
        "backups.delete" => changed((|| {
            let id: String = arg(args, "id")?;
            delete(&state.space()?, &id)?;
            Ok(Value::Null)
        })()),
        "backups.restore" => {
            let result = (|| {
                let space = state.space()?;
                let id: String = arg(args, "id")?;
                let module: Option<String> = opt_arg(args, "module")?;
                let safety = match module {
                    Some(module) => restore_module(&space, &id, &module)?,
                    None => restore_all(&space, &id)?,
                };
                Ok(serde_json::to_value(safety)?)
            })();
            if result.is_ok() {
                state.emit("space:changed", Value::Null);
            }
            changed(result)
        }
        "backups.exportModule" => (|| {
            let module: String = arg(args, "module")?;
            let path: String = arg(args, "path")?;
            let data = export_module(&state.space()?, &module)?;
            std::fs::write(&path, serde_json::to_vec_pretty(&data)?)?;
            Ok(json!({ "path": path }))
        })(),
        "backups.importModule" => {
            let result = (|| {
                let module: String = arg(args, "module")?;
                let path: String = arg(args, "path")?;
                let text = std::fs::read_to_string(&path)
                    .map_err(|error| AppError::new(format!("Le fichier n’a pas pu être lu : {error}")))?;
                let data: Value = serde_json::from_str(&text)
                    .map_err(|_| AppError::new("Ce fichier n’est pas un export de données de module d’Alfred."))?;
                Ok(serde_json::to_value(import_module(&state.space()?, &module, &data)?)?)
            })();
            if result.is_ok() {
                state.emit("space:changed", Value::Null);
            }
            changed(result)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{ModuleManifest, Space};

    fn space_with(modules: &[(&str, &str)]) -> (tempfile::TempDir, Space) {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        for (module, sql) in modules {
            let manifest = ModuleManifest { id: (*module).into(), name: (*module).into(), ..Default::default() };
            space.write_module(&manifest).unwrap();
            let migrations = space.module_dir(module).join("migrations");
            std::fs::create_dir_all(&migrations).unwrap();
            std::fs::write(migrations.join("0001.sql"), sql).unwrap();
        }
        assert!(space_db::apply_migrations(&space).unwrap().is_empty());
        (dir, space)
    }

    fn rows(space: &Space, module: &str, sql: &str) -> Value {
        space_db::run(space, module, sql, &[], false).unwrap()
    }

    fn write(space: &Space, module: &str, sql: &str) {
        space_db::run(space, module, sql, &[], true).unwrap();
    }

    #[test]
    fn a_backup_restores_the_whole_space_or_a_single_module() {
        let (_dir, space) = space_with(&[
            ("notes", "CREATE TABLE notes_n (id INTEGER PRIMARY KEY, texte TEXT); CREATE INDEX notes_n_texte ON notes_n (texte);"),
            ("suivi", "CREATE TABLE suivi_t (id INTEGER PRIMARY KEY, titre TEXT);"),
        ]);
        write(&space, "notes", "INSERT INTO notes_n (texte) VALUES ('avant')");
        write(&space, "suivi", "INSERT INTO suivi_t (titre) VALUES ('avant')");
        std::fs::create_dir_all(files_root(&space).join("notes")).unwrap();
        std::fs::write(files_root(&space).join("notes/a.txt"), "piece").unwrap();

        let backup = create(&space, Reason::Manuelle, None).unwrap();
        let notes = backup.modules.iter().find(|module| module.id == "notes").unwrap();
        assert_eq!((notes.tables, notes.rows, notes.files), (1, 1, 1));
        assert_eq!(list(&space)[0].id, backup.id);

        write(&space, "notes", "UPDATE notes_n SET texte = 'apres'");
        write(&space, "suivi", "UPDATE suivi_t SET titre = 'apres'");
        std::fs::remove_file(files_root(&space).join("notes/a.txt")).unwrap();

        // Un seul module : l’autre garde ses changements.
        restore_module(&space, &backup.id, "notes").unwrap();
        assert_eq!(rows(&space, "notes", "SELECT texte FROM notes_n"), json!([{ "texte": "avant" }]));
        assert_eq!(rows(&space, "suivi", "SELECT titre FROM suivi_t"), json!([{ "titre": "apres" }]));
        assert!(files_root(&space).join("notes/a.txt").is_file());
        let schema = space_db::schema(&space, Some("notes")).unwrap();
        assert!(schema[0]["sql"].as_str().unwrap().contains("notes_n"));
        let db = space_db::open(&space).unwrap();
        assert!(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'notes_n_texte'").unwrap().exists([]).unwrap(), "index restauré");
        assert!(space_db::apply_migrations(&space).unwrap().is_empty(), "migrations du module restaurées");

        // Tout l’espace, après une copie de sécurité.
        let before = list(&space).len();
        restore_all(&space, &backup.id).unwrap();
        assert_eq!(rows(&space, "suivi", "SELECT titre FROM suivi_t"), json!([{ "titre": "avant" }]));
        assert_eq!(list(&space).len(), before + 1);
        assert_eq!(list(&space)[0].reason, Reason::Restauration);

        assert!(restore_all(&space, "../../etc").is_err());
    }

    #[test]
    fn a_migration_is_preceded_by_a_backup_once_the_module_has_tables() {
        let (_dir, space) = space_with(&[("notes", "CREATE TABLE notes_n (id INTEGER PRIMARY KEY);")]);
        assert!(list(&space).is_empty(), "première migration : rien à sauvegarder");
        write(&space, "notes", "INSERT INTO notes_n (id) VALUES (1)");
        std::fs::write(space.module_dir("notes").join("migrations/0002.sql"), "ALTER TABLE notes_n ADD COLUMN x TEXT;").unwrap();
        assert_eq!(rows(&space, "notes", "SELECT id FROM notes_n"), json!([{ "id": 1 }]));
        let backups = list(&space);
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].reason, Reason::Migration);
        assert_eq!(backups[0].note.as_deref(), Some("notes : 0002.sql"));

        // La copie quotidienne n’est faite qu’une fois par jour.
        assert!(ensure_daily(&space).unwrap().is_some());
        assert!(ensure_daily(&space).unwrap().is_none());
    }

    #[test]
    fn only_the_latest_automatic_backups_are_kept() {
        let (_dir, space) = space_with(&[("notes", "CREATE TABLE notes_n (id INTEGER PRIMARY KEY);")]);
        write_settings(&space, &Settings { keep: 2, copy_dir: None }).unwrap();
        for _ in 0..4 {
            create(&space, Reason::Quotidienne, None).unwrap();
        }
        create(&space, Reason::Manuelle, None).unwrap();
        let backups = list(&space);
        assert_eq!(backups.iter().filter(|backup| backup.reason == Reason::Quotidienne).count(), 2);
        assert_eq!(backups.iter().filter(|backup| backup.reason == Reason::Manuelle).count(), 1);
        delete(&space, &backups[0].id).unwrap();
        assert_eq!(list(&space).len(), 2);
    }

    #[test]
    fn backups_are_copied_to_the_folder_the_user_chose() {
        let (_dir, space) = space_with(&[("notes", "CREATE TABLE notes_n (id INTEGER PRIMARY KEY);")]);
        let target = tempfile::tempdir().unwrap();
        write_settings(&space, &Settings { keep: 3, copy_dir: Some(target.path().to_string_lossy().into()) }).unwrap();
        let backup = create(&space, Reason::Manuelle, None).unwrap();
        assert!(backup.copy_error.is_none());
        assert!(target.path().join("Alfred - Test").join(&backup.id).join("data.sqlite").is_file());
        assert!(write_settings(&space, &Settings { keep: 3, copy_dir: Some("/nulle/part".into()) }).is_err());
    }

    #[test]
    fn module_data_moves_between_spaces_as_json() {
        let sql = "CREATE TABLE notes_n (id INTEGER PRIMARY KEY, texte TEXT, image BLOB);
                   CREATE TABLE notes_tag (n INTEGER REFERENCES notes_n (id), tag TEXT);";
        let (_a, source) = space_with(&[("notes", sql)]);
        write(&source, "notes", "INSERT INTO notes_n (id, texte, image) VALUES (1, 'élan', x'00ff')");
        write(&source, "notes", "INSERT INTO notes_tag (n, tag) VALUES (1, 'a')");
        std::fs::create_dir_all(files_root(&source).join("notes")).unwrap();
        std::fs::write(files_root(&source).join("notes/f1"), b"\x01\x02").unwrap();
        let export = export_module(&source, "notes").unwrap();
        assert_eq!(export["tables"]["notes_n"]["rows"][0][2], json!({ "$blob": "AP8=" }));

        let (_b, target) = space_with(&[("notes", sql)]);
        write(&target, "notes", "INSERT INTO notes_n (id, texte) VALUES (9, 'remplacée')");
        import_module(&target, "notes", &export).unwrap();
        assert_eq!(
            rows(&target, "notes", "SELECT id, texte, hex(image) AS image FROM notes_n"),
            json!([{ "id": 1, "texte": "élan", "image": "00FF" }])
        );
        assert_eq!(std::fs::read(files_root(&target).join("notes/f1")).unwrap(), b"\x01\x02");
        assert_eq!(list(&target)[0].reason, Reason::Import);

        // Pas le même module, ou pas les mêmes migrations : refusé sans rien toucher.
        assert!(import_module(&target, "suivi", &export).unwrap_err().message.contains("notes"));
        std::fs::write(target.module_dir("notes").join("migrations/0002.sql"), "ALTER TABLE notes_n ADD COLUMN y TEXT;").unwrap();
        let refused = import_module(&target, "notes", &export).unwrap_err();
        assert!(refused.message.contains("structure"), "{}", refused.message);
        assert_eq!(rows(&target, "notes", "SELECT count(*) AS n FROM notes_n"), json!([{ "n": 1 }]));
    }
}
