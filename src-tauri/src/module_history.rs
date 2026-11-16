//! Historique des données d’un module : pour chaque table que le module nomme dans `history` de son `module.json`,
//! Alfred garde chaque insertion, modification et suppression (la ligne avant et après, qui l’a faite, quand) et
//! sait remettre une ligne dans l’état d’avant un changement. Les déclencheurs et la table d’historique sont à
//! Alfred (`_alfred_`) : le module les lit par `history.list`, jamais en SQL.

use std::sync::Arc;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::Space;
use crate::space_db::{owned_tables, table_prefix, MigrationProblem};
use crate::state::AppState;

/// Changements gardés par table, et leur âge maximal.
const KEEP_ROWS: i64 = 10_000;
const KEEP_DAYS: i64 = 90;

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn ensure_tables(db: &Connection) -> AppResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_history (
           id INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL, tbl TEXT NOT NULL, row_key TEXT,
           op TEXT NOT NULL, before TEXT, after TEXT, actor TEXT NOT NULL, at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS _alfred_history_row ON _alfred_history (module, tbl, row_key, id);
         CREATE TABLE IF NOT EXISTS _alfred_history_tables (
           module TEXT NOT NULL, tbl TEXT NOT NULL, definition TEXT NOT NULL, PRIMARY KEY (module, tbl));",
    )?;
    Ok(())
}

fn trigger_names(table: &str) -> [String; 3] {
    ["ai", "au", "ad"].map(|suffix| format!("_alfred_hist_{table}_{suffix}"))
}

/// Colonnes d’une table et sa clé : la colonne de clé primaire si elle est seule, sinon `rowid`.
fn structure(db: &Connection, table: &str) -> AppResult<(Vec<String>, String)> {
    let mut statement = db.prepare("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid")?;
    let rows: Vec<(String, i64)> =
        statement.query_map([table], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    let keys: Vec<&String> = rows.iter().filter(|(_, pk)| *pk > 0).map(|(name, _)| name).collect();
    let key = if keys.len() == 1 { keys[0].clone() } else { "rowid".to_string() };
    Ok((rows.into_iter().map(|(name, _)| name).collect(), key))
}

/// `json_object(...)` d’une ligne (`new` ou `old`) ; un BLOB devient `{ "$blob": "<hex>" }`.
fn row_json(prefix: &str, columns: &[String]) -> String {
    let fields: Vec<String> = columns
        .iter()
        .map(|column| {
            let value = format!("{prefix}.{}", quoted(column));
            format!(
                "{}, CASE WHEN typeof({value}) = 'blob' THEN json_object('$blob', hex({value})) ELSE {value} END",
                literal(column)
            )
        })
        .collect();
    format!("json_object({})", fields.join(", "))
}

fn drop_table_history(db: &Connection, module: &str, table: &str) -> AppResult<()> {
    for name in trigger_names(table) {
        db.execute_batch(&format!("DROP TRIGGER IF EXISTS {};", quoted(&name)))?;
    }
    db.execute("DELETE FROM _alfred_history_tables WHERE module = ?1 AND tbl = ?2", params![module, table])?;
    Ok(())
}

fn create_triggers(db: &Connection, module: &str, table: &str, columns: &[String], key: &str) -> AppResult<()> {
    let [ai, au, ad] = trigger_names(table).map(|name| quoted(&name));
    let target = quoted(table);
    let (module, table_literal) = (literal(module), literal(table));
    let key_of = |prefix: &str| if key == "rowid" { format!("{prefix}.rowid") } else { format!("{prefix}.{}", quoted(key)) };
    let insert = |op: &str, row_key: String, before: &str, after: &str| {
        format!(
            "INSERT INTO _alfred_history (module, tbl, row_key, op, before, after, actor, at)
             VALUES ({module}, {table_literal}, CAST({row_key} AS TEXT), '{op}', {before}, {after}, alfred_actor(), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));"
        )
    };
    let (new_row, old_row) = (row_json("new", columns), row_json("old", columns));
    db.execute_batch(&format!(
        "CREATE TRIGGER {ai} AFTER INSERT ON {target} BEGIN {} END;
         CREATE TRIGGER {au} AFTER UPDATE ON {target} BEGIN {} END;
         CREATE TRIGGER {ad} AFTER DELETE ON {target} BEGIN {} END;",
        insert("insert", key_of("new"), "NULL", &new_row),
        insert("update", key_of("new"), &old_row, &new_row),
        insert("delete", key_of("old"), &old_row, "NULL"),
    ))?;
    Ok(())
}

fn intact(db: &Connection, table: &str) -> AppResult<bool> {
    let [ai, au, ad] = trigger_names(table);
    let count: i64 =
        db.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?1, ?2, ?3)", params![ai, au, ad], |row| row.get(0))?;
    Ok(count == 3)
}

/// Pose (ou repose) les déclencheurs des tables déclarées et retire ceux des tables qui ne le sont plus. Les
/// changements déjà gardés restent.
pub fn sync(space: &Space, module: &str, problems: &mut Vec<MigrationProblem>) -> AppResult<()> {
    let Ok(manifest) = space.module(module) else { return Ok(()) };
    let db = crate::space_db::open(space)?;
    ensure_tables(&db)?;
    let mut statement = db.prepare("SELECT tbl, definition FROM _alfred_history_tables WHERE module = ?1")?;
    let applied: Vec<(String, String)> =
        statement.query_map([module], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    drop(statement);
    for (table, _) in applied.iter().filter(|(table, _)| !manifest.history.contains(table)) {
        drop_table_history(&db, module, table)?;
    }
    let owned = owned_tables(&db, space, module)?;
    for table in &manifest.history {
        if !owned.contains(table) {
            problems.push(MigrationProblem {
                module: module.to_string(),
                file: format!("module.json (history « {table} »)"),
                message: format!(
                    "La table « {table} » n’existe pas dans le module (ses tables commencent par « {} »).",
                    table_prefix(module)
                ),
            });
            continue;
        }
        let (columns, key) = structure(&db, table)?;
        let definition = json!({ "columns": columns, "key": key }).to_string();
        let current = applied.iter().find(|(name, _)| name == table).map(|(_, definition)| definition.as_str());
        if current == Some(definition.as_str()) && intact(&db, table)? {
            continue;
        }
        db.execute_batch("BEGIN;")?;
        let result = drop_table_history(&db, module, table)
            .and_then(|()| create_triggers(&db, module, table, &columns, &key))
            .and_then(|()| {
                db.execute(
                    "INSERT INTO _alfred_history_tables (module, tbl, definition) VALUES (?1, ?2, ?3)",
                    params![module, table, definition],
                )?;
                Ok(())
            });
        match result {
            Ok(()) => db.execute_batch("COMMIT;")?,
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK;");
                problems.push(MigrationProblem {
                    module: module.to_string(),
                    file: format!("module.json (history « {table} »)"),
                    message: error.message,
                });
            }
        }
    }
    Ok(())
}

/// Retire les déclencheurs et l’historique d’un module désinstallé.
pub fn drop_module(db: &Connection, module: &str) -> AppResult<()> {
    ensure_tables(db)?;
    let mut statement = db.prepare("SELECT tbl FROM _alfred_history_tables WHERE module = ?1")?;
    let tables: Vec<String> = statement.query_map([module], |row| row.get(0))?.filter_map(Result::ok).collect();
    drop(statement);
    for table in tables {
        drop_table_history(db, module, &table)?;
    }
    db.execute("DELETE FROM _alfred_history WHERE module = ?1", [module])?;
    Ok(())
}

fn prune(db: &Connection, module: &str) -> AppResult<()> {
    db.execute(
        &format!("DELETE FROM _alfred_history WHERE module = ?1 AND at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-{KEEP_DAYS} days')"),
        [module],
    )?;
    db.execute(
        "DELETE FROM _alfred_history WHERE module = ?1 AND id IN (
           SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY tbl ORDER BY id DESC) AS rang
                           FROM _alfred_history WHERE module = ?1) WHERE rang > ?2)",
        params![module, KEEP_ROWS],
    )?;
    Ok(())
}

fn change(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let parse = |text: Option<String>| text.and_then(|text| serde_json::from_str::<Value>(&text).ok()).unwrap_or(Value::Null);
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "table": row.get::<_, String>(1)?,
        "key": row.get::<_, Option<String>>(2)?,
        "op": row.get::<_, String>(3)?,
        "before": parse(row.get(4)?),
        "after": parse(row.get(5)?),
        "actor": row.get::<_, String>(6)?,
        "at": row.get::<_, String>(7)?,
    }))
}

/// Changements d’une table (et d’une ligne si `key` est donné), les plus récents d’abord.
pub fn list(space: &Space, module: &str, table: Option<&str>, key: Option<&str>, limit: usize) -> AppResult<Vec<Value>> {
    let mut problems = Vec::new();
    sync(space, module, &mut problems)?;
    let db = crate::space_db::open(space)?;
    ensure_tables(&db)?;
    prune(&db, module)?;
    let mut statement = db.prepare(
        "SELECT id, tbl, row_key, op, before, after, actor, at FROM _alfred_history
         WHERE module = ?1 AND (?2 IS NULL OR tbl = ?2) AND (?3 IS NULL OR row_key = ?3)
         ORDER BY id DESC LIMIT ?4",
    )?;
    let rows = statement.query_map(params![module, table, key, limit as i64], change)?.filter_map(Result::ok).collect();
    Ok(rows)
}

fn to_sql(value: &Value) -> AppResult<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => {
            number.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(number.as_f64().unwrap_or_default()))
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(object) if object.len() == 1 && object.contains_key("$blob") => {
            let hex = object["$blob"].as_str().unwrap_or_default();
            let bytes: Option<Vec<u8>> = (0..hex.len())
                .step_by(2)
                .map(|index| hex.get(index..index + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()))
                .collect();
            SqlValue::Blob(bytes.ok_or_else(|| AppError::new("Valeur binaire illisible dans l’historique."))?)
        }
        other => SqlValue::Text(other.to_string()),
    })
}

/// Remet la ligne d’un changement dans l’état d’avant ce changement : une insertion est retirée, une modification
/// annulée (toute la ligne revient), une suppression rétablie. La remise est elle-même un changement, qu’on peut
/// annuler à son tour.
pub fn revert(space: &Space, module: &str, id: i64, actor: &str) -> AppResult<Value> {
    let db = crate::space_db::open(space)?;
    ensure_tables(&db)?;
    let found = db
        .query_row(
            "SELECT id, tbl, row_key, op, before, after, actor, at FROM _alfred_history WHERE id = ?1 AND module = ?2",
            params![id, module],
            change,
        )
        .optional()?
        .ok_or_else(|| AppError::new("Ce changement n’existe pas dans l’historique du module."))?;
    drop(db);
    let table = found["table"].as_str().unwrap_or_default().to_string();
    let db = crate::space_db::open(space)?;
    let (columns, key) = structure(&db, &table)?;
    drop(db);
    let key_value = found["key"].clone();
    let where_key = if key == "rowid" { "rowid = ?1".to_string() } else { format!("{} = ?1", quoted(&key)) };
    let key_param = match (&key_value, key.as_str()) {
        (Value::String(text), "rowid") => SqlValue::Integer(text.parse().unwrap_or_default()),
        (Value::String(text), _) => {
            // La clé est gardée en texte : on retrouve son type dans l’état de la ligne.
            let typed = found["after"].get(&key).or_else(|| found["before"].get(&key)).cloned().unwrap_or(Value::String(text.clone()));
            to_sql(&typed)?
        }
        _ => SqlValue::Null,
    };
    let assignments = |row: &Map<String, Value>| -> AppResult<(Vec<String>, Vec<SqlValue>)> {
        let mut names = Vec::new();
        let mut values = Vec::new();
        for column in columns.iter().filter(|column| row.contains_key(*column)) {
            names.push(column.clone());
            values.push(to_sql(&row[column])?);
        }
        Ok((names, values))
    };
    let run = |sql: &str, values: Vec<SqlValue>| crate::space_db::run_as(space, module, actor, sql, &values, true);
    let target = quoted(&table);
    match found["op"].as_str() {
        Some("insert") => {
            run(&format!("DELETE FROM {target} WHERE {where_key}"), vec![key_param])?;
        }
        Some("update" | "delete") => {
            let before = found["before"].as_object().cloned().unwrap_or_default();
            let (names, mut values) = assignments(&before)?;
            if names.is_empty() {
                return Err(AppError::new("L’état d’avant ce changement est vide : rien à remettre."));
            }
            let exists = crate::space_db::run_as(
                space,
                module,
                actor,
                &format!("SELECT count(*) AS n FROM {target} WHERE {where_key}"),
                std::slice::from_ref(&key_param),
                false,
            )?[0]["n"]
                .as_i64()
                .unwrap_or_default()
                > 0;
            if exists {
                let set: Vec<String> = names.iter().enumerate().map(|(index, name)| format!("{} = ?{}", quoted(name), index + 2)).collect();
                let mut parameters = vec![key_param];
                parameters.append(&mut values);
                run(&format!("UPDATE {target} SET {} WHERE {where_key}", set.join(", ")), parameters)?;
            } else {
                let placeholders: Vec<String> = (1..=names.len()).map(|index| format!("?{index}")).collect();
                run(
                    &format!(
                        "INSERT INTO {target} ({}) VALUES ({})",
                        names.iter().map(|name| quoted(name)).collect::<Vec<_>>().join(", "),
                        placeholders.join(", ")
                    ),
                    values,
                )?;
            }
        }
        _ => return Err(AppError::new("Changement inconnu.")),
    }
    Ok(found)
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    let result = match command {
        "frame.history.list" => (|| {
            let subject: Subject = arg(args, "subject")?;
            let table: Option<String> = opt_arg(args, "table")?;
            let key = args.get("key").filter(|key| !key.is_null()).map(|key| match key {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            });
            let limit: Option<usize> = opt_arg(args, "limit")?;
            Ok(Value::Array(list(&state.space()?, &subject.module, table.as_deref(), key.as_deref(), limit.unwrap_or(100).min(1000))?))
        })(),
        "frame.history.revert" => (|| {
            let subject: Subject = arg(args, "subject")?;
            let id: i64 = arg(args, "id")?;
            revert(&state.space()?, &subject.module, id, &format!("{} (annulation)", subject.key()))
        })(),
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::ModuleManifest;
    use crate::space_db::{apply_migrations, run, run_as};

    fn setup(sql: &str, history: &[&str]) -> (tempfile::TempDir, Space) {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let manifest = ModuleManifest {
            id: "crm".into(),
            name: "CRM".into(),
            history: history.iter().map(|table| table.to_string()).collect(),
            ..Default::default()
        };
        space.write_module(&manifest).unwrap();
        let migrations = space.module_dir("crm").join("migrations");
        std::fs::create_dir_all(&migrations).unwrap();
        std::fs::write(migrations.join("0001.sql"), sql).unwrap();
        let problems = apply_migrations(&space).unwrap();
        assert!(problems.is_empty(), "{problems:?}");
        (dir, space)
    }

    #[test]
    fn every_change_is_kept_with_its_author_and_can_be_reverted() {
        let (_dir, space) = setup(
            "CREATE TABLE crm_contacts (id INTEGER PRIMARY KEY, nom TEXT NOT NULL, photo BLOB); CREATE TABLE crm_brouillons (id INTEGER PRIMARY KEY);",
            &["crm_contacts"],
        );
        run_as(&space, "crm", "page:crm/liste", "INSERT INTO crm_contacts (nom, photo) VALUES ('Alice', x'01ff')", &[], true).unwrap();
        run_as(&space, "crm", "function:crm/import", "UPDATE crm_contacts SET nom = 'Alicia' WHERE id = 1", &[], true).unwrap();
        run(&space, "crm", "INSERT INTO crm_brouillons (id) VALUES (1)", &[], true).unwrap();

        let changes = list(&space, "crm", Some("crm_contacts"), Some("1"), 10).unwrap();
        assert_eq!(changes.len(), 2, "{changes:?}");
        assert_eq!(changes[0]["op"], "update");
        assert_eq!(changes[0]["actor"], "function:crm/import");
        assert_eq!(changes[0]["before"]["nom"], "Alice");
        assert_eq!(changes[0]["after"]["nom"], "Alicia");
        assert_eq!(changes[1]["after"]["photo"], json!({ "$blob": "01FF" }));
        assert_eq!(changes[1]["actor"], "page:crm/liste");
        assert!(list(&space, "crm", Some("crm_brouillons"), None, 10).unwrap().is_empty(), "table non déclarée");

        // Annuler la modification, puis supprimer et rétablir la ligne, BLOB compris.
        revert(&space, "crm", changes[0]["id"].as_i64().unwrap(), "page:crm/liste (annulation)").unwrap();
        assert_eq!(run(&space, "crm", "SELECT nom FROM crm_contacts", &[], false).unwrap(), json!([{ "nom": "Alice" }]));
        run(&space, "crm", "DELETE FROM crm_contacts WHERE id = 1", &[], true).unwrap();
        let deleted = list(&space, "crm", None, None, 1).unwrap();
        assert_eq!(deleted[0]["op"], "delete");
        revert(&space, "crm", deleted[0]["id"].as_i64().unwrap(), "agent").unwrap();
        assert_eq!(
            run(&space, "crm", "SELECT id, nom, hex(photo) AS photo FROM crm_contacts", &[], false).unwrap(),
            json!([{ "id": 1, "nom": "Alice", "photo": "01FF" }])
        );
        // Annuler une insertion retire la ligne ; chaque remise est elle-même dans l’historique.
        revert(&space, "crm", changes[1]["id"].as_i64().unwrap(), "agent").unwrap();
        assert_eq!(run(&space, "crm", "SELECT count(*) AS n FROM crm_contacts", &[], false).unwrap(), json!([{ "n": 0 }]));
        assert_eq!(list(&space, "crm", None, None, 100).unwrap().len(), 6);

        // Un autre module ne lit ni n’annule cet historique, et ne lit pas sa table.
        assert!(list(&space, "autre", None, None, 10).unwrap().is_empty());
        assert!(revert(&space, "autre", changes[0]["id"].as_i64().unwrap(), "x").is_err());
        assert!(run(&space, "crm", "SELECT * FROM _alfred_history", &[], false).is_err());
    }

    #[test]
    fn history_follows_a_table_rebuilt_by_a_migration_and_text_keys() {
        let (_dir, space) = setup("CREATE TABLE crm_villes (code TEXT PRIMARY KEY, nom TEXT);", &["crm_villes"]);
        run(&space, "crm", "INSERT INTO crm_villes VALUES ('69', 'Lyon')", &[], true).unwrap();
        std::fs::write(
            space.module_dir("crm").join("migrations/0002.sql"),
            "ALTER TABLE crm_villes ADD COLUMN region TEXT;",
        )
        .unwrap();
        assert!(apply_migrations(&space).unwrap().is_empty());
        run(&space, "crm", "UPDATE crm_villes SET region = 'ARA' WHERE code = '69'", &[], true).unwrap();
        let changes = list(&space, "crm", Some("crm_villes"), Some("69"), 10).unwrap();
        assert_eq!(changes[0]["after"]["region"], "ARA", "la nouvelle colonne est suivie : {changes:?}");
        revert(&space, "crm", changes[0]["id"].as_i64().unwrap(), "agent").unwrap();
        assert_eq!(run(&space, "crm", "SELECT region FROM crm_villes", &[], false).unwrap(), json!([{ "region": null }]));
    }
}
