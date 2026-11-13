//! Fusion et scission de modules locaux, depuis l’écran des modules. Chaque opération est un commit de l’espace.
//!
//! Les tables gardent leurs données : une table change de préfixe en même temps que de module. Pour une fusion, les
//! migrations du module absorbé sont recopiées dans le module d’accueil avec les nouveaux noms et marquées comme
//! appliquées, tandis que les tables existantes sont renommées dans la même transaction ; rejouées sur une base neuve,
//! elles produisent la même structure. Pour une scission, les tables qui suivent les pages déplacées sont décrites
//! par une migration générée dans le nouveau module (leur structure actuelle, sous le nouveau nom), et le module
//! d’origine reçoit une migration qui les retire ; les deux sont marquées comme appliquées. Tout ce qui ne peut pas
//! être déplacé sans risque (webhooks dont l’adresse changerait, identifiants en double, table partagée…) fait
//! refuser l’opération avec la raison.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{arg, AppError, AppResult};
use crate::git;
use crate::space::{self, ModuleManifest, Placement, Space, MODULE_FILE};
use crate::space_db::{self, table_prefix};
use crate::state::AppState;

pub async fn handle(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Option<AppResult<Value>> {
    let result = match command {
        "modules.merge" => (|| {
            let source: String = arg(args, "source")?;
            let target: String = arg(args, "target")?;
            let space = state.space()?;
            prepare_commit(&space)?;
            let report = merge(state, &space, &source, &target)?;
            let commit = git::commit_all(
                &space.root,
                &format!("Fusion du module {source} dans {target}"),
            )?;
            state.emit("space:changed", Value::Null);
            Ok(json!({ "module": target, "commit": commit, "report": report }))
        })(),
        "modules.splitPlan" => (|| {
            let module: String = arg(args, "module")?;
            let pages: Vec<String> = arg(args, "pages")?;
            Ok(serde_json::to_value(plan_split(
                &state.space()?,
                &module,
                &pages,
            )?)?)
        })(),
        "modules.split" => (|| {
            let module: String = arg(args, "module")?;
            let pages: Vec<String> = arg(args, "pages")?;
            let name: String = arg(args, "name")?;
            let space = state.space()?;
            prepare_commit(&space)?;
            let created = split(state, &space, &module, &pages, &name)?;
            let commit = git::commit_all(
                &space.root,
                &format!("Scission du module {module} : nouveau module {created}"),
            )?;
            state.emit("space:changed", Value::Null);
            Ok(json!({ "module": created, "commit": commit }))
        })(),
        _ => return None,
    };
    Some(result)
}

/// Les modifications en cours (un tour d’agent pas encore enregistré) ont leur propre commit : celui de l’opération
/// ne contient qu’elle, et s’annule seul.
fn prepare_commit(space: &Space) -> AppResult<()> {
    if git::has_changes(&space.root)? {
        git::commit_all(
            &space.root,
            "Modifications en cours avant réorganisation des modules",
        )?;
    }
    Ok(())
}

fn refuse(action: &str, problems: &[String]) -> AppError {
    AppError::new(format!("{action} : {}", problems.join(" ")))
}

fn writable(space: &Space, id: &str) -> AppResult<ModuleManifest> {
    let module = space.module(id)?;
    if module.read_only() {
        return Err(AppError::new(format!(
            "Le module « {} » est installé depuis un marketplace : il est en lecture seule et ne se fusionne ni ne se scinde. Le détacher d’abord pour en faire un module local.",
            module.name
        )));
    }
    Ok(module)
}

// ---------------------------------------------------------------------------------------------------------------
// Textes : noms de tables et références de fonctions
// ---------------------------------------------------------------------------------------------------------------

fn is_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// Remplace les mots entiers `ancien` → `nouveau` : un nom de table n’est pas modifié à l’intérieur d’un autre nom.
fn replace_words(text: &str, renames: &[(String, String)]) -> String {
    if renames.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    'scan: while index < text.len() {
        let starts_word = text[..index]
            .chars()
            .next_back()
            .is_none_or(|before| !is_word(before));
        if starts_word {
            for (old, new) in renames {
                if text[index..].starts_with(old.as_str()) {
                    let end = index + old.len();
                    if text[end..]
                        .chars()
                        .next()
                        .is_none_or(|after| !is_word(after))
                    {
                        out.push_str(new);
                        index = end;
                        continue 'scan;
                    }
                }
            }
        }
        let character = text[index..].chars().next().unwrap_or_default();
        out.push(character);
        index += character.len_utf8().max(1);
    }
    out
}

fn mentions_word(text: &str, word: &str) -> bool {
    replace_words(text, &[(word.to_string(), String::new())]).len() != text.len()
}

const QUOTES: [char; 3] = ['"', '\'', '`'];

/// Remplace une chaîne littérale exacte (`"ventes/exporter"`, `'…'`, `` `…` ``) : c’est ainsi que le code appelle une
/// fonction par `functions.call(…)`.
fn replace_literals(text: &str, renames: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (old, new) in renames {
        for quote in QUOTES {
            out = out.replace(
                &format!("{quote}{old}{quote}"),
                &format!("{quote}{new}{quote}"),
            );
        }
    }
    out
}

fn mentions_literal(text: &str, value: &str) -> bool {
    QUOTES
        .iter()
        .any(|quote| text.contains(&format!("{quote}{value}{quote}")))
}

fn is_source(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "sql")
    )
}

/// Fichiers d’un dossier, chemins relatifs ; les liens symboliques sont ignorés.
fn files_under(dir: &Path) -> Vec<PathBuf> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                walk(root, &path, out);
            } else if meta.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    out.push(relative.to_path_buf());
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn read_source(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Réécrit un fichier source du module s’il change.
fn rewrite_file(path: &Path, rewrite: impl Fn(&str) -> String) -> AppResult<()> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(());
    };
    let next = rewrite(&text);
    if next != text {
        fs::write(path, next)?;
    }
    Ok(())
}

fn migrations_of(dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(dir.join("migrations"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    files.sort();
    files
}

/// Numéro de la prochaine migration d’un module : un de plus que le plus grand numéro en tête de ses fichiers.
fn next_migration(dir: &Path) -> u32 {
    migrations_of(dir)
        .iter()
        .filter_map(|name| {
            name.split(|c: char| !c.is_ascii_digit())
                .next()
                .and_then(|digits| digits.parse::<u32>().ok())
        })
        .max()
        .unwrap_or(0)
        + 1
}

/// `0003_taches.sql` → `taches.sql` : le nom sans son numéro.
fn without_number(name: &str) -> &str {
    let trimmed = name.trim_start_matches(|c: char| c.is_ascii_digit());
    trimmed
        .strip_prefix('_')
        .unwrap_or(if trimmed.is_empty() { name } else { trimmed })
}

// ---------------------------------------------------------------------------------------------------------------
// Références entre modules (manifestes et navigation de l’espace)
// ---------------------------------------------------------------------------------------------------------------

/// Applique `rename` aux références qualifiées (`module/x`) d’un manifeste : emplacements et `uses.functions`.
fn rewrite_manifest(
    manifest: &mut ModuleManifest,
    rename: &dyn Fn(&str) -> Option<String>,
) -> bool {
    let mut changed = false;
    let mut swap = |value: &mut String| {
        if let Some(next) = rename(value) {
            *value = next;
            changed = true;
        }
    };
    for page in &mut manifest.pages {
        match &mut page.placement {
            Placement::Tab { section } => swap(section),
            Placement::Panel { page } => swap(page),
            Placement::Settings => {}
        }
        page.uses.functions.iter_mut().for_each(&mut swap);
    }
    for function in &mut manifest.functions {
        function.uses.functions.iter_mut().for_each(&mut swap);
    }
    changed
}

/// Le manifeste vise-t-il une référence que `rename` déplacerait ?
fn references(manifest: &ModuleManifest, rename: &dyn Fn(&str) -> Option<String>) -> bool {
    let mut copy = manifest.clone();
    rewrite_manifest(&mut copy, rename)
}

/// Navigation réorganisée par l’utilisateur (`alfred.json`) et liaisons de clients.
fn rewrite_layout(
    space: &Space,
    rename: &dyn Fn(&str) -> Option<String>,
    bindings: &dyn Fn(&str) -> Vec<String>,
    keep_bindings: bool,
) -> AppResult<()> {
    let mut manifest = space.manifest()?;
    let map = |value: &str| rename(value).unwrap_or_else(|| value.to_string());
    let layout = &mut manifest.layout;
    layout.sections = layout.sections.iter().map(|id| map(id)).collect();
    layout.settings = layout.settings.iter().map(|id| map(id)).collect();
    layout.tabs = std::mem::take(&mut layout.tabs)
        .into_iter()
        .map(|(section, pages)| (map(&section), pages.iter().map(|page| map(page)).collect()))
        .collect();
    layout.overrides = std::mem::take(&mut layout.overrides)
        .into_iter()
        .map(|(key, mut value)| {
            let key = match key.split_once(':') {
                Some((kind, reference)) => format!("{kind}:{}", map(reference)),
                None => key,
            };
            match &mut value.placement {
                Some(Placement::Tab { section }) => *section = map(section),
                Some(Placement::Panel { page }) => *page = map(page),
                _ => {}
            }
            (key, value)
        })
        .collect();
    let mut next = BTreeMap::new();
    for (need, client) in &manifest.bindings {
        let targets = bindings(need);
        if targets.is_empty() || keep_bindings {
            next.insert(need.clone(), client.clone());
        }
        for target in targets {
            next.entry(target).or_insert_with(|| client.clone());
        }
    }
    manifest.bindings = next;
    space.write_manifest(&manifest)
}

/// Accords mémorisés (hors de l’espace) : ceux d’une page ou d’une fonction suivent leur nouveau module. `rename`
/// reçoit une clé (`page:module/page`, `function:module/*`, `function:module/fonction`) et dit sa nouvelle valeur et
/// si l’ancienne reste valable.
fn carry_grants(
    state: &AppState,
    space: &Space,
    rename: &dyn Fn(&str) -> Option<(String, bool)>,
) -> AppResult<()> {
    let key = space.root.to_string_lossy().to_string();
    let db = state
        .app_db
        .lock()
        .map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    let rows: Vec<(String, String, String)> = {
        let mut statement =
            db.prepare("SELECT subject, resource, granted_at FROM grants WHERE space = ?1")?;
        let rows =
            statement.query_map([&key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.filter_map(Result::ok).collect()
    };
    for (subject, resource, granted_at) in rows {
        let next_subject = rename(&subject);
        let next_resource = rename(&resource);
        if next_subject.is_none() && next_resource.is_none() {
            continue;
        }
        let keep = next_subject.as_ref().is_none_or(|(_, keep)| *keep)
            && next_resource.as_ref().is_none_or(|(_, keep)| *keep);
        let new_subject = next_subject
            .map(|(value, _)| value)
            .unwrap_or_else(|| subject.clone());
        let new_resource = next_resource
            .map(|(value, _)| value)
            .unwrap_or_else(|| resource.clone());
        db.execute(
            "INSERT OR IGNORE INTO grants (space, subject, resource, granted_at) VALUES (?1, ?2, ?3, ?4)",
            params![key, new_subject, new_resource, granted_at],
        )?;
        if !keep {
            db.execute(
                "DELETE FROM grants WHERE space = ?1 AND subject = ?2 AND resource = ?3",
                params![key, subject, resource],
            )?;
        }
    }
    Ok(())
}

fn qualified_rename(from: &str, to: &str) -> impl Fn(&str) -> Option<String> {
    let from = format!("{from}/");
    let to = format!("{to}/");
    move |value: &str| value.strip_prefix(&from).map(|rest| format!("{to}{rest}"))
}

fn table_renames(tables: &[String], from: &str, to: &str) -> Vec<(String, String)> {
    let (from, to) = (table_prefix(from), table_prefix(to));
    tables
        .iter()
        .map(|table| (table.clone(), format!("{to}{}", &table[from.len()..])))
        .collect()
}

/// Un nouveau nom de table ne doit ni exister déjà ni tomber sous le préfixe d’un module plus précis (une table
/// `suivi_notes_x` appartiendrait au module `suivi-notes`, pas à `suivi`).
fn table_conflicts(
    db: &rusqlite::Connection,
    space: &Space,
    owner: &str,
    renames: &[(String, String)],
    ignored: &[&str],
) -> AppResult<Vec<String>> {
    let existing: BTreeSet<String> = {
        let mut statement = db.prepare("SELECT lower(name) FROM sqlite_master")?;
        let names = statement.query_map([], |row| row.get::<_, String>(0))?;
        names.filter_map(Result::ok).collect()
    };
    let own = table_prefix(owner);
    let longer: Vec<String> = space
        .module_ids()
        .iter()
        .filter(|id| id.as_str() != owner && !ignored.contains(&id.as_str()))
        .map(|id| table_prefix(id))
        .filter(|prefix| prefix.len() > own.len() && prefix.starts_with(&own))
        .collect();
    let mut problems = Vec::new();
    for (_, new) in renames {
        if existing.contains(&new.to_lowercase()) {
            problems.push(format!("La table « {new} » existe déjà."));
        } else if let Some(prefix) = longer
            .iter()
            .find(|prefix| new.starts_with(prefix.as_str()))
        {
            problems.push(format!("La table « {new} » appartiendrait au module dont les tables commencent par « {prefix} »."));
        }
    }
    Ok(problems)
}

// ---------------------------------------------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub pages: usize,
    pub functions: usize,
    /// Tables renommées : ancien nom → nouveau.
    pub tables: Vec<(String, String)>,
}

/// Fusionne le module `source` dans `target` : pages, fonctions, sections, clients, planifications, code partagé et
/// migrations rejoignent `target` ; `source` disparaît.
pub fn merge(
    state: &AppState,
    space: &Space,
    source: &str,
    target: &str,
) -> AppResult<MergeReport> {
    if source == target {
        return Err(AppError::new("Choisir deux modules différents."));
    }
    let absorbed = writable(space, source)?;
    let host = writable(space, target)?;
    let action = format!(
        "Fusion de « {} » dans « {} » refusée",
        absorbed.name, host.name
    );
    let mut problems = Vec::new();

    let mut duplicates = |kind: &str, left: Vec<&String>, right: Vec<&String>| {
        let right: BTreeSet<&String> = right.into_iter().collect();
        let both: Vec<&str> = left
            .into_iter()
            .filter(|id| right.contains(id))
            .map(String::as_str)
            .collect();
        if !both.is_empty() {
            problems.push(format!(
                "{kind} existent dans les deux modules : {}.",
                both.join(", ")
            ));
        }
    };
    duplicates(
        "Des sections",
        absorbed.sections.iter().map(|s| &s.id).collect(),
        host.sections.iter().map(|s| &s.id).collect(),
    );
    duplicates(
        "Des pages",
        absorbed.pages.iter().map(|p| &p.id).collect(),
        host.pages.iter().map(|p| &p.id).collect(),
    );
    duplicates(
        "Des fonctions",
        absorbed.functions.iter().map(|f| &f.id).collect(),
        host.functions.iter().map(|f| &f.id).collect(),
    );
    duplicates(
        "Des planifications",
        absorbed.schedules.iter().map(|s| &s.id).collect(),
        host.schedules.iter().map(|s| &s.id).collect(),
    );
    for need in &absorbed.clients {
        if host
            .clients
            .iter()
            .any(|other| other.id == need.id && other != need)
        {
            problems.push(format!(
                "Le client « {} » est déclaré différemment dans les deux modules.",
                need.id
            ));
        }
    }
    if !absorbed.webhooks.is_empty() {
        problems.push(format!(
            "Le module « {} » a des webhooks : leur adresse (…/hooks/{source}/…) changerait et les services qui les appellent ne les trouveraient plus. Retirer ces webhooks d’abord, ou garder les modules séparés.",
            absorbed.name
        ));
    }
    if space.module_dir(&format!("{source}-ajouts")).is_dir() {
        problems.push(format!(
            "Le module « {source}-ajouts » lit les tables de « {source} » : il perdrait cet accès."
        ));
    }
    let rename = qualified_rename(source, target);
    for id in space.module_ids() {
        if id == source || id == target {
            continue;
        }
        if let Ok(other) = space.module(&id) {
            if other.read_only() && references(&other, &rename) {
                problems.push(format!(
                    "Le module installé « {} » vise ce module et ne peut pas être modifié.",
                    other.name
                ));
            }
        }
    }
    let source_dir = space.module_dir(source);
    let target_dir = space.module_dir(target);
    let files: Vec<PathBuf> = files_under(&source_dir)
        .into_iter()
        .filter(|path| path != Path::new(MODULE_FILE) && !path.starts_with("migrations"))
        .collect();
    for path in &files {
        if target_dir.join(path).exists() {
            problems.push(format!(
                "Le fichier « {} » existe dans les deux modules.",
                path.display()
            ));
        }
    }
    let bindings = space.manifest()?.bindings;
    for need in &absorbed.clients {
        if let (Some(mine), Some(theirs)) = (
            bindings.get(&format!("{source}/{}", need.id)),
            bindings.get(&format!("{target}/{}", need.id)),
        ) {
            if mine != theirs {
                problems.push(format!(
                    "Le besoin « {} » est relié à deux clients différents.",
                    need.id
                ));
            }
        }
    }
    for problem in space_db::apply_migrations(space)? {
        if problem.module == source || problem.module == target {
            problems.push(format!(
                "La migration « {}/{} » est en échec : la corriger d’abord ({}).",
                problem.module, problem.file, problem.message
            ));
        }
    }
    let db = space_db::open(space)?;
    let tables = space_db::owned_tables(&db, space, source)?;
    let renames = table_renames(&tables, source, target);
    problems.extend(table_conflicts(&db, space, target, &renames, &[source])?);
    if !problems.is_empty() {
        return Err(refuse(&action, &problems));
    }

    // Migrations : recopiées sous les nouveaux noms de tables, à la suite de celles du module d’accueil.
    fs::create_dir_all(target_dir.join("migrations"))?;
    let mut written = Vec::new();
    for (number, file) in (next_migration(&target_dir)..).zip(migrations_of(&source_dir)) {
        let sql = replace_words(
            &read_source(&source_dir.join("migrations").join(&file)),
            &renames,
        );
        let name = format!("{number:04}_{}", without_number(&file));
        fs::write(target_dir.join("migrations").join(&name), &sql)?;
        written.push((name, space_db::checksum(&sql)));
    }
    let applied = (|| -> AppResult<()> {
        db.execute_batch("BEGIN;")?;
        for (old, new) in &renames {
            db.execute(&format!("ALTER TABLE \"{old}\" RENAME TO \"{new}\""), [])?;
        }
        db.execute("DELETE FROM _alfred_migrations WHERE module = ?1", [source])?;
        for (name, digest) in &written {
            db.execute(
                "INSERT INTO _alfred_migrations (module, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
                params![target, name, crate::app_db::now(), digest],
            )?;
        }
        db.execute_batch("COMMIT;")?;
        Ok(())
    })();
    if let Err(error) = applied {
        let _ = db.execute_batch("ROLLBACK;");
        for (name, _) in &written {
            let _ = fs::remove_file(target_dir.join("migrations").join(name));
        }
        return Err(AppError::new(format!(
            "Les tables n’ont pas pu être renommées : {}",
            error.message
        )));
    }
    drop(db);

    // Fichiers : pages, fonctions, code partagé. Le code suit les nouveaux noms de tables et de fonctions.
    let function_renames: Vec<(String, String)> = absorbed
        .functions
        .iter()
        .map(|function| {
            (
                format!("{source}/{}", function.id),
                format!("{target}/{}", function.id),
            )
        })
        .collect();
    for path in &files {
        let (from, to) = (source_dir.join(path), target_dir.join(path));
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        if is_source(path) {
            let text = replace_literals(
                &replace_words(&read_source(&from), &renames),
                &function_renames,
            );
            fs::write(&to, text)?;
            fs::remove_file(&from)?;
        } else {
            fs::rename(&from, &to)?;
        }
    }

    let mut merged = host.clone();
    merged.sections.extend(absorbed.sections.iter().cloned());
    merged.pages.extend(absorbed.pages.iter().cloned());
    merged.functions.extend(absorbed.functions.iter().cloned());
    for need in &absorbed.clients {
        if !merged.clients.iter().any(|other| other.id == need.id) {
            merged.clients.push(need.clone());
        }
    }
    merged.schedules.extend(absorbed.schedules.iter().cloned());
    rewrite_manifest(&mut merged, &rename);
    space.write_module(&merged)?;
    fs::remove_dir_all(&source_dir)?;

    // Les autres modules locaux qui visaient le module absorbé suivent : emplacements, `uses` et appels de fonctions.
    for id in space.module_ids() {
        let Ok(mut other) = space.module(&id) else {
            continue;
        };
        if other.read_only() {
            continue;
        }
        if id != target && rewrite_manifest(&mut other, &rename) {
            space.write_module(&other)?;
        }
        for path in files_under(&space.module_dir(&id)) {
            if is_source(&path) && path.extension().is_some_and(|extension| extension != "sql") {
                rewrite_file(&space.module_dir(&id).join(&path), |text| {
                    replace_literals(text, &function_renames)
                })?;
            }
        }
    }
    rewrite_layout(
        space,
        &rename,
        &|need| {
            need.strip_prefix(&format!("{source}/"))
                .map(|id| vec![format!("{target}/{id}")])
                .unwrap_or_default()
        },
        false,
    )?;
    let page_prefix = format!("page:{source}/");
    let function_prefix = format!("function:{source}/");
    carry_grants(state, space, &|key| {
        key.strip_prefix(&page_prefix)
            .map(|rest| (format!("page:{target}/{rest}"), false))
            .or_else(|| {
                key.strip_prefix(&function_prefix)
                    .map(|rest| (format!("function:{target}/{rest}"), false))
            })
    })?;
    if let Ok(db) = state.app_db.lock() {
        let key = space.root.to_string_lossy().to_string();
        for schedule in &absorbed.schedules {
            let _ = db.execute(
                "UPDATE OR IGNORE schedule_state SET schedule = ?3 WHERE space = ?1 AND schedule = ?2",
                params![key, format!("{source}/{}", schedule.id), format!("{target}/{}", schedule.id)],
            );
        }
        let _ = db.execute(
            "UPDATE agent_scopes SET module = ?2 WHERE module = ?1",
            params![source, target],
        );
    }
    Ok(MergeReport {
        pages: absorbed.pages.len(),
        functions: absorbed.functions.len(),
        tables: renames,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Scission
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SplitPlan {
    pub pages: Vec<String>,
    /// Fonctions que seules les pages déplacées utilisent : elles partent avec elles.
    pub functions: Vec<String>,
    /// Fonctions utilisées par les pages déplacées et par ce qui reste : elles restent, appelées par « module/id ».
    pub shared_functions: Vec<String>,
    pub sections: Vec<String>,
    /// Tables que seul le code déplacé utilise : elles partent avec leurs données.
    pub tables: Vec<String>,
    /// Raisons d’un refus ; vide si la scission est possible.
    pub problems: Vec<String>,
}

struct Usage {
    /// Fonctions du module appelées par chaque élément (`page:id`, `function:id`, `webhook:id`, `schedule:id`).
    calls: BTreeMap<String, BTreeSet<String>>,
}

fn usage(space: &Space, module: &ModuleManifest) -> Usage {
    let ids: Vec<&String> = module
        .functions
        .iter()
        .map(|function| &function.id)
        .collect();
    let mentioned = |text: &str, uses: &[String]| -> BTreeSet<String> {
        ids.iter()
            .filter(|id| {
                let qualified = format!("{}/{id}", module.id);
                uses.iter()
                    .any(|used| used == id.as_str() || *used == qualified)
                    || mentions_literal(text, id)
                    || mentions_literal(text, &qualified)
            })
            .map(|id| id.to_string())
            .collect()
    };
    let mut calls = BTreeMap::new();
    for page in &module.pages {
        let text = read_source(&space.page_file(&module.id, &page.id));
        calls.insert(
            format!("page:{}", page.id),
            mentioned(&text, &page.uses.functions),
        );
    }
    for function in &module.functions {
        let text = read_source(&space.function_file(&module.id, &function.id));
        let mut used = mentioned(&text, &function.uses.functions);
        used.remove(&function.id);
        calls.insert(format!("function:{}", function.id), used);
    }
    for webhook in &module.webhooks {
        calls.insert(
            format!("webhook:{}", webhook.id),
            BTreeSet::from([webhook.function.clone()]),
        );
    }
    for schedule in &module.schedules {
        calls.insert(
            format!("schedule:{}", schedule.id),
            BTreeSet::from([schedule.function.clone()]),
        );
    }
    Usage { calls }
}

/// Ce que déplacerait la scission de `pages` hors du module, et ce qui l’empêche.
pub fn plan_split(space: &Space, module_id: &str, pages: &[String]) -> AppResult<SplitPlan> {
    let module = writable(space, module_id)?;
    let mut plan = SplitPlan::default();
    let selected: BTreeSet<String> = pages
        .iter()
        .map(|page| page.rsplit('/').next().unwrap_or(page).to_string())
        .collect();
    if selected.is_empty() {
        plan.problems
            .push("Choisir au moins une page à déplacer.".into());
        return Ok(plan);
    }
    for page in &selected {
        if !module.pages.iter().any(|declared| &declared.id == page) {
            plan.problems
                .push(format!("La page « {module_id}/{page} » n’existe pas."));
        }
    }
    if selected.len() == module.pages.len() {
        plan.problems.push("Garder au moins une page dans le module : déplacer toutes ses pages revient à le renommer.".into());
    }
    plan.pages = selected
        .iter()
        .map(|page| format!("{module_id}/{page}"))
        .collect();

    // Une fonction part quand tous ceux qui l’appellent partent, et qu’au moins l’un d’eux part.
    let usage = usage(space, &module);
    let mut moved: BTreeSet<String> = selected.iter().map(|page| format!("page:{page}")).collect();
    loop {
        let mut grew = false;
        for function in &module.functions {
            let key = format!("function:{}", function.id);
            if moved.contains(&key) {
                continue;
            }
            let users: Vec<&String> = usage
                .calls
                .iter()
                .filter(|(user, called)| **user != key && called.contains(&function.id))
                .map(|(user, _)| user)
                .collect();
            if !users.is_empty() && users.iter().all(|user| moved.contains(*user)) {
                moved.insert(key);
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    plan.functions = module
        .functions
        .iter()
        .filter(|function| moved.contains(&format!("function:{}", function.id)))
        .map(|function| function.id.clone())
        .collect();
    let mut shared = BTreeSet::new();
    for (user, called) in &usage.calls {
        if moved.contains(user) {
            shared.extend(
                called
                    .iter()
                    .filter(|id| !plan.functions.contains(id))
                    .cloned(),
            );
        }
    }
    plan.shared_functions = shared.into_iter().collect();

    // Une section part avec ses pages quand elles partent toutes.
    for section in &module.sections {
        let qualified = format!("{module_id}/{}", section.id);
        let inside: Vec<&String> = module
            .pages
            .iter()
            .filter(|page| matches!(&page.placement, Placement::Tab { section: target } if *target == section.id || *target == qualified))
            .map(|page| &page.id)
            .collect();
        if !inside.is_empty() && inside.iter().all(|page| selected.contains(*page)) {
            plan.sections.push(section.id.clone());
        }
    }

    // Tables : chacune reste ou part, jamais partagée entre deux modules.
    let dir = space.module_dir(module_id);
    let moved_text: Vec<String> = selected
        .iter()
        .map(|page| read_source(&space.page_file(module_id, page)))
        .chain(
            plan.functions
                .iter()
                .map(|function| read_source(&space.function_file(module_id, function))),
        )
        .collect();
    let lib: Vec<String> = files_under(&dir.join("lib"))
        .iter()
        .map(|path| read_source(&dir.join("lib").join(path)))
        .collect();
    let remaining_text: Vec<String> = module
        .pages
        .iter()
        .filter(|page| !selected.contains(&page.id))
        .map(|page| read_source(&space.page_file(module_id, &page.id)))
        .chain(
            module
                .functions
                .iter()
                .filter(|function| !plan.functions.contains(&function.id))
                .map(|function| read_source(&space.function_file(module_id, &function.id))),
        )
        .chain(lib.iter().cloned())
        .collect();
    let lib_used = moved_text.iter().any(|text| text.contains("lib/"));
    for problem in space_db::apply_migrations(space)? {
        if problem.module == module_id {
            plan.problems.push(format!(
                "La migration « {} » est en échec : la corriger d’abord.",
                problem.file
            ));
        }
    }
    let db = space_db::open(space)?;
    let tables = space_db::owned_tables(&db, space, module_id)?;
    for table in &tables {
        let by_moved = moved_text.iter().any(|text| mentions_word(text, table))
            || (lib_used && lib.iter().any(|text| mentions_word(text, table)));
        let by_remaining = remaining_text.iter().any(|text| mentions_word(text, table));
        match (by_moved, by_remaining) {
            (true, true) => plan.problems.push(format!(
                "La table « {table} » sert aux pages déplacées et à ce qui reste : une table n’appartient qu’à un module. Déplacer aussi les pages qui l’utilisent, ou garder ces pages ensemble."
            )),
            (true, false) => plan.tables.push(table.clone()),
            _ => {}
        }
    }
    for table in &plan.tables {
        let mut statement = db.prepare("SELECT \"table\" FROM pragma_foreign_key_list(?1)")?;
        let parents: Vec<String> = statement
            .query_map([table], |row| row.get(0))?
            .filter_map(Result::ok)
            .collect();
        for parent in parents {
            if !plan
                .tables
                .iter()
                .any(|moved| moved.eq_ignore_ascii_case(&parent))
            {
                plan.problems.push(format!(
                    "La table « {table} » référence « {parent} », qui resterait dans le module."
                ));
            }
        }
        for other in tables.iter().filter(|other| !plan.tables.contains(other)) {
            let mut statement = db.prepare("SELECT \"table\" FROM pragma_foreign_key_list(?1)")?;
            let parents: Vec<String> = statement
                .query_map([other], |row| row.get(0))?
                .filter_map(Result::ok)
                .collect();
            if parents
                .iter()
                .any(|parent| parent.eq_ignore_ascii_case(table))
            {
                plan.problems.push(format!(
                    "La table « {other} », qui reste, référence « {table} », qui partirait."
                ));
            }
        }
    }

    // Modules installés qui visent une page ou une section qui partirait.
    let moving: BTreeSet<String> = plan
        .pages
        .iter()
        .cloned()
        .chain(
            plan.sections
                .iter()
                .map(|section| format!("{module_id}/{section}")),
        )
        .chain(
            plan.functions
                .iter()
                .map(|function| format!("{module_id}/{function}")),
        )
        .collect();
    let rename = |value: &str| moving.contains(value).then(|| value.to_string());
    for id in space.module_ids() {
        if let Ok(other) = space.module(&id) {
            if id != module_id && other.read_only() && references(&other, &rename) {
                plan.problems.push(format!(
                    "Le module installé « {} » vise une page ou une fonction déplacée.",
                    other.name
                ));
            }
        }
    }
    Ok(plan)
}

fn new_module_id(space: &Space, db: &rusqlite::Connection, name: &str) -> AppResult<String> {
    let base = space::slug(name);
    if base.is_empty() {
        return Err(AppError::new("Donner un nom au nouveau module."));
    }
    let existing: BTreeSet<String> = space.module_ids().into_iter().collect();
    let tables: Vec<String> = {
        let mut statement = db.prepare("SELECT name FROM sqlite_master")?;
        let names = statement.query_map([], |row| row.get::<_, String>(0))?;
        names.filter_map(Result::ok).collect()
    };
    // Ni un module existant, ni un préfixe qui s’approprierait des tables déjà là.
    let free = |id: &str| {
        !existing.contains(id)
            && !tables
                .iter()
                .any(|table| table.starts_with(&table_prefix(id)))
    };
    std::iter::once(base.clone())
        .chain((2..100).map(|index| format!("{base}-{index}")))
        .find(|id| space::valid_id(id) && free(id))
        .ok_or_else(|| AppError::new("Aucun identifiant libre pour ce nom de module."))
}

/// Déplace `pages` (et ce que le plan emporte avec elles) dans un nouveau module nommé `name` ; renvoie son
/// identifiant.
pub fn split(
    state: &AppState,
    space: &Space,
    module_id: &str,
    pages: &[String],
    name: &str,
) -> AppResult<String> {
    let plan = plan_split(space, module_id, pages)?;
    let module = space.module(module_id)?;
    if !plan.problems.is_empty() {
        return Err(refuse(
            &format!("Scission de « {} » refusée", module.name),
            &plan.problems,
        ));
    }
    let db = space_db::open(space)?;
    let created = new_module_id(space, &db, name)?;
    let source_dir = space.module_dir(module_id);
    let target_dir = space.module_dir(&created);
    let selected: BTreeSet<String> = plan
        .pages
        .iter()
        .map(|page| page.rsplit('/').next().unwrap_or(page).to_string())
        .collect();
    let renames = table_renames(&plan.tables, module_id, &created);
    let conflicts = table_conflicts(&db, space, &created, &renames, &[])?;
    if !conflicts.is_empty() {
        return Err(refuse(
            &format!("Scission de « {} » refusée", module.name),
            &conflicts,
        ));
    }

    // Références qualifiées qui changent de module.
    let moving: BTreeMap<String, String> = selected
        .iter()
        .map(|page| page.as_str())
        .chain(plan.sections.iter().map(String::as_str))
        .chain(plan.functions.iter().map(String::as_str))
        .map(|id| (format!("{module_id}/{id}"), format!("{created}/{id}")))
        .collect();
    let rename = |value: &str| moving.get(value).cloned();

    // Tables : décrites par une migration du nouveau module, retirées par une migration du module d’origine. Les
    // deux sont marquées comme appliquées : la base a déjà la bonne structure, renommée dans la même transaction.
    let mut create_sql = String::new();
    let mut drop_sql = String::new();
    // Index et déclencheurs des tables qui partent : renommés eux aussi, sinon une base neuve qui rejoue les deux
    // modules verrait deux index du même nom.
    let objects: Vec<(String, String, String)> = {
        let names: Vec<&str> = plan.tables.iter().map(String::as_str).collect();
        let mut statement = db.prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid",
        )?;
        let rows: Vec<(String, String, String, String)> = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .filter_map(Result::ok)
            .collect();
        rows.into_iter()
            .filter(|(_, _, table, _)| names.iter().any(|name| name.eq_ignore_ascii_case(table)))
            .map(|(kind, name, _, sql)| (kind, name, sql))
            .collect()
    };
    let (old_prefix, new_prefix) = (table_prefix(module_id), table_prefix(&created));
    let mut every_rename = renames.clone();
    for (kind, name, _) in &objects {
        if kind != "table" {
            let renamed = match name.strip_prefix(&old_prefix) {
                Some(rest) => format!("{new_prefix}{rest}"),
                None => format!("{new_prefix}{name}"),
            };
            every_rename.push((name.clone(), renamed));
        }
    }
    if !renames.is_empty() {
        create_sql.push_str(&format!(
            "-- Tables reprises du module {module_id} lors de la scission, avec leurs données.\n"
        ));
        for (_, _, sql) in &objects {
            create_sql.push_str(&replace_words(sql, &every_rename));
            create_sql.push_str(";\n");
        }
        drop_sql.push_str(&format!(
            "-- Tables parties dans le module {created} lors de la scission.\n"
        ));
        for table in plan.tables.iter().rev() {
            drop_sql.push_str(&format!("DROP TABLE IF EXISTS {table};\n"));
        }
    }
    let create_name = format!("0001_reprise_{}.sql", module_id.replace('-', "_"));
    let drop_name = format!(
        "{:04}_scission_{}.sql",
        next_migration(&source_dir),
        created.replace('-', "_")
    );
    if !renames.is_empty() {
        let applied = (|| -> AppResult<()> {
            db.execute_batch("BEGIN;")?;
            for (old, new) in &renames {
                db.execute(&format!("ALTER TABLE \"{old}\" RENAME TO \"{new}\""), [])?;
            }
            for (kind, name, sql) in objects.iter().filter(|(kind, _, _)| kind != "table") {
                let keyword = if kind == "trigger" {
                    "TRIGGER"
                } else {
                    "INDEX"
                };
                db.execute(&format!("DROP {keyword} \"{name}\""), [])?;
                db.execute_batch(&replace_words(sql, &every_rename))?;
            }
            for (owner, file, sql) in [
                (created.as_str(), &create_name, &create_sql),
                (module_id, &drop_name, &drop_sql),
            ] {
                db.execute(
                    "INSERT INTO _alfred_migrations (module, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
                    params![owner, file, crate::app_db::now(), space_db::checksum(sql)],
                )?;
            }
            db.execute_batch("COMMIT;")?;
            Ok(())
        })();
        if let Err(error) = applied {
            let _ = db.execute_batch("ROLLBACK;");
            return Err(AppError::new(format!(
                "Les tables n’ont pas pu être déplacées : {}",
                error.message
            )));
        }
        fs::create_dir_all(target_dir.join("migrations"))?;
        fs::write(
            target_dir.join("migrations").join(&create_name),
            &create_sql,
        )?;
        fs::write(source_dir.join("migrations").join(&drop_name), &drop_sql)?;
    }
    drop(db);

    // Manifestes.
    let mut origin = module.clone();
    let mut target = ModuleManifest {
        id: created.clone(),
        name: name.trim().to_string(),
        version: "0.1.0".to_string(),
        description: format!("Pages reprises du module {}.", module.name),
        ..ModuleManifest::default()
    };
    target.sections = origin
        .sections
        .iter()
        .filter(|section| plan.sections.contains(&section.id))
        .cloned()
        .collect();
    origin
        .sections
        .retain(|section| !plan.sections.contains(&section.id));
    let qualify = |value: &str, moves: &dyn Fn(&str) -> bool| -> String {
        if value.contains('/') || moves(value) {
            value.to_string()
        } else {
            format!("{module_id}/{value}")
        }
    };
    for mut page in origin
        .pages
        .iter()
        .filter(|page| selected.contains(&page.id))
        .cloned()
    {
        if let Placement::Tab { section } = &mut page.placement {
            *section = qualify(section, &|id| plan.sections.iter().any(|moved| moved == id));
        }
        page.uses.functions = page
            .uses
            .functions
            .iter()
            .map(|id| qualify(id, &|id| plan.functions.iter().any(|moved| moved == id)))
            .collect();
        target.pages.push(page);
    }
    origin.pages.retain(|page| !selected.contains(&page.id));
    for mut function in origin
        .functions
        .iter()
        .filter(|function| plan.functions.contains(&function.id))
        .cloned()
    {
        function.uses.functions = function
            .uses
            .functions
            .iter()
            .map(|id| qualify(id, &|id| plan.functions.iter().any(|moved| moved == id)))
            .collect();
        target.functions.push(function);
    }
    origin
        .functions
        .retain(|function| !plan.functions.contains(&function.id));
    target.clients = origin.clients.clone();
    rewrite_manifest(&mut target, &rename);
    rewrite_manifest(&mut origin, &rename);
    space.write_module(&target)?;
    space.write_module(&origin)?;

    // Fichiers : pages et fonctions déplacées, code partagé recopié s’il est importé. Le code déplacé appelle les
    // fonctions restées par « module/id » et ses tables par leur nouveau nom.
    let stayed: Vec<(String, String)> = plan
        .shared_functions
        .iter()
        .map(|id| (id.clone(), format!("{module_id}/{id}")))
        .collect();
    let function_moves: Vec<(String, String)> = moving
        .iter()
        .map(|(from, to)| (from.clone(), to.clone()))
        .collect();
    let rewrite = |text: &str| {
        replace_literals(
            &replace_literals(&replace_words(text, &renames), &stayed),
            &function_moves,
        )
    };
    let mut moves: Vec<(PathBuf, bool)> = selected
        .iter()
        .map(|page| (PathBuf::from("pages").join(format!("{page}.tsx")), true))
        .collect();
    moves.extend(
        plan.functions
            .iter()
            .map(|id| (PathBuf::from("functions").join(format!("{id}.ts")), true)),
    );
    let lib_used = moves
        .iter()
        .any(|(path, _)| read_source(&source_dir.join(path)).contains("lib/"));
    if lib_used {
        moves.extend(
            files_under(&source_dir.join("lib"))
                .into_iter()
                .map(|path| (PathBuf::from("lib").join(path), false)),
        );
    }
    for (path, take) in moves {
        let from = source_dir.join(&path);
        if !from.is_file() {
            continue;
        }
        let to = target_dir.join(&path);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        if is_source(&path) {
            fs::write(&to, rewrite(&read_source(&from)))?;
        } else {
            fs::copy(&from, &to)?;
        }
        if take {
            fs::remove_file(&from)?;
        }
    }

    // Les autres modules locaux suivent : emplacements, `uses` et appels « module/fonction ».
    for id in space.module_ids() {
        if id == created || id == module_id {
            continue;
        }
        let Ok(mut other) = space.module(&id) else {
            continue;
        };
        if other.read_only() {
            continue;
        }
        if rewrite_manifest(&mut other, &rename) {
            space.write_module(&other)?;
        }
        for path in files_under(&space.module_dir(&id)) {
            if is_source(&path) && path.extension().is_some_and(|extension| extension != "sql") {
                rewrite_file(&space.module_dir(&id).join(&path), |text| {
                    replace_literals(text, &function_moves)
                })?;
            }
        }
    }
    for path in files_under(&source_dir) {
        if is_source(&path) && path.extension().is_some_and(|extension| extension != "sql") {
            rewrite_file(&source_dir.join(&path), |text| {
                replace_literals(text, &function_moves)
            })?;
        }
    }
    let needs: Vec<String> = target.clients.iter().map(|need| need.id.clone()).collect();
    rewrite_layout(
        space,
        &rename,
        &|need| {
            need.strip_prefix(&format!("{module_id}/"))
                .filter(|id| needs.iter().any(|wanted| wanted == id))
                .map(|id| vec![format!("{created}/{id}")])
                .unwrap_or_default()
        },
        true,
    )?;
    let module_functions = format!("function:{module_id}/*");
    carry_grants(state, space, &|key| {
        if key == module_functions {
            return Some((format!("function:{created}/*"), true));
        }
        if let Some(reference) = key.strip_prefix("page:") {
            return moving
                .get(reference)
                .map(|next| (format!("page:{next}"), false));
        }
        if let Some(reference) = key.strip_prefix("function:") {
            return moving
                .get(reference)
                .map(|next| (format!("function:{next}"), false));
        }
        None
    })?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{FunctionDecl, PageDecl, SectionDecl, Uses, WebhookDecl};

    fn page(id: &str, placement: Placement) -> PageDecl {
        PageDecl {
            id: id.into(),
            title: id.into(),
            icon: None,
            description: String::new(),
            placement,
            uses: Uses::default(),
        }
    }

    fn module(
        space: &Space,
        id: &str,
        sections: &[&str],
        pages: Vec<PageDecl>,
        functions: &[&str],
    ) {
        let manifest = ModuleManifest {
            id: id.into(),
            name: id.to_uppercase(),
            version: "0.1.0".into(),
            sections: sections
                .iter()
                .map(|s| SectionDecl {
                    id: (*s).into(),
                    label: (*s).into(),
                    ..Default::default()
                })
                .collect(),
            pages,
            functions: functions
                .iter()
                .map(|f| FunctionDecl {
                    id: (*f).into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        space.write_module(&manifest).unwrap();
    }

    fn write(space: &Space, path: &str, text: &str) {
        let path = space.root.join("modules").join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn count(space: &Space, sql: &str) -> i64 {
        space_db::open(space)
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    fn setup() -> (tempfile::TempDir, Arc<AppState>, Space) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        state.set_space(Some(space.clone()));
        (dir, state, space)
    }

    async fn invoke(state: &Arc<AppState>, command: &str, args: Value) -> Result<Value, String> {
        crate::dispatch::dispatch(state.clone(), command, args)
            .await
            .map_err(|error| error.message)
    }

    #[test]
    fn table_names_are_replaced_as_whole_words_only() {
        let renames = vec![("notes_items".to_string(), "suivi_items".to_string())];
        assert_eq!(
            replace_words(
                "SELECT * FROM notes_items JOIN notes_items_tags; \"notes_items\"",
                &renames
            ),
            "SELECT * FROM suivi_items JOIN notes_items_tags; \"suivi_items\""
        );
        assert_eq!(without_number("0003_taches.sql"), "taches.sql");
    }

    /// Deux modules locaux deviennent un : pages, fonctions, migrations et données suivent, les références des
    /// autres modules et de la navigation aussi, en un commit annulable.
    #[tokio::test(flavor = "multi_thread")]
    async fn merging_two_local_modules_keeps_pages_functions_and_data() {
        let (_dir, state, space) = setup();
        module(
            &space,
            "notes",
            &["principal"],
            vec![page(
                "liste",
                Placement::Tab {
                    section: "principal".into(),
                },
            )],
            &["compter"],
        );
        write(&space, "notes/pages/liste.tsx", "import { db, functions } from \"@alfred/sdk\";\nexport default function Page() { void db.query(\"SELECT * FROM notes_items\"); void functions.call(\"compter\"); return null; }\n");
        write(
            &space,
            "notes/functions/compter.ts",
            "export default async () => ({ n: 1 });\n",
        );
        write(&space, "notes/lib/format.ts", "export const f = 1;\n");
        write(
            &space,
            "notes/migrations/0001_items.sql",
            "CREATE TABLE notes_items (id INTEGER PRIMARY KEY, titre TEXT);\n",
        );
        module(
            &space,
            "suivi",
            &["suivi"],
            vec![page(
                "taches",
                Placement::Tab {
                    section: "suivi".into(),
                },
            )],
            &[],
        );
        write(
            &space,
            "suivi/pages/taches.tsx",
            "export default function Page() { return null; }\n",
        );
        write(
            &space,
            "suivi/migrations/0001_taches.sql",
            "CREATE TABLE suivi_taches (id INTEGER PRIMARY KEY);\n",
        );
        // Un autre module appelle une fonction du module fusionné et pose un panneau sur sa page.
        let mut extra = ModuleManifest {
            id: "outils".into(),
            name: "Outils".into(),
            ..Default::default()
        };
        extra.pages.push(page(
            "detail",
            Placement::Panel {
                page: "notes/liste".into(),
            },
        ));
        space.write_module(&extra).unwrap();
        write(&space, "outils/pages/detail.tsx", "import { functions } from \"@alfred/sdk\";\nvoid functions.call(\"notes/compter\");\nexport default function Page() { return null; }\n");
        assert!(space_db::apply_migrations(&space).unwrap().is_empty());
        space_db::open(&space)
            .unwrap()
            .execute("INSERT INTO notes_items (titre) VALUES ('garder')", [])
            .unwrap();
        git::commit_all(&space.root, "départ").unwrap();

        let merged = invoke(
            &state,
            "modules.merge",
            json!({ "source": "notes", "target": "suivi" }),
        )
        .await
        .unwrap();
        assert!(merged["commit"].is_string(), "{merged}");
        assert!(!space.module_dir("notes").exists());
        let suivi = space.module("suivi").unwrap();
        assert!(
            suivi.pages.iter().any(|p| p.id == "liste")
                && suivi.functions.iter().any(|f| f.id == "compter")
        );
        assert!(space.module_dir("suivi").join("lib/format.ts").is_file());
        let page_text = fs::read_to_string(space.page_file("suivi", "liste")).unwrap();
        assert!(
            page_text.contains("FROM suivi_items") && page_text.contains("call(\"compter\")"),
            "{page_text}"
        );
        assert!(fs::read_to_string(space.page_file("outils", "detail"))
            .unwrap()
            .contains("\"suivi/compter\""));
        assert_eq!(
            space.module("outils").unwrap().pages[0].placement,
            Placement::Panel {
                page: "suivi/liste".into()
            }
        );
        assert_eq!(
            count(
                &space,
                "SELECT count(*) FROM suivi_items WHERE titre = 'garder'"
            ),
            1,
            "les données suivent"
        );
        let migration =
            fs::read_to_string(space.module_dir("suivi").join("migrations/0002_items.sql"))
                .unwrap();
        assert!(migration.contains("CREATE TABLE suivi_items"));
        assert!(
            space_db::apply_migrations(&space).unwrap().is_empty(),
            "rien ne repasse, rien n’échoue"
        );
        let snapshot = space.snapshot().unwrap();
        assert!(snapshot.problems.is_empty(), "{:?}", snapshot.problems);
        let history = git::log(&space.root, 1, None).unwrap();
        assert_eq!(history[0].message, "Fusion du module notes dans suivi");

        // Un module installé est refusé, avec la raison.
        let mut installed = ModuleManifest {
            id: "achat".into(),
            name: "Achats".into(),
            ..Default::default()
        };
        installed.origin = Some(crate::space::Origin {
            marketplace: "m".into(),
            version: "1".into(),
            commit: "c".into(),
            ..Default::default()
        });
        space.write_module(&installed).unwrap();
        let refused = invoke(
            &state,
            "modules.merge",
            json!({ "source": "achat", "target": "suivi" }),
        )
        .await
        .unwrap_err();
        assert!(refused.contains("lecture seule"), "{refused}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_merge_that_is_not_safe_is_refused_with_its_reasons() {
        let (_dir, state, space) = setup();
        module(
            &space,
            "notes",
            &[],
            vec![page("liste", Placement::Settings)],
            &["recevoir"],
        );
        let mut notes = space.module("notes").unwrap();
        notes.webhooks.push(WebhookDecl {
            id: "entree".into(),
            description: String::new(),
            function: "recevoir".into(),
        });
        space.write_module(&notes).unwrap();
        module(
            &space,
            "suivi",
            &[],
            vec![page("liste", Placement::Settings)],
            &[],
        );
        let refused = invoke(
            &state,
            "modules.merge",
            json!({ "source": "notes", "target": "suivi" }),
        )
        .await
        .unwrap_err();
        assert!(
            refused.contains("Des pages existent dans les deux modules : liste."),
            "{refused}"
        );
        assert!(refused.contains("webhooks"), "{refused}");
        assert!(space.module_dir("notes").exists(), "rien n’a bougé");
    }

    /// Des pages choisies partent dans un nouveau module avec les fonctions et les tables qu’elles seules utilisent ;
    /// ce qui est partagé reste et s’appelle par « module/id ».
    #[tokio::test(flavor = "multi_thread")]
    async fn splitting_moves_chosen_pages_with_what_only_they_use() {
        let (_dir, state, space) = setup();
        module(
            &space,
            "ventes",
            &["principal", "archives"],
            vec![
                page(
                    "factures",
                    Placement::Tab {
                        section: "principal".into(),
                    },
                ),
                page(
                    "clients",
                    Placement::Tab {
                        section: "principal".into(),
                    },
                ),
                page(
                    "anciennes",
                    Placement::Tab {
                        section: "archives".into(),
                    },
                ),
            ],
            &["archiver", "formater"],
        );
        write(&space, "ventes/pages/factures.tsx", "import { db, functions } from \"@alfred/sdk\";\nvoid db.query(\"SELECT * FROM ventes_factures\");\nvoid functions.call(\"formater\");\nexport default function Page() { return null; }\n");
        write(
            &space,
            "ventes/pages/clients.tsx",
            "export default function Page() { return null; }\n",
        );
        write(&space, "ventes/pages/anciennes.tsx", "import { db, functions } from \"@alfred/sdk\";\nvoid db.query(\"SELECT * FROM ventes_archives\");\nvoid functions.call(\"archiver\");\nvoid functions.call(\"formater\");\nexport default function Page() { return null; }\n");
        write(&space, "ventes/functions/archiver.ts", "import { db } from \"@alfred/sdk\";\nexport default async () => db.query(\"SELECT * FROM ventes_archives\");\n");
        write(
            &space,
            "ventes/functions/formater.ts",
            "export default async () => ({});\n",
        );
        write(&space, "ventes/migrations/0001_tables.sql", "CREATE TABLE ventes_factures (id INTEGER PRIMARY KEY);\nCREATE TABLE ventes_archives (id INTEGER PRIMARY KEY, annee INTEGER);\nCREATE INDEX ventes_archives_annee ON ventes_archives (annee);\n");
        assert!(space_db::apply_migrations(&space).unwrap().is_empty());
        space_db::open(&space)
            .unwrap()
            .execute("INSERT INTO ventes_archives (annee) VALUES (2019)", [])
            .unwrap();
        git::commit_all(&space.root, "départ").unwrap();

        let plan = invoke(
            &state,
            "modules.splitPlan",
            json!({ "module": "ventes", "pages": ["anciennes"] }),
        )
        .await
        .unwrap();
        assert_eq!(plan["functions"], json!(["archiver"]));
        assert_eq!(plan["sharedFunctions"], json!(["formater"]));
        assert_eq!(plan["sections"], json!(["archives"]));
        assert_eq!(plan["tables"], json!(["ventes_archives"]));
        assert_eq!(plan["problems"], json!([]));

        let split = invoke(
            &state,
            "modules.split",
            json!({ "module": "ventes", "pages": ["anciennes"], "name": "Archives" }),
        )
        .await
        .unwrap();
        assert_eq!(split["module"], json!("archives"));
        let archives = space.module("archives").unwrap();
        assert_eq!(
            archives.pages[0].placement,
            Placement::Tab {
                section: "archives".into()
            }
        );
        assert_eq!(archives.functions[0].id, "archiver");
        let page_text = fs::read_to_string(space.page_file("archives", "anciennes")).unwrap();
        assert!(
            page_text.contains("archives_archives")
                && page_text.contains("\"ventes/formater\"")
                && page_text.contains("call(\"archiver\")"),
            "{page_text}"
        );
        assert!(!space.page_file("ventes", "anciennes").exists());
        assert_eq!(
            count(
                &space,
                "SELECT count(*) FROM archives_archives WHERE annee = 2019"
            ),
            1,
            "les données suivent"
        );
        let ventes = space.module("ventes").unwrap();
        assert_eq!(ventes.sections.len(), 1);
        assert!(
            ventes.functions.iter().any(|f| f.id == "formater")
                && !ventes.functions.iter().any(|f| f.id == "archiver")
        );
        assert!(
            space_db::apply_migrations(&space).unwrap().is_empty(),
            "les migrations générées sont marquées appliquées"
        );
        assert!(space.snapshot().unwrap().problems.is_empty());
        // Rejouées sur une base neuve, les migrations redonnent la même structure.
        fs::remove_file(space.local_dir().join("data.sqlite")).unwrap();
        let _ = fs::remove_file(space.local_dir().join("data.sqlite-wal"));
        let _ = fs::remove_file(space.local_dir().join("data.sqlite-shm"));
        assert!(space_db::apply_migrations(&space).unwrap().is_empty());
        assert_eq!(count(&space, "SELECT count(*) FROM sqlite_master WHERE name IN ('archives_archives', 'archives_archives_annee', 'ventes_factures')"), 3);
        assert_eq!(
            count(
                &space,
                "SELECT count(*) FROM sqlite_master WHERE name = 'ventes_archives'"
            ),
            0
        );

        // Une table partagée entre ce qui part et ce qui reste fait refuser, sans rien déplacer.
        write(&space, "ventes/pages/clients.tsx", "import { db } from \"@alfred/sdk\";\nvoid db.query(\"SELECT * FROM ventes_factures\");\nexport default function Page() { return null; }\n");
        let refused = invoke(
            &state,
            "modules.split",
            json!({ "module": "ventes", "pages": ["factures"], "name": "Autre" }),
        )
        .await
        .unwrap_err();
        assert!(
            refused.contains("« ventes_factures » sert aux pages déplacées et à ce qui reste"),
            "{refused}"
        );
        assert!(space.page_file("ventes", "factures").exists());
    }
}
