//! Mémoire des états sur le disque : `<espace>/.alfred/etats.sqlite`, jamais versionné. Le magasin des états
//! (`states.rs`) reste en mémoire ; ce fichier en garde une copie, pour qu’une page s’affiche tout de suite avec la
//! dernière valeur connue, même après un redémarrage d’Alfred.
//!
//! - **Une ligne par clé** du magasin (état ou entité), sans le chemin de l’espace : déplacer l’espace garde ses
//!   valeurs. Chaque ligne garde sa portée (mode exemple, compte et son client), la version de son contrat, sa valeur,
//!   l’heure de son dernier changement (`at`) et celle de la dernière lecture réussie (`checked`).
//! - **Écriture groupée.** Une opération marque ses clés ; [`flush`] les écrit en une transaction, à la fin.
//! - **Jamais gardé** : une valeur qui porte une référence de secret (`secret_refs`, réponse scellée), ni un état
//!   déclaré `persist: false`. Il vit le temps du lancement, en mémoire.
//! - **Oublié** : une valeur d’une autre version de son contrat, d’un module retiré, d’un état ou d’une entité qui
//!   n’existe plus, d’un compte supprimé ([`forget_client`]).
//! - **Âge maximal choisi par l’utilisateur** (Réglages → États), par état : table `overrides`.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection};

use crate::error::AppResult;

pub const FILE: &str = "etats.sqlite";
const SEPARATOR: char = '\u{1f}';

/// Une ligne lue ou à écrire. `key` est la clé du magasin, chemin de l’espace compris.
#[derive(Debug, Clone)]
pub(crate) struct Row {
    pub key: String,
    pub module: String,
    pub client: String,
    pub version: String,
    pub value: String,
    pub at: u64,
    pub checked: Option<u64>,
}

struct Disk {
    connection: Connection,
    overrides: HashMap<String, u64>,
}

#[derive(Default)]
struct Disks {
    /// Une base par espace ouvert (chemin de l’espace → base).
    open: HashMap<String, Disk>,
    /// Clés à écrire (ou à effacer) au prochain [`flush`].
    dirty: HashSet<String>,
}

fn disks() -> MutexGuard<'static, Disks> {
    static DISKS: OnceLock<Mutex<Disks>> = OnceLock::new();
    DISKS.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Chemin de l’espace d’une clé du magasin (`etat␟<espace>␟…`).
pub(crate) fn space_of(key: &str) -> Option<&str> {
    key.split(SEPARATOR).nth(1)
}

/// La clé sans le chemin de l’espace, telle que rangée sur le disque.
fn stored_key(key: &str) -> Option<String> {
    let mut parts = key.splitn(3, SEPARATOR);
    let kind = parts.next()?;
    let _space = parts.next()?;
    Some(format!("{kind}{SEPARATOR}{}", parts.next()?))
}

fn full_key(root: &str, stored: &str) -> Option<String> {
    let (kind, rest) = stored.split_once(SEPARATOR)?;
    Some(format!("{kind}{SEPARATOR}{root}{SEPARATOR}{rest}"))
}

/// Compte d’une clé : `etat␟espace␟exemples␟module/id␟compte␟…`.
pub(crate) fn instance_of(key: &str) -> Option<&str> {
    key.split(SEPARATOR).nth(4)
}

fn schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS entries (
           key TEXT PRIMARY KEY,
           module TEXT NOT NULL,
           client TEXT NOT NULL DEFAULT '',
           instance TEXT NOT NULL DEFAULT '',
           version TEXT NOT NULL DEFAULT '',
           value TEXT NOT NULL,
           at INTEGER NOT NULL,
           checked INTEGER
         );
         CREATE INDEX IF NOT EXISTS entries_module ON entries (module);
         CREATE TABLE IF NOT EXISTS overrides (name TEXT PRIMARY KEY, max_age INTEGER NOT NULL);",
    )
}

/// Ouvre la base de l’espace et rend ses lignes. `keep` dit si une ligne vaut encore (module présent, même version) :
/// les autres sont effacées.
pub(crate) fn open(root: &str, dir: &std::path::Path, keep: impl Fn(&Row) -> bool) -> AppResult<Vec<Row>> {
    std::fs::create_dir_all(dir)?;
    let connection = Connection::open(dir.join(FILE))?;
    schema(&connection)?;
    let mut rows = Vec::new();
    let mut dropped = Vec::new();
    {
        let mut statement = connection.prepare("SELECT key, module, client, version, value, at, checked FROM entries")?;
        let found = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
            ))
        })?;
        for item in found {
            let (stored, module, client, version, value, at, checked) = item?;
            let Some(key) = full_key(root, &stored) else {
                dropped.push(stored);
                continue;
            };
            let row = Row { key, module, client, version, value, at: at.max(0) as u64, checked: checked.map(|at| at.max(0) as u64) };
            if keep(&row) {
                rows.push(row);
            } else {
                dropped.push(stored);
            }
        }
    }
    if !dropped.is_empty() {
        let transaction = connection.unchecked_transaction()?;
        for stored in &dropped {
            transaction.execute("DELETE FROM entries WHERE key = ?1", [stored])?;
        }
        transaction.commit()?;
    }
    let overrides = {
        let mut statement = connection.prepare("SELECT name, max_age FROM overrides")?;
        let found = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
        found.filter_map(Result::ok).map(|(name, seconds)| (name, seconds.max(0) as u64)).collect()
    };
    disks().open.insert(root.to_string(), Disk { connection, overrides });
    Ok(rows)
}

/// Ferme la base d’un espace (un autre espace s’ouvre) ; ses clés en attente sont écrites avant.
pub(crate) fn close(root: &str, rows: impl Fn(&str) -> Option<Option<Row>>) {
    flush(rows);
    disks().open.remove(root);
}

pub(crate) fn is_open(root: &str) -> bool {
    disks().open.contains_key(root)
}

/// Marque une clé : elle sera écrite (ou effacée) au prochain [`flush`].
pub(crate) fn mark(key: &str) {
    if space_of(key).is_some_and(is_open) {
        disks().dirty.insert(key.to_string());
    }
}

/// Écrit les clés marquées. `rows(key)` rend la ligne à garder (`Some(Some)`), à effacer (`Some(None)` : clé
/// absente du magasin, ou valeur qui ne se garde pas), ou rien à faire (`None`).
pub(crate) fn flush(rows: impl Fn(&str) -> Option<Option<Row>>) {
    let dirty: Vec<String> = std::mem::take(&mut disks().dirty).into_iter().collect();
    if dirty.is_empty() {
        return;
    }
    // Les lignes se lisent dans le magasin hors du verrou des bases.
    let mut by_space: HashMap<String, Vec<(String, Option<Row>)>> = HashMap::new();
    for key in dirty {
        let (Some(space), Some(stored)) = (space_of(&key).map(str::to_string), stored_key(&key)) else { continue };
        if let Some(row) = rows(&key) {
            by_space.entry(space).or_default().push((stored, row));
        }
    }
    let disks = disks();
    for (space, rows) in by_space {
        let Some(disk) = disks.open.get(&space) else { continue };
        if let Err(error) = write(&disk.connection, &rows) {
            log::error!("états gardés sur le disque, {space} : {error}");
        }
    }
}

fn write(connection: &Connection, rows: &[(String, Option<Row>)]) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    for (stored, row) in rows {
        match row {
            Some(row) => {
                transaction.execute(
                    "INSERT INTO entries (key, module, client, instance, version, value, at, checked)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT (key) DO UPDATE SET module = ?2, client = ?3, instance = ?4, version = ?5, value = ?6,
                       at = ?7, checked = ?8",
                    params![
                        stored,
                        row.module,
                        row.client,
                        instance_of(&row.key).unwrap_or_default(),
                        row.version,
                        row.value,
                        row.at as i64,
                        row.checked.map(|at| at as i64)
                    ],
                )?;
            }
            None => {
                transaction.execute("DELETE FROM entries WHERE key = ?1", [stored])?;
            }
        }
    }
    transaction.commit()
}

/// Efface sur le disque les lignes d’un espace qui répondent à `filter` (`module = ?`, compte supprimé…).
pub(crate) fn delete_where(root: &str, filter: &str, values: &[&str]) {
    let disks = disks();
    let Some(disk) = disks.open.get(root) else { return };
    let sql = format!("DELETE FROM entries WHERE {filter}");
    if let Err(error) = disk.connection.execute(&sql, rusqlite::params_from_iter(values.iter())) {
        log::error!("états gardés sur le disque, {root} : {error}");
    }
}

/// Âge maximal choisi par l’utilisateur pour un état (`module/etat`), en secondes.
pub(crate) fn override_of(root: &str, name: &str) -> Option<u64> {
    disks().open.get(root).and_then(|disk| disk.overrides.get(name).copied())
}

pub(crate) fn overrides(root: &str) -> HashMap<String, u64> {
    disks().open.get(root).map(|disk| disk.overrides.clone()).unwrap_or_default()
}

/// Choisit (ou retire, avec `None`) l’âge maximal d’un état.
pub(crate) fn set_override(root: &str, name: &str, seconds: Option<u64>) -> AppResult<()> {
    let mut disks = disks();
    let Some(disk) = disks.open.get_mut(root) else {
        return Err(crate::error::AppError::new("Aucun espace de travail ouvert."));
    };
    match seconds {
        Some(seconds) => {
            disk.connection.execute(
                "INSERT INTO overrides (name, max_age) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET max_age = ?2",
                params![name, seconds as i64],
            )?;
            disk.overrides.insert(name.to_string(), seconds);
        }
        None => {
            disk.connection.execute("DELETE FROM overrides WHERE name = ?1", [name])?;
            disk.overrides.remove(name);
        }
    }
    Ok(())
}
