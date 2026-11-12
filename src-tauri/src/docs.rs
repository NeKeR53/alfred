//! Documents de référence qu’Alfred dépose dans l’espace pour les agents. Ils appartiennent à Alfred : réécrits à
//! chaque ouverture, donc toujours à la version de l’application.

use std::fs;

use crate::error::AppResult;
use crate::space::Space;

const DESIGN: &str = include_str!("../../DESIGN.md");
const GUIDE: &str = include_str!("../../docs/espace/AGENTS.md");
const SDK: &str = include_str!("../../docs/espace/SDK.md");

fn write_if_changed(path: &std::path::Path, content: &str) -> AppResult<()> {
    if fs::read_to_string(path).is_ok_and(|current| current == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

pub fn materialize(space: &Space) -> AppResult<()> {
    write_if_changed(&space.root.join("AGENTS.md"), GUIDE)?;
    // Claude Code lit CLAUDE.md : il renvoie vers le même guide.
    write_if_changed(&space.root.join("CLAUDE.md"), "@AGENTS.md\n")?;
    write_if_changed(&space.root.join("docs/alfred/DESIGN.md"), DESIGN)?;
    write_if_changed(&space.root.join("docs/alfred/SDK.md"), SDK)?;
    Ok(())
}
