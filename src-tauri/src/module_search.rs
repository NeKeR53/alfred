//! Recherche plein texte (SQLite FTS5) dans les données d’un module. Le module déclare ses index dans
//! `module.json` (`search`) ; Alfred crée la table FTS5, à contenu externe, et les déclencheurs qui la tiennent à
//! jour à chaque écriture, puis la reconstruit quand la déclaration ou la table change. Les tables et déclencheurs
//! d’index portent le préfixe `_alfred_` : le module ne peut ni les lire, ni les modifier, ni les imiter.

use std::sync::Arc;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, IndexDecl, Space};
use crate::space_db::{owned_tables, table_prefix, MigrationProblem};
use crate::state::AppState;

const MAX_RESULTS: usize = 200;
/// Repères d’un passage trouvé dans l’extrait, retirés avant de rendre le texte.
const MARK_START: char = '\u{e000}';
const MARK_END: char = '\u{e001}';

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Nom de la table FTS5 d’un index.
pub fn fts_table(module: &str, index: &str) -> String {
    format!("_alfred_fts_{}{}", table_prefix(module), index.replace('-', "_"))
}

fn ensure_registry(db: &Connection) -> AppResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_search (
           module TEXT NOT NULL, id TEXT NOT NULL, definition TEXT NOT NULL, PRIMARY KEY (module, id));",
    )?;
    Ok(())
}

fn columns_of(db: &Connection, table: &str) -> AppResult<Vec<String>> {
    let mut statement = db.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let columns = statement.query_map([table], |row| row.get(0))?.filter_map(Result::ok).collect();
    Ok(columns)
}

/// Vérifie une déclaration contre la structure réelle.
fn validate(db: &Connection, space: &Space, module: &str, index: &IndexDecl) -> Result<(), String> {
    if !valid_id(&index.id) {
        return Err(format!("Identifiant d’index invalide : « {} ».", index.id));
    }
    if !owned_tables(db, space, module).map_err(|error| error.message)?.contains(&index.table) {
        return Err(format!(
            "La table « {} » n’existe pas dans le module (ses tables commencent par « {} »).",
            index.table,
            table_prefix(module)
        ));
    }
    let without_rowid = db
        .query_row("SELECT sql FROM sqlite_master WHERE name = ?1", [&index.table], |row| row.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .is_some_and(|sql| sql.to_ascii_uppercase().contains("WITHOUT ROWID"));
    if without_rowid {
        return Err(format!("La table « {} » est WITHOUT ROWID : elle ne peut pas être indexée.", index.table));
    }
    let existing = columns_of(db, &index.table).map_err(|error| error.message)?;
    if index.columns.is_empty() {
        return Err("Un index de recherche nomme au moins une colonne (`columns`).".into());
    }
    for column in index.columns.iter().chain(std::iter::once(&index.key().to_string())) {
        if !existing.contains(column) {
            return Err(format!("La colonne « {column} » n’existe pas dans « {} ».", index.table));
        }
    }
    Ok(())
}

fn drop_index(db: &Connection, module: &str, id: &str) -> AppResult<()> {
    let table = fts_table(module, id);
    for suffix in ["ai", "ad", "au"] {
        db.execute_batch(&format!("DROP TRIGGER IF EXISTS {};", quoted(&format!("{table}_{suffix}"))))?;
    }
    db.execute_batch(&format!("DROP TABLE IF EXISTS {};", quoted(&table)))?;
    db.execute("DELETE FROM _alfred_search WHERE module = ?1 AND id = ?2", params![module, id])?;
    Ok(())
}

/// Crée la table FTS5 et ses déclencheurs, puis l’alimente avec les lignes existantes.
fn create_index(db: &Connection, module: &str, index: &IndexDecl) -> AppResult<()> {
    let table = fts_table(module, &index.id);
    let content = quoted(&index.table);
    let columns: Vec<String> = index.columns.iter().map(|column| quoted(column)).collect();
    let list = columns.join(", ");
    let new_values = index.columns.iter().map(|column| format!("new.{}", quoted(column))).collect::<Vec<_>>().join(", ");
    let old_values = index.columns.iter().map(|column| format!("old.{}", quoted(column))).collect::<Vec<_>>().join(", ");
    let fts = quoted(&table);
    db.execute_batch(&format!(
        "CREATE VIRTUAL TABLE {fts} USING fts5({list}, content={content}, content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
         CREATE TRIGGER {ai} AFTER INSERT ON {content} BEGIN
           INSERT INTO {fts} (rowid, {list}) VALUES (new.rowid, {new_values});
         END;
         CREATE TRIGGER {ad} AFTER DELETE ON {content} BEGIN
           INSERT INTO {fts} ({fts}, rowid, {list}) VALUES ('delete', old.rowid, {old_values});
         END;
         CREATE TRIGGER {au} AFTER UPDATE ON {content} BEGIN
           INSERT INTO {fts} ({fts}, rowid, {list}) VALUES ('delete', old.rowid, {old_values});
           INSERT INTO {fts} (rowid, {list}) VALUES (new.rowid, {new_values});
         END;
         INSERT INTO {fts} ({fts}) VALUES ('rebuild');",
        ai = quoted(&format!("{table}_ai")),
        ad = quoted(&format!("{table}_ad")),
        au = quoted(&format!("{table}_au")),
    ))?;
    Ok(())
}

/// L’index existe-t-il en entier (table et trois déclencheurs) ? Une migration qui recrée la table, ou une
/// restauration, emporte les déclencheurs.
fn intact(db: &Connection, module: &str, id: &str) -> AppResult<bool> {
    let table = fts_table(module, id);
    let count: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name IN (?1, ?2, ?3, ?4)",
        params![table, format!("{table}_ai"), format!("{table}_ad"), format!("{table}_au")],
        |row| row.get(0),
    )?;
    Ok(count == 4)
}

/// Met les index d’un module en accord avec sa déclaration : crée, reconstruit ou supprime.
pub fn sync(space: &Space, module: &str, problems: &mut Vec<MigrationProblem>) -> AppResult<()> {
    let Ok(manifest) = space.module(module) else { return Ok(()) };
    let db = crate::space_db::open(space)?;
    ensure_registry(&db)?;
    let mut statement = db.prepare("SELECT id, definition FROM _alfred_search WHERE module = ?1")?;
    let applied: Vec<(String, String)> =
        statement.query_map([module], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    drop(statement);
    for (id, _) in applied.iter().filter(|(id, _)| !manifest.search.iter().any(|index| &index.id == id)) {
        drop_index(&db, module, id)?;
    }
    for index in &manifest.search {
        let definition = serde_json::to_string(index)?;
        let current = applied.iter().find(|(id, _)| id == &index.id).map(|(_, definition)| definition.as_str());
        if current == Some(definition.as_str()) && intact(&db, module, &index.id)? {
            continue;
        }
        if let Err(message) = validate(&db, space, module, index) {
            problems.push(MigrationProblem {
                module: module.to_string(),
                file: format!("module.json (search « {} »)", index.id),
                message,
            });
            drop_index(&db, module, &index.id)?;
            continue;
        }
        db.execute_batch("BEGIN;")?;
        let result = drop_index(&db, module, &index.id).and_then(|()| create_index(&db, module, index)).and_then(|()| {
            db.execute(
                "INSERT INTO _alfred_search (module, id, definition) VALUES (?1, ?2, ?3)",
                params![module, index.id, definition],
            )?;
            Ok(())
        });
        match result {
            Ok(()) => db.execute_batch("COMMIT;")?,
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK;");
                problems.push(MigrationProblem {
                    module: module.to_string(),
                    file: format!("module.json (search « {} »)", index.id),
                    message: error.message,
                });
            }
        }
    }
    Ok(())
}

/// Supprime tous les index d’un module (désinstallation).
pub fn drop_module(db: &Connection, module: &str) -> AppResult<()> {
    ensure_registry(db)?;
    let mut statement = db.prepare("SELECT id FROM _alfred_search WHERE module = ?1")?;
    let ids: Vec<String> = statement.query_map([module], |row| row.get(0))?.filter_map(Result::ok).collect();
    drop(statement);
    for id in ids {
        drop_index(db, module, &id)?;
    }
    Ok(())
}

/// Requête FTS5 tirée d’un texte libre : chaque mot doit apparaître ; avec `prefix`, chacun peut n’être qu’un
/// début de mot (recherche pendant la frappe).
pub fn free_text_query(text: &str, prefix: bool) -> String {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| if prefix { format!("\"{word}\"*") } else { format!("\"{word}\"") })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Découpe un extrait en morceaux, en marquant les passages trouvés.
fn snippet_parts(snippet: &str) -> (String, Vec<Value>) {
    let mut parts = Vec::new();
    let mut plain = String::new();
    let mut current = String::new();
    let mut matched = false;
    for c in snippet.chars() {
        if c == MARK_START || c == MARK_END {
            if !current.is_empty() {
                parts.push(json!({ "text": current, "match": matched }));
                current = String::new();
            }
            matched = c == MARK_START;
        } else {
            current.push(c);
            plain.push(c);
        }
    }
    if !current.is_empty() {
        parts.push(json!({ "text": current, "match": matched }));
    }
    (plain, parts)
}

pub struct Query<'a> {
    pub index: &'a str,
    pub text: &'a str,
    pub limit: usize,
    pub offset: usize,
    /// Le texte est une requête FTS5 complète (opérateurs, guillemets, NEAR) au lieu de mots libres.
    pub raw: bool,
    pub prefix: bool,
}

pub fn query(space: &Space, module: &str, request: &Query<'_>) -> AppResult<Value> {
    let mut problems = Vec::new();
    sync(space, module, &mut problems)?;
    let manifest = space.module(module)?;
    let Some(index) = manifest.search.iter().find(|index| index.id == request.index) else {
        return Err(AppError::new(format!(
            "L’index de recherche « {} » n’est pas déclaré dans `search` du module.",
            request.index
        )));
    };
    if let Some(problem) = problems.iter().find(|problem| problem.file.contains(&format!("« {} »", index.id))) {
        return Err(AppError::new(format!("Index de recherche inutilisable : {}", problem.message)));
    }
    let expression = if request.raw { request.text.trim().to_string() } else { free_text_query(request.text, request.prefix) };
    if expression.is_empty() {
        return Ok(json!({ "total": 0, "results": [] }));
    }
    let db = crate::space_db::open(space)?;
    let fts = quoted(&fts_table(module, &index.id));
    let syntax = |error: rusqlite::Error| {
        let text = error.to_string();
        if text.contains("fts5") || text.contains("syntax") || text.contains("unterminated") || text.contains("no such column") {
            AppError::new(format!("Recherche mal formée : {text}"))
        } else {
            AppError::from(error)
        }
    };
    let total: i64 = db
        .query_row(&format!("SELECT count(*) FROM {fts} WHERE {fts} MATCH ?1"), [&expression], |row| row.get(0))
        .map_err(syntax)?;
    let sql = format!(
        "SELECT t.{key}, bm25({fts}), snippet({fts}, -1, ?2, ?3, '…', 16)
         FROM {fts} JOIN {table} AS t ON t.rowid = {fts}.rowid
         WHERE {fts} MATCH ?1 ORDER BY bm25({fts}) LIMIT ?4 OFFSET ?5",
        key = quoted(index.key()),
        table = quoted(&index.table),
    );
    let mut statement = db.prepare(&sql).map_err(syntax)?;
    let rows = statement
        .query_map(
            params![
                expression,
                MARK_START.to_string(),
                MARK_END.to_string(),
                request.limit.min(MAX_RESULTS) as i64,
                request.offset as i64
            ],
            |row| {
                let key = match row.get_ref(0)? {
                    rusqlite::types::ValueRef::Integer(number) => json!(number),
                    rusqlite::types::ValueRef::Real(number) => json!(number),
                    rusqlite::types::ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
                    _ => Value::Null,
                };
                let rank: f64 = row.get(1)?;
                let snippet: Option<String> = row.get(2)?;
                Ok((key, rank, snippet.unwrap_or_default()))
            },
        )
        .map_err(syntax)?;
    let mut results = Vec::new();
    for row in rows {
        let (key, rank, snippet) = row.map_err(syntax)?;
        let (plain, parts) = snippet_parts(&snippet);
        // bm25 est négatif et plus petit pour un meilleur résultat : le score rendu est positif, plus grand = mieux.
        results.push(json!({ "key": key, "score": -rank, "snippet": plain, "parts": parts }));
    }
    Ok(json!({ "total": total, "results": results }))
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if command != "frame.search.query" {
        return None;
    }
    Some((|| {
        let subject: Subject = arg(args, "subject")?;
        let index: String = arg(args, "index")?;
        let text: String = arg(args, "text")?;
        query(
            &state.space()?,
            &subject.module,
            &Query {
                index: &index,
                text: &text,
                limit: opt_arg::<usize>(args, "limit")?.unwrap_or(20),
                offset: opt_arg::<usize>(args, "offset")?.unwrap_or(0),
                raw: opt_arg::<bool>(args, "raw")?.unwrap_or(false),
                prefix: opt_arg::<bool>(args, "prefix")?.unwrap_or(true),
            },
        )
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::ModuleManifest;
    use crate::space_db::{apply_migrations, run};
    use rusqlite::types::Value as SqlValue;

    fn setup() -> (tempfile::TempDir, Space) {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let manifest = ModuleManifest {
            id: "notes".into(),
            name: "Notes".into(),
            search: vec![IndexDecl {
                id: "texte".into(),
                table: "notes_n".into(),
                key: "uid".into(),
                columns: vec!["titre".into(), "corps".into()],
            }],
            ..Default::default()
        };
        space.write_module(&manifest).unwrap();
        let migrations = space.module_dir("notes").join("migrations");
        std::fs::create_dir_all(&migrations).unwrap();
        std::fs::write(migrations.join("0001.sql"), "CREATE TABLE notes_n (uid TEXT PRIMARY KEY, titre TEXT, corps TEXT);").unwrap();
        (dir, space)
    }

    fn insert(space: &Space, uid: &str, titre: &str, corps: &str) {
        let values = [SqlValue::Text(uid.into()), SqlValue::Text(titre.into()), SqlValue::Text(corps.into())];
        run(space, "notes", "INSERT INTO notes_n (uid, titre, corps) VALUES (?1, ?2, ?3)", &values, true).unwrap();
    }

    fn search(space: &Space, text: &str) -> Value {
        query(space, "notes", &Query { index: "texte", text, limit: 10, offset: 0, raw: false, prefix: true }).unwrap()
    }

    #[test]
    fn rows_are_found_by_words_without_accents_and_ranked() {
        let (_dir, space) = setup();
        insert(&space, "a", "Réunion d’équipe", "Préparer le budget de l’été.");
        assert!(apply_migrations(&space).unwrap().is_empty());
        insert(&space, "b", "Budget", "Budget, budget et encore le budget.");
        insert(&space, "c", "Vacances", "Rien à voir.");

        let found = search(&space, "budget");
        assert_eq!(found["total"], 2);
        assert_eq!(found["results"][0]["key"], "b", "le plus pertinent d’abord : {found}");
        // Sans accents, début de mot, mots dans le désordre.
        assert_eq!(search(&space, "reunion")["results"][0]["key"], "a");
        assert_eq!(search(&space, "ete prep")["results"][0]["key"], "a");
        let parts = &search(&space, "été")["results"][0]["parts"];
        assert!(parts.as_array().unwrap().iter().any(|part| part["match"] == true && part["text"] == "été"), "{parts}");

        // Écritures suivies : modification et suppression.
        run(&space, "notes", "UPDATE notes_n SET corps = 'Plus de budget' WHERE uid = 'a'", &[], true).unwrap();
        assert_eq!(search(&space, "reunion")["total"], 1);
        assert_eq!(search(&space, "été")["total"], 0);
        run(&space, "notes", "DELETE FROM notes_n WHERE uid = 'b'", &[], true).unwrap();
        assert_eq!(search(&space, "budget")["total"], 1);

        // Ponctuation libre sans erreur ; syntaxe FTS5 seulement en mode brut, avec un message clair.
        assert_eq!(search(&space, "d'équipe \"(")["total"], 1);
        let raw = query(&space, "notes", &Query { index: "texte", text: "titre: \"(", limit: 5, offset: 0, raw: true, prefix: false });
        let message = raw.unwrap_err().message;
        assert!(message.contains("Recherche mal formée"), "{message}");
        assert!(query(&space, "notes", &Query { index: "autre", text: "x", limit: 5, offset: 0, raw: false, prefix: true }).is_err());
    }

    #[test]
    fn the_index_follows_migrations_that_rebuild_the_table() {
        let (_dir, space) = setup();
        assert!(apply_migrations(&space).unwrap().is_empty());
        insert(&space, "a", "Facture", "Électricité");
        std::fs::write(
            space.module_dir("notes").join("migrations/0002.sql"),
            "CREATE TABLE notes_tmp (uid TEXT PRIMARY KEY, titre TEXT, corps TEXT, ajout TEXT);
             INSERT INTO notes_tmp (uid, titre, corps) SELECT uid, titre, corps FROM notes_n;
             DROP TABLE notes_n; ALTER TABLE notes_tmp RENAME TO notes_n;",
        )
        .unwrap();
        let problems = apply_migrations(&space).unwrap();
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(search(&space, "electricite")["total"], 1);
        insert(&space, "b", "Facture", "Gaz");
        assert_eq!(search(&space, "facture")["total"], 2);
    }

    #[test]
    fn a_module_cannot_reach_or_forge_alfred_tables() {
        let (_dir, space) = setup();
        assert!(apply_migrations(&space).unwrap().is_empty());
        let fts = fts_table("notes", "texte");
        // Le module lit son propre index ; un autre module ne le lit ni ne l’efface.
        assert!(run(&space, "notes", &format!("SELECT * FROM {fts}"), &[], false).is_ok());
        assert!(run(&space, "suivi", &format!("SELECT * FROM {fts}"), &[], false).is_err());
        assert!(run(&space, "suivi", &format!("DELETE FROM {fts}"), &[], true).is_err());
        assert!(run(&space, "notes", "DROP TABLE _alfred_search", &[], true).is_err());
        // Un déclencheur qui se ferait passer pour un déclencheur d’Alfred est refusé.
        std::fs::write(
            space.module_dir("notes").join("migrations/0002.sql"),
            "CREATE TABLE notes_x (id INTEGER PRIMARY KEY);
             CREATE TRIGGER _alfred_pirate AFTER INSERT ON notes_x BEGIN DELETE FROM _alfred_jobs; END;",
        )
        .unwrap();
        let problems = apply_migrations(&space).unwrap();
        assert_eq!(problems.len(), 1, "{problems:?}");
    }

    #[test]
    fn a_wrong_declaration_is_reported_by_check() {
        let (_dir, space) = setup();
        let mut manifest = space.module("notes").unwrap();
        manifest.search[0].columns.push("absente".into());
        space.write_module(&manifest).unwrap();
        let problems = apply_migrations(&space).unwrap();
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].message.contains("absente"));
        manifest.search.clear();
        space.write_module(&manifest).unwrap();
        assert!(apply_migrations(&space).unwrap().is_empty());
    }
}
