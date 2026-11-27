//! Git dans les dossiers du poste accordés à un module (`folders.rs`) : état, branches locales et distantes, tags,
//! historique, écarts, différences, fetch, pull, commit, push, changement de branche, clone.
//!
//! Mêmes règles que le git de l’espace (`git.rs`, `git_network.rs`), adaptées à des dépôts qui appartiennent à
//! l’utilisateur :
//! - aucun crochet ni surveillance du dossier, aucun éditeur ni pager, aucune question au terminal ; une
//!   configuration du dépôt qui lancerait un autre programme (filtre, aide d’identification, inclusion…) est
//!   refusée. `core.hooksPath` (husky) est permis puisqu’il est neutralisé ;
//! - les fins de ligne restent celles que l’utilisateur a réglées (`core.autocrlf` de Git for Windows compris) ;
//! - la recherche du dépôt s’arrête au dossier accordé (`GIT_CEILING_DIRECTORIES`) : un dossier accordé à
//!   l’intérieur d’un dépôt plus grand ne donne pas accès à ce dépôt ;
//! - les chemins passés à git sont littéraux (`GIT_LITERAL_PATHSPECS`) et confinés au dossier ;
//! - le réseau passe par `marketplace::remote_git` : identifiants du poste, proxy et certificats du système ;
//! - un dossier « d’un autre propriétaire » (partage réseau, disque externe sous Windows) est déclaré sûr pour la
//!   seule commande, comme pour les marketplaces ;
//! - une opération à la fois par dépôt.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::folders::{self, plain};
use crate::marketplace::{explain_remote, remote_git_with};
use crate::permissions::Subject;
use crate::state::AppState;
use crate::{git, git_network};

/// Clés de configuration du dépôt permises bien qu’elles nomment un programme : Alfred les neutralise lui-même.
const NEUTRALIZED: [&str; 5] = ["core.hookspath", "core.fsmonitor", "core.editor", "sequence.editor", "core.pager"];
/// Taille maximale d’une différence ou d’un fichier lu dans l’historique.
const MAX_OUTPUT: usize = 2 * 1024 * 1024;

/// Un dépôt dans un dossier accordé : `dir` est le dossier où git tourne, `root` celui du dossier accordé.
#[derive(Debug, Clone)]
pub struct Repo {
    pub dir: PathBuf,
    pub root: PathBuf,
}

impl Repo {
    /// Dépôt (ou sous-dossier d’un dépôt) `repo`, relatif au dossier accordé `root`.
    pub fn open(root: &Path, repo: &str) -> AppResult<Self> {
        let dir = plain(&folders::resolve(root, repo)?);
        if !dir.is_dir() {
            return Err(AppError::new(format!("« {repo} » n’est pas un dossier.")));
        }
        Ok(Self { dir, root: plain(root) })
    }

    fn env(&self) -> Vec<(&'static str, String)> {
        let ceiling = self.root.parent().map(|parent| parent.to_string_lossy().to_string()).unwrap_or_default();
        vec![
            ("GIT_CEILING_DIRECTORIES", ceiling),
            ("GIT_LITERAL_PATHSPECS", "1".into()),
            ("GIT_EDITOR", ":".into()),
            ("GIT_SEQUENCE_EDITOR", ":".into()),
            ("GIT_PAGER", "cat".into()),
            ("GIT_OPTIONAL_LOCKS", "0".into()),
        ]
    }

    /// Réglages remis tels que l’utilisateur les a, après ceux, neutres, du git de l’espace.
    fn user_settings(&self) -> Vec<String> {
        // Fichier par fichier, du dépôt au système : un simple `config --get` lirait aussi les `-c` neutres que git
        // reçoit ici (`core.autocrlf=false`), et jamais le réglage de l’utilisateur.
        let read = |key: &str| {
            ["--local", "--global", "--system"].iter().find_map(|scope| {
                git::run_unchecked(&self.dir, &["config", scope, "--get", key], &self.env())
                    .ok()
                    .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
                    .filter(|value| !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric()))
            })
        };
        let mut settings = vec![
            "-c".to_string(),
            format!("core.autocrlf={}", read("core.autocrlf").unwrap_or_else(|| "false".into())),
            "-c".to_string(),
            format!("core.safecrlf={}", read("core.safecrlf").unwrap_or_else(|| "false".into())),
        ];
        if cfg!(windows) {
            // Chemins de plus de 260 caractères dans les dépôts des composants.
            settings.extend(["-c".to_string(), "core.longpaths=true".to_string()]);
        }
        settings
    }

    fn check(&self) -> AppResult<()> {
        git::ensure_safe_config_allowing(&self.dir, &NEUTRALIZED)
    }

    /// git local ; rend la sortie standard en octets.
    pub fn raw(&self, args: &[&str]) -> AppResult<Vec<u8>> {
        self.check()?;
        let settings = self.user_settings();
        let mut full: Vec<&str> = settings.iter().map(String::as_str).collect();
        full.extend(args);
        match git::run_unchecked(&self.dir, &full, &self.env()) {
            Err(error) => match git_network::dubious_repository(&crate::marketplace::stderr_of(&error)) {
                Some(repository) => {
                    let safe = format!("safe.directory={repository}");
                    let mut again = vec!["-c", safe.as_str()];
                    again.extend(&full);
                    git::run_unchecked(&self.dir, &again, &self.env())
                }
                None => Err(error),
            },
            ok => ok,
        }
    }

    /// git local ; rend la sortie standard en texte, sans les fins de ligne finales.
    pub fn run(&self, args: &[&str]) -> AppResult<String> {
        self.raw(args).map(|bytes| String::from_utf8_lossy(&bytes).trim_end().to_string())
    }

    /// git sur le réseau (fetch, pull, push) ; l’échec est traduit en une phrase qui dit quoi vérifier.
    pub fn remote(&self, action: &str, args: &[&str]) -> AppResult<String> {
        self.check()?;
        let settings = self.user_settings();
        let mut full: Vec<&str> = settings.iter().map(String::as_str).collect();
        full.extend(args);
        remote_git_with(&self.dir, &full, &self.env()).map_err(|error| explain_remote(error, action))
    }

    /// Le dossier est-il dans un dépôt (qui ne dépasse pas le dossier accordé) ?
    pub fn is_repository(&self) -> bool {
        self.run(&["rev-parse", "--is-inside-work-tree"]).is_ok_and(|out| out == "true")
    }

    fn require(&self) -> AppResult<()> {
        self.check()?;
        if self.is_repository() {
            Ok(())
        } else {
            Err(AppError::new(format!("« {} » n’est pas un dépôt Git.", self.dir.display())))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

/// Une révision (`main`, `origin/main`, `v1.2.0`, `HEAD~3`, un identifiant) ; jamais une option ni une plage.
fn revision(text: &str) -> AppResult<&str> {
    let valid = !text.is_empty()
        && text.len() <= 200
        && !text.starts_with('-')
        && !text.contains("..")
        && text.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '/' | '-' | '@' | '^' | '~' | '{' | '}' | '+'));
    if valid {
        Ok(text)
    } else {
        Err(AppError::new(format!("Révision invalide : « {text} ».")))
    }
}

/// Un nom de branche ou de tag que git accepte, jamais une option.
fn ref_name(repo: &Repo, text: &str, kind: &str) -> AppResult<String> {
    let invalid = || AppError::new(format!("Nom de {kind} invalide : « {text} »."));
    if text.is_empty() || text.starts_with('-') || text.len() > 200 {
        return Err(invalid());
    }
    let full = if kind == "tag" { format!("refs/tags/{text}") } else { format!("refs/heads/{text}") };
    repo.run(&["check-ref-format", &full]).map_err(|_| invalid())?;
    Ok(text.to_string())
}

/// Un distant (`origin`).
fn remote_name(text: &str) -> AppResult<&str> {
    let valid = !text.is_empty() && !text.starts_with('-') && text.len() <= 100 && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(text)
    } else {
        Err(AppError::new(format!("Distant invalide : « {text} ».")))
    }
}

/// Chemins relatifs au dépôt, confinés au dossier accordé.
fn pathspecs(repo: &Repo, paths: &[String]) -> AppResult<Vec<String>> {
    let real_dir = repo.dir.canonicalize()?;
    let real_root = repo.root.canonicalize()?;
    paths
        .iter()
        .map(|path| {
            let relative = real_dir.strip_prefix(&real_root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            let joined = if relative.is_empty() { path.clone() } else { format!("{relative}/{path}") };
            folders::resolve(&real_root, &joined)?;
            Ok(path.replace('\\', "/"))
        })
        .collect()
}

/// URL d’un dépôt à cloner : https, http, ssh, git ou la forme `utilisateur@hôte:chemin`. Ni `ext::`, ni `file://`,
/// ni option.
fn clone_url(url: &str) -> AppResult<&str> {
    let lower = url.to_ascii_lowercase();
    let scp = !lower.contains("://") && url.contains('@') && url.contains(':') && !url.contains(' ');
    let allowed = ["https://", "http://", "ssh://", "git://"].iter().any(|scheme| lower.starts_with(scheme)) || scp;
    if url.starts_with('-') || lower.contains("::") || !allowed || url.len() > 2048 {
        return Err(AppError::new(format!("Adresse de dépôt invalide : « {url} ». Attendu https://… ou git@hôte:chemin.")));
    }
    Ok(url)
}

// ---------------------------------------------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Ancien chemin d’un renommage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// `modified`, `added`, `deleted`, `renamed`, `copied`, `typechange`, `untracked`, `conflicted`.
    pub kind: &'static str,
    /// Le changement est indexé (prêt pour le commit).
    pub staged: bool,
    /// Le fichier a aussi des changements non indexés.
    pub unstaged: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Dossier du dépôt, relatif au dossier accordé (`""` : le dossier lui-même).
    pub repo: String,
    /// Branche courante ; `None` si HEAD est détachée.
    pub branch: Option<String>,
    /// Dernier commit ; `None` pour un dépôt sans commit.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub clean: bool,
    pub files: Vec<FileStatus>,
    /// Opération en cours : `merge`, `rebase`, `cherry-pick`, `revert`.
    pub operation: Option<&'static str>,
}

fn kind_of(code: char) -> &'static str {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        _ => "modified",
    }
}

/// Lit `git status --porcelain=v2 --branch -z`.
pub(crate) fn parse_status(output: &[u8]) -> Status {
    let text = String::from_utf8_lossy(output);
    let mut records = text.split('\0').filter(|record| !record.is_empty());
    let mut status = Status::default();
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => status.head = Some(value.to_string()),
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_string()),
                "branch.upstream" => status.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split_whitespace() {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let (tag, rest) = record.split_at(1.min(record.len()));
        let rest = rest.trim_start();
        match tag {
            "?" => status.files.push(FileStatus { path: rest.to_string(), from: None, kind: "untracked", staged: false, unstaged: true }),
            "1" | "2" => {
                // XY sous mH mI mW hH hI [score] chemin
                let fields = if tag == "1" { 7 } else { 8 };
                let mut parts = rest.splitn(fields + 1, ' ');
                let xy: Vec<char> = parts.next().unwrap_or("..").chars().collect();
                let path = parts.nth(fields - 1).unwrap_or_default().to_string();
                let (x, y) = (xy.first().copied().unwrap_or('.'), xy.get(1).copied().unwrap_or('.'));
                let from = (tag == "2").then(|| records.next().unwrap_or_default().to_string());
                let code = if x != '.' { x } else { y };
                status.files.push(FileStatus { path, from, kind: kind_of(code), staged: x != '.', unstaged: y != '.' });
            }
            "u" => {
                let path = rest.splitn(10, ' ').nth(9).unwrap_or_default().to_string();
                status.files.push(FileStatus { path, from: None, kind: "conflicted", staged: false, unstaged: true });
            }
            _ => {}
        }
    }
    status.clean = status.files.is_empty();
    status
}

pub fn status(repo: &Repo) -> AppResult<Status> {
    repo.require()?;
    let output = repo.raw(&["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"])?;
    let mut status = parse_status(&output);
    let top = repo.run(&["rev-parse", "--show-toplevel"]).map(PathBuf::from).unwrap_or_else(|_| repo.dir.clone());
    let real_root = repo.root.canonicalize().unwrap_or_else(|_| repo.root.clone());
    status.repo = top
        .canonicalize()
        .ok()
        .and_then(|top| top.strip_prefix(&real_root).ok().map(|p| p.to_string_lossy().replace('\\', "/")))
        .unwrap_or_default();
    let git_dir = repo.run(&["rev-parse", "--absolute-git-dir"]).map(PathBuf::from).unwrap_or_default();
    status.operation = [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .iter()
    .find(|(file, _)| git_dir.join(file).exists())
    .map(|(_, name)| *name);
    Ok(status)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub head: String,
    /// Distant suivi (`origin/main`), pour une branche locale.
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub current: bool,
    /// Distant d’une branche distante (`origin`).
    pub remote: Option<String>,
    pub date: String,
    pub subject: String,
}

pub fn branches(repo: &Repo) -> AppResult<Value> {
    repo.require()?;
    let format = "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(committerdate:iso-strict)%00%(contents:subject)";
    let output = repo.run(&["for-each-ref", format, "refs/heads", "refs/remotes"])?;
    let (mut local, mut remote) = (Vec::new(), Vec::new());
    for line in output.lines() {
        let fields: Vec<&str> = line.split('\0').collect();
        let [reference, head, upstream, track, current, date, subject] = fields[..] else { continue };
        let (mut ahead, mut behind) = (0, 0);
        for part in track.split(',') {
            let part = part.trim();
            if let Some(n) = part.strip_prefix("ahead ") {
                ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                behind = n.parse().unwrap_or(0);
            }
        }
        let branch = |name: &str, remote: Option<String>| Branch {
            name: name.to_string(),
            head: head.to_string(),
            upstream: Some(upstream.to_string()).filter(|u| !u.is_empty()),
            ahead,
            behind,
            current: current == "*",
            remote,
            date: date.to_string(),
            subject: subject.to_string(),
        };
        if let Some(name) = reference.strip_prefix("refs/heads/") {
            local.push(branch(name, None));
        } else if let Some(name) = reference.strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") {
                continue;
            }
            let remote_of = name.split('/').next().map(str::to_string);
            remote.push(branch(name, remote_of));
        }
    }
    let current = local.iter().find(|branch| branch.current).map(|branch| branch.name.clone());
    Ok(json!({ "current": current, "local": local, "remote": remote }))
}

pub fn tags(repo: &Repo) -> AppResult<Value> {
    repo.require()?;
    let format = "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)%00%(contents:subject)";
    let output = repo.run(&["for-each-ref", "--sort=-creatordate", format, "refs/tags"])?;
    let tags: Vec<Value> = output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            let [name, object, peeled, date, subject] = fields[..] else { return None };
            let annotated = !peeled.is_empty();
            Some(json!({
                "name": name,
                "commit": if annotated { peeled } else { object },
                "annotated": annotated,
                "date": date,
                "message": subject,
            }))
        })
        .collect();
    Ok(Value::Array(tags))
}

pub struct LogQuery {
    pub rev: Option<String>,
    pub file: Option<String>,
    pub since: Option<String>,
    pub limit: usize,
}

pub fn log(repo: &Repo, query: &LogQuery) -> AppResult<Vec<git::Commit>> {
    repo.require()?;
    if repo.run(&["rev-parse", "-q", "--verify", "HEAD"]).is_err() && query.rev.is_none() {
        return Ok(Vec::new());
    }
    let limit = format!("-{}", query.limit.clamp(1, 500));
    let since = query.since.as_deref().map(|since| format!("--since={since}"));
    let mut args = vec!["log", limit.as_str(), "--numstat", "--no-renames", git::LOG_FORMAT];
    if let Some(since) = &since {
        if since.chars().any(|c| matches!(c, '\n' | '\0')) {
            return Err(AppError::new("Date invalide."));
        }
        args.push(since);
    }
    if let Some(rev) = &query.rev {
        args.push(revision(rev)?);
    }
    let files;
    if let Some(file) = &query.file {
        files = pathspecs(repo, std::slice::from_ref(file))?;
        args.push("--");
        args.extend(files.iter().map(String::as_str));
    }
    Ok(git::parse_log(&repo.run(&args)?))
}

/// Écart entre deux révisions : commits de `head` absents de `base` (`ahead`) et l’inverse (`behind`).
pub fn compare(repo: &Repo, base: &str, head: &str) -> AppResult<Value> {
    repo.require()?;
    let (base, head) = (revision(base)?, revision(head)?);
    let counts = repo.run(&["rev-list", "--left-right", "--count", &format!("{base}...{head}")])?;
    let mut numbers = counts.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
    let (behind, ahead) = (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0));
    let commits = git::parse_log(&repo.run(&["log", "-100", "--numstat", "--no-renames", git::LOG_FORMAT, &format!("{base}..{head}")])?);
    Ok(json!({ "base": base, "head": head, "ahead": ahead, "behind": behind, "commits": commits }))
}

pub struct DiffQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub file: Option<String>,
    pub staged: bool,
}

pub fn diff(repo: &Repo, query: &DiffQuery) -> AppResult<Value> {
    repo.require()?;
    let mut base = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    if query.staged {
        base.push("--cached");
    }
    if let Some(from) = &query.from {
        base.push(revision(from)?);
    }
    if let Some(to) = &query.to {
        base.push(revision(to)?);
    }
    let files = query.file.as_ref().map(|file| pathspecs(repo, std::slice::from_ref(file))).transpose()?.unwrap_or_default();
    let with_files = |extra: &[&'static str]| {
        let mut args = base.clone();
        args.extend(extra);
        args.push("--");
        args.extend(files.iter().map(String::as_str));
        args
    };
    let mut text = repo.raw(&with_files(&[]))?;
    let truncated = text.len() > MAX_OUTPUT;
    text.truncate(MAX_OUTPUT);
    let numstat = repo.run(&with_files(&["--numstat"]))?;
    let changed: Vec<Value> = numstat
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let (added, removed, path) = (fields.next()?, fields.next()?, fields.next()?);
            Some(json!({ "path": path, "added": added.parse::<u64>().ok(), "removed": removed.parse::<u64>().ok() }))
        })
        .collect();
    Ok(json!({ "text": String::from_utf8_lossy(&text), "truncated": truncated, "files": changed }))
}

/// Contenu d’un fichier à une révision.
pub fn show(repo: &Repo, rev: &str, file: &str) -> AppResult<String> {
    repo.require()?;
    let rev = revision(rev)?;
    let file = pathspecs(repo, &[file.to_string()])?.remove(0);
    // `./` : chemin relatif au dossier courant, pas à la racine du dépôt.
    let mut bytes = repo.raw(&["show", "--no-textconv", &format!("{rev}:./{file}")])?;
    if bytes.len() > MAX_OUTPUT * 10 {
        bytes.truncate(MAX_OUTPUT * 10);
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Dépôts Git du dossier, sur trois niveaux : le dossier d’un produit et les dépôts de ses composants.
pub fn repositories(root: &Path) -> Vec<Value> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        if dir.join(".git").exists() {
            let relative = dir.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            let name = if relative.is_empty() {
                root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
            } else {
                relative.rsplit('/').next().unwrap_or_default().to_string()
            };
            found.push(json!({ "repo": relative, "name": name }));
        }
        if depth >= 3 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let skip = name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | "vendor");
            if !skip && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    found.sort_by(|a, b| a["repo"].as_str().cmp(&b["repo"].as_str()));
    found
}

// ---------------------------------------------------------------------------------------------------------------
// Écritures
// ---------------------------------------------------------------------------------------------------------------

/// Enregistre les changements (`paths` : ces chemins seulement, nouveaux fichiers compris ; sinon tout) sous
/// l’identité git de l’utilisateur. Rend l’identifiant du commit, `None` s’il n’y avait rien à enregistrer.
pub fn commit(repo: &Repo, message: &str, paths: Option<&[String]>) -> AppResult<Option<String>> {
    repo.require()?;
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::new("Le message du commit est vide."));
    }
    let specs = paths.map(|paths| pathspecs(repo, paths)).transpose()?;
    let mut add = vec!["add", "-A", "--"];
    if let Some(specs) = &specs {
        if specs.is_empty() {
            return Err(AppError::new("`paths` est vide : donne au moins un chemin, ou omets-le pour tout enregistrer."));
        }
        add.extend(specs.iter().map(String::as_str));
    }
    repo.run(&add)?;
    let staged = |specs: &[String]| {
        let mut args = vec!["diff", "--cached", "--quiet", "--"];
        args.extend(specs.iter().map(String::as_str));
        repo.run(&args).is_err()
    };
    if !staged(specs.as_deref().unwrap_or_default()) {
        return Ok(None);
    }
    let mut args = git::user_identity_args(&repo.dir);
    args.extend(["commit", "-q", "--no-verify", "-m", message]);
    if let Some(specs) = &specs {
        // Seulement ces chemins, même si d’autres changements étaient déjà indexés.
        args.push("--");
        args.extend(specs.iter().map(String::as_str));
    }
    repo.run(&args).map_err(|error| explain_local(error, "commit"))?;
    repo.run(&["rev-parse", "HEAD"]).map(Some)
}

/// Bascule sur `branch` (créée depuis `start` avec `create`) ; une branche distante seule devient une branche locale
/// qui la suit.
pub fn switch(repo: &Repo, branch: &str, create: bool, start: Option<&str>) -> AppResult<()> {
    repo.require()?;
    let branch = ref_name(repo, branch, "branche")?;
    let mut args = vec!["switch", "-q"];
    if create {
        args.push("-c");
    }
    args.push(&branch);
    if let Some(start) = start {
        args.push(revision(start)?);
    }
    repo.run(&args).map(|_| ()).map_err(|error| explain_local(error, "changement de branche"))
}

/// Crée un tag : annoté avec `message`, léger sinon.
pub fn create_tag(repo: &Repo, name: &str, rev: Option<&str>, message: Option<&str>) -> AppResult<()> {
    repo.require()?;
    let name = ref_name(repo, name, "tag")?;
    let mut args = git::user_identity_args(&repo.dir);
    args.push("tag");
    let message = message.map(str::trim).filter(|message| !message.is_empty());
    if let Some(message) = message {
        args.extend(["-a", "-m", message]);
    }
    args.push(&name);
    if let Some(rev) = rev {
        args.push(revision(rev)?);
    }
    repo.run(&args).map(|_| ()).map_err(|error| explain_local(error, "création du tag"))
}

pub fn fetch(repo: &Repo, remote: Option<&str>) -> AppResult<()> {
    repo.require()?;
    let mut args = vec!["fetch", "--prune", "--quiet"];
    match remote {
        Some(remote) => args.push(remote_name(remote)?),
        None => args.push("--all"),
    }
    repo.remote("récupération", &args).map(|_| ())
}

/// Tire la branche suivie : en avance rapide seulement, ou en rejouant les commits locaux (`rebase`). Un rebase qui
/// bute sur un conflit est annulé : le dépôt reste tel qu’il était.
pub fn pull(repo: &Repo, rebase: bool) -> AppResult<()> {
    let status = status(repo)?;
    if status.branch.is_none() {
        return Err(AppError::new("Aucune branche n’est active (HEAD détachée) : changez de branche avant de tirer."));
    }
    if status.upstream.is_none() {
        return Err(AppError::new(format!(
            "La branche « {} » ne suit aucune branche distante : poussez-la d’abord.",
            status.branch.unwrap_or_default()
        )));
    }
    let identity = git::user_identity_args(&repo.dir);
    let mut args = identity.clone();
    if rebase {
        args.extend(["pull", "--rebase", "--autostash", "--quiet"]);
    } else {
        args.extend(["pull", "--ff-only", "--quiet"]);
    }
    match repo.remote("mise à jour", &args) {
        Ok(_) => Ok(()),
        Err(error) => {
            let stderr = crate::marketplace::stderr_of(&error).to_lowercase();
            if rebase && repo.run(&["rev-parse", "--absolute-git-dir"]).is_ok_and(|dir| Path::new(&dir).join("rebase-merge").exists() || Path::new(&dir).join("rebase-apply").exists()) {
                let _ = repo.run(&["rebase", "--abort"]);
                return Err(AppError::with_detail(
                    "Vos commits locaux entrent en conflit avec ceux de la branche distante : rien n’a été changé. Résolvez le conflit dans votre éditeur.",
                    error.detail.unwrap_or_default(),
                ));
            }
            if stderr.contains("not possible to fast-forward") || stderr.contains("diverg") {
                return Err(AppError::with_detail(
                    "La branche locale et la branche distante ont chacune des commits : une avance rapide n’est pas possible. Tirez en rejouant vos commits (`rebase: true`) ou fusionnez dans votre éditeur.",
                    error.detail.unwrap_or_default(),
                ));
            }
            if stderr.contains("would be overwritten") || stderr.contains("uncommitted changes") || stderr.contains("unstaged changes") {
                return Err(AppError::with_detail(
                    "Des modifications non enregistrées seraient écrasées : faites un commit avant de tirer.",
                    error.detail.unwrap_or_default(),
                ));
            }
            Err(error)
        }
    }
}

pub struct PushQuery {
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub tag: Option<String>,
}

/// Pousse la branche courante (ou `branch`) vers son distant, en la faisant suivre si elle ne suivait rien ; ou
/// pousse un tag. Jamais de force.
pub fn push(repo: &Repo, query: &PushQuery) -> AppResult<Value> {
    let current = status(repo)?;
    if let Some(tag) = &query.tag {
        let tag = ref_name(repo, tag, "tag")?;
        let remote = remote_name(query.remote.as_deref().unwrap_or("origin"))?;
        let spec = format!("refs/tags/{tag}");
        repo.remote("envoi du tag", &["push", "--quiet", "--no-verify", remote, &spec])?;
        return Ok(json!({ "remote": remote, "tag": tag }));
    }
    let branch = match &query.branch {
        Some(branch) => ref_name(repo, branch, "branche")?,
        None => current.branch.clone().ok_or_else(|| AppError::new("Aucune branche n’est active (HEAD détachée)."))?,
    };
    let upstream = repo.run(&["rev-parse", "--abbrev-ref", &format!("{branch}@{{upstream}}")]).ok();
    let remote = match (&query.remote, &upstream) {
        (Some(remote), _) => remote.clone(),
        (None, Some(upstream)) => upstream.split('/').next().unwrap_or("origin").to_string(),
        (None, None) => "origin".to_string(),
    };
    let remote = remote_name(&remote)?.to_string();
    let mut args = vec!["push", "--quiet", "--no-verify"];
    if upstream.is_none() {
        args.push("--set-upstream");
    }
    args.extend([remote.as_str(), branch.as_str()]);
    repo.remote("envoi", &args).map_err(|error| {
        let stderr = crate::marketplace::stderr_of(&error).to_lowercase();
        if stderr.contains("non-fast-forward") || stderr.contains("fetch first") || stderr.contains("rejected") {
            AppError::with_detail(
                "La branche distante a avancé depuis votre dernière mise à jour : tirez (`git.pull`) puis poussez de nouveau.",
                error.detail.clone().unwrap_or_default(),
            )
        } else {
            error
        }
    })?;
    Ok(json!({ "remote": remote, "branch": branch }))
}

/// Clone `url` dans `target` (qui ne doit pas exister) : dans un dossier voisin, renommé ensuite.
pub fn clone(root: &Path, target_relative: &str, url: &str) -> AppResult<()> {
    let url = clone_url(url)?;
    let target = folders::resolve(root, target_relative)?;
    if target_relative.trim_matches(['/', '\\', '.']).is_empty() || std::fs::symlink_metadata(&target).is_ok() {
        return Err(AppError::new(format!("« {target_relative} » existe déjà : choisissez un dossier neuf.")));
    }
    let parent = target.parent().ok_or_else(|| AppError::new("Chemin invalide."))?;
    std::fs::create_dir_all(parent)?;
    let parent = plain(parent);
    let staging = format!(".clone-{}", uuid::Uuid::new_v4().simple());
    // Les fins de ligne du clone suivent la configuration de l’utilisateur (`core.autocrlf` de Git for Windows).
    let autocrlf = git::run(&parent, &["config", "--global", "--get", "core.autocrlf"])
        .or_else(|_| git::run(&parent, &["config", "--system", "--get", "core.autocrlf"]))
        .ok()
        .filter(|value| value.chars().all(|c| c.is_ascii_alphanumeric()) && !value.is_empty())
        .unwrap_or_else(|| "false".into());
    let setting = format!("core.autocrlf={autocrlf}");
    let mut args = vec!["-c", setting.as_str()];
    if cfg!(windows) {
        args.extend(["-c", "core.longpaths=true"]);
    }
    args.extend(["clone", "--quiet", "--", url, staging.as_str()]);
    if let Err(error) = remote_git_with(&parent, &args, &[]) {
        let _ = crate::marketplace::remove_tree(&parent.join(&staging));
        return Err(explain_remote(error, "clonage"));
    }
    std::fs::rename(parent.join(&staging), &target)?;
    Ok(())
}

/// Phrase pour un échec local de git, la sortie de git restant en détail.
fn explain_local(error: AppError, action: &str) -> AppError {
    let stderr = crate::marketplace::stderr_of(&error);
    let lower = stderr.to_lowercase();
    let message = if lower.contains("would be overwritten") || lower.contains("local changes") {
        format!("Des modifications non enregistrées seraient écrasées ({action}) : faites d’abord un commit.")
    } else if lower.contains("already exists") {
        format!("Ce nom existe déjà ({action}).")
    } else if lower.contains("invalid reference") || lower.contains("did not match") || lower.contains("not a valid") {
        format!("Branche ou révision introuvable ({action}).")
    } else if lower.contains(".lock") {
        format!("Un autre programme travaille sur ce dépôt ({action}) : réessayez dans un instant.")
    } else if lower.contains("unmerged") || lower.contains("conflict") {
        format!("Le dépôt a des conflits non résolus ({action}) : résolvez-les dans votre éditeur.")
    } else {
        return error;
    };
    AppError::with_detail(message, json!({ "stderr": git_network::redact(&stderr) }))
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

/// Une opération à la fois par dépôt : deux pages qui tirent et enregistrent en même temps ne se gênent pas.
fn repo_lock(dir: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let mut all = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|poison| poison.into_inner());
    all.entry(key).or_default().clone()
}

fn run_command(command: &str, root: &Path, args: &Value) -> AppResult<Value> {
    if command == "frame.git.repositories" {
        return Ok(Value::Array(repositories(root)));
    }
    if command == "frame.git.clone" {
        let url: String = arg(args, "url")?;
        let path: String = arg(args, "path")?;
        clone(root, &path, &url)?;
        return Ok(Value::Null);
    }
    let repo = Repo::open(root, &opt_arg::<String>(args, "repo")?.unwrap_or_default())?;
    let lock = repo_lock(&repo.dir);
    let _guard = lock.lock().unwrap_or_else(|poison| poison.into_inner());
    let text = |name: &str| opt_arg::<String>(args, name);
    Ok(match command {
        "frame.git.status" => json!(status(&repo)?),
        "frame.git.branches" => branches(&repo)?,
        "frame.git.tags" => tags(&repo)?,
        "frame.git.log" => json!(log(
            &repo,
            &LogQuery { rev: text("ref")?, file: text("file")?, since: text("since")?, limit: opt_arg(args, "limit")?.unwrap_or(50) }
        )?),
        "frame.git.compare" => compare(&repo, &arg::<String>(args, "base")?, &text("head")?.unwrap_or_else(|| "HEAD".into()))?,
        "frame.git.diff" => diff(
            &repo,
            &DiffQuery { from: text("from")?, to: text("to")?, file: text("file")?, staged: opt_arg(args, "staged")?.unwrap_or(false) },
        )?,
        "frame.git.show" => Value::String(show(&repo, &arg::<String>(args, "ref")?, &arg::<String>(args, "file")?)?),
        "frame.git.fetch" => {
            fetch(&repo, text("remote")?.as_deref())?;
            json!(status(&repo)?)
        }
        "frame.git.pull" => {
            pull(&repo, opt_arg(args, "rebase")?.unwrap_or(false))?;
            json!(status(&repo)?)
        }
        "frame.git.push" => push(&repo, &PushQuery { remote: text("remote")?, branch: text("branch")?, tag: text("tag")? })?,
        "frame.git.commit" => {
            let paths: Option<Vec<String>> = opt_arg(args, "paths")?;
            json!({ "commit": commit(&repo, &arg::<String>(args, "message")?, paths.as_deref())? })
        }
        "frame.git.switch" => {
            switch(&repo, &arg::<String>(args, "branch")?, opt_arg(args, "create")?.unwrap_or(false), text("start")?.as_deref())?;
            json!(status(&repo)?)
        }
        "frame.git.createTag" => {
            create_tag(&repo, &arg::<String>(args, "name")?, text("ref")?.as_deref(), text("message")?.as_deref())?;
            Value::Null
        }
        _ => return Err(AppError::new(format!("Commande inconnue : {command}"))),
    })
}

/// Opérations qui changent le dépôt ou parlent au réseau : elles vont au journal.
fn journaled(command: &str) -> bool {
    matches!(command, "frame.git.fetch" | "frame.git.pull" | "frame.git.push" | "frame.git.commit" | "frame.git.switch" | "frame.git.createTag" | "frame.git.clone")
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("frame.git.") {
        return None;
    }
    Some(
        async {
            let subject: Subject = arg(args, "subject")?;
            let (folder, root) = folders::root_from(state, &subject, args)?;
            let started = std::time::Instant::now();
            let (owned_command, owned_args) = (command.to_string(), args.clone());
            let result = tokio::task::spawn_blocking(move || run_command(&owned_command, &root, &owned_args))
                .await
                .unwrap_or_else(|_| Err(AppError::new("L’opération git a été interrompue.")));
            if journaled(command) {
                let action = command.trim_start_matches("frame.git.");
                let repo = args.get("repo").and_then(Value::as_str).unwrap_or_default();
                let summary = format!("git {action} dans {}{}{repo}", folder.label, if repo.is_empty() { "" } else { "/" });
                let duration = Some(started.elapsed().as_millis() as u64);
                match &result {
                    Ok(_) => crate::functions::journal(state, "git", &subject.reference, true, duration, &summary, None),
                    Err(error) => crate::functions::journal(state, "git", &subject.reference, false, duration, &format!("{summary} : {}", error.message), error.detail.as_ref()),
                }
            }
            result
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} : {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Un distant nu, et deux clones : celui du poste (dans le dossier accordé) et celui d’un collègue.
    fn team(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let remote = dir.join("distant.git");
        std::fs::create_dir_all(&remote).unwrap();
        sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
        let mine = dir.join("produit").join("api");
        let theirs = dir.join("collegue");
        std::fs::create_dir_all(mine.parent().unwrap()).unwrap();
        // Fins de ligne fixes : le parcours ne dépend pas du `core.autocrlf` du poste (vrai sur les machines Windows).
        sh(dir, &["clone", "-q", "--config", "core.autocrlf=false", remote.to_str().unwrap(), theirs.to_str().unwrap()]);
        std::fs::create_dir_all(theirs.join(".oneapp")).unwrap();
        std::fs::write(theirs.join(".oneapp/produit.json"), "{\"nom\":\"Alpha\"}\n").unwrap();
        sh(&theirs, &["add", "-A"]);
        sh(&theirs, &["commit", "-q", "-m", "premier"]);
        sh(&theirs, &["push", "-q", "origin", "main"]);
        sh(dir, &["clone", "-q", "--config", "core.autocrlf=false", remote.to_str().unwrap(), mine.to_str().unwrap()]);
        (remote, mine, theirs)
    }

    #[test]
    fn status_parses_branch_and_every_kind_of_change() {
        let output = b"# branch.oid abc\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +2 -1\x001 .M N... 100644 100644 100644 h1 h2 src/a b.rs\x001 A. N... 000000 100644 100644 h1 h2 neuf.txt\x002 R. N... 100644 100644 100644 h1 h2 R100 nouveau.md\x00ancien.md\x00u UU N... 100644 100644 100644 100644 h1 h2 h3 conflit.txt\x00? brouillon.txt\x00";
        let status = parse_status(output);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        let kinds: Vec<(&str, &str, bool)> = status.files.iter().map(|f| (f.path.as_str(), f.kind, f.staged)).collect();
        assert_eq!(
            kinds,
            vec![
                ("src/a b.rs", "modified", false),
                ("neuf.txt", "added", true),
                ("nouveau.md", "renamed", true),
                ("conflit.txt", "conflicted", false),
                ("brouillon.txt", "untracked", false),
            ]
        );
        assert_eq!(status.files[2].from.as_deref(), Some("ancien.md"));
        assert!(!status.clean);
    }

    #[test]
    fn options_and_ranges_are_never_taken_for_names() {
        for bad in ["-x", "--upload-pack=x", "a..b", "a b", ""] {
            assert!(revision(bad).is_err(), "{bad}");
        }
        assert!(revision("origin/main").is_ok() && revision("HEAD~2").is_ok() && revision("v1.2.0").is_ok());
        for bad in ["ext::sh -c x", "file:///etc", "-u", "/chemin/local", "C:\\depot"] {
            assert!(clone_url(bad).is_err(), "{bad}");
        }
        assert!(clone_url("https://git.example.com/equipe/alpha.git").is_ok());
        assert!(clone_url("git@github.com:equipe/alpha.git").is_ok());
    }

    /// Les fins de ligne réglées par l’utilisateur passent, malgré le `core.autocrlf=false` neutre du git de l’espace :
    /// sinon, sous Windows (`autocrlf=true` par défaut), chaque fichier extrait en CRLF paraît modifié.
    #[test]
    fn the_user_line_endings_win_over_the_neutral_ones() {
        let dir = tempfile::tempdir().unwrap();
        let (_remote, mine, _theirs) = team(dir.path());
        sh(&mine, &["config", "core.autocrlf", "input"]);
        let repo = Repo::open(&mine.parent().unwrap().canonicalize().unwrap(), "api").unwrap();
        assert!(repo.user_settings().contains(&"core.autocrlf=input".to_string()), "{:?}", repo.user_settings());
    }

    /// Parcours complet sur des dépôts réels : lire l’état, écrire un fichier partagé, enregistrer, pousser ; un
    /// collègue pousse à son tour, on récupère, on tire ; branches, tags, écarts et différences.
    #[test]
    fn a_shared_repository_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let (_remote, mine, theirs) = team(dir.path());
        let root = mine.parent().unwrap().canonicalize().unwrap();
        // Le dossier accordé est celui du produit ; le dépôt est un de ses composants.
        assert_eq!(repositories(&root), vec![json!({ "repo": "api", "name": "api" })]);
        let repo = Repo::open(&root, "api").unwrap();
        let clean = status(&repo).unwrap();
        assert_eq!(clean.branch.as_deref(), Some("main"));
        assert_eq!(clean.upstream.as_deref(), Some("origin/main"));
        assert!(clean.clean, "{clean:?}");
        assert_eq!(clean.repo, "api");

        // Le dossier du produit lui-même n’est pas un dépôt, même s’il est dans un autre dépôt plus haut.
        sh(dir.path(), &["init", "-q"]);
        let outer = Repo::open(&root, "").unwrap();
        assert!(!outer.is_repository(), "la recherche du dépôt s’arrête au dossier accordé");
        assert!(status(&outer).unwrap_err().message.contains("n’est pas un dépôt"));

        // Écrire un fichier de configuration partagé, puis l’enregistrer et le pousser.
        folders::write_bytes(&root, "api/.oneapp/produit.json", b"{\"nom\":\"Alpha 2\"}\n").unwrap();
        folders::write_bytes(&root, "api/brouillon.txt", b"pas pour l\xe2\x80\x99\xc3\xa9quipe").unwrap();
        let dirty = status(&repo).unwrap();
        assert_eq!(dirty.files.len(), 2);
        let id = commit(&repo, "Produit renommé", Some(&[".oneapp/produit.json".to_string()])).unwrap().unwrap();
        assert_eq!(id.len(), 40);
        let after = status(&repo).unwrap();
        assert_eq!(after.ahead, 1);
        assert_eq!(after.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["brouillon.txt"], "seul le chemin donné est enregistré");
        assert!(commit(&repo, "Rien", Some(&[".oneapp/produit.json".to_string()])).unwrap().is_none());
        assert!(commit(&repo, "Hors", Some(&["../../secret".to_string()])).is_err());
        push(&repo, &PushQuery { remote: None, branch: None, tag: None }).unwrap();
        assert_eq!(status(&repo).unwrap().ahead, 0);

        // Le collègue tire, modifie et pousse ; on récupère l’écart puis on tire en avance rapide.
        sh(&theirs, &["pull", "-q", "--ff-only"]);
        std::fs::write(theirs.join(".oneapp/produit.json"), "{\"nom\":\"Alpha 3\"}\n").unwrap();
        sh(&theirs, &["commit", "-q", "-am", "par le collègue"]);
        sh(&theirs, &["push", "-q"]);
        fetch(&repo, None).unwrap();
        assert_eq!(status(&repo).unwrap().behind, 1);
        let gap = compare(&repo, "HEAD", "origin/main").unwrap();
        assert_eq!(gap["ahead"], 1);
        assert_eq!(gap["commits"][0]["message"], "par le collègue");
        assert_eq!(gap["commits"][0]["author"], "Test");
        let changed = diff(&repo, &DiffQuery { from: Some("HEAD".into()), to: Some("origin/main".into()), file: None, staged: false }).unwrap();
        assert!(changed["text"].as_str().unwrap().contains("+{\"nom\":\"Alpha 3\"}"));
        assert_eq!(changed["files"][0]["path"], ".oneapp/produit.json");
        pull(&repo, false).unwrap();
        assert_eq!(folders::read_text(&root, "api/.oneapp/produit.json").unwrap(), "{\"nom\":\"Alpha 3\"}\n");
        assert_eq!(show(&repo, "HEAD~1", ".oneapp/produit.json").unwrap(), "{\"nom\":\"Alpha 2\"}\n");

        // Divergence : un commit de chaque côté ; l’avance rapide est refusée, le rebase passe.
        std::fs::write(theirs.join("LISEZMOI.md"), "collègue\n").unwrap();
        sh(&theirs, &["add", "-A"]);
        sh(&theirs, &["commit", "-q", "-m", "lisez-moi"]);
        sh(&theirs, &["push", "-q"]);
        folders::write_bytes(&root, "api/notes.md", b"moi\n").unwrap();
        commit(&repo, "notes", Some(&["notes.md".to_string()])).unwrap();
        let refused = pull(&repo, false).unwrap_err();
        assert!(refused.message.contains("avance rapide"), "{}", refused.message);
        pull(&repo, true).unwrap();
        let rebased = status(&repo).unwrap();
        assert_eq!((rebased.ahead, rebased.behind), (1, 0));
        assert!(rebased.files.iter().any(|f| f.path == "brouillon.txt"), "le brouillon non suivi reste");

        // Branches et tags.
        switch(&repo, "fonction/export", true, None).unwrap();
        push(&repo, &PushQuery { remote: None, branch: None, tag: None }).unwrap();
        let listed = branches(&repo).unwrap();
        assert_eq!(listed["current"], "fonction/export");
        assert!(listed["remote"].as_array().unwrap().iter().any(|b| b["name"] == "origin/fonction/export"));
        switch(&repo, "main", false, None).unwrap();
        assert!(switch(&repo, "--orphan", false, None).is_err());
        create_tag(&repo, "v1.0.0", None, Some("Première version")).unwrap();
        create_tag(&repo, "v1.0.1", Some("HEAD"), None).unwrap();
        push(&repo, &PushQuery { remote: None, branch: None, tag: Some("v1.0.0".into()) }).unwrap();
        let tagged = tags(&repo).unwrap();
        let names: Vec<&str> = tagged.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"v1.0.0") && names.contains(&"v1.0.1"));
        assert!(tagged.as_array().unwrap().iter().any(|t| t["name"] == "v1.0.0" && t["annotated"] == true));
        sh(&theirs, &["fetch", "-q", "--tags"]);
        assert_eq!(sh(&theirs, &["tag", "--list", "v1.0.0"]), "v1.0.0");
        let history = log(&repo, &LogQuery { rev: None, file: Some(".oneapp/produit.json".into()), since: None, limit: 10 }).unwrap();
        assert_eq!(history.len(), 3);

        // Le collègue avance pendant qu’on enregistre : l’envoi est refusé avec la marche à suivre.
        sh(&theirs, &["pull", "-q", "--rebase"]);
        std::fs::write(theirs.join("b.txt"), "b").unwrap();
        sh(&theirs, &["add", "-A"]);
        sh(&theirs, &["commit", "-q", "-m", "b"]);
        sh(&theirs, &["push", "-q"]);
        let rejected = push(&repo, &PushQuery { remote: None, branch: None, tag: None }).unwrap_err();
        assert!(rejected.message.contains("tirez"), "{}", rejected.message);

        // Cloner un dépôt dans le dossier accordé.
        let url = format!("file://{}", dir.path().join("distant.git").display());
        assert!(clone(&root, "web", &url).is_err(), "file:// est refusé");
    }

    /// Ni crochet du dépôt (husky compris), ni filtre, ni aide d’identification du dépôt ne s’exécutent.
    #[cfg(unix)]
    #[test]
    fn hooks_and_programs_of_a_user_repository_never_run() {
        let dir = tempfile::tempdir().unwrap();
        let (_remote, mine, _theirs) = team(dir.path());
        let root = mine.parent().unwrap().canonicalize().unwrap();
        let marker = dir.path().join("execute");
        std::fs::create_dir_all(mine.join(".husky")).unwrap();
        for hook in ["pre-commit", "post-commit", "pre-push", "post-merge", "post-checkout"] {
            let path = mine.join(".husky").join(hook);
            std::fs::write(&path, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::copy(&path, mine.join(".git/hooks").join(hook)).unwrap();
        }
        sh(&mine, &["config", "core.hooksPath", ".husky"]);
        let repo = Repo::open(&root, "api").unwrap();
        folders::write_bytes(&root, "api/a.txt", b"a").unwrap();
        commit(&repo, "a", None).unwrap();
        push(&repo, &PushQuery { remote: None, branch: None, tag: None }).unwrap();
        switch(&repo, "autre", true, None).unwrap();
        assert!(!marker.exists(), "aucun crochet ne doit tourner");

        sh(&mine, &["config", "filter.x.clean", &format!("touch '{}'", marker.display())]);
        assert!(status(&repo).unwrap_err().message.contains("filter.x.clean"));
        assert!(!marker.exists());
    }
}
