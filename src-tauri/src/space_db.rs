//! Base SQLite de l’espace. Chaque module y a ses propres tables, préfixées par son identifiant ; il les crée par des
//! fichiers de migration versionnés avec lui, et ses pages et fonctions ne peuvent lire et écrire que celles-là.

use std::sync::Arc;

use base64::Engine;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, Space, LOCAL_DIR};
use crate::state::AppState;

const MAX_ROWS: usize = 5_000;
/// Préfixe des tables et des déclencheurs qu’Alfred gère lui-même dans la base de l’espace.
pub const ALFRED_PREFIX: &str = "_alfred_";

/// Préfixe des tables d’un module : son identifiant, tirets remplacés (un nom SQL n’en accepte pas sans guillemets).
pub fn table_prefix(module: &str) -> String {
    format!("{}_", module.replace('-', "_"))
}

pub(crate) fn open(space: &Space) -> AppResult<Connection> {
    std::fs::create_dir_all(space.root.join(LOCAL_DIR))?;
    let db = Connection::open(space.root.join(LOCAL_DIR).join("data.sqlite"))?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS _alfred_migrations (
           module TEXT NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (module, name));",
    )?;
    // Empreinte du fichier appliqué : une migration réécrite après coup est signalée au lieu d’être ignorée.
    let has_checksum = db
        .prepare("SELECT 1 FROM pragma_table_info('_alfred_migrations') WHERE name = 'checksum'")?
        .exists([])?;
    if !has_checksum {
        db.execute_batch("ALTER TABLE _alfred_migrations ADD COLUMN checksum TEXT;")?;
    }
    Ok(db)
}

/// Empreinte d’une migration, insensible aux fins de ligne et aux espaces en fin de fichier.
pub(crate) fn checksum(sql: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = sql.replace("\r\n", "\n");
    Sha256::digest(normalized.trim_end().as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Scope {
    /// Lecture et écriture des lignes : ce qu’une page ou une fonction fait.
    Data,
    /// Structure comprise : réservé aux migrations.
    Schema,
}

/// Limite la connexion aux tables du module. Un module d’ajouts (`x-ajouts`) lit aussi les tables du module `x`
/// qu’il complète, sans pouvoir y écrire.
fn restrict(db: &Connection, space: &Space, module: &str, scope: Scope) {
    let own = table_prefix(module);
    let base = module.strip_suffix("-ajouts").map(table_prefix);
    // Une table appartient au module dont le préfixe est le plus long : « suivi » ne possède pas celles de
    // « suivi-ajouts », dont le nom commence pourtant aussi par « suivi_ ».
    let shortest = base.as_deref().map_or(own.len(), str::len);
    let longer: Vec<String> =
        space.module_ids().iter().map(|id| table_prefix(id)).filter(|prefix| prefix.len() > shortest).collect();
    db.authorizer(Some(move |context: AuthContext<'_>| {
        let claimed = |table: &str, prefix: &str| {
            table.starts_with(prefix)
                && !longer.iter().any(|other| other.len() > prefix.len() && other.starts_with(prefix) && table.starts_with(other.as_str()))
        };
        let owned = |table: &str| claimed(table, &own);
        // Le module complété, et lui seul : pas les tables d’un autre module dont le nom prolonge le sien
        // (« suivi-prive » pour « suivi-ajouts »).
        let readable = |table: &str| owned(table) || base.as_deref().is_some_and(|prefix| claimed(table, prefix));
        let catalog = |table: &str| {
            matches!(table, "sqlite_master" | "sqlite_schema" | "sqlite_temp_master" | "sqlite_temp_schema")
        };
        // Index de recherche d’une table du module : FTS5 lit et écrit ses tables internes par des requêtes
        // compilées sur cette connexion. Ils ne contiennent que les données du module.
        let own_index = |table: &str| table.strip_prefix("_alfred_fts_").is_some_and(|rest| owned(rest));
        let schema = scope == Scope::Schema;
        // Les déclencheurs posés par Alfred (index de recherche, historique) écrivent dans ses propres tables :
        // ils agissent pour Alfred, pas pour le module, qui ne peut ni en créer ni en supprimer (plus bas).
        if context.accessor.is_some_and(|trigger| trigger.starts_with(ALFRED_PREFIX)) {
            return Authorization::Allow;
        }
        let allowed = match context.action {
            AuthAction::Select | AuthAction::Recursive | AuthAction::Function { .. } => true,
            AuthAction::Transaction { .. } => !schema,
            AuthAction::Savepoint { .. } => true,
            // Le catalogue décrit les tables de tous les modules : seule une migration le lit.
            AuthAction::Read { table_name, .. } => {
                readable(table_name) || own_index(table_name) || (schema && catalog(table_name))
            }
            AuthAction::Insert { table_name } | AuthAction::Delete { table_name } => {
                owned(table_name) || own_index(table_name) || (schema && catalog(table_name))
            }
            AuthAction::Update { table_name, .. } => {
                owned(table_name) || own_index(table_name) || (schema && catalog(table_name))
            }
            AuthAction::CreateTable { table_name }
            | AuthAction::DropTable { table_name }
            | AuthAction::AlterTable { table_name, .. } => schema && owned(table_name),
            AuthAction::CreateIndex { table_name, .. } | AuthAction::DropIndex { table_name, .. } => {
                schema && owned(table_name)
            }
            // Un module ne crée pas de déclencheur au nom d’Alfred : il échapperait à ce contrôle. Il peut en
            // supprimer un avec sa table (une migration qui recrée la table) : Alfred le repose ensuite.
            AuthAction::CreateTrigger { trigger_name, table_name } => {
                schema && owned(table_name) && !trigger_name.starts_with(ALFRED_PREFIX)
            }
            AuthAction::DropTrigger { table_name, .. } => schema && owned(table_name),
            AuthAction::Reindex { .. } | AuthAction::Analyze { .. } => schema,
            // FTS5 lit ce compteur pour savoir si la base a changé ; il ne révèle rien d’un autre module.
            AuthAction::Pragma { pragma_name: "data_version", pragma_value: None } => true,
            // Pas de vue, de table virtuelle, de base attachée ni de PRAGMA : rien qui sorte du module.
            _ => false,
        };
        if allowed {
            Authorization::Allow
        } else {
            Authorization::Deny
        }
    }));
}

fn sql_error(error: rusqlite::Error, module: &str) -> AppError {
    let text = error.to_string();
    if text.contains("not authorized") || text.contains("authorization denied") || text.contains("is prohibited") {
        AppError::new(format!(
            "Requête refusée : le module « {module} » n’accède qu’à ses propres tables, dont le nom commence par « {} ». La structure se modifie par un fichier de migration, pas depuis une page.",
            table_prefix(module)
        ))
    } else {
        AppError::new(format!("Erreur SQL : {text}"))
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
        other => SqlValue::Text(other.to_string()),
    }
}

fn from_sql(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => json!(number),
        ValueRef::Real(number) => json!(number),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).to_string()),
        ValueRef::Blob(bytes) => Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
    }
}

fn bind(args: &Value) -> Vec<SqlValue> {
    args.get("params").and_then(Value::as_array).map(|values| values.iter().map(to_sql).collect()).unwrap_or_default()
}

/// Exécute une requête pour un module ; renvoie les lignes (lecture) ou le nombre de lignes touchées (écriture).
pub fn run(space: &Space, module: &str, sql: &str, parameters: &[SqlValue], write: bool) -> AppResult<Value> {
    if !valid_id(module) {
        return Err(AppError::new("Module inconnu."));
    }
    apply_pending_for(space, module)?;
    let db = open(space)?;
    restrict(&db, space, module, Scope::Data);
    let mut statement = db.prepare(sql).map_err(|error| sql_error(error, module))?;
    if statement.readonly() || statement.column_count() > 0 {
        if !statement.readonly() && !write {
            return Err(AppError::new("Cette requête modifie des données : utiliser `db.execute`."));
        }
        let names: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
        let mut rows = statement
            .query(rusqlite::params_from_iter(parameters.iter()))
            .map_err(|error| sql_error(error, module))?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(|error| sql_error(error, module))? {
            if result.len() >= MAX_ROWS {
                return Err(AppError::new(format!(
                    "La requête renvoie plus de {MAX_ROWS} lignes : ajouter un filtre ou une clause LIMIT."
                )));
            }
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                object.insert(name.clone(), from_sql(row.get_ref(index)?));
            }
            result.push(Value::Object(object));
        }
        return Ok(Value::Array(result));
    }
    if !write {
        return Err(AppError::new("Cette requête modifie des données : utiliser `db.execute`."));
    }
    let changes =
        statement.execute(rusqlite::params_from_iter(parameters.iter())).map_err(|error| sql_error(error, module))?;
    Ok(json!({ "changes": changes, "lastInsertId": db.last_insert_rowid() }))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProblem {
    pub module: String,
    pub file: String,
    pub message: String,
}

/// Applique, module par module, les migrations pas encore passées. Chaque fichier est une transaction : une erreur
/// l’annule en entier et arrête les migrations suivantes de ce module.
pub fn apply_migrations(space: &Space) -> AppResult<Vec<MigrationProblem>> {
    let mut problems = Vec::new();
    for module in space.module_ids() {
        apply_module_migrations(space, &module, &mut problems)?;
        // Les index de recherche suivent la structure : reconstruits si une migration a recréé leur table.
        if let Err(error) = crate::module_search::sync(space, &module, &mut problems) {
            problems.push(MigrationProblem { module: module.clone(), file: "module.json (search)".into(), message: error.message });
        }
    }
    Ok(problems)
}

/// Migrations en attente d’un module et, pour un module d’ajouts, du module qu’il complète : appliquées avant chaque
/// requête d’une page ou d’une fonction, pour qu’une table déclarée existe sans attendre un rafraîchissement de
/// l’interface ni un `check` de l’agent. Une migration en échec reste signalée par `check`.
fn apply_pending_for(space: &Space, module: &str) -> AppResult<()> {
    for target in std::iter::once(module).chain(module.strip_suffix("-ajouts")) {
        if space.module_dir(target).is_dir() && apply_module_migrations(space, target, &mut Vec::new())? {
            crate::module_search::sync(space, target, &mut Vec::new())?;
        }
    }
    Ok(())
}

/// Rend `true` si au moins une migration vient de passer.
fn apply_module_migrations(space: &Space, module: &str, problems: &mut Vec<MigrationProblem>) -> AppResult<bool> {
    let dir = space.module_dir(module).join("migrations");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(false) };
    let mut applied_any = false;
    let mut files: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    files.sort();
    for file in files {
        let db = open(space)?;
        let sql = match std::fs::read_to_string(dir.join(&file)) {
            Ok(sql) => sql,
            Err(error) => {
                problems.push(MigrationProblem { module: module.to_string(), file, message: error.to_string() });
                return Ok(applied_any);
            }
        };
        let digest = checksum(&sql);
        let applied: Option<Option<String>> = db
            .query_row(
                "SELECT checksum FROM _alfred_migrations WHERE module = ?1 AND name = ?2",
                params![module, file],
                |row| row.get(0),
            )
            .ok();
        match applied {
            // Appliquée avant que les empreintes existent : celle du fichier actuel est adoptée.
            Some(None) => {
                db.execute(
                    "UPDATE _alfred_migrations SET checksum = ?3 WHERE module = ?1 AND name = ?2",
                    params![module, file, digest],
                )?;
                continue;
            }
            Some(Some(recorded)) if recorded == digest => continue,
            // Réécrite après application (ou recréée sous le même nom après une annulation) : la base ne
            // correspond plus au fichier. Elle ne repasse jamais ; il faut une migration suivante.
            Some(Some(_)) => {
                problems.push(MigrationProblem {
                    module: module.to_string(),
                    file,
                    message: "Cette migration a déjà été appliquée avec un autre contenu : la base ne suit pas ce \
                              fichier. Remettre son contenu d’origine et écrire les changements dans une migration \
                              suivante (0002_…), ou lire la structure réelle avec db_schema."
                        .to_string(),
                });
                return Ok(applied_any);
            }
            None => crate::backups::before_migration(space, module, &file),
        }
        // La transaction est ouverte et close par Alfred : la migration ne peut pas la terminer elle-même (son
        // autoriseur refuse `BEGIN`/`COMMIT`), si bien qu’un refus l’annule toujours en entier.
        db.execute_batch("BEGIN;")?;
        restrict(&db, space, module, Scope::Schema);
        let result = db.execute_batch(&sql);
        db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let result = result.map_err(|error| sql_error(error, module)).and_then(|()| {
            foreign_references(&db, space, module)?;
            db.execute(
                "INSERT INTO _alfred_migrations (module, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
                params![module, file, crate::app_db::now(), digest],
            )?;
            Ok(())
        });
        match result {
            Ok(()) => {
                db.execute_batch("COMMIT;")?;
                applied_any = true;
            }
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK;");
                problems.push(MigrationProblem { module: module.to_string(), file, message: error.message });
                return Ok(applied_any);
            }
        }
    }
    Ok(applied_any)
}

/// Tables du module qui ne sont à aucun module plus précis (celles de « suivi-ajouts » ne sont pas à « suivi »).
pub(crate) fn owned_tables(db: &Connection, space: &Space, module: &str) -> AppResult<Vec<String>> {
    let own = table_prefix(module);
    let longer: Vec<String> =
        space.module_ids().iter().map(|id| table_prefix(id)).filter(|prefix| prefix.len() > own.len()).collect();
    let mut statement = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let tables: Vec<String> = statement.query_map([], |row| row.get(0))?.filter_map(Result::ok).collect();
    Ok(tables
        .into_iter()
        .filter(|table| {
            table.starts_with(&own) && !longer.iter().any(|other| other.starts_with(&own) && table.starts_with(other.as_str()))
        })
        .collect())
}

/// Refuse une clé étrangère vers la table d’un autre module : elle ferait échouer ses suppressions (l’autoriseur de
/// l’autre module refuse de lire la table qui la référence) ou les répercuterait dans des données qui ne sont pas
/// les siennes.
fn foreign_references(db: &Connection, space: &Space, module: &str) -> AppResult<()> {
    let owned = owned_tables(db, space, module)?;
    for table in &owned {
        let mut statement = db.prepare("SELECT \"table\" FROM pragma_foreign_key_list(?1)")?;
        let parents: Vec<String> = statement.query_map([table], |row| row.get(0))?.filter_map(Result::ok).collect();
        if let Some(parent) = parents.iter().find(|parent| !owned.iter().any(|own| own.eq_ignore_ascii_case(parent))) {
            return Err(AppError::new(format!(
                "Requête refusée : la table « {table} » référence « {parent} », qui n’appartient pas au module « {module} ». Une clé étrangère ne vise que les tables du module."
            )));
        }
    }
    Ok(())
}

/// Tables de l’espace et leurs colonnes, limitées à un module si demandé.
pub fn schema(space: &Space, module: Option<&str>) -> AppResult<Value> {
    let db = open(space)?;
    let mut statement = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_alfred\\_%' ESCAPE '\\' ORDER BY name",
    )?;
    let tables: Vec<(String, Option<String>)> =
        statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    let prefix = module.map(table_prefix);
    let mut result = Vec::new();
    for (name, sql) in tables {
        if prefix.as_deref().is_some_and(|prefix| !name.starts_with(prefix)) {
            continue;
        }
        let mut columns = db.prepare(&format!("PRAGMA table_info(\"{}\")", name.replace('"', "\"\"")))?;
        let columns: Vec<Value> = columns
            .query_map([], |row| {
                Ok(json!({
                    "name": row.get::<_, String>(1)?,
                    "type": row.get::<_, String>(2)?,
                    "notNull": row.get::<_, i64>(3)? != 0,
                    "primaryKey": row.get::<_, i64>(5)? != 0,
                }))
            })?
            .filter_map(Result::ok)
            .collect();
        let rows: i64 = db
            .query_row(&format!("SELECT count(*) FROM \"{}\"", name.replace('"', "\"\"")), [], |row| row.get(0))
            .unwrap_or_default();
        result.push(json!({ "table": name, "columns": columns, "rows": rows, "sql": sql }));
    }
    Ok(Value::Array(result))
}

/// Supprime les tables d’un module désinstallé, et l’historique de ses migrations.
pub fn drop_module(space: &Space, module: &str) -> AppResult<()> {
    let db = open(space)?;
    let prefix = table_prefix(module);
    let mut statement = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let tables: Vec<String> = statement.query_map([], |row| row.get(0))?.filter_map(Result::ok).collect();
    let longer: Vec<String> =
        space.module_ids().iter().filter(|id| id.as_str() != module).map(|id| table_prefix(id)).filter(|other| other.starts_with(&prefix)).collect();
    for table in tables
        .iter()
        .filter(|table| table.starts_with(&prefix) && !longer.iter().any(|other| table.starts_with(other.as_str())))
    {
        db.execute_batch(&format!("DROP TABLE IF EXISTS \"{}\";", table.replace('"', "\"\"")))?;
    }
    db.execute("DELETE FROM _alfred_migrations WHERE module = ?1", params![module])?;
    crate::module_search::drop_module(&db, module)?;
    // Ses fichiers partent avec ses tables ; les sauvegardes les gardent.
    let files = crate::backups::files_root(space).join(module);
    if valid_id(module) && files.is_dir() {
        std::fs::remove_dir_all(files)?;
    }
    Ok(())
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "frame.db.query" | "frame.db.execute" => (|| {
            let subject: Subject = arg(args, "subject")?;
            let sql: String = arg(args, "sql")?;
            run(&state.space()?, &subject.module, &sql, &bind(args), command == "frame.db.execute")
        })(),
        "db.schema" => (|| {
            let module: Option<String> = opt_arg(args, "module")?;
            schema(&state.space()?, module.as_deref())
        })(),
        "db.applyMigrations" => (|| Ok(serde_json::to_value(apply_migrations(&state.space()?)?)?))(),
        "db.dropModule" => (|| {
            let module: String = arg(args, "module")?;
            drop_module(&state.space()?, &module)?;
            Ok(Value::Null)
        })(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{PlaceTarget, Space};

    /// Une migration réécrite après application (cas d’un module recréé après une annulation) n’est plus ignorée
    /// en silence : `check` la signale, et elle redevient muette quand son contenu d’origine revient.
    #[test]
    fn a_migration_rewritten_after_it_ran_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        space.place_page("Liste", None, "", &PlaceTarget::Menu { label: "Notes".into(), icon: None, color: None }, None).unwrap();
        let migrations = space.module_dir("notes").join("migrations");
        std::fs::create_dir_all(&migrations).unwrap();
        let original = "CREATE TABLE notes_notes (id INTEGER PRIMARY KEY);\n";
        std::fs::write(migrations.join("0001_notes.sql"), original).unwrap();
        assert!(apply_migrations(&space).unwrap().is_empty());

        std::fs::write(migrations.join("0001_notes.sql"), "CREATE TABLE notes_notes (id INTEGER PRIMARY KEY AUTOINCREMENT);").unwrap();
        std::fs::write(migrations.join("0002_index.sql"), "CREATE INDEX notes_notes_id ON notes_notes (id);").unwrap();
        let problems = apply_migrations(&space).unwrap();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].file, "0001_notes.sql");
        assert!(problems[0].message.contains("autre contenu"), "{}", problems[0].message);

        // Contenu d’origine (fins de ligne Windows comprises) : plus de problème, et la suivante passe.
        std::fs::write(migrations.join("0001_notes.sql"), original.replace('\n', "\r\n")).unwrap();
        assert!(apply_migrations(&space).unwrap().is_empty());
        assert_eq!(schema(&space, Some("notes")).unwrap()[0]["table"], "notes_notes");
    }

    #[test]
    fn a_query_applies_the_module_migrations_still_pending() {
        // Migration écrite alors qu’Alfred était fermé : ni rafraîchissement de l’interface ni `check` ne l’a passée.
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        space
            .place_page("Liste", None, "", &PlaceTarget::Menu { label: "Suivi".into(), icon: None, color: None }, None)
            .unwrap();
        let migrations = space.module_dir("suivi").join("migrations");
        std::fs::create_dir_all(&migrations).unwrap();
        std::fs::write(migrations.join("0001_taches.sql"), "CREATE TABLE suivi_taches (id INTEGER PRIMARY KEY, titre TEXT);")
            .unwrap();

        let rows = run(&space, "suivi", "SELECT id, titre FROM suivi_taches", &[], false).unwrap();
        assert_eq!(rows, json!([]));
        let inserted =
            run(&space, "suivi", "INSERT INTO suivi_taches (titre) VALUES (?1)", &[SqlValue::Text("Une".into())], true)
                .unwrap();
        assert_eq!(inserted["changes"], 1);

        // Une migration ajoutée plus tard passe aussi avant la requête suivante, sans repasser la première.
        std::fs::write(migrations.join("0002_fait.sql"), "ALTER TABLE suivi_taches ADD COLUMN fait INTEGER NOT NULL DEFAULT 0;")
            .unwrap();
        let rows = run(&space, "suivi", "SELECT titre, fait FROM suivi_taches", &[], false).unwrap();
        assert_eq!(rows, json!([{ "titre": "Une", "fait": 0 }]));
        assert!(apply_migrations(&space).unwrap().is_empty());
    }

    #[test]
    fn a_module_owns_its_tables_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        for label in ["Suivi", "Notes"] {
            space
                .place_page("Liste", None, "", &PlaceTarget::Menu { label: label.into(), icon: None, color: None }, None)
                .unwrap();
        }
        let migrations = space.module_dir("suivi").join("migrations");
        std::fs::create_dir_all(&migrations).unwrap();
        std::fs::write(
            migrations.join("0001_taches.sql"),
            "CREATE TABLE suivi_taches (id INTEGER PRIMARY KEY, titre TEXT NOT NULL, fait INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX suivi_taches_fait ON suivi_taches (fait);",
        )
        .unwrap();
        // Une migration qui sort de son module est refusée en entier, sans rien laisser derrière elle.
        let other = space.module_dir("notes").join("migrations");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(
            other.join("0001_intrusion.sql"),
            "CREATE TABLE notes_pages (id INTEGER PRIMARY KEY); DROP TABLE suivi_taches;",
        )
        .unwrap();

        let problems = apply_migrations(&space).unwrap();
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert_eq!(problems[0].module, "notes");
        assert!(apply_migrations(&space).unwrap().len() == 1, "une migration appliquée ne repasse pas");

        let inserted = run(
            &space,
            "suivi",
            "INSERT INTO suivi_taches (titre) VALUES (?1)",
            &[SqlValue::Text("Écrire la base".into())],
            true,
        )
        .unwrap();
        assert_eq!(inserted["changes"], 1);
        let rows = run(&space, "suivi", "SELECT id, titre, fait FROM suivi_taches", &[], false).unwrap();
        assert_eq!(rows[0]["titre"], "Écrire la base");

        // Lecture seule par `query`, tables des autres modules invisibles, structure intouchable depuis une page.
        assert!(run(&space, "suivi", "DELETE FROM suivi_taches", &[], false).is_err());
        let foreign = run(&space, "notes", "SELECT * FROM suivi_taches", &[], false).unwrap_err();
        assert!(foreign.message.contains("notes_"), "{}", foreign.message);
        assert!(run(&space, "suivi", "DROP TABLE suivi_taches", &[], true).is_err());
        assert!(run(&space, "suivi", "ATTACH DATABASE '/tmp/x.db' AS x", &[], true).is_err());
        assert!(run(&space, "notes", "SELECT name, sql FROM sqlite_master", &[], false).is_err(), "schéma des autres");
        assert!(run(&space, "notes", "SELECT name FROM sqlite_schema", &[], false).is_err());

        // Un module dont le nom prolonge celui d’un autre garde ses tables pour lui.
        let extra = crate::space::ModuleManifest { id: "suivi-ajouts".into(), name: "Ajouts".into(), ..Default::default() };
        space.write_module(&extra).unwrap();
        let extras = space.module_dir("suivi-ajouts").join("migrations");
        std::fs::create_dir_all(&extras).unwrap();
        std::fs::write(extras.join("0001_notes.sql"), "CREATE TABLE suivi_ajouts_notes (id INTEGER PRIMARY KEY);").unwrap();
        assert_eq!(apply_migrations(&space).unwrap().len(), 1);
        assert!(run(&space, "suivi", "SELECT * FROM suivi_ajouts_notes", &[], false).is_err());
        assert!(run(&space, "suivi-ajouts", "SELECT * FROM suivi_taches", &[], false).is_ok(), "lecture du module complété");
        assert!(run(&space, "suivi-ajouts", "DELETE FROM suivi_taches", &[], true).is_err());
        // Le module complété, mais pas un autre module dont le nom commence comme lui.
        let private = crate::space::ModuleManifest { id: "suivi-prive".into(), name: "Privé".into(), ..Default::default() };
        space.write_module(&private).unwrap();
        let privates = space.module_dir("suivi-prive").join("migrations");
        std::fs::create_dir_all(&privates).unwrap();
        std::fs::write(privates.join("0001_salaires.sql"), "CREATE TABLE suivi_prive_salaires (id INTEGER PRIMARY KEY);").unwrap();
        assert_eq!(apply_migrations(&space).unwrap().len(), 1);
        assert!(run(&space, "suivi-ajouts", "SELECT * FROM suivi_prive_salaires", &[], false).is_err());
        assert!(run(&space, "suivi-prive", "SELECT * FROM suivi_prive_salaires", &[], false).is_ok());
        drop_module(&space, "suivi-prive").unwrap();
        drop_module(&space, "suivi-ajouts").unwrap();

        let tables = schema(&space, Some("suivi")).unwrap();
        assert_eq!(tables[0]["table"], "suivi_taches");
        assert_eq!(tables[0]["rows"], 1);
        assert_eq!(schema(&space, Some("notes")).unwrap().as_array().unwrap().len(), 0);

        drop_module(&space, "suivi").unwrap();
        assert!(schema(&space, None).unwrap().as_array().unwrap().is_empty());
    }

    /// Un module ne peut ni lier ses tables à celles d’un autre (ce qui bloquerait ses suppressions), ni clore
    /// lui-même la transaction de sa migration pour en garder une partie.
    #[test]
    fn a_migration_never_reaches_into_another_module() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let migrate = |module: &str, file: &str, sql: &str| {
            let manifest = crate::space::ModuleManifest { id: module.into(), name: module.into(), ..Default::default() };
            if !space.module_dir(module).exists() {
                space.write_module(&manifest).unwrap();
            }
            let migrations = space.module_dir(module).join("migrations");
            std::fs::create_dir_all(&migrations).unwrap();
            std::fs::write(migrations.join(file), sql).unwrap();
            apply_migrations(&space).unwrap()
        };
        assert!(migrate("notes", "0001.sql", "CREATE TABLE notes_n (id INTEGER PRIMARY KEY);").is_empty());
        run(&space, "notes", "INSERT INTO notes_n (id) VALUES (1)", &[], true).unwrap();

        let problems = migrate(
            "intrus",
            "0001.sql",
            "CREATE TABLE intrus_lien (id INTEGER PRIMARY KEY, n INTEGER REFERENCES notes_n (id) ON DELETE CASCADE);",
        );
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].message.contains("notes_n"), "{}", problems[0].message);
        assert!(schema(&space, Some("intrus")).unwrap().as_array().unwrap().is_empty(), "rien n’est resté");
        run(&space, "notes", "DELETE FROM notes_n WHERE id = 1", &[], true).unwrap();
        std::fs::remove_file(space.module_dir("intrus").join("migrations/0001.sql")).unwrap();

        let problems = migrate(
            "intrus",
            "0002.sql",
            "CREATE TABLE intrus_garde (id INTEGER PRIMARY KEY); COMMIT; CREATE TABLE notes_vol (id INTEGER);",
        );
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(schema(&space, Some("intrus")).unwrap().as_array().unwrap().is_empty(), "migration annulée en entier");

        // Une clé étrangère entre tables du même module reste permise.
        std::fs::remove_file(space.module_dir("intrus").join("migrations/0002.sql")).unwrap();
        let problems = migrate(
            "intrus",
            "0003.sql",
            "CREATE TABLE intrus_a (id INTEGER PRIMARY KEY); CREATE TABLE intrus_b (a INTEGER REFERENCES intrus_a (id));",
        );
        assert!(problems.is_empty(), "{problems:?}");
    }
}
