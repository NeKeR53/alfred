//! Références de la saisie, reprises de OneApp (`composer_references.rs`) : `@` cherche un fichier du dossier de
//! travail de la conversation, `/` liste les commandes et les skills que le harnais de la conversation sait lire.
//! La recherche est bornée (profondeur, nombre d’entrées visitées, nombre de résultats) et ne sort jamais du dossier.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::error::{arg, AppError, AppResult};
use crate::state::AppState;

const MAX_VISITED: usize = 20_000;
const MAX_FILES: usize = 50;
const MAX_DEPTH: usize = 12;
const MAX_CATALOG: usize = 2_000;
const IGNORED: [&str; 7] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".alfred",
    ".DS_Store",
];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceKind {
    File,
    Skill,
    Command,
}

#[derive(Debug, Serialize)]
pub struct Reference {
    pub name: String,
    pub path: String,
    pub kind: ReferenceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

pub async fn handle(
    _state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Option<AppResult<Value>> {
    if command != "composer.references" {
        return None;
    }
    Some(
        async {
            let cwd: String = arg(args, "cwd")?;
            let provider: String = arg(args, "provider")?;
            let kind: String = arg(args, "kind")?;
            let query: String = arg(args, "query")?;
            if !["claude", "codex", "opencode"].contains(&provider.as_str())
                || !["file", "command"].contains(&kind.as_str())
                || query.len() > 500
                || query.chars().any(char::is_control)
                || cwd.len() > 32_000
            {
                return Err(AppError::new("Recherche de références invalide."));
            }
            let found = tokio::task::spawn_blocking(move || {
                let cwd = PathBuf::from(&cwd);
                if !cwd.is_absolute() || !cwd.is_dir() {
                    return Err(AppError::new(
                        "Le dossier de travail de la conversation est inaccessible.",
                    ));
                }
                if kind == "file" {
                    search_files(&cwd, &query)
                } else {
                    let mut items = catalog(&cwd, &provider, "command", &home_dir());
                    items.extend(catalog(&cwd, &provider, "skill", &home_dir()));
                    Ok(items)
                }
            })
            .await
            .map_err(|_| AppError::new("La recherche de références a été interrompue."))??;
            Ok(serde_json::to_value(found)?)
        }
        .await,
    )
}

fn home_dir() -> Option<PathBuf> {
    crate::dispatch::home_dir()
}

/// Fichiers et dossiers dont le chemin relatif contient la recherche, ou en reprend les lettres dans l’ordre (à
/// partir de trois lettres : « sft » trouve « src/fichier.ts »). Les liens symboliques ne sont pas suivis.
pub fn search_files(root: &Path, query: &str) -> AppResult<Vec<Reference>> {
    let root = root
        .canonicalize()
        .map_err(|_| AppError::new("Le dossier de travail est inaccessible."))?;
    let query = query.replace('\\', "/").to_lowercase();
    let mut pending = vec![(root.clone(), 0)];
    let mut result = Vec::new();
    let mut visited = 0;
    'walk: while let Some((directory, depth)) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) if directory == root => {
                return Err(AppError::new("Impossible de lire le dossier de travail."))
            }
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_VISITED || result.len() >= MAX_FILES {
                break 'walk;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if IGNORED.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let normalized = relative.to_lowercase();
            let mut letters = query.chars().peekable();
            for character in normalized.chars() {
                if letters.peek() == Some(&character) {
                    letters.next();
                }
            }
            if normalized.contains(&query)
                || (query.chars().count() >= 3 && letters.peek().is_none())
            {
                result.push(Reference {
                    name: format!("{relative}{}", if kind.is_dir() { "/" } else { "" }),
                    path: path.to_string_lossy().into_owned(),
                    kind: ReferenceKind::File,
                    description: None,
                });
            }
            if kind.is_dir() && depth < MAX_DEPTH {
                pending.push((path, depth + 1));
            }
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Dossiers où chaque harnais lit ses commandes et ses skills : le dossier de travail et ses parents, puis le
/// dossier personnel. Le premier trouvé l’emporte, comme pour le harnais.
fn catalog_roots(cwd: &Path, provider: &str, kind: &str, home: &Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    match (provider, kind) {
        ("claude", _) => {
            let folder = if kind == "skill" {
                "skills"
            } else {
                "commands"
            };
            roots.extend(
                cwd.ancestors()
                    .map(|ancestor| ancestor.join(".claude").join(folder)),
            );
            roots.extend(home.iter().map(|home| home.join(".claude").join(folder)));
        }
        ("codex", _) => {
            let codex = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|home| home.join(".codex")));
            if kind == "skill" {
                roots.extend(cwd.ancestors().flat_map(|ancestor| {
                    [
                        ancestor.join(".agents/skills"),
                        ancestor.join(".codex/skills"),
                    ]
                }));
                roots.extend(codex.iter().map(|codex| codex.join("skills")));
                roots.extend(home.iter().map(|home| home.join(".agents/skills")));
            } else {
                roots.extend(codex.iter().map(|codex| codex.join("prompts")));
            }
        }
        _ => {
            if kind == "skill" {
                for ancestor in cwd.ancestors() {
                    for relative in [".opencode/skills", ".agents/skills", ".claude/skills"] {
                        roots.push(ancestor.join(relative));
                    }
                }
            } else {
                roots.extend(
                    cwd.ancestors()
                        .map(|ancestor| ancestor.join(".opencode/commands")),
                );
            }
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|home| home.join(".config")));
            roots.extend(config.iter().map(|config| {
                config.join("opencode").join(if kind == "skill" {
                    "skills"
                } else {
                    "commands"
                })
            }));
            if kind == "skill" {
                roots.extend(
                    home.iter().flat_map(|home| {
                        [home.join(".agents/skills"), home.join(".claude/skills")]
                    }),
                );
            }
        }
    }
    roots
}

/// `description:` de l’en-tête YAML d’un fichier Markdown, pour la liste des suggestions.
fn description_of(path: &Path) -> Option<String> {
    header_description(&fs::read_to_string(path).ok()?)
}

/// Valeur de `description:` sur une ligne (guillemets retirés) ou en bloc YAML (`>`, `>-`, `|`…) : les lignes
/// indentées qui suivent sont réunies en une seule.
fn header_description(text: &str) -> Option<String> {
    let header = text.strip_prefix("---")?.split("\n---").next()?;
    let mut lines = header.lines();
    while let Some(line) = lines.next() {
        let Some(value) = line.trim_start().strip_prefix("description:") else { continue };
        let value = value.trim();
        let text = if value.starts_with(['>', '|']) {
            lines
                .by_ref()
                .take_while(|next| next.starts_with([' ', '\t']) || next.trim().is_empty())
                .map(str::trim)
                .filter(|next| !next.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            value.trim_matches(|c| c == '"' || c == '\'').to_string()
        };
        return (!text.is_empty()).then(|| text.chars().take(200).collect());
    }
    None
}

fn catalog(cwd: &Path, provider: &str, kind: &str, home: &Option<PathBuf>) -> Vec<Reference> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for root in catalog_roots(cwd, provider, kind, home) {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten().take(MAX_CATALOG) {
            let path = if kind == "skill" {
                entry.path().join("SKILL.md")
            } else {
                entry.path()
            };
            if !path.is_file() || path.extension().is_none_or(|extension| extension != "md") {
                continue;
            }
            let name = if kind == "skill" {
                entry.file_name().to_string_lossy().into_owned()
            } else {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            };
            if !seen.insert(name.clone()) {
                continue;
            }
            result.push(Reference {
                description: description_of(&path),
                name,
                path: path.to_string_lossy().into_owned(),
                kind: if kind == "skill" {
                    ReferenceKind::Skill
                } else {
                    ReferenceKind::Command
                },
            });
            if result.len() >= MAX_CATALOG {
                return result;
            }
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folded_yaml_description_is_read_as_one_line() {
        let folded = "---\nname: anti\ndescription: >-\n  Bans the tells\n  of a vibecoded site.\nallowed-tools:\n  - Bash\n---\nCorps";
        assert_eq!(header_description(folded).as_deref(), Some("Bans the tells of a vibecoded site."));
        assert_eq!(header_description("---\ndescription: 'Relit'\n---\n").as_deref(), Some("Relit"));
        assert_eq!(header_description("---\nname: x\n---\n"), None);
    }
    use serde_json::json;

    #[test]
    fn files_are_searched_inside_the_folder_without_build_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/fichier.ts"), "").unwrap();
        fs::write(root.join("node_modules/pkg/ignore.ts"), "").unwrap();
        let found = search_files(root, ".ts").unwrap();
        assert_eq!(
            found
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["src/fichier.ts"]
        );
        assert_eq!(
            search_files(root, "sft").unwrap().len(),
            1,
            "les lettres dans l’ordre suffisent"
        );
        assert!(search_files(root, "absent").unwrap().is_empty());
        assert_eq!(search_files(root, "src").unwrap()[0].name, "src/");
    }

    /// Le parcours complet de la saisie : `/` propose les commandes et les skills du harnais de la conversation,
    /// `@` les fichiers du dossier de travail ; une demande malformée est refusée.
    #[tokio::test]
    async fn the_composer_lists_the_harness_commands_skills_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let project = dir.path().join("projet");
        fs::create_dir_all(project.join(".claude/commands")).unwrap();
        fs::create_dir_all(project.join(".claude/skills/relire-page")).unwrap();
        fs::create_dir_all(project.join(".opencode/commands")).unwrap();
        fs::write(
            project.join(".claude/commands/publier.md"),
            "---\ndescription: Publie le module\n---\nCorps",
        )
        .unwrap();
        fs::write(
            project.join(".claude/skills/relire-page/SKILL.md"),
            "---\nname: relire-page\ndescription: \"Relit une page\"\n---\n",
        )
        .unwrap();
        fs::write(project.join(".opencode/commands/deployer.md"), "Corps").unwrap();
        fs::write(project.join("notes.md"), "").unwrap();
        let cwd = project.to_string_lossy().to_string();

        let commands = crate::dispatch::dispatch(
            state.clone(),
            "composer.references",
            json!({ "cwd": cwd, "provider": "claude", "kind": "command", "query": "" }),
        )
        .await
        .unwrap();
        let names: Vec<(String, String)> = commands
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["kind"].as_str().unwrap().to_string(),
                    item["name"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert!(
            names.contains(&("command".into(), "publier".into())),
            "{names:?}"
        );
        assert!(
            names.contains(&("skill".into(), "relire-page".into())),
            "{names:?}"
        );
        assert!(
            !names.iter().any(|(_, name)| name == "deployer"),
            "les commandes d’OpenCode ne sont pas celles de Claude"
        );
        let skill = commands
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "relire-page")
            .unwrap();
        assert_eq!(skill["description"], "Relit une page");

        let opencode = crate::dispatch::dispatch(
            state.clone(),
            "composer.references",
            json!({ "cwd": cwd, "provider": "opencode", "kind": "command", "query": "" }),
        )
        .await
        .unwrap();
        assert!(opencode.to_string().contains("deployer"));

        let files = crate::dispatch::dispatch(
            state.clone(),
            "composer.references",
            json!({ "cwd": cwd, "provider": "codex", "kind": "file", "query": "notes" }),
        )
        .await
        .unwrap();
        assert_eq!(files[0]["name"], "notes.md");

        let refused = crate::dispatch::dispatch(
            state.clone(),
            "composer.references",
            json!({ "cwd": "relatif", "provider": "claude", "kind": "file", "query": "" }),
        )
        .await;
        assert!(refused.is_err());
    }
}
