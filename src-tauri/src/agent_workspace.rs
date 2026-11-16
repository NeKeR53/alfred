//! Dossier de travail d’une conversation d’agent, repris de OneApp (`agent_local_git_summary`, `open_with_text_editor`,
//! `open_local_directory`) : état Git relu à chaque fin de tour pour la carte « Modifications » et la pastille sous la
//! saisie, ouverture du dossier dans l’éditeur choisi dans les réglages ou dans l’explorateur du système.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::error::{arg, AppError, AppResult};
use crate::git;
use crate::state::AppState;

/// Au-delà, la liste est tronquée et les lignes ne sont plus comptées.
const MAX_GIT_CHANGED_FILES: usize = 500;
/// Emplacement du dossier dans la commande de l’éditeur.
pub const TEXT_EDITOR_DIRECTORY_PLACEHOLDER: &str = "{{directory}}";

pub async fn handle(_state: &AppState, command: &str, args: &Value) -> Option<AppResult<Value>> {
    let result = match command {
        "agentWorkspace.gitSummary" => {
            let path = match arg::<String>(args, "path") {
                Ok(path) => path,
                Err(error) => return Some(Err(error)),
            };
            blocking(move || {
                let summary = git_summary(&existing_directory(&path, "Le dépôt Git à inspecter")?)?;
                Ok(serde_json::to_value(summary)?)
            })
            .await
        }
        "agentWorkspace.openEditor" => {
            let (command, path) = match (arg::<String>(args, "command"), arg::<String>(args, "path")) {
                (Ok(command), Ok(path)) => (command, path),
                (Err(error), _) | (_, Err(error)) => return Some(Err(error)),
            };
            blocking(move || {
                let directory = existing_directory(&path, "Le dossier à ouvrir dans l’éditeur")?;
                let mut editor = text_editor_command(&command, &directory).map_err(AppError::new)?;
                editor.current_dir(&directory);
                editor.spawn().map(|_| Value::Null).map_err(|_| {
                    AppError::new("Impossible de lancer l’éditeur. Vérifiez la commande et son installation.")
                })
            })
            .await
        }
        "agentWorkspace.openExplorer" => {
            let path = match arg::<String>(args, "path") {
                Ok(path) => path,
                Err(error) => return Some(Err(error)),
            };
            blocking(move || {
                let directory = existing_directory(&path, "Le dossier à ouvrir")?;
                tauri_plugin_opener::open_path(&directory, None::<&str>)
                    .map(|_| Value::Null)
                    .map_err(|_| AppError::new("Impossible d’ouvrir le dossier dans l’explorateur."))
            })
            .await
        }
        _ => return None,
    };
    Some(result)
}

async fn blocking(work: impl FnOnce() -> AppResult<Value> + Send + 'static) -> AppResult<Value> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| AppError::new("L’opération sur le dossier de travail a été interrompue."))?
}

fn existing_directory(path: &str, subject: &str) -> AppResult<PathBuf> {
    let directory = PathBuf::from(path.trim());
    if path.trim().is_empty() || !directory.is_dir() {
        return Err(AppError::new(format!("{subject} est introuvable : {path}")));
    }
    Ok(directory)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    pub root: String,
    pub files: Vec<GitChangedFile>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub truncated: bool,
}

/// Commande Git de lecture : ni verrou optionnel (l’agent peut écrire en même temps), ni programme lancé par la
/// configuration du dépôt (vérifiée par `git::run`).
fn read(dir: &Path, args: &[&str]) -> AppResult<String> {
    let mut full = vec!["--no-optional-locks"];
    full.extend_from_slice(args);
    git::run(dir, &full)
}

/// Lit la sortie `git status --porcelain=v1 -z` ; un renommage occupe deux entrées.
fn parse_changed_files(output: &str) -> Vec<GitChangedFile> {
    let mut entries = output.split('\0').filter(|entry| !entry.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 || files.len() >= MAX_GIT_CHANGED_FILES {
            break;
        }
        let (code, path) = entry.split_at(3);
        let state = match code.trim() {
            "??" => "nouveau",
            code if code.contains('R') => {
                entries.next();
                "renommé"
            }
            code if code.contains('D') => "supprimé",
            code if code.contains('A') => "ajouté",
            code if code.contains('U') => "en conflit",
            _ => "modifié",
        };
        files.push(GitChangedFile { path: path.to_owned(), state: state.to_owned() });
    }
    files
}

/// Somme des lignes de `git diff --numstat -z` ; un fichier binaire (« - ») rend le total inconnu.
fn parse_numstat(output: &str) -> Option<(u32, u32)> {
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for line in output.split('\0').filter(|line| !line.is_empty()) {
        let mut fields = line.splitn(3, '\t');
        let added = fields.next()?.parse::<u32>().ok()?;
        let removed = fields.next()?.parse::<u32>().ok()?;
        fields.next()?;
        additions = additions.checked_add(added)?;
        deletions = deletions.checked_add(removed)?;
    }
    Some((additions, deletions))
}

/// Compare les changements suivis à HEAD et compte aussi les nouveaux fichiers texte.
pub fn git_summary(path: &Path) -> AppResult<GitSummary> {
    let root_string = read(path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| AppError::new("Ce dossier n’est pas un dépôt Git."))?
        .trim()
        .to_owned();
    let root = PathBuf::from(&root_string);
    let status = read(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .map_err(|_| AppError::new("Impossible de lire les modifications locales."))?;
    let mut files = parse_changed_files(&status);
    let truncated = files.len() >= MAX_GIT_CHANGED_FILES;
    // Git signale un dépôt imbriqué non suivi comme un seul chemin de dossier. Ce n’est pas un fichier texte : ses
    // propres changements sont relevés dans son dépôt, séparément.
    files.retain(|file| {
        let path = root.join(&file.path);
        !(std::fs::symlink_metadata(&path).map(|metadata| metadata.file_type().is_dir()).unwrap_or(false)
            && path.join(".git").exists())
    });
    let diff = read(&root, &["diff", "--numstat", "-z", "--no-ext-diff", "--no-renames", "HEAD", "--"]);
    let only_untracked = status.split('\0').filter(|entry| !entry.is_empty()).all(|entry| entry.starts_with("?? "));
    let mut totals = if truncated {
        None
    } else if let Ok(diff) = &diff {
        parse_numstat(diff)
    } else if only_untracked {
        // Un dépôt sans premier commit n’a pas encore de HEAD ; ses fichiers non suivis sont tous des ajouts.
        Some((0, 0))
    } else {
        None
    };
    let mut untracked_bytes = 0u64;
    for file in files.iter().filter(|file| file.state == "nouveau") {
        if let Some((added, removed)) = totals {
            let file_path = root.join(&file.path);
            let count = std::fs::symlink_metadata(&file_path)
                .ok()
                .filter(|meta| {
                    untracked_bytes = untracked_bytes.saturating_add(meta.len());
                    meta.is_file()
                        && !meta.file_type().is_symlink()
                        && meta.len() <= 2_000_000
                        && untracked_bytes <= 8_000_000
                })
                .and_then(|_| std::fs::read(&file_path).ok())
                .filter(|bytes| !bytes.contains(&0))
                .and_then(|bytes| {
                    u32::try_from(
                        bytes.iter().filter(|byte| **byte == b'\n').count()
                            + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n")),
                    )
                    .ok()
                });
            totals = count.and_then(|count| added.checked_add(count).map(|added| (added, removed)));
        }
    }
    Ok(GitSummary {
        root: root_string,
        files,
        additions: totals.map(|value| value.0),
        deletions: totals.map(|value| value.1),
        truncated,
    })
}

/// Découpe la commande de l’éditeur en arguments ; les guillemets regroupent un chemin qui contient des espaces.
fn split_text_editor_command(template: &str) -> Result<Vec<String>, String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut token_started = false;
    for character in template.chars() {
        match character {
            '"' => {
                quoted = !quoted;
                token_started = true;
            }
            character if character.is_whitespace() && !quoted => {
                if token_started {
                    arguments.push(std::mem::take(&mut current));
                    token_started = false;
                }
            }
            character => {
                current.push(character);
                token_started = true;
            }
        }
    }
    if quoted {
        return Err("La commande de l’éditeur contient des guillemets non fermés.".into());
    }
    if token_started {
        arguments.push(current);
    }
    if arguments.is_empty() {
        return Err("Saisissez la commande de lancement de l’éditeur.".into());
    }
    Ok(arguments)
}

#[cfg(windows)]
fn find_windows_editor_program(program: &str, search_paths: &[PathBuf], install_roots: &[PathBuf]) -> Option<PathBuf> {
    let requested = PathBuf::from(program);
    let file_names = if requested.extension().is_some() {
        vec![requested.clone()]
    } else {
        ["exe", "com", "cmd", "bat"].into_iter().map(|extension| requested.with_extension(extension)).collect()
    };
    if requested.is_absolute() || requested.parent().is_some_and(|parent| !parent.as_os_str().is_empty()) {
        return file_names.into_iter().find(|candidate| candidate.is_file());
    }
    for directory in search_paths {
        if let Some(candidate) =
            file_names.iter().map(|file_name| directory.join(file_name)).find(|candidate| candidate.is_file())
        {
            return Some(candidate);
        }
    }
    let fallback_paths: &[&str] = if program.eq_ignore_ascii_case("code")
        || program.eq_ignore_ascii_case("code.exe")
        || program.eq_ignore_ascii_case("code.cmd")
    {
        &["Microsoft VS Code/Code.exe", "Programs/Microsoft VS Code/Code.exe"]
    } else if program.eq_ignore_ascii_case("codium")
        || program.eq_ignore_ascii_case("codium.exe")
        || program.eq_ignore_ascii_case("codium.cmd")
    {
        &["VSCodium/VSCodium.exe", "Programs/VSCodium/VSCodium.exe", "apps/vscodium/current/VSCodium.exe"]
    } else {
        &[]
    };
    install_roots.iter().find_map(|root| {
        fallback_paths.iter().find_map(|relative_path| {
            let candidate = root.join(relative_path);
            candidate.is_file().then_some(candidate)
        })
    })
}

#[cfg(windows)]
fn windows_editor_program(program: &str) -> Option<PathBuf> {
    use std::env;
    let search_paths = env::var_os("PATH").map(|paths| env::split_paths(&paths).collect::<Vec<_>>()).unwrap_or_default();
    let mut install_roots = ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "SCOOP"]
        .into_iter()
        .filter_map(env::var_os)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if let Some(user_profile) = env::var_os("USERPROFILE") {
        install_roots.push(PathBuf::from(user_profile).join("scoop"));
    }
    find_windows_editor_program(program, &search_paths, &install_roots)
}

/// Commande de l’éditeur, le dossier substitué à `{{directory}}` dans chaque argument.
fn text_editor_command(template: &str, directory: &Path) -> Result<Command, String> {
    if !template.contains(TEXT_EDITOR_DIRECTORY_PLACEHOLDER) {
        return Err(format!("Ajoutez {TEXT_EDITOR_DIRECTORY_PLACEHOLDER} pour transmettre le dossier à l’éditeur."));
    }
    let directory = directory.to_string_lossy();
    let arguments = split_text_editor_command(template)?
        .into_iter()
        .map(|argument| argument.replace(TEXT_EDITOR_DIRECTORY_PLACEHOLDER, &directory))
        .collect::<Vec<_>>();
    let (program, arguments) =
        arguments.split_first().ok_or_else(|| "Saisissez la commande de lancement de l’éditeur.".to_string())?;
    #[cfg(windows)]
    let mut command = Command::new(windows_editor_program(program).ok_or_else(|| {
        format!(
            "La commande « {program} » est introuvable. Vérifiez son installation ou indiquez le chemin complet de l’éditeur."
        )
    })?);
    #[cfg(not(windows))]
    let mut command = Command::new(program);
    command.args(arguments);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alfred-agent-workspace-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
    }

    #[test]
    fn lit_les_etats_du_statut_porcelaine() {
        let files = parse_changed_files(" M a.txt\0?? b.txt\0R  c.txt\0old.txt\0 D d.txt\0A  e.txt\0UU f.txt\0");
        let states: Vec<_> = files.iter().map(|file| (file.path.as_str(), file.state.as_str())).collect();
        assert_eq!(
            states,
            [
                ("a.txt", "modifié"),
                ("b.txt", "nouveau"),
                ("c.txt", "renommé"),
                ("d.txt", "supprimé"),
                ("e.txt", "ajouté"),
                ("f.txt", "en conflit")
            ]
        );
    }

    #[test]
    fn un_fichier_binaire_rend_le_total_inconnu() {
        assert_eq!(parse_numstat("3\t1\ta.txt\x002\t0\tb.txt\0"), Some((5, 1)));
        assert_eq!(parse_numstat("-\t-\timage.png\0"), None);
        assert_eq!(parse_numstat(""), Some((0, 0)));
    }

    #[test]
    fn resume_un_depot_avec_les_nouveaux_fichiers_texte() {
        let dir = temp_dir("summary");
        git_in(&dir, &["init", "-q"]);
        std::fs::write(dir.join("suivi.txt"), "un\ndeux\n").unwrap();
        git_in(&dir, &["add", "."]);
        git_in(&dir, &["commit", "-q", "-m", "départ"]);
        std::fs::write(dir.join("suivi.txt"), "un\ntrois\nquatre\n").unwrap();
        std::fs::write(dir.join("nouveau.txt"), "a\nb\nc").unwrap();
        let sub = dir.join("sous");
        std::fs::create_dir_all(&sub).unwrap();
        let summary = git_summary(&sub).unwrap();
        assert_eq!(
            std::fs::canonicalize(&summary.root).unwrap(),
            std::fs::canonicalize(&dir).unwrap(),
            "la racine du dépôt est remontée depuis un sous-dossier"
        );
        assert_eq!(summary.files.len(), 2);
        // suivi.txt : +2 −1 ; nouveau.txt : 3 lignes, la dernière sans fin de ligne.
        assert_eq!((summary.additions, summary.deletions), (Some(5), Some(1)));
        assert!(!summary.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_depot_sans_commit_compte_ses_fichiers_comme_des_ajouts() {
        let dir = temp_dir("empty");
        git_in(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "x\ny\n").unwrap();
        let summary = git_summary(&dir).unwrap();
        assert_eq!((summary.additions, summary.deletions), (Some(2), Some(0)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_dossier_hors_depot_est_signale() {
        let dir = temp_dir("plain");
        // Le dossier temporaire du système n’est pas dans un dépôt.
        let error = git_summary(&dir).unwrap_err();
        assert_eq!(error.to_string(), "Ce dossier n’est pas un dépôt Git.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_commande_de_l_editeur_recoit_le_dossier() {
        assert_eq!(
            split_text_editor_command(r#"code --reuse-window "{{directory}}""#).unwrap(),
            ["code", "--reuse-window", "{{directory}}"]
        );
        assert!(split_text_editor_command(r#"code "{{directory}}"#).unwrap_err().contains("guillemets"));
        assert!(text_editor_command("code", Path::new("/tmp")).unwrap_err().contains("{{directory}}"));
        #[cfg(not(windows))]
        {
            let command = text_editor_command(r#"code -n "{{directory}}""#, Path::new("/tmp/mon dossier")).unwrap();
            let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
            assert_eq!(command.get_program(), "code");
            assert_eq!(args, ["-n", "/tmp/mon dossier"]);
        }
    }

    #[test]
    fn un_dossier_absent_est_refuse() {
        assert!(existing_directory("/n/existe/pas", "Le dossier à ouvrir").is_err());
        assert!(existing_directory("  ", "Le dossier à ouvrir").is_err());
    }
}
