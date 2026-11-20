//! Dossiers du poste accordés à un module : les dépôts locaux des composants d’un produit, le dépôt partagé d’une
//! équipe (`.oneapp/`), un dossier de documentation. Une page n’a pas de disque ; l’utilisateur lui donne un dossier
//! (`folders.pick`, un sélecteur du système) ou l’agent le lui accorde d’avance (`grant_access`, `folder`).
//!
//! - L’accord vaut pour tout le module (ses pages, ses panneaux, ses fonctions) et il est gardé hors de l’espace,
//!   dans la base d’Alfred, là où l’agent ne l’écrit pas ; la fiche du module le montre et le retire.
//! - Chaque chemin donné par le module est relatif au dossier et confiné : ni `..`, ni chemin absolu, ni lecteur, ni
//!   lien symbolique qui en sort. Rien ne s’écrit dans `.git` (crochets, configuration).
//! - Une écriture est atomique (fichier voisin puis renommage), une suppression part à la corbeille du système.
//!
//! Git dans ces dossiers : `folder_git.rs`. Les agents lancés dans un dossier (S3) s’appuient sur `resolve_dir` et
//! `contains`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_db;
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::state::AppState;

const SETTING: &str = "folders";
/// Taille maximale d’un fichier lu ou écrit par une page ou une fonction.
pub const MAX_FILE: usize = 20 * 1024 * 1024;
/// Entrées rendues au plus par `folders.entries`.
const MAX_ENTRIES: usize = 10_000;
/// Profondeur maximale d’un parcours récursif.
const MAX_DEPTH: usize = 32;
/// Dossiers accordés au plus à un module.
const MAX_FOLDERS: usize = 64;
/// Dossiers surveillés en même temps, tous modules confondus.
const MAX_WATCHES: usize = 64;

/// Un dossier accordé à un module.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    /// Identifiant stable dans le module (`alpha-api`), celui que les appels nomment.
    pub id: String,
    /// Chemin absolu, tel que le poste l’écrit (sans le préfixe `\\?\` de Windows).
    pub path: String,
    /// Nom montré à l’utilisateur (le nom du dossier par défaut).
    pub label: String,
    pub granted_at: String,
    /// `user` (choisi dans le sélecteur) ou `agent` (`grant_access`).
    pub granted_by: String,
}

/// Une entrée d’un dossier.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Chemin relatif au dossier accordé, toujours avec des `/`.
    pub path: String,
    pub name: String,
    /// `file`, `dir` ou `link` (lien symbolique, jamais suivi).
    pub kind: &'static str,
    pub size: u64,
    pub modified_at: Option<String>,
}

// ---------------------------------------------------------------------------------------------------------------
// Accords
// ---------------------------------------------------------------------------------------------------------------

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn key(space: &Path, module: &str) -> String {
    format!("{}|{module}", space.to_string_lossy())
}

fn load_all(state: &AppState) -> AppResult<BTreeMap<String, Vec<Folder>>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    Ok(app_db::get_setting(&db, SETTING)?.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default())
}

fn save_all(state: &AppState, all: &BTreeMap<String, Vec<Folder>>) -> AppResult<()> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::set_setting(&db, SETTING, &serde_json::to_value(all)?)
}

/// Dossiers accordés au module dans l’espace ouvert.
pub fn list(state: &AppState, module: &str) -> AppResult<Vec<Folder>> {
    let space = state.space()?;
    Ok(load_all(state)?.remove(&key(&space.root, module)).unwrap_or_default())
}

/// Dossier `id` accordé au module.
pub fn get(state: &AppState, module: &str, id: &str) -> AppResult<Folder> {
    list(state, module)?.into_iter().find(|folder| folder.id == id).ok_or_else(|| {
        AppError::new(format!(
            "Le dossier « {id} » n’est pas accordé à ce module : faites-le choisir par l’utilisateur (`folders.pick`)."
        ))
    })
}

/// Retire le préfixe `\\?\` qu’ajoute `canonicalize` sous Windows : git, un éditeur ou `cmd.exe` ne le lisent pas.
pub fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Identifiant d’un dossier tiré de son nom : minuscules, chiffres et tirets.
fn slug(label: &str) -> String {
    let mut slug = String::new();
    for c in label.chars() {
        let c = match c {
            'à' | 'â' | 'ä' | 'À' | 'Â' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c => c.to_ascii_lowercase(),
        };
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_end_matches('-').chars().take(40).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() || !crate::space::valid_id(&slug) {
        "dossier".to_string()
    } else {
        slug
    }
}

/// Un dossier qui ne peut pas être accordé : la racine d’un disque, le dossier personnel lui-même, l’espace de
/// travail (le code des modules) ou les données d’Alfred (accords, coffre), ce qui les contient ou s’y trouve.
fn refuse_reserved(state: &AppState, canonical: &Path) -> AppResult<()> {
    if canonical.parent().is_none() {
        return Err(AppError::new("La racine d’un disque ne peut pas être accordée : choisissez un dossier précis."));
    }
    let home = crate::dispatch::home_dir().and_then(|home| home.canonicalize().ok());
    if home.as_deref() == Some(canonical) {
        return Err(AppError::new(
            "Le dossier personnel entier ne peut pas être accordé : choisissez le dossier du projet.",
        ));
    }
    let mut reserved = vec![("l’espace de travail", state.space()?.root.clone()), ("les données d’Alfred", state.data_dir.clone())];
    reserved.retain(|(_, path)| path.exists());
    for (what, path) in reserved {
        let Ok(path) = path.canonicalize() else { continue };
        if canonical.starts_with(&path) || path.starts_with(canonical) {
            return Err(AppError::new(format!(
                "« {} » contient {what} ou s’y trouve : Alfred ne l’accorde pas à un module.",
                plain(canonical).display()
            )));
        }
    }
    Ok(())
}

/// Accorde `path` au module ; le même dossier déjà accordé est rendu tel quel.
pub fn grant(state: &AppState, module: &str, path: &Path, label: Option<&str>, by: &str) -> AppResult<Folder> {
    if !crate::space::valid_id(module) {
        return Err(AppError::new("Module inconnu."));
    }
    if !path.is_absolute() {
        return Err(AppError::new(format!("Chemin absolu attendu : « {} ».", path.display())));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::new(format!("Le dossier « {} » n’existe pas.", path.display())))?;
    if !canonical.is_dir() {
        return Err(AppError::new(format!("« {} » n’est pas un dossier.", path.display())));
    }
    refuse_reserved(state, &canonical)?;
    let shown = plain(&canonical);
    let space = state.space()?;
    let _lock = store_lock().lock().map_err(|_| AppError::new("Les dossiers sont indisponibles."))?;
    let mut all = load_all(state)?;
    let folders = all.entry(key(&space.root, module)).or_default();
    if let Some(existing) = folders.iter().find(|folder| Path::new(&folder.path) == shown) {
        return Ok(existing.clone());
    }
    if folders.len() >= MAX_FOLDERS {
        return Err(AppError::new(format!("{MAX_FOLDERS} dossiers au plus par module.")));
    }
    let name = shown.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let label = label.map(str::trim).filter(|label| !label.is_empty()).map(str::to_string).unwrap_or(name);
    let label: String = label.chars().take(80).collect();
    let base = slug(&label);
    let mut id = base.clone();
    let mut rank = 2;
    while folders.iter().any(|folder| folder.id == id) {
        id = format!("{base}-{rank}");
        rank += 1;
    }
    let folder = Folder {
        id,
        path: shown.to_string_lossy().to_string(),
        label,
        granted_at: app_db::now(),
        granted_by: by.to_string(),
    };
    folders.push(folder.clone());
    save_all(state, &all)?;
    state.emit("folders:granted", json!({ "module": module, "folder": folder }));
    Ok(folder)
}

/// Retire l’accord d’un dossier ; ses fichiers restent sur le disque.
pub fn revoke(state: &AppState, module: &str, id: &str) -> AppResult<()> {
    let space = state.space()?;
    {
        let _lock = store_lock().lock().map_err(|_| AppError::new("Les dossiers sont indisponibles."))?;
        let mut all = load_all(state)?;
        if let Some(folders) = all.get_mut(&key(&space.root, module)) {
            folders.retain(|folder| folder.id != id);
        }
        save_all(state, &all)?;
    }
    stop_watch(&watch_key(&space.root, module, id));
    state.emit("folders:revoked", json!({ "module": module, "folder": id }));
    Ok(())
}

/// Oublie les dossiers d’un module désinstallé : un module installé ensuite sous le même identifiant n’en hérite pas.
pub fn forget_module(state: &AppState, module: &str) -> AppResult<()> {
    for folder in list(state, module)? {
        revoke(state, module, &folder.id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Chemins confinés
// ---------------------------------------------------------------------------------------------------------------

/// Racine réelle (liens résolus) d’un dossier accordé, et vérifiée encore présente.
fn root_of(folder: &Folder) -> AppResult<PathBuf> {
    let root = Path::new(&folder.path);
    root.canonicalize().ok().filter(|root| root.is_dir()).ok_or_else(|| {
        AppError::new(format!(
            "Le dossier « {} » ({}) n’existe plus : il a été déplacé ou supprimé.",
            folder.label, folder.path
        ))
    })
}

/// Composants d’un chemin relatif donné par un module ; refuse tout ce qui sortirait du dossier.
fn components(relative: &str) -> AppResult<Vec<String>> {
    if relative.len() > 4096 || relative.contains('\0') {
        return Err(AppError::new("Chemin invalide."));
    }
    let normalized = relative.replace('\\', "/");
    if normalized.starts_with('/') || normalized.as_bytes().get(1) == Some(&b':') {
        return Err(AppError::new(format!(
            "Chemin invalide : « {relative} ». Donne un chemin relatif au dossier (« docs/index.md »)."
        )));
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(AppError::new(format!("Chemin invalide : « {relative} » sort du dossier."))),
            // `:` désigne un lecteur ou un flux de données alternatif sous Windows.
            part if part.contains(':') => return Err(AppError::new(format!("Chemin invalide : « {relative} »."))),
            part => parts.push(part.to_string()),
        }
    }
    // Sous Windows, « fichier. » ou « fichier  » désignent « fichier » : on refuse ces noms ambigus partout.
    if parts.iter().any(|part| part.ends_with(['.', ' '])) {
        return Err(AppError::new(format!("Chemin invalide : « {relative} » (nom terminé par un point ou une espace).")));
    }
    Ok(parts)
}

/// Chemin réel de `relative` dans `root` (racine déjà résolue). Le chemin peut ne pas exister encore ; ce qui en
/// existe déjà, liens symboliques résolus, doit rester dans `root`.
pub fn resolve(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let mut path = root.to_path_buf();
    for part in components(relative)? {
        path.push(part);
    }
    // Le plus long préfixe existant, liens résolus, doit rester dans le dossier.
    let mut existing = path.as_path();
    loop {
        if std::fs::symlink_metadata(existing).is_ok() {
            break;
        }
        match existing.parent() {
            Some(parent) => existing = parent,
            None => break,
        }
    }
    let real = existing.canonicalize().unwrap_or_else(|_| existing.to_path_buf());
    if !real.starts_with(root) {
        return Err(AppError::new(format!("Chemin invalide : « {relative} » mène hors du dossier.")));
    }
    Ok(path)
}

/// Un chemin destiné à être écrit : jamais dans `.git` (crochets, configuration), jamais la racine elle-même.
fn writable(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let parts = components(relative)?;
    if parts.is_empty() {
        return Err(AppError::new("Donne le chemin d’un fichier ou d’un sous-dossier, pas le dossier lui-même."));
    }
    if parts.iter().any(|part| part.eq_ignore_ascii_case(".git")) {
        return Err(AppError::new("Alfred n’écrit jamais dans `.git` : passe par `git.*`."));
    }
    resolve(root, relative)
}

/// `path` est-il dans `root` (ou `root` lui-même), liens résolus ? Pour vérifier qu’un agent reste dans son dossier
/// (S3, agents lancés dans un dossier).
#[allow(dead_code)]
pub fn contains(root: &Path, path: &Path) -> bool {
    let Ok(root) = root.canonicalize() else { return false };
    let mut existing = path;
    while std::fs::symlink_metadata(existing).is_err() {
        match existing.parent() {
            Some(parent) => existing = parent,
            None => return false,
        }
    }
    existing.canonicalize().is_ok_and(|real| real.starts_with(&root))
}

/// Pour les agents lancés dans un dossier (S3) et `commands.run` : chemin absolu (sans `\\?\`) du sous-dossier
/// `sub` du dossier `id` accordé au module. Il doit exister et être un dossier.
pub fn resolve_dir(state: &AppState, module: &str, id: &str, sub: Option<&str>) -> AppResult<PathBuf> {
    let folder = get(state, module, id)?;
    let root = root_of(&folder)?;
    let path = resolve(&root, sub.unwrap_or_default())?;
    if !path.is_dir() {
        return Err(AppError::new(format!(
            "« {} » n’est pas un dossier de « {} ».",
            sub.unwrap_or_default(),
            folder.label
        )));
    }
    Ok(plain(&path))
}

fn relative_text(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|relative| relative.components().filter_map(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().to_string()),
            _ => None,
        }).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------------------------------------------

fn entry_of(root: &Path, path: &Path) -> Option<Entry> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let kind = if meta.file_type().is_symlink() {
        "link"
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    };
    let modified_at = meta.modified().ok().map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
    Some(Entry {
        path: relative_text(root, path),
        name: path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        kind,
        size: if kind == "file" { meta.len() } else { 0 },
        modified_at,
    })
}

/// Filtre `*`, `?` et `**` sur un chemin relatif à `/`. Sans `/` dans le motif, il porte sur le nom seul.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    fn segment(pattern: &[char], text: &[char]) -> bool {
        match (pattern.first(), text.first()) {
            (None, None) => true,
            (Some('*'), _) => segment(&pattern[1..], text) || (!text.is_empty() && segment(pattern, &text[1..])),
            (Some('?'), Some(_)) => segment(&pattern[1..], &text[1..]),
            (Some(p), Some(t)) if p.eq_ignore_ascii_case(t) => segment(&pattern[1..], &text[1..]),
            _ => false,
        }
    }
    fn parts(pattern: &[&str], path: &[&str]) -> bool {
        match pattern.first() {
            None => path.is_empty(),
            Some(&"**") => (0..=path.len()).any(|skip| parts(&pattern[1..], &path[skip..])),
            Some(first) => {
                !path.is_empty()
                    && segment(&first.chars().collect::<Vec<_>>(), &path[0].chars().collect::<Vec<_>>())
                    && parts(&pattern[1..], &path[1..])
            }
        }
    }
    let pattern = pattern.replace('\\', "/");
    if !pattern.contains('/') {
        let name = path.rsplit('/').next().unwrap_or(path);
        return segment(&pattern.chars().collect::<Vec<_>>(), &name.chars().collect::<Vec<_>>());
    }
    let pattern: Vec<&str> = pattern.split('/').filter(|part| !part.is_empty()).collect();
    let path: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    parts(&pattern, &path)
}

/// Entrées de `relative` ; récursif avec `recursive` (sans entrer dans `.git` ni suivre de lien), filtrées par
/// `glob`. Triées par chemin.
pub fn entries(root: &Path, relative: &str, recursive: bool, glob: Option<&str>) -> AppResult<(Vec<Entry>, bool)> {
    let start = resolve(root, relative)?;
    if !start.is_dir() {
        return Err(AppError::new(format!("« {relative} » n’est pas un dossier.")));
    }
    let mut found = Vec::new();
    let mut truncated = false;
    let mut pending = vec![(start, 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for item in read.flatten() {
            let path = item.path();
            let Some(entry) = entry_of(root, &path) else { continue };
            if recursive && entry.kind == "dir" && entry.name != ".git" && depth + 1 < MAX_DEPTH {
                pending.push((path, depth + 1));
            }
            if glob.is_none_or(|glob| glob_matches(glob, &entry.path)) {
                if found.len() >= MAX_ENTRIES {
                    truncated = true;
                    break;
                }
                found.push(entry);
            }
        }
        if truncated {
            break;
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((found, truncated))
}

pub fn read_bytes(root: &Path, relative: &str) -> AppResult<Vec<u8>> {
    let path = resolve(root, relative)?;
    let meta = std::fs::metadata(&path).map_err(|_| AppError::new(format!("Le fichier « {relative} » n’existe pas.")))?;
    if !meta.is_file() {
        return Err(AppError::new(format!("« {relative} » n’est pas un fichier.")));
    }
    if meta.len() as usize > MAX_FILE {
        return Err(AppError::new(format!("« {relative} » dépasse {} Mo.", MAX_FILE / 1024 / 1024)));
    }
    Ok(std::fs::read(&path)?)
}

/// Texte UTF-8 (BOM retiré).
pub fn read_text(root: &Path, relative: &str) -> AppResult<String> {
    let bytes = read_bytes(root, relative)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// Écrit `bytes` à la place de `relative` d’un seul geste : un fichier voisin, puis un renommage. Les dossiers
/// parents sont créés.
pub fn write_bytes(root: &Path, relative: &str, bytes: &[u8]) -> AppResult<()> {
    if bytes.len() > MAX_FILE {
        return Err(AppError::new(format!("Contenu trop gros : {} Mo au plus.", MAX_FILE / 1024 / 1024)));
    }
    let path = writable(root, relative)?;
    if path.is_dir() {
        return Err(AppError::new(format!("« {relative} » est un dossier.")));
    }
    if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AppError::new(format!("« {relative} » est un lien symbolique : Alfred ne l’écrase pas.")));
    }
    let parent = path.parent().ok_or_else(|| AppError::new("Chemin invalide."))?;
    std::fs::create_dir_all(parent)?;
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let staging = parent.join(format!(".{name}.alfred-{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&staging)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        retrying(|| std::fs::rename(&staging, &path))
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&staging);
        return Err(error.into());
    }
    Ok(())
}

/// Sous Windows, un antivirus ou un éditeur qui tient le fichier fait échouer un renommage un instant.
fn retrying(mut operation: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match operation() {
            Err(error) if cfg!(windows) && attempt < 10 && matches!(error.raw_os_error(), Some(5 | 32)) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
            other => return other,
        }
    }
}

pub fn mkdir(root: &Path, relative: &str) -> AppResult<()> {
    Ok(std::fs::create_dir_all(writable(root, relative)?)?)
}

/// Envoie un fichier ou un dossier à la corbeille du système (supprimé directement dans les tests).
pub fn remove(root: &Path, relative: &str) -> AppResult<()> {
    let path = writable(root, relative)?;
    if std::fs::symlink_metadata(&path).is_err() {
        return Err(AppError::new(format!("« {relative} » n’existe pas.")));
    }
    #[cfg(test)]
    {
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }
    #[cfg(not(test))]
    trash::delete(plain(&path)).map_err(|error| AppError::new(format!("« {relative} » n’a pas pu aller à la corbeille : {error}")))
}

/// Renomme ou déplace dans le dossier ; refuse d’écraser une entrée existante.
pub fn rename(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let source = writable(root, from)?;
    let target = writable(root, to)?;
    if std::fs::symlink_metadata(&source).is_err() {
        return Err(AppError::new(format!("« {from} » n’existe pas.")));
    }
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(AppError::new(format!("« {to} » existe déjà.")));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(retrying(|| std::fs::rename(&source, &target))?)
}

// ---------------------------------------------------------------------------------------------------------------
// Surveillance
// ---------------------------------------------------------------------------------------------------------------

/// Délai pendant lequel les changements sont regroupés avant d’être signalés.
const SETTLE: Duration = Duration::from_millis(300);

fn watches() -> &'static Mutex<HashMap<String, notify::RecommendedWatcher>> {
    static WATCHES: OnceLock<Mutex<HashMap<String, notify::RecommendedWatcher>>> = OnceLock::new();
    WATCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn watch_key(space: &Path, module: &str, id: &str) -> String {
    format!("{}|{module}|{id}", space.to_string_lossy())
}

fn stop_watch(key: &str) {
    if let Ok(mut all) = watches().lock() {
        all.remove(key);
    }
}

/// Ce qu’on signale d’un chemin changé : son chemin relatif, `.git` pour l’état du dépôt (branche, index, réfs),
/// rien pour les objets, journaux et verrous de git ni pour un fichier d’écriture d’Alfred.
fn reported(root: &Path, path: &Path) -> Option<String> {
    let relative = relative_text(root, path);
    let parts: Vec<&str> = relative.split('/').collect();
    if let Some(at) = parts.iter().position(|part| *part == ".git") {
        let inner = &parts[at + 1..];
        let noisy = inner.first().is_some_and(|first| matches!(*first, "objects" | "logs" | "lfs"))
            || relative.ends_with(".lock");
        let prefix = parts[..at].join("/");
        return (!noisy).then(|| if prefix.is_empty() { ".git".to_string() } else { format!("{prefix}/.git") });
    }
    if parts.last().is_some_and(|name| name.starts_with('.') && name.ends_with(".tmp") && name.contains(".alfred-")) {
        return None;
    }
    Some(relative)
}

/// Surveille le dossier : chaque lot de changements émet `folders:changed` `{ module, folder, paths }`, que la
/// coquille relaie aux pages du module (`folders.watch`). Une seule surveillance par dossier.
pub fn watch(state: &Arc<AppState>, module: &str, id: &str) -> AppResult<()> {
    let folder = get(state, module, id)?;
    let root = root_of(&folder)?;
    let space = state.space()?;
    let key = watch_key(&space.root, module, id);
    let mut all = watches().lock().map_err(|_| AppError::new("La surveillance est indisponible."))?;
    // Les surveillances d’un autre espace ne servent plus.
    let prefix = format!("{}|", space.root.to_string_lossy());
    all.retain(|key, _| key.starts_with(&prefix));
    if all.contains_key(&key) {
        return Ok(());
    }
    if all.len() >= MAX_WATCHES {
        return Err(AppError::new(format!("{MAX_WATCHES} dossiers surveillés au plus.")));
    }
    let (sender, receiver) = std::sync::mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        for path in event.paths {
            let _ = sender.send(path);
        }
    })
    .map_err(|error| AppError::new(format!("Surveillance du dossier impossible : {error}")))?;
    notify::Watcher::watch(&mut watcher, &root, notify::RecursiveMode::Recursive)
        .map_err(|error| AppError::new(format!("Surveillance du dossier impossible : {error}")))?;
    let weak = Arc::downgrade(state);
    let (module, id) = (module.to_string(), id.to_string());
    // Le fil s’arrête quand la surveillance est abandonnée (son émetteur avec elle).
    std::thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut paths = std::collections::BTreeSet::new();
            paths.extend(reported(&root, &first));
            while let Ok(next) = receiver.recv_timeout(SETTLE) {
                paths.extend(reported(&root, &next));
            }
            if paths.is_empty() {
                continue;
            }
            let Some(state) = weak.upgrade() else { return };
            let paths: Vec<String> = paths.into_iter().take(500).collect();
            state.emit("folders:changed", json!({ "module": module, "folder": id, "paths": paths }));
        }
    });
    all.insert(key, watcher);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Ouvrir dans l’éditeur, l’explorateur ou le terminal
// ---------------------------------------------------------------------------------------------------------------

/// Éditeurs de code cherchés dans le PATH, dans cet ordre.
const EDITORS: [&str; 4] = ["code", "cursor", "zed", "subl"];

fn spawn(program: &Path, args: &[&std::ffi::OsStr], dir: &Path) -> AppResult<()> {
    let mut command = std::process::Command::new(program);
    command.args(args).current_dir(dir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    command.spawn().map(|_| ()).map_err(|error| AppError::new(format!("« {} » n’a pas pu être lancé : {error}", program.display())))
}

/// Ouvre `path` (absolu, déjà confiné) dans l’éditeur de code du poste ; à défaut, avec le système.
pub fn open_in_editor(path: &Path) -> AppResult<&'static str> {
    let dir = if path.is_dir() { path.to_path_buf() } else { path.parent().map(Path::to_path_buf).unwrap_or_default() };
    for editor in EDITORS {
        if let Ok(program) = crate::commands::resolve(editor) {
            if !cfg!(test) {
                spawn(&program, &[path.as_os_str()], &dir)?;
            }
            return Ok(editor);
        }
    }
    if !cfg!(test) {
        crate::conversations::open_with_system(path, false)?;
    }
    Ok("system")
}

/// Ouvre un terminal du poste dans `dir` : Terminal sur Mac ; Windows Terminal, à défaut Git Bash, à défaut l’invite
/// de commandes sous Windows ; l’émulateur par défaut sous Linux.
pub fn open_terminal(dir: &Path) -> AppResult<()> {
    if !dir.is_dir() {
        return Err(AppError::new(format!("« {} » n’est pas un dossier.", dir.display())));
    }
    if cfg!(test) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        spawn(Path::new("open"), &["-a".as_ref(), "Terminal".as_ref(), dir.as_os_str()], dir)
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(wt) = crate::commands::resolve("wt") {
            return spawn(&wt, &["-d".as_ref(), dir.as_os_str()], dir);
        }
        // Git Bash est à côté de `cmd\git.exe` dans le dossier de Git for Windows (jamais le git de WSL).
        if let Ok(git) = crate::commands::resolve("git") {
            if let Some(bash) = git.parent().and_then(Path::parent).map(|root| root.join("git-bash.exe")).filter(|bash| bash.is_file()) {
                let cd = std::ffi::OsString::from(format!("--cd={}", dir.display()));
                return spawn(&bash, &[cd.as_os_str()], dir);
            }
        }
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/c", "start", "", "/D"]).arg(dir).arg("cmd.exe").current_dir(dir);
        command.spawn().map(|_| ()).map_err(|error| AppError::new(format!("Le terminal n’a pas pu être ouvert : {error}")))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if let Ok(program) = crate::commands::resolve(terminal) {
                return spawn(&program, &[], dir);
            }
        }
        Err(AppError::new("Aucun terminal trouvé sur ce poste."))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

/// Un geste de l’utilisateur (choisir, ouvrir) ne se déclenche pas depuis une fonction en arrière-plan.
fn interactive(subject: &Subject) -> AppResult<()> {
    if subject.kind == "function" {
        return Err(AppError::new("Une fonction ne peut pas ouvrir de fenêtre : faites-le depuis une page."));
    }
    Ok(())
}

/// Racine résolue du dossier nommé par `folder` dans les arguments d’un appel.
pub(crate) fn root_from(state: &AppState, subject: &Subject, args: &Value) -> AppResult<(Folder, PathBuf)> {
    let id: String = arg(args, "folder").map_err(|_| AppError::new("Donne `folder`, l’identifiant d’un dossier accordé."))?;
    let folder = get(state, &subject.module, &id)?;
    let root = root_of(&folder)?;
    Ok((folder, root))
}

fn path_arg(args: &Value) -> AppResult<String> {
    Ok(opt_arg::<String>(args, "path")?.unwrap_or_default())
}

fn bytes_from(args: &Value) -> AppResult<Vec<u8>> {
    if let Some(text) = opt_arg::<String>(args, "text")? {
        return Ok(text.into_bytes());
    }
    let data: String = arg(args, "data").map_err(|_| AppError::new("Fournir `data` (base64) ou `text`."))?;
    base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| AppError::new("`data` doit être du base64."))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(work).await.unwrap_or_else(|_| Err(AppError::new("L’opération a été interrompue.")))
}

async fn frame(state: &Arc<AppState>, command: &str, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let module = subject.module.clone();
    match command {
        "frame.folders.list" => return Ok(json!(list(state, &module)?)),
        "frame.folders.get" => return Ok(json!(get(state, &module, &arg::<String>(args, "folder")?)?)),
        // Ne vient que de la coquille, après le sélecteur de dossiers montré à l’utilisateur.
        "frame.folders.grantPicked" => {
            interactive(&subject)?;
            let path: String = arg(args, "path")?;
            let label: Option<String> = opt_arg(args, "label")?;
            return Ok(json!(grant(state, &module, Path::new(&path), label.as_deref(), "user")?));
        }
        "frame.folders.forget" => {
            revoke(state, &module, &arg::<String>(args, "folder")?)?;
            return Ok(Value::Null);
        }
        "frame.folders.watch" => {
            watch(state, &module, &arg::<String>(args, "folder")?)?;
            return Ok(Value::Null);
        }
        _ => {}
    }
    let (folder, root) = root_from(state, &subject, args)?;
    let path = path_arg(args)?;
    let args = args.clone();
    match command {
        "frame.folders.entries" => blocking(move || {
            let recursive = opt_arg::<bool>(&args, "recursive")?.unwrap_or(false);
            let glob: Option<String> = opt_arg(&args, "glob")?;
            let (found, truncated) = entries(&root, &path, recursive || glob.as_deref().is_some_and(|glob| glob.contains('/')), glob.as_deref())?;
            Ok(json!({ "entries": found, "truncated": truncated }))
        })
        .await,
        "frame.folders.stat" => blocking(move || {
            let target = resolve(&root, &path)?;
            Ok(entry_of(&root, &target).map_or(Value::Null, |entry| json!(entry)))
        })
        .await,
        "frame.folders.readText" => blocking(move || Ok(Value::String(read_text(&root, &path)?))).await,
        "frame.folders.readFile" => blocking(move || {
            Ok(json!({ "data": base64::engine::general_purpose::STANDARD.encode(read_bytes(&root, &path)?) }))
        })
        .await,
        "frame.folders.writeText" | "frame.folders.writeFile" => blocking(move || {
            write_bytes(&root, &path, &bytes_from(&args)?)?;
            Ok(Value::Null)
        })
        .await,
        "frame.folders.mkdir" => blocking(move || mkdir(&root, &path).map(|()| Value::Null)).await,
        "frame.folders.remove" => blocking(move || remove(&root, &path).map(|()| Value::Null)).await,
        "frame.folders.rename" => blocking(move || {
            let to: String = arg(&args, "to")?;
            rename(&root, &path, &to).map(|()| Value::Null)
        })
        .await,
        "frame.folders.open" => {
            interactive(&subject)?;
            let app = opt_arg::<String>(&args, "app")?.unwrap_or_else(|| "explorer".into());
            let target = plain(&resolve(&root, &path)?);
            if std::fs::symlink_metadata(&target).is_err() {
                return Err(AppError::new(format!("« {path} » n’existe pas dans « {} ».", folder.label)));
            }
            match app.as_str() {
                "editor" => Ok(json!({ "opened": open_in_editor(&target)? })),
                "terminal" => {
                    let dir = if target.is_dir() { target } else { target.parent().map(Path::to_path_buf).unwrap_or(target) };
                    open_terminal(&dir)?;
                    Ok(json!({ "opened": "terminal" }))
                }
                "explorer" => {
                    if !cfg!(test) {
                        // Un dossier s’ouvre dans le Finder ou l’Explorateur ; un fichier y est montré, jamais lancé.
                        crate::conversations::open_with_system(&target, !target.is_dir())?;
                    }
                    Ok(json!({ "opened": "explorer" }))
                }
                other => Err(AppError::new(format!("`app` vaut « explorer », « editor » ou « terminal », pas « {other} »."))),
            }
        }
        _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
    }
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        // Fiche du module (Réglages › Modules) : la coquille, jamais un cadre.
        "folders.list" => Some(arg::<String>(args, "module").and_then(|module| list(state, &module)).map(|folders| json!(folders))),
        "folders.revoke" => Some((|| {
            let module: String = arg(args, "module")?;
            revoke(state, &module, &arg::<String>(args, "folder")?)?;
            Ok(Value::Null)
        })()),
        command if command.starts_with("frame.folders.") => Some(frame(state, command, args).await),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn granted(state: &Arc<AppState>, dir: &Path) -> (Folder, PathBuf) {
        let folder = grant(state, "produits", dir, None, "user").unwrap();
        let root = root_of(&folder).unwrap();
        (folder, root)
    }

    #[test]
    fn relative_paths_never_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        assert_eq!(resolve(&root, "docs/a.md").unwrap(), root.join("docs").join("a.md"));
        assert_eq!(resolve(&root, "").unwrap(), root);
        assert_eq!(resolve(&root, "./docs\\b.md").unwrap(), root.join("docs").join("b.md"));
        for bad in ["../x", "docs/../../x", "/etc/passwd", "C:\\Windows", "c:x", "a.txt:flux", "fichier.", "nom "] {
            assert!(resolve(&root, bad).is_err(), "{bad}");
        }
        assert!(writable(&root, ".git/hooks/pre-commit").is_err());
        assert!(writable(&root, "sous/.GIT/config").is_err());
        assert!(writable(&root, "").is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join("sortie")).unwrap();
            assert!(resolve(&root, "sortie/secret.txt").is_err(), "un lien qui sort du dossier est refusé");
            assert!(!contains(&root, &root.join("sortie/secret.txt")));
            std::os::unix::fs::symlink(root.join("docs"), root.join("raccourci")).unwrap();
            assert!(resolve(&root, "raccourci/a.md").is_ok(), "un lien qui reste dans le dossier passe");
        }
        assert!(contains(&root, &root.join("docs/neuf/x.txt")));
        assert!(!contains(&root, dir.path().parent().unwrap()));
    }

    #[test]
    fn globs_match_names_and_paths() {
        assert!(glob_matches("*.md", "docs/index.md"));
        assert!(glob_matches("*.MD", "README.md"));
        assert!(!glob_matches("*.md", "docs/index.mdx"));
        assert!(glob_matches("docs/**/*.md", "docs/a/b/c.md"));
        assert!(glob_matches("docs/**/*.md", "docs/c.md"));
        assert!(!glob_matches("docs/*.md", "docs/a/c.md"));
        assert!(glob_matches(".oneapp/produits/?.json", ".oneapp/produits/a.json"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_module_reads_and_writes_only_its_granted_folders() {
        let (state, dir) = crate::clients::testing::test_state();
        let repo = dir.path().join("Dépôt Équipe");
        std::fs::create_dir_all(repo.join(".oneapp")).unwrap();
        std::fs::write(repo.join(".oneapp/produits.json"), "\u{feff}{\"produits\":[]}").unwrap();

        // Ni la racine, ni l’espace de travail, ni les données d’Alfred.
        assert!(grant(&state, "produits", Path::new("/"), None, "user").is_err());
        assert!(grant(&state, "produits", &state.space().unwrap().root, None, "user").is_err());
        assert!(grant(&state, "produits", &state.data_dir, None, "user").is_err());
        assert!(grant(&state, "produits", Path::new("relatif"), None, "user").is_err());

        let (folder, root) = granted(&state, &repo);
        assert_eq!(folder.id, "depot-equipe");
        assert_eq!(folder.label, "Dépôt Équipe");
        assert_eq!(grant(&state, "produits", &repo, Some("Autre"), "user").unwrap(), folder, "même dossier, même accord");
        let call = |command: &str, extra: Value| {
            let state = state.clone();
            let mut args = json!({ "subject": { "kind": "page", "module": "produits", "reference": "produits/liste" }, "folder": "depot-equipe" });
            for (key, value) in extra.as_object().unwrap() {
                args[key] = value.clone();
            }
            let command = command.to_string();
            async move { handle(&state, &command, &args).await.unwrap() }
        };
        assert_eq!(call("frame.folders.readText", json!({ "path": ".oneapp/produits.json" })).await.unwrap(), "{\"produits\":[]}");
        call("frame.folders.writeText", json!({ "path": ".oneapp/produits/alpha.json", "text": "{\"nom\":\"Alpha\"}\n" })).await.unwrap();
        assert_eq!(std::fs::read_to_string(repo.join(".oneapp/produits/alpha.json")).unwrap(), "{\"nom\":\"Alpha\"}\n");
        call("frame.folders.writeText", json!({ "path": ".oneapp/produits/alpha.json", "text": "{}" })).await.unwrap();
        let listed = call("frame.folders.entries", json!({ "path": ".oneapp", "recursive": true })).await.unwrap();
        let paths: Vec<&str> = listed["entries"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap()).collect();
        assert_eq!(paths, vec![".oneapp/produits", ".oneapp/produits.json", ".oneapp/produits/alpha.json"], "aucun fichier d’écriture ne reste");
        let globbed = call("frame.folders.entries", json!({ "glob": "**/*.json" })).await.unwrap();
        assert_eq!(globbed["entries"].as_array().unwrap().len(), 2);
        assert!(call("frame.folders.readText", json!({ "path": "../secret" })).await.is_err());
        assert!(call("frame.folders.writeText", json!({ "path": ".git/config", "text": "x" })).await.is_err());
        call("frame.folders.rename", json!({ "path": ".oneapp/produits/alpha.json", "to": ".oneapp/archives/alpha.json" })).await.unwrap();
        assert!(call("frame.folders.stat", json!({ "path": ".oneapp/produits/alpha.json" })).await.unwrap().is_null());
        assert_eq!(call("frame.folders.stat", json!({ "path": ".oneapp/archives/alpha.json" })).await.unwrap()["kind"], "file");
        call("frame.folders.remove", json!({ "path": ".oneapp/archives" })).await.unwrap();
        assert!(!repo.join(".oneapp/archives").exists());
        let _ = root;

        // Un autre module n’y a pas accès.
        let other = json!({ "subject": { "kind": "page", "module": "ventes", "reference": "ventes/liste" }, "folder": "depot-equipe", "path": ".oneapp/produits.json" });
        assert!(handle(&state, "frame.folders.readText", &other).await.unwrap().is_err());
        // Une fonction ne peut pas faire choisir un dossier.
        let picked = json!({ "subject": { "kind": "function", "module": "produits", "reference": "produits/f" }, "path": dir.path() });
        assert!(handle(&state, "frame.folders.grantPicked", &picked).await.unwrap().is_err());

        // S3 : sous-dossier absolu pour lancer un agent, refusé hors du dossier.
        let sub = resolve_dir(&state, "produits", "depot-equipe", Some(".oneapp")).unwrap();
        assert!(sub.ends_with(".oneapp"));
        assert!(resolve_dir(&state, "produits", "depot-equipe", Some("..")).is_err());
        assert!(resolve_dir(&state, "produits", "depot-equipe", Some(".oneapp/produits.json")).is_err());

        // Retiré, l’accord ne vaut plus ; les fichiers restent.
        revoke(&state, "produits", "depot-equipe").unwrap();
        assert!(call("frame.folders.readText", json!({ "path": ".oneapp/produits.json" })).await.is_err());
        assert!(repo.join(".oneapp/produits.json").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_watched_folder_reports_its_changes_in_batches() {
        let (state, dir) = crate::clients::testing::test_state();
        let repo = dir.path().join("depot");
        std::fs::create_dir_all(repo.join(".git/objects")).unwrap();
        granted(&state, &repo);
        let mut events = state.events.subscribe();
        watch(&state, "produits", "depot").unwrap();
        watch(&state, "produits", "depot").unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        std::fs::write(repo.join(".git/objects/xx"), "x").unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        let event = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.name == "folders:changed" {
                    return event;
                }
            }
        })
        .await
        .expect("un changement signalé");
        assert_eq!(event.payload["module"], "produits");
        assert_eq!(event.payload["folder"], "depot");
        let paths: Vec<&str> = event.payload["paths"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(paths.contains(&"a.txt"), "{paths:?}");
        assert!(!paths.iter().any(|path| path.contains("objects")), "{paths:?}");
        revoke(&state, "produits", "depot").unwrap();
    }

    #[test]
    fn reported_paths_hide_git_internals() {
        let root = Path::new("/r");
        assert_eq!(reported(root, Path::new("/r/src/a.rs")).as_deref(), Some("src/a.rs"));
        assert_eq!(reported(root, Path::new("/r/.git/index")).as_deref(), Some(".git"));
        assert_eq!(reported(root, Path::new("/r/api/.git/refs/heads/main")).as_deref(), Some("api/.git"));
        assert_eq!(reported(root, Path::new("/r/.git/objects/ab/cd")), None);
        assert_eq!(reported(root, Path::new("/r/.git/index.lock")), None);
        assert_eq!(reported(root, Path::new("/r/.a.json.alfred-0123.tmp")), None);
    }

    #[test]
    fn windows_verbatim_prefixes_are_removed() {
        assert_eq!(plain(Path::new(r"\\?\C:\Projets\alpha")), PathBuf::from(r"C:\Projets\alpha"));
        assert_eq!(plain(Path::new(r"\\?\UNC\serveur\partage\alpha")), PathBuf::from(r"\\serveur\partage\alpha"));
        assert_eq!(plain(Path::new("/Users/a")), PathBuf::from("/Users/a"));
        assert_eq!(slug("Dépôt Équipe"), "depot-equipe");
        assert_eq!(slug("!!!"), "dossier");
    }
}
