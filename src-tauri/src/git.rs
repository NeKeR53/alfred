//! Git en ligne de commande : l’espace et les marketplaces sont des dépôts ordinaires, et l’accès distant repose sur
//! les identifiants déjà configurés sur le poste (gestionnaire d’identifiants, agent SSH).

use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{AppError, AppResult};

/// Le dossier de l’espace (et celui d’un marketplace) est écrit par l’agent : ni ses crochets ni sa configuration
/// locale ne doivent faire exécuter un programme quand Alfred enregistre ou consulte l’historique. Les fins de
/// ligne restent celles écrites : Git for Windows règle `core.autocrlf=true` par défaut, ce qui réécrirait les
/// fichiers de l’espace en CRLF à chaque annulation.
const NEUTRAL: [&str; 8] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
];

fn command(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        .stdin(Stdio::null())
        // Jamais de question interactive : une authentification manquante doit échouer tout de suite.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Ni fenêtre du Git Credential Manager sous Windows.
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C")
        .args(NEUTRAL);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Clé de configuration dont la valeur est un programme qu’une commande git lancerait (filtres, pilotes de diff ou de
/// fusion, éditeurs, aides d’identification, inclusions d’autres fichiers).
fn runs_a_program(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let ends = |prefix: &str, suffixes: &[&str]| key.starts_with(prefix) && suffixes.iter().any(|suffix| key.ends_with(suffix));
    matches!(
        key.as_str(),
        "core.fsmonitor"
            | "core.hookspath"
            | "core.sshcommand"
            | "core.pager"
            | "core.editor"
            | "core.askpass"
            | "core.gitproxy"
            | "core.worktree"
            | "sequence.editor"
            | "diff.external"
            | "include.path"
            | "uploadpack.packobjectshook"
            | "credential.helper"
    ) || key.starts_with("includeif.")
        || ends("filter.", &[".clean", ".smudge", ".process"])
        || ends("diff.", &[".textconv", ".command"])
        || ends("merge.", &[".driver"])
        || ends("credential.", &[".helper"])
        || ends("gpg.", &[".program"])
}

/// Refuse un dépôt dont la configuration locale ferait exécuter un programme. Lire la configuration n’exécute rien.
fn ensure_safe_config(dir: &Path) -> AppResult<()> {
    let Ok(output) = command(dir).args(["config", "--local", "--no-includes", "--name-only", "--list"]).output() else {
        return Ok(());
    };
    // Hors d’un dépôt (avant `git init`), il n’y a pas de configuration locale.
    if !output.status.success() {
        return Ok(());
    }
    let listed = String::from_utf8_lossy(&output.stdout);
    if let Some(key) = listed.lines().map(str::trim).find(|key| runs_a_program(key)) {
        return Err(AppError::new(format!(
            "La configuration git de « {} » contient « {key} », qui ferait exécuter un programme : Alfred refuse de s’en servir. La retirer de .git/config.",
            dir.display()
        )));
    }
    Ok(())
}

/// Exécute git et renvoie sa sortie standard ; l’erreur porte la sortie d’erreur de git.
pub fn run(dir: &Path, args: &[&str]) -> AppResult<String> {
    ensure_safe_config(dir)?;
    let output = command(dir)
        .args(args)
        .output()
        .map_err(|error| AppError::new(format!("Git est introuvable sur ce poste : {error}")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(AppError::with_detail(
            format!("Git a refusé l’opération « {} ».", args.first().copied().unwrap_or_default()),
            serde_json::json!({ "stderr": stderr }),
        ))
    }
}

/// Identité neutre pour les commits qu’Alfred crée lui-même, sans dépendre de la configuration du poste.
const IDENTITY: [&str; 4] = ["-c", "user.name=Alfred", "-c", "user.email=alfred@localhost"];

pub fn init(dir: &Path) -> AppResult<()> {
    if dir.join(".git").exists() {
        return Ok(());
    }
    run(dir, &["init", "-q", "-b", "main"]).map(|_| ())
}

pub fn has_changes(dir: &Path) -> AppResult<bool> {
    Ok(!run(dir, &["status", "--porcelain"])?.is_empty())
}

/// Enregistre tout l’état du dossier ; renvoie l’identifiant du commit, ou `None` si rien n’a changé.
pub fn commit_all(dir: &Path, message: &str) -> AppResult<Option<String>> {
    run(dir, &["add", "-A"])?;
    if !has_changes(dir)? {
        return Ok(None);
    }
    let mut args: Vec<&str> = IDENTITY.to_vec();
    args.extend(["commit", "-q", "--no-verify", "-m", message]);
    run(dir, &args)?;
    Ok(Some(run(dir, &["rev-parse", "HEAD"])?))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub message: String,
    pub date: String,
    pub files: Vec<String>,
}

pub fn log(dir: &Path, limit: usize, path: Option<&str>) -> AppResult<Vec<Commit>> {
    let limit = format!("-{limit}");
    let mut args = vec!["log", limit.as_str(), "--name-only", "--format=%x1e%H%x1f%s%x1f%cI"];
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    let output = match run(dir, &args) {
        Ok(output) => output,
        // Dépôt sans commit.
        Err(_) => return Ok(Vec::new()),
    };
    Ok(output
        .split('\u{1e}')
        .filter(|entry| !entry.trim().is_empty())
        .filter_map(|entry| {
            let mut lines = entry.lines();
            let mut header = lines.next()?.split('\u{1f}');
            Some(Commit {
                id: header.next()?.to_string(),
                message: header.next()?.to_string(),
                date: header.next()?.to_string(),
                files: lines.map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect(),
            })
        })
        .collect())
}

/// Annule un commit par un commit inverse : l’historique reste linéaire et l’annulation est elle-même annulable.
pub fn revert(dir: &Path, commit: &str) -> AppResult<String> {
    let mut args: Vec<&str> = IDENTITY.to_vec();
    args.extend(["revert", "--no-edit", commit]);
    if let Err(error) = run(dir, &args) {
        let _ = run(dir, &["revert", "--abort"]);
        return Err(AppError::with_detail(
            "Cette modification ne peut pas être annulée seule : des changements plus récents touchent les mêmes fichiers.",
            error.detail.unwrap_or_default(),
        ));
    }
    run(dir, &["rev-parse", "HEAD"])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ni un crochet ni une configuration locale écrits dans l’espace ne font exécuter de programme à Alfred.
    #[cfg(unix)]
    #[test]
    fn hooks_and_local_configuration_of_the_space_never_run() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("espace");
        std::fs::create_dir_all(&repo).unwrap();
        init(&repo).unwrap();
        let marker = dir.path().join("execute");
        let hook = repo.join(".git/hooks/post-commit");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        assert!(commit_all(&repo, "premier").unwrap().is_some());
        assert!(!marker.exists(), "le crochet post-commit ne doit pas tourner");

        let set = |key: &str, value: &str| {
            Command::new("git").current_dir(&repo).args(["config", "--local", key, value]).status().unwrap()
        };
        set("core.fsmonitor", &format!("touch '{}'; false", marker.display()));
        std::fs::write(repo.join("b.txt"), "b").unwrap();
        let error = commit_all(&repo, "second").unwrap_err();
        assert!(error.message.contains("core.fsmonitor"), "{}", error.message);
        assert!(!marker.exists(), "fsmonitor ne doit pas tourner");
        Command::new("git").current_dir(&repo).args(["config", "--local", "--unset", "core.fsmonitor"]).status().unwrap();

        set("filter.x.clean", &format!("touch '{}'", marker.display()));
        assert!(commit_all(&repo, "second").is_err());
        assert!(!marker.exists());
    }
}
