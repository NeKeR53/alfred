//! Les espaces de travail de l’utilisateur, vus depuis les Réglages : renommer un espace sans l’ouvrir, et mettre
//! son dossier à la corbeille du système. La liste des espaces récents reste dans les réglages d’Alfred
//! (`spaces.recent`), tenue par l’interface.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{arg, AppError, AppResult};
use crate::space::{Space, SPACE_FILE};
use crate::state::AppState;

/// Longueur maximale d’un nom d’espace, en caractères.
const NAME_MAX: usize = 80;

fn same_folder(left: &Path, right: &Path) -> bool {
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(left) == canonical(right)
}

/// Le dossier doit être un espace d’Alfred : rien d’autre n’est renommé ni mis à la corbeille.
fn existing_space(path: &Path) -> AppResult<Space> {
    if !path.join(SPACE_FILE).is_file() {
        return Err(AppError::new(format!(
            "Le dossier {} n’est pas un espace de travail d’Alfred, ou il n’existe plus.",
            path.display()
        )));
    }
    Ok(Space { root: path.to_path_buf() })
}

/// Change le nom affiché d’un espace, ouvert ou non ; le dossier ne bouge pas. Renvoie le nom retenu.
pub fn rename(path: &Path, name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::new("Saisissez le nom de l’espace de travail."));
    }
    if name.chars().count() > NAME_MAX {
        return Err(AppError::new(format!("Le nom d’un espace de travail tient en {NAME_MAX} caractères au plus.")));
    }
    let space = existing_space(path)?;
    let mut manifest = space.manifest()?;
    if manifest.name == name {
        return Ok(manifest.name);
    }
    manifest.name = name.to_string();
    space.write_manifest(&manifest)?;
    crate::git::commit_all(&space.root, &format!("Renommage de l’espace de travail en « {name} »"))?;
    Ok(manifest.name)
}

/// Met le dossier d’un espace à la corbeille du système, d’où il se récupère. L’espace ouvert est refusé : on passe
/// d’abord sur un autre.
pub fn trash(path: &Path, open: Option<&Path>) -> AppResult<()> {
    if open.is_some_and(|open| same_folder(open, path)) {
        return Err(AppError::new("L’espace de travail ouvert ne peut pas être mis à la corbeille : ouvrez-en un autre d’abord."));
    }
    existing_space(path)?;
    trash::delete(path).map_err(|error| {
        AppError::new(format!("Le dossier {} n’a pas pu être mis à la corbeille : {error}", path.display()))
    })
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("spaces.") {
        return None;
    }
    let result = (|| -> AppResult<Value> {
        let path = PathBuf::from(arg::<String>(args, "path")?);
        let open = state.try_space().map(|space| space.root);
        match command {
            "spaces.rename" => {
                let name = rename(&path, &arg::<String>(args, "name")?)?;
                // L’espace ouvert renommé : le menu et les fenêtres relisent leur nom.
                if open.as_deref().is_some_and(|open| same_folder(open, &path)) {
                    state.emit("space:changed", Value::Null);
                }
                Ok(json!({ "name": name }))
            }
            "spaces.trash" => {
                trash(&path, open.as_deref())?;
                Ok(Value::Null)
            }
            _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
        }
    })();
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space_in(dir: &Path, name: &str) -> PathBuf {
        let root = dir.join(name);
        Space::open_or_create(&root, Some(name)).unwrap();
        root
    }

    #[test]
    fn renaming_changes_only_the_shown_name_and_commits_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = space_in(dir.path(), "Atelier");
        assert_eq!(rename(&root, "  Atelier Lyon ").unwrap(), "Atelier Lyon");
        assert_eq!(Space { root: root.clone() }.manifest().unwrap().name, "Atelier Lyon");
        assert!(root.is_dir(), "le dossier ne bouge pas");
        let log = crate::git::log(&root, 1, None).unwrap();
        assert!(log[0].message.contains("Atelier Lyon"), "{:?}", log[0].message);
    }

    #[test]
    fn renaming_refuses_an_empty_or_too_long_name_and_a_folder_that_is_not_a_space() {
        let dir = tempfile::tempdir().unwrap();
        let root = space_in(dir.path(), "Atelier");
        assert!(rename(&root, "   ").is_err());
        assert!(rename(&root, &"a".repeat(NAME_MAX + 1)).is_err());
        assert_eq!(Space { root: root.clone() }.manifest().unwrap().name, "Atelier");
        let plain = dir.path().join("photos");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(rename(&plain, "Photos").is_err());
        assert!(!plain.join(SPACE_FILE).exists(), "aucun espace n’est créé en renommant");
    }

    #[test]
    fn the_trash_refuses_the_open_space_and_a_folder_that_is_not_a_space() {
        let dir = tempfile::tempdir().unwrap();
        let root = space_in(dir.path(), "Atelier");
        assert!(trash(&root, Some(&root)).is_err());
        assert!(root.join(SPACE_FILE).is_file(), "l’espace ouvert reste en place");
        let plain = dir.path().join("photos");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(trash(&plain, None).is_err());
        assert!(plain.is_dir(), "un dossier ordinaire n’est jamais touché");
    }
}
