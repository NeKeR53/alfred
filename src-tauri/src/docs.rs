//! Documents de référence qu’Alfred dépose dans l’espace pour les agents. Ils appartiennent à Alfred : réécrits à
//! chaque ouverture, donc toujours à la version de l’application. La doc de socle-ui (`docs/alfred/socle/`) est celle
//! de la version installée au build (`socle_ui::DOCS`) : un fichier qui n’en fait plus partie est retiré.

use std::fs;
use std::path::Path;

use crate::error::AppResult;
use crate::space::Space;

const DESIGN: &str = include_str!("../../DESIGN.md");
const PLACEMENT: &str = include_str!("../../docs/espace/PLACEMENT.md");
const GUIDE: &str = include_str!("../../docs/espace/AGENTS.md");
const SDK: &str = include_str!("../../docs/espace/SDK.md");

fn write_if_changed(path: &Path, content: &str) -> AppResult<()> {
    if fs::read_to_string(path).is_ok_and(|current| current == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

/// Retire de `dir` les fichiers que la version courante ne livre plus (`keep` : chemins relatifs à `base`).
fn remove_stale(base: &Path, dir: &Path, keep: &[&str]) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            remove_stale(base, &path, keep);
            let _ = fs::remove_dir(&path); // seulement s’il est vide
        } else if let Ok(relative) = path.strip_prefix(base) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if !keep.contains(&relative.as_str()) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

pub fn materialize(space: &Space) -> AppResult<()> {
    write_if_changed(&space.root.join("AGENTS.md"), GUIDE)?;
    // Claude Code lit CLAUDE.md : il renvoie vers le même guide.
    write_if_changed(&space.root.join("CLAUDE.md"), "@AGENTS.md\n")?;
    write_if_changed(&space.root.join("docs/alfred/PLACEMENT.md"), PLACEMENT)?;
    write_if_changed(&space.root.join("docs/alfred/DESIGN.md"), DESIGN)?;
    write_if_changed(&space.root.join("docs/alfred/SDK.md"), SDK)?;
    let socle = space.root.join("docs/alfred/socle");
    for (relative, content) in crate::socle_ui::DOCS {
        write_if_changed(&socle.join(relative), content)?;
    }
    let keep: Vec<&str> = crate::socle_ui::DOCS.iter().map(|(relative, _)| *relative).collect();
    remove_stale(&socle, &socle, &keep);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_doc_de_socle_suit_la_version_installee() {
        let root = tempfile::tempdir().unwrap();
        let socle = root.path().join("docs/alfred/socle");
        fs::create_dir_all(socle.join("specs")).unwrap();
        fs::write(socle.join("specs/Ancien.md"), "retiré").unwrap();
        for (relative, content) in crate::socle_ui::DOCS {
            write_if_changed(&socle.join(relative), content).unwrap();
        }
        let keep: Vec<&str> = crate::socle_ui::DOCS.iter().map(|(relative, _)| *relative).collect();
        remove_stale(&socle, &socle, &keep);
        assert!(!socle.join("specs/Ancien.md").exists());
        assert!(socle.join("AI.md").exists());
        assert!(socle.join("specs/Drawer.md").exists());
        assert!(socle.join("docs/layout-rules.md").exists());
    }

    #[test]
    fn les_guides_renvoient_au_guide_de_placement() {
        assert!(GUIDE.contains("docs/alfred/PLACEMENT.md"));
        assert!(DESIGN.contains("PLACEMENT.md"));
        assert!(SDK.contains("PLACEMENT.md"));
        assert!(PLACEMENT.contains("alfred-question"));
    }
}
