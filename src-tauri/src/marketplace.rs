//! Marketplaces : modules partagés et mis à jour par des dépôts git.
//!
//! Un marketplace est un dépôt git ordinaire contenant un dossier par module. Il est cloné hors de l’espace, dans
//! les données d’Alfred, et ce clone n’est jamais modifié à la main : il suit la branche par défaut du distant.
//! Installer un module copie son dossier dans l’espace en notant d’où il vient ; il reste en lecture seule tant
//! qu’il n’est pas détaché. Rien n’est jamais fusionné en silence : une mise à jour remplace le dossier entier,
//! sur accord, dans un commit de l’espace que l’on peut annuler.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{self, ModuleManifest, Origin, Space, MODULE_FILE, MODULES_DIR};
use crate::state::AppState;
use crate::{app_db, git, transpile};

const SETTING: &str = "marketplaces";
const CHANGELOG: &str = "CHANGELOG.md";
/// Jamais copiés d’un dossier à l’autre : dépôt imbriqué et fichiers que le système d’exploitation sème.
const SKIPPED: [&str; 3] = [".git", ".DS_Store", "Thumbs.db"];

const COMMANDS: [&str; 15] = [
    "marketplace.list",
    "marketplace.add",
    "marketplace.remove",
    "marketplace.refresh",
    "marketplace.modules",
    "marketplace.install",
    "marketplace.updates",
    "marketplace.update",
    "marketplace.updateAll",
    "marketplace.pin",
    "marketplace.detach",
    "marketplace.uninstall",
    "marketplace.publish",
    "marketplace.suggestVersion",
    "marketplace.publications",
];

/// Une seule opération à la fois : deux commandes ne doivent pas déplacer le même clone, ni écrire deux commits
/// de l’espace entremêlés (vérification périodique pendant une publication, par exemple).
static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !COMMANDS.contains(&command) {
        return None;
    }
    let (state, command, args) = (state.clone(), command.to_string(), args.clone());
    // La liste ne lit que les réglages : elle n’attend pas derrière un rafraîchissement réseau en cours.
    let _guard = if matches!(command.as_str(), "marketplace.list" | "marketplace.publications") { None } else { Some(OPERATIONS.lock().await) };
    // Git et le disque sont bloquants : tout le traitement quitte le fil asynchrone.
    let outcome = tokio::task::spawn_blocking(move || run(&state, &command, &args)).await;
    Some(outcome.unwrap_or_else(|_| Err(AppError::new("L’opération sur les marketplaces a été interrompue."))))
}

fn run(state: &Arc<AppState>, command: &str, args: &Value) -> AppResult<Value> {
    match command {
        "marketplace.list" => list(state),
        "marketplace.add" => add(state, &arg::<String>(args, "url")?, opt_arg(args, "name")?),
        "marketplace.remove" => remove(state, &arg::<String>(args, "id")?),
        "marketplace.refresh" => refresh(state, opt_arg::<String>(args, "id")?.as_deref()),
        "marketplace.modules" => modules(state, &arg::<String>(args, "id")?),
        "marketplace.publications" => publications(state),
        "marketplace.install" => {
            install(state, &arg::<String>(args, "marketplace")?, &arg::<String>(args, "module")?)
        }
        "marketplace.updates" => {
            if opt_arg::<bool>(args, "refresh")?.unwrap_or(false) {
                // Un marketplace injoignable garde son erreur dans la liste ; les autres sont vérifiés quand même.
                refresh(state, None)?;
            }
            updates(state)
        }
        "marketplace.update" => {
            let space = state.space()?;
            let updated = update_one(state, &space, &arg::<String>(args, "module")?)?;
            state.emit("space:changed", Value::Null);
            Ok(updated)
        }
        "marketplace.updateAll" => update_all(state),
        "marketplace.pin" => pin(state, &arg::<String>(args, "module")?, arg(args, "pinned")?),
        "marketplace.detach" => detach(state, &arg::<String>(args, "module")?),
        "marketplace.uninstall" => uninstall(state, &arg::<String>(args, "module")?, arg(args, "deleteData")?),
        "marketplace.publish" => publish(
            state,
            &arg::<String>(args, "module")?,
            &arg::<String>(args, "marketplace")?,
            &arg::<String>(args, "version")?,
            opt_arg::<String>(args, "notes")?.as_deref().unwrap_or(""),
        ),
        "marketplace.suggestVersion" => suggest_version(
            state,
            &arg::<String>(args, "module")?,
            &arg::<String>(args, "marketplace")?,
            opt_arg::<bool>(args, "refresh")?.unwrap_or(false),
        ),
        _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Marketplaces branchés
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marketplace {
    id: String,
    url: String,
    name: String,
    added_at: String,
    #[serde(default)]
    last_checked: Option<String>,
    /// Dernier échec de rafraîchissement, effacé au rafraîchissement réussi suivant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn load(state: &AppState) -> AppResult<Vec<Marketplace>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    Ok(app_db::get_setting(&db, SETTING)?.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default())
}

fn save(state: &AppState, marketplaces: &[Marketplace]) -> AppResult<()> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::set_setting(&db, SETTING, &serde_json::to_value(marketplaces)?)
}

fn clone_dir(state: &AppState, id: &str) -> PathBuf {
    state.data_dir.join("marketplaces").join(id)
}

fn find(state: &AppState, id: &str) -> AppResult<Marketplace> {
    load(state)?
        .into_iter()
        .find(|marketplace| marketplace.id == id)
        .ok_or_else(|| AppError::new(format!("Le marketplace « {id} » n’est pas branché.")))
}

/// Deux écritures de la même adresse (`…/depot`, `…/depot.git`, `…/depot/`) désignent le même dépôt.
fn normalized_url(url: &str) -> &str {
    let url = url.trim().trim_end_matches('/');
    url.strip_suffix(".git").unwrap_or(url)
}

fn same_url(left: &str, right: &str) -> bool {
    normalized_url(left) == normalized_url(right)
}

fn default_name(url: &str) -> String {
    let name = normalized_url(url).rsplit(['/', ':', '\\']).next().unwrap_or_default().trim();
    if name.is_empty() {
        "Marketplace".to_string()
    } else {
        name.to_string()
    }
}

/// L’adresse est recopiée dans les réglages et dans le manifeste de chaque module installé, donc dans l’historique
/// de l’espace : elle ne doit porter aucun identifiant.
fn carries_credentials(address: &str) -> bool {
    let Ok(parsed) = url::Url::parse(address) else { return false };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    parsed.password().is_some() || parsed.username().len() >= 30 || has_known_token(parsed.username())
}

fn list(state: &AppState) -> AppResult<Value> {
    let mut marketplaces = load(state)?;
    for marketplace in &mut marketplaces {
        if marketplace.error.is_none() && !clone_dir(state, &marketplace.id).join(".git").exists() {
            marketplace.error = Some("Le clone local est absent. Rafraîchir pour le recréer.".to_string());
        }
    }
    Ok(serde_json::to_value(marketplaces)?)
}

fn add(state: &AppState, url: &str, name: Option<String>) -> AppResult<Value> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::new("Indiquer l’adresse git du marketplace."));
    }
    if url.starts_with('-') {
        return Err(AppError::new("Adresse git invalide."));
    }
    if carries_credentials(url) {
        return Err(AppError::new(
            "L’adresse contient un mot de passe ou un jeton. Le retirer : Alfred utilise les identifiants git déjà configurés sur ce poste.",
        ));
    }
    let mut marketplaces = load(state)?;
    if marketplaces.iter().any(|marketplace| same_url(&marketplace.url, url)) {
        return Err(AppError::new("Ce marketplace est déjà branché."));
    }
    let name = name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty()).unwrap_or_else(|| default_name(url));
    let base = space::slug(&name);
    let id = (1..)
        .map(|index| if index == 1 { base.clone() } else { format!("{base}-{index}") })
        .find(|id| !marketplaces.iter().any(|marketplace| &marketplace.id == id))
        .unwrap_or_default();

    let target = clone_dir(state, &id);
    // Reste d’un marketplace débranché dont le dossier n’a pas pu être supprimé.
    remove_tree(&target)?;
    clone_into(url, &target)?;
    if target.join(space::SPACE_FILE).exists() {
        remove_tree(&target)?;
        return Err(AppError::new(
            "Cette adresse est celle d’un espace de travail, pas d’un marketplace. Un marketplace est un dépôt git qui contient un dossier par module ; publiez-y vos modules depuis leur fiche.",
        ));
    }

    let marketplace = Marketplace {
        id,
        url: url.to_string(),
        name,
        added_at: app_db::now(),
        last_checked: Some(app_db::now()),
        error: None,
    };
    marketplaces.push(marketplace.clone());
    save(state, &marketplaces)?;
    Ok(serde_json::to_value(marketplace)?)
}

/// Un espace de travail n’est pas un marketplace, et inversement : chacun a sa forme (`alfred.json` et `modules/`
/// pour l’un, un dossier par module à la racine pour l’autre). Refuse d’ouvrir comme espace de travail un clone de
/// marketplace d’Alfred, ou un dossier qui a la forme d’un marketplace.
pub fn refuse_as_workspace(state: &AppState, path: &Path) -> AppResult<()> {
    let refusal = || {
        AppError::new(
            "Ce dossier est un marketplace (un catalogue de modules partagé), pas un espace de travail. Ajoutez son adresse dans Réglages › Marketplace pour importer ses modules, et choisissez un autre dossier pour l’espace de travail.",
        )
    };
    let clones = state.data_dir.join("marketplaces");
    let canonical = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if canonical(path).starts_with(canonical(&clones)) {
        return Err(refusal());
    }
    if path.join(space::SPACE_FILE).exists() {
        return Ok(());
    }
    if path.join(MODULE_FILE).is_file() || !catalog_ids(path).is_empty() {
        return Err(refusal());
    }
    // Un dépôt git nu (celui d’un marketplace sur un serveur ou un partage) n’a pas de fichiers où ranger un
    // espace de travail.
    let bare = !path.join(".git").exists()
        && path.join("HEAD").is_file()
        && path.join("objects").is_dir()
        && path.join("refs").is_dir();
    if bare {
        return Err(AppError::new(
            "Ce dossier est un dépôt git nu, comme celui d’un marketplace : il ne peut pas contenir un espace de travail. S’il s’agit d’un marketplace, ajoutez son adresse dans Réglages › Marketplace, et choisissez un autre dossier pour l’espace de travail.",
        ));
    }
    Ok(())
}

fn remove(state: &AppState, id: &str) -> AppResult<Value> {
    let mut marketplaces = load(state)?;
    let before = marketplaces.len();
    marketplaces.retain(|marketplace| marketplace.id != id);
    if marketplaces.len() == before {
        return Err(AppError::new(format!("Le marketplace « {id} » n’est pas branché.")));
    }
    // Les modules déjà installés restent dans l’espace ; ils seront signalés sans source.
    save(state, &marketplaces)?;
    remove_tree(&clone_dir(state, id))?;
    Ok(Value::Null)
}

/// Rafraîchit un marketplace, ou tous. Pour un seul, l’échec est renvoyé ; pour tous, il est noté sur chaque
/// marketplace fautif sans empêcher de vérifier les autres.
fn refresh(state: &AppState, only: Option<&str>) -> AppResult<Value> {
    let mut marketplaces = load(state)?;
    if let Some(id) = only {
        if !marketplaces.iter().any(|marketplace| marketplace.id == id) {
            return Err(AppError::new(format!("Le marketplace « {id} » n’est pas branché.")));
        }
    }
    let mut failure = None;
    for marketplace in marketplaces.iter_mut().filter(|marketplace| only.is_none_or(|id| marketplace.id == id)) {
        match sync_clone(&clone_dir(state, &marketplace.id), &marketplace.url) {
            Ok(()) => marketplace.error = None,
            Err(error) => {
                marketplace.error = Some(error.message.clone());
                failure = Some(error);
            }
        }
        marketplace.last_checked = Some(app_db::now());
    }
    save(state, &marketplaces)?;
    match (only, failure) {
        (Some(_), Some(error)) => Err(error),
        _ => Ok(serde_json::to_value(marketplaces)?),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Git distant
// ---------------------------------------------------------------------------------------------------------------

/// Git pour les opérations réseau (clone, fetch, push). Seuls les identifiants déjà configurés sur le poste
/// servent : aucune question au terminal, aucune fenêtre du gestionnaire d’identifiants, aucune phrase secrète
/// demandée par SSH. Une connexion qui ne répond plus est abandonnée au lieu de bloquer l’interface.
pub(crate) fn remote_git(dir: &Path, args: &[&str]) -> AppResult<String> {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C")
        .args(["-c", "credential.interactive=false", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"])
        // Un clone garde les fins de ligne du dépôt, même avec le `core.autocrlf=true` de Git for Windows.
        .args(["-c", "core.autocrlf=false"])
        .args(args);
    if let Some(ssh) = ssh_command(dir) {
        command.env("GIT_SSH_COMMAND", ssh);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output =
        command.output().map_err(|error| AppError::new(format!("Git est introuvable sur ce poste : {error}")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(AppError::with_detail(
            format!("Git a refusé l’opération « {} ».", args.first().copied().unwrap_or_default()),
            json!({ "stderr": stderr }),
        ))
    }
}

/// Commande SSH du poste, complétée pour ne jamais attendre de saisie. Celle que l’utilisateur a configurée (clé
/// ou agent particulier) est conservée ; un programme tiers désigné par `GIT_SSH` n’est pas touché, ses options
/// n’étant pas celles d’OpenSSH.
fn ssh_command(dir: &Path) -> Option<String> {
    if std::env::var_os("GIT_SSH").is_some() {
        return None;
    }
    let configured = std::env::var("GIT_SSH_COMMAND")
        .ok()
        .or_else(|| git::run(dir, &["config", "--get", "core.sshCommand"]).ok())
        .filter(|command| !command.trim().is_empty())
        .unwrap_or_else(|| "ssh".to_string());
    Some(format!("{configured} -o BatchMode=yes -o ConnectTimeout=20"))
}

pub(crate) fn stderr_of(error: &AppError) -> String {
    error.detail.as_ref().and_then(|detail| detail.get("stderr")).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// Traduit l’échec d’une opération distante en une phrase qui dit quoi vérifier ; la sortie de git reste en détail.
pub(crate) fn explain_remote(error: AppError, action: &str) -> AppError {
    let stderr = stderr_of(&error);
    if stderr.is_empty() {
        return error;
    }
    let lower = stderr.to_lowercase();
    let mentions = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    let message = if mentions(&[
        "authentication failed",
        "permission denied",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "access denied",
        "error: 401",
        "error: 403",
        "publickey",
    ]) {
        format!(
            "Accès refusé ({action}). Les identifiants git configurés sur ce poste ne donnent pas accès à ce dépôt."
        )
    } else if mentions(&["repository not found", "does not appear to be a git repository", "does not exist", "error: 404"]) {
        format!("Dépôt introuvable ({action}). Vérifier l’adresse.")
    } else if mentions(&[
        "could not resolve host",
        "failed to connect",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "connection refused",
        "unable to access",
    ]) {
        format!("Dépôt injoignable ({action}). Vérifier le réseau ou l’adresse.")
    } else {
        format!("Git a échoué ({action}).")
    };
    AppError::with_detail(message, json!({ "stderr": stderr }))
}

/// Clone dans un dossier voisin puis le renomme : un clone interrompu ne laisse jamais un marketplace à moitié là.
pub(crate) fn clone_into(url: &str, target: &Path) -> AppResult<()> {
    let parent = target.parent().ok_or_else(|| AppError::new("Dossier des marketplaces invalide."))?;
    fs::create_dir_all(parent)?;
    let staging_name = format!(".clone-{}", uuid::Uuid::new_v4().simple());
    let staging = parent.join(&staging_name);
    if let Err(error) = remote_git(parent, &["clone", "--quiet", "--", url, &staging_name]) {
        let _ = remove_tree(&staging);
        return Err(explain_remote(error, "clonage"));
    }
    rename_dir(&staging, target)?;
    Ok(())
}

fn sync_clone(clone: &Path, url: &str) -> AppResult<()> {
    if !clone.join(".git").exists() {
        remove_tree(clone)?;
        return clone_into(url, clone);
    }
    fetch_and_align(clone)
}

fn remote_ref_exists(clone: &Path, name: &str) -> bool {
    git::run(clone, &["rev-parse", "-q", "--verify", &format!("refs/remotes/origin/{name}^{{commit}}")]).is_ok()
}

pub(crate) fn fetch_and_align(clone: &Path) -> AppResult<()> {
    remote_git(clone, &["fetch", "--prune", "--quiet", "origin"])
        .map_err(|error| explain_remote(error, "rafraîchissement"))?;
    if !remote_ref_exists(clone, "HEAD") {
        // Dépôt cloné vide puis alimenté, ou branche par défaut supprimée : on redemande au distant laquelle suivre.
        let _ = remote_git(clone, &["remote", "set-head", "origin", "--auto"]);
    }
    align(clone)
}

/// Branche du distant que le clone suit : sa branche par défaut, sinon celle du clone si le distant l’a, sinon la
/// première qu’il propose. `None` tant que le distant n’a aucun commit.
pub(crate) fn remote_branch(clone: &Path) -> Option<String> {
    if remote_ref_exists(clone, "HEAD") {
        let target = git::run(clone, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).unwrap_or_default();
        if let Some(branch) = target.strip_prefix("refs/remotes/origin/") {
            return Some(branch.to_string());
        }
    }
    if let Ok(current) = git::run(clone, &["symbolic-ref", "-q", "--short", "HEAD"]) {
        if remote_ref_exists(clone, &current) {
            return Some(current);
        }
    }
    git::run(clone, &["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])
        .ok()?
        .lines()
        .filter_map(|reference| reference.strip_prefix("refs/remotes/origin/"))
        .find(|branch| *branch != "HEAD")
        .map(str::to_string)
}

/// Remet le clone exactement dans l’état du distant tel qu’il a été récupéré. Le clone n’est jamais modifié à la
/// main : tout ce qui s’y trouve en plus est le reste d’une publication qui n’a pas abouti.
fn align(clone: &Path) -> AppResult<()> {
    match remote_branch(clone) {
        Some(branch) => {
            git::run(clone, &["checkout", "-q", "-f", "-B", &branch, &format!("refs/remotes/origin/{branch}")])?;
            git::run(clone, &["clean", "-fdxq"])?;
        }
        None => {
            // Distant sans commit : rien à suivre, donc rien ne doit rester non plus dans le clone.
            if git::run(clone, &["rev-parse", "-q", "--verify", "HEAD"]).is_ok() {
                git::run(clone, &["update-ref", "-d", "HEAD"])?;
            }
            let _ = git::run(clone, &["read-tree", "--empty"]);
            for entry in fs::read_dir(clone)?.flatten() {
                if entry.file_name() != ".git" {
                    remove_tree(&entry.path())?;
                }
            }
        }
    }
    Ok(())
}

/// Commit dans le clone d’un marketplace, sous l’identité git de l’utilisateur pour que l’équipe voie qui a
/// publié ; sous celle d’Alfred si le poste n’en a pas. La signature est désactivée : elle pourrait demander une
/// phrase secrète.
pub(crate) fn commit_clone(clone: &Path, message: &str) -> AppResult<Option<String>> {
    git::run(clone, &["add", "-A"])?;
    if !git::has_changes(clone)? {
        return Ok(None);
    }
    let configured = |key: &str| git::run(clone, &["config", "--get", key]).is_ok_and(|value| !value.is_empty());
    let mut args = vec!["-c", "commit.gpgsign=false"];
    if !(configured("user.name") && configured("user.email")) {
        args.extend(["-c", "user.name=Alfred", "-c", "user.email=alfred@localhost"]);
    }
    args.extend(["commit", "-q", "--no-verify", "-m", message]);
    git::run(clone, &args)?;
    git::run(clone, &["rev-parse", "HEAD"]).map(Some)
}

/// Dernier commit du marketplace qui touche le dossier du module : c’est lui qui identifie ce qui a été installé.
fn last_commit(clone: &Path, module: &str) -> String {
    git::run(clone, &["log", "-1", "--format=%H", "--", module]).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------------------------------------------

/// Sous Windows, un antivirus, l’indexeur ou un éditeur qui tient encore un fichier fait échouer un renommage ou
/// une suppression pendant un instant (accès refusé, violation de partage, dossier « pas vide » en attente de
/// suppression) : l’opération est retentée quelques fois avant d’abandonner.
fn windows_transient(error: &std::io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 145))
}

fn retrying<T>(
    transient: impl Fn(&std::io::Error) -> bool,
    mut operation: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let mut attempt = 0;
    loop {
        match operation() {
            Err(error) if attempt < 10 && transient(&error) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            other => return other,
        }
    }
}

fn rename_dir(from: &Path, to: &Path) -> AppResult<()> {
    Ok(retrying(windows_transient, || fs::rename(from, to))?)
}

pub(crate) fn remove_tree(path: &Path) -> AppResult<()> {
    match retrying(windows_transient, || fs::remove_dir_all(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            // Sous Windows, les objets git sont en lecture seule et résistent à la suppression.
            #[cfg(windows)]
            {
                make_writable(path);
                if fs::remove_dir_all(path).is_ok() {
                    return Ok(());
                }
            }
            Err(error.into())
        }
    }
}

#[cfg(windows)]
fn make_writable(path: &Path) {
    let Ok(entries) = fs::read_dir(path) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            make_writable(&path);
        } else if let Ok(metadata) = fs::metadata(&path) {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            let _ = fs::set_permissions(&path, permissions);
        }
    }
}

/// Copie un dossier de module. Les liens symboliques sont ignorés : un module partagé ne doit pas pouvoir
/// désigner, ni faire recopier, un fichier situé hors de son dossier.
fn copy_tree(from: &Path, to: &Path) -> AppResult<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIPPED.iter().any(|skipped| name == *skipped) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// Fichiers d’un dossier de module, en chemins relatifs à barres obliques, triés.
fn list_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, files: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            if SKIPPED.contains(&name.as_str()) {
                continue;
            }
            let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => walk(&entry.path(), &relative, files),
                Ok(kind) if kind.is_file() => files.push(relative),
                _ => {}
            }
        }
    }
    let mut files = Vec::new();
    walk(root, "", &mut files);
    files.sort();
    files
}

/// Manifeste brut d’un dossier de module. Les copies passent par lui plutôt que par `ModuleManifest` pour ne
/// perdre aucun champ qu’une version plus récente d’Alfred aurait ajouté.
fn read_manifest_map(dir: &Path) -> AppResult<Map<String, Value>> {
    let text = fs::read_to_string(dir.join(MODULE_FILE))
        .map_err(|_| AppError::new("Le manifeste du module (module.json) est introuvable."))?;
    serde_json::from_str(&text)
        .map_err(|error| AppError::new(format!("Le manifeste du module (module.json) est illisible : {error}")))
}

fn typed_manifest(map: &Map<String, Value>, id: &str) -> AppResult<ModuleManifest> {
    let mut manifest: ModuleManifest = serde_json::from_value(Value::Object(map.clone()))
        .map_err(|error| AppError::new(format!("Le manifeste du module « {id} » est illisible : {error}")))?;
    // Le dossier fait foi, comme dans l’espace.
    manifest.id = id.to_string();
    Ok(manifest)
}

fn display_name(manifest: &ModuleManifest) -> &str {
    if manifest.name.trim().is_empty() {
        &manifest.id
    } else {
        manifest.name.trim()
    }
}

fn check_module_id(id: &str) -> AppResult<()> {
    if space::valid_id(id) {
        Ok(())
    } else {
        Err(AppError::new(format!("Identifiant de module invalide : « {id} ».")))
    }
}

/// Modules proposés par un marketplace : chaque dossier de la racine du dépôt qui contient un `module.json`.
fn catalog_ids(clone: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(clone) else { return Vec::new() };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().join(MODULE_FILE).is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|id| space::valid_id(id))
        .collect();
    ids.sort();
    ids
}

fn catalog_manifest(clone: &Path, id: &str) -> AppResult<ModuleManifest> {
    typed_manifest(&read_manifest_map(&clone.join(id))?, id)
}

// ---------------------------------------------------------------------------------------------------------------
// Versions et notes
// ---------------------------------------------------------------------------------------------------------------

fn parse_version(text: &str) -> Option<[u64; 3]> {
    space::parse_version(text)
}

fn format_version(version: [u64; 3]) -> String {
    format!("{}.{}.{}", version[0], version[1], version[2])
}

/// Une version illisible d’un côté ne se compare pas : toute différence est alors signalée plutôt que tue.
fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => candidate.trim() != current.trim(),
    }
}

/// Entrées du journal des versions d’un module, la plus récente d’abord : `(version, notes)`.
fn changelog_entries(text: &str) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        if let Some(title) = line.strip_prefix("## ") {
            let version = title.split_whitespace().next().unwrap_or_default().trim_start_matches('v').to_string();
            entries.push((version, String::new()));
        } else if let Some((_, body)) = entries.last_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    entries.into_iter().map(|(version, body)| (version, body.trim().to_string())).collect()
}

fn with_new_entry(previous: &str, version: &str, notes: &str) -> String {
    let date = app_db::now().chars().take(10).collect::<String>();
    let notes = notes.trim();
    let mut text = format!("## {version} — {date}\n\n");
    if !notes.is_empty() {
        text.push_str(notes);
        text.push_str("\n\n");
    }
    text.push_str(previous.trim_start());
    text
}

/// Notes des versions parues après `current` ; sans version de référence, celles de la dernière version.
fn notes_since(module_dir: &Path, current: Option<&str>) -> String {
    let entries = changelog_entries(&fs::read_to_string(module_dir.join(CHANGELOG)).unwrap_or_default());
    let relevant: Vec<&(String, String)> = match current {
        Some(current) => entries.iter().filter(|(version, _)| is_newer(version, current)).collect(),
        None => entries.iter().take(1).collect(),
    };
    match relevant.as_slice() {
        [] => String::new(),
        [(_, notes)] => notes.clone(),
        several => several
            .iter()
            .map(|(version, notes)| format!("Version {version}\n{notes}").trim().to_string())
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Contenu et accès d’un module
// ---------------------------------------------------------------------------------------------------------------

/// Ce qu’un module demande au-delà de ses propres pages : l’utilisateur doit le voir avant d’installer, et de
/// nouveau quand une mise à jour en ajoute.
#[derive(Debug, Clone, Serialize, PartialEq)]
struct Access {
    /// `module` (dépendance), `client`, `tool`, `webhook`, `schedule` ou `tables` (lecture des données du module
    /// qu’un `x-ajouts` complète).
    kind: &'static str,
    id: String,
    label: String,
}

fn accesses(manifest: &ModuleManifest) -> Vec<Access> {
    let label = |text: &str, id: &str| if text.trim().is_empty() { id.to_string() } else { text.trim().to_string() };
    let mut accesses = Vec::new();
    if let Some(base) = extended_module(manifest) {
        accesses.push(Access { kind: "tables", id: base.to_string(), label: format!("lecture des données du module « {base} »") });
    }
    for requirement in &manifest.requires {
        accesses.push(Access {
            kind: "module",
            id: requirement.module.clone(),
            label: format!("fonctions et clients du module {}", requirement.describe()),
        });
    }
    for client in &manifest.clients {
        accesses.push(Access { kind: "client", id: client.id.clone(), label: label(&client.label, &client.id) });
    }
    for function in manifest.functions.iter().filter(|function| function.tool) {
        accesses.push(Access {
            kind: "tool",
            id: function.id.clone(),
            label: label(&function.description, &function.id),
        });
    }
    for webhook in &manifest.webhooks {
        accesses.push(Access { kind: "webhook", id: webhook.id.clone(), label: label(&webhook.description, &webhook.id) });
    }
    for schedule in &manifest.schedules {
        let cadence = match (&schedule.every_minutes, &schedule.at) {
            (Some(minutes), _) => format!(" (toutes les {minutes} min)"),
            (None, Some(at)) => format!(" (chaque jour à {at})"),
            (None, None) => String::new(),
        };
        accesses.push(Access {
            kind: "schedule",
            id: schedule.id.clone(),
            label: format!("{}{cadence}", label(&schedule.description, &schedule.id)),
        });
    }
    accesses
}

/// Module dont celui-ci lit les tables : un module `x-ajouts` complète `x` et lit ses données.
fn extended_module(manifest: &ModuleManifest) -> Option<&str> {
    manifest.id.strip_suffix("-ajouts").filter(|base| !base.is_empty())
}

fn describe(manifest: &ModuleManifest) -> Value {
    json!({
        "id": manifest.id,
        "extends": extended_module(manifest),
        "name": display_name(manifest),
        "version": manifest.version,
        "description": manifest.description,
        "pages": manifest.pages.iter().map(|page| json!({
            "id": page.id, "title": page.title, "description": page.description,
        })).collect::<Vec<_>>(),
        "functions": manifest.functions.iter().map(|function| json!({
            "id": function.id, "description": function.description, "tool": function.tool, "effect": function.effect,
        })).collect::<Vec<_>>(),
        "requires": manifest.requires,
        "clients": manifest.clients,
        "webhooks": manifest.webhooks,
        "schedules": manifest.schedules,
        "tools": manifest.functions.iter().filter(|function| function.tool).map(|function| json!({
            "id": function.id, "description": function.description,
        })).collect::<Vec<_>>(),
    })
}

fn changes(installed: &ModuleManifest, available: &ModuleManifest) -> Value {
    let page_ids = |manifest: &ModuleManifest| manifest.pages.iter().map(|page| page.id.clone()).collect::<BTreeSet<_>>();
    let function_ids =
        |manifest: &ModuleManifest| manifest.functions.iter().map(|function| function.id.clone()).collect::<BTreeSet<_>>();
    let (old_pages, new_pages) = (page_ids(installed), page_ids(available));
    let (old_functions, new_functions) = (function_ids(installed), function_ids(available));
    let titles = |manifest: &ModuleManifest, other: &BTreeSet<String>| {
        manifest.pages.iter().filter(|page| !other.contains(&page.id)).map(|page| page.title.clone()).collect::<Vec<_>>()
    };
    let known = accesses(installed);
    let new_accesses: Vec<Access> = accesses(available)
        .into_iter()
        .filter(|access| !known.iter().any(|existing| existing.kind == access.kind && existing.id == access.id))
        .collect();
    json!({
        "pagesAdded": titles(available, &old_pages),
        "pagesRemoved": titles(installed, &new_pages),
        "functionsAdded": new_functions.difference(&old_functions).collect::<Vec<_>>(),
        "functionsRemoved": old_functions.difference(&new_functions).collect::<Vec<_>>(),
        "newAccesses": new_accesses,
    })
}

fn modules(state: &AppState, id: &str) -> AppResult<Value> {
    let marketplace = find(state, id)?;
    let clone = clone_dir(state, &marketplace.id);
    let space = state.try_space();
    let mut modules = Vec::new();
    for module_id in catalog_ids(&clone) {
        let manifest = match catalog_manifest(&clone, &module_id) {
            Ok(manifest) => manifest,
            Err(error) => {
                modules.push(json!({ "id": module_id, "name": module_id, "error": error.message }));
                continue;
            }
        };
        let local = space.as_ref().and_then(|space| space.module(&module_id).ok());
        let installed = local.as_ref().and_then(|local| {
            local
                .origin
                .as_ref()
                .filter(|origin| !origin.detached && same_url(&origin.marketplace, &marketplace.url))
                .map(|origin| origin.version.clone())
        });
        // Module développé dans cet espace de travail et publié sur ce marketplace : c’est le sien, pas un conflit.
        let own = local.as_ref().filter(|local| local.origin.is_none() || local.origin.as_ref().is_some_and(|o| o.detached)).and_then(|local| {
            local
                .published
                .iter()
                .find(|publication| same_url(&publication.marketplace, &marketplace.url))
                .map(|publication| json!({ "version": publication.version, "local": local.version }))
        });
        let mut entry = describe(&manifest);
        entry["notes"] = json!(notes_since(&clone.join(&module_id), None));
        // Un module de même identifiant venu d’ailleurs (local, détaché, autre marketplace) bloque l’importation.
        entry["conflict"] = json!(local.is_some() && installed.is_none() && own.is_none());
        entry["own"] = own.unwrap_or(Value::Null);
        match dependency_plan(space.as_ref(), &clone, &marketplace, &manifest) {
            Ok(steps) => entry["dependencies"] = json!(steps),
            Err(error) => {
                entry["dependencies"] = json!([]);
                entry["blocked"] = json!(error.message);
            }
        }
        entry["installed"] = json!(installed);
        modules.push(entry);
    }
    Ok(Value::Array(modules))
}

// ---------------------------------------------------------------------------------------------------------------
// Installation, mises à jour, détachement, désinstallation
// ---------------------------------------------------------------------------------------------------------------

/// Enregistre à part ce qui était en cours dans l’espace, pour que le commit de l’opération ne contienne qu’elle
/// et puisse être annulé seul.
fn checkpoint(space: &Space, operation: &str) -> AppResult<()> {
    if git::has_changes(&space.root)? {
        git::commit_all(&space.root, &format!("Modifications en cours avant {operation}"))?;
    }
    Ok(())
}

fn journal(state: &AppState, space: &Space, module: &str, summary: &str) {
    if let Ok(db) = state.app_db.lock() {
        let _ = app_db::record_journal(
            &db,
            &app_db::JournalEntry {
                space: &space.root.to_string_lossy(),
                kind: "module",
                subject: module,
                status: "ok",
                duration_ms: None,
                summary,
                detail: None,
            },
        );
    }
}

/// Pose dans l’espace la copie d’un module du marketplace, avec son origine. La copie est préparée à côté puis
/// mise en place d’un seul geste : une copie interrompue ne laisse pas un module à moitié remplacé.
fn place_module(space: &Space, source: &Path, id: &str, origin: &Origin) -> AppResult<()> {
    let staging = space.local_dir().join("tmp").join(format!("{id}-{}", uuid::Uuid::new_v4().simple()));
    let prepared = (|| {
        copy_tree(source, &staging)?;
        let mut map = read_manifest_map(source)?;
        map.insert("origin".to_string(), serde_json::to_value(origin)?);
        space::write_json(&staging.join(MODULE_FILE), &Value::Object(map))
    })();
    if let Err(error) = prepared {
        let _ = remove_tree(&staging);
        return Err(error);
    }
    let target = space.module_dir(id);
    remove_tree(&target)?;
    fs::create_dir_all(space.modules_dir())?;
    rename_dir(&staging, &target)?;
    Ok(())
}

fn install(state: &AppState, marketplace_id: &str, module_id: &str) -> AppResult<Value> {
    let space = state.space()?;
    check_module_id(module_id)?;
    let marketplace = find(state, marketplace_id)?;
    let clone = clone_dir(state, &marketplace.id);
    let source = clone.join(module_id);
    if !source.join(MODULE_FILE).is_file() {
        return Err(AppError::new(format!(
            "Le module « {module_id} » n’existe pas dans le marketplace « {} ».",
            marketplace.name
        )));
    }
    if space.module_dir(module_id).exists() {
        return Err(AppError::new(format!(
            "Un module « {module_id} » existe déjà dans l’espace de travail. Le retirer avant d’importer celui-ci."
        )));
    }
    let manifest = catalog_manifest(&clone, module_id)?;
    let steps = dependency_plan(Some(&space), &clone, &marketplace, &manifest)?;
    let origin = Origin {
        marketplace: marketplace.url.clone(),
        version: manifest.version.clone(),
        commit: last_commit(&clone, module_id),
        ..Origin::default()
    };
    checkpoint(&space, "l’import d’un module")?;
    apply_dependencies(&space, &clone, &marketplace, &steps)?;
    place_module(&space, &source, module_id, &origin)?;
    let message =
        format!("Import du module {} v{}{}", display_name(&manifest), manifest.version, steps_summary(&steps));
    let commit = git::commit_all(&space.root, &message)?;
    journal(state, &space, module_id, &message);
    state.emit("space:changed", Value::Null);
    Ok(json!({ "module": module_id, "version": manifest.version, "commit": commit, "dependencies": steps }))
}

/// Ce que l’installation ou la mise à jour d’un module fait d’une de ses dépendances.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DependencyStep {
    module: String,
    name: String,
    /// `install` (absente : installée et masquée du menu) ou `update` (trop ancienne : mise à jour).
    action: &'static str,
    version: String,
}

/// Dépendances à installer ou à mettre à jour, depuis le même marketplace, avant `manifest` : les plus profondes
/// d’abord. Une dépendance déjà là est amenée à la dernière version du marketplace quand celle-ci reste dans sa
/// version majeure (mineure ou correctif) ; jamais au-delà, car une nouvelle majeure casserait ce qui en dépend.
/// L’erreur dit ce qui empêche l’opération (dépendance introuvable, d’une autre majeure, figée, locale…).
fn dependency_plan(
    space: Option<&Space>,
    clone: &Path,
    marketplace: &Marketplace,
    manifest: &ModuleManifest,
) -> AppResult<Vec<DependencyStep>> {
    fn visit(
        space: Option<&Space>,
        clone: &Path,
        marketplace: &Marketplace,
        manifest: &ModuleManifest,
        path: &mut Vec<String>,
        steps: &mut Vec<DependencyStep>,
    ) -> AppResult<()> {
        path.push(manifest.id.clone());
        for requirement in &manifest.requires {
            let wanted = requirement.module.as_str();
            if path.iter().any(|id| id == wanted) {
                return Err(AppError::new(format!("Dépendances en boucle : {} → {wanted}.", path.join(" → "))));
            }
            if steps.iter().any(|step| step.module == wanted) {
                continue;
            }
            let who = display_name(manifest).to_string();
            let local = space.and_then(|space| space.module(wanted).ok());
            let available = catalog_manifest(clone, wanted).ok();
            let action = match &local {
                Some(local) => {
                    let from_here = local
                        .origin
                        .as_ref()
                        .is_some_and(|origin| !origin.detached && same_url(&origin.marketplace, &marketplace.url));
                    let pinned = local.origin.as_ref().is_some_and(|origin| origin.pinned);
                    if requirement.accepts(&local.version) {
                        // Déjà compatible : mise à niveau seulement si elle reste dans la même majeure, sans casser
                        // un autre module de l’espace de travail ; sinon la dépendance reste telle quelle.
                        let refresh = available.as_ref().is_some_and(|available| {
                            from_here
                                && !pinned
                                && is_newer(&available.version, &local.version)
                                && same_major(&available.version, &local.version)
                                && requirement.accepts(&available.version)
                                && breaking_dependents(space, wanted, &available.version, path).is_empty()
                        });
                        if !refresh {
                            continue;
                        }
                    } else {
                        if !from_here {
                            return Err(AppError::new(format!(
                                "« {who} » demande le module {}, mais celui de l’espace de travail est en v{} et ne vient pas de ce marketplace : le mettre à jour d’abord.",
                                requirement.describe(),
                                local.version
                            )));
                        }
                        if pinned {
                            return Err(AppError::new(format!(
                                "« {who} » demande le module {}, figé en v{} : le libérer pour qu’il soit mis à jour.",
                                requirement.describe(),
                                local.version
                            )));
                        }
                    }
                    "update"
                }
                None => "install",
            };
            let available = available.ok_or_else(|| {
                AppError::new(format!(
                    "« {who} » dépend du module {}, que le marketplace « {} » ne propose pas.",
                    requirement.describe(),
                    marketplace.name
                ))
            })?;
            if !requirement.accepts(&available.version) {
                return Err(AppError::new(format!(
                    "« {who} » dépend du module {}, mais le marketplace « {} » propose la v{}.",
                    requirement.describe(),
                    marketplace.name,
                    available.version
                )));
            }
            if action == "update" {
                let broken = breaking_dependents(space, wanted, &available.version, path);
                if let Some(message) = broken_message(space, wanted, &available.version, &broken) {
                    return Err(AppError::new(message));
                }
            }
            visit(space, clone, marketplace, &available, path, steps)?;
            steps.push(DependencyStep {
                module: wanted.to_string(),
                name: display_name(&available).to_string(),
                action,
                version: available.version.clone(),
            });
        }
        path.pop();
        Ok(())
    }
    let mut steps = Vec::new();
    visit(space, clone, marketplace, manifest, &mut Vec::new(), &mut steps)?;
    Ok(steps)
}

fn same_major(left: &str, right: &str) -> bool {
    matches!((parse_version(left), parse_version(right)), (Some(left), Some(right)) if left[0] == right[0])
}

/// Modules de l’espace de travail (hors `except`, ceux que l’opération remplace) dont la dépendance envers
/// `module` n’accepterait pas la version `version`.
fn breaking_dependents(space: Option<&Space>, module: &str, version: &str, except: &[String]) -> Vec<ModuleManifest> {
    let Some(space) = space else { return Vec::new() };
    space
        .dependents(module)
        .into_iter()
        .filter(|id| !except.contains(id))
        .filter_map(|id| space.module(&id).ok())
        .filter(|dependent| {
            dependent.requires.iter().any(|requirement| requirement.module == module && !requirement.accepts(version))
        })
        .collect()
}

/// Pourquoi `module` ne passe pas en `version` : les modules qui demandent une autre version majeure.
fn broken_message(space: Option<&Space>, module: &str, version: &str, broken: &[ModuleManifest]) -> Option<String> {
    if broken.is_empty() {
        return None;
    }
    let name = space
        .and_then(|space| space.module(module).ok())
        .map(|manifest| display_name(&manifest).to_string())
        .unwrap_or_else(|| module.to_string());
    let who: Vec<String> = broken
        .iter()
        .map(|dependent| {
            let wanted = dependent
                .requires
                .iter()
                .find(|requirement| requirement.module == module)
                .map(|requirement| requirement.describe())
                .unwrap_or_default();
            format!("« {} » demande {wanted}", display_name(dependent))
        })
        .collect();
    Some(format!(
        "{name} v{version} est une nouvelle version majeure : {}. Mettre d’abord à jour {} vers une version qui accepte la v{version}.",
        who.join(", "),
        if broken.len() > 1 { "ces modules" } else { "ce module" }
    ))
}

/// Pose les dépendances prévues ; une dépendance nouvellement installée ne s’affiche pas dans le menu.
fn apply_dependencies(space: &Space, clone: &Path, marketplace: &Marketplace, steps: &[DependencyStep]) -> AppResult<()> {
    for step in steps {
        let origin = Origin {
            marketplace: marketplace.url.clone(),
            version: step.version.clone(),
            commit: last_commit(clone, &step.module),
            ..Origin::default()
        };
        place_module(space, &clone.join(&step.module), &step.module, &origin)?;
        if step.action == "install" {
            space.set_visibility(&space::module_key(&step.module), true)?;
        }
    }
    Ok(())
}

fn steps_summary(steps: &[DependencyStep]) -> String {
    if steps.is_empty() {
        return String::new();
    }
    let items: Vec<String> = steps.iter().map(|step| format!("{} v{}", step.name, step.version)).collect();
    format!(" (avec {})", items.join(", "))
}

/// Où en est la source d’un module installé.
enum Source {
    /// Son marketplace n’est plus branché, ou son clone a disparu.
    Unplugged,
    /// Le marketplace est là, mais ne propose plus ce module.
    Withdrawn(Marketplace),
    Present { marketplace: Marketplace, dir: PathBuf, manifest: Box<ModuleManifest> },
}

fn source_of(state: &AppState, marketplaces: &[Marketplace], module_id: &str, origin: &Origin) -> Source {
    let Some(marketplace) = marketplaces.iter().find(|marketplace| same_url(&marketplace.url, &origin.marketplace))
    else {
        return Source::Unplugged;
    };
    let clone = clone_dir(state, &marketplace.id);
    if !clone.join(".git").exists() {
        return Source::Unplugged;
    }
    match catalog_manifest(&clone, module_id) {
        Ok(manifest) => {
            Source::Present { marketplace: marketplace.clone(), dir: clone.join(module_id), manifest: Box::new(manifest) }
        }
        Err(_) => Source::Withdrawn(marketplace.clone()),
    }
}

/// Module installé et toujours rattaché à son marketplace ; l’erreur dit pourquoi l’opération ne s’applique pas.
fn installed_module(space: &Space, module_id: &str) -> AppResult<(ModuleManifest, Origin)> {
    let manifest = space.module(module_id)?;
    match manifest.origin.clone() {
        Some(origin) if !origin.detached => Ok((manifest, origin)),
        Some(_) => Err(AppError::new(format!(
            "Le module « {} » est détaché : il ne suit plus son marketplace.",
            display_name(&manifest)
        ))),
        None => Err(AppError::new(format!(
            "Le module « {} » est local : il ne vient d’aucun marketplace.",
            display_name(&manifest)
        ))),
    }
}

/// Le dossier d’un module installé diffère-t-il de ce qui a été installé ? La référence est le commit de l’espace
/// qui a inscrit l’origine actuelle (installation ou dernière mise à jour) ; figer ou libérer le module ne
/// compte pas comme une modification.
fn locally_modified(space: &Space, module_id: &str, origin: &Origin) -> bool {
    changed_since(space, module_id, &origin.commit)
}

/// Le dossier du module a-t-il changé depuis le commit de l’espace de travail qui a inscrit `marker` (le commit du
/// marketplace d’une installation ou d’une publication) dans son manifeste ? L’origine et les publications ne
/// comptent pas.
fn changed_since(space: &Space, module_id: &str, marker: &str) -> bool {
    let root = &space.root;
    let folder = format!("{MODULES_DIR}/{module_id}");
    let manifest_path = format!("{folder}/{MODULE_FILE}");
    let pending = || git::run(root, &["status", "--porcelain", "--", &folder]).is_ok_and(|output| !output.is_empty());
    if marker.is_empty() {
        return pending();
    }
    let needle = format!("-S{marker}");
    let base = git::run(root, &["log", "-1", "--format=%H", &needle, "--", &manifest_path]).unwrap_or_default();
    if base.is_empty() {
        // Espace repris sans son historique : seul ce qui n’est pas encore enregistré peut être constaté.
        return pending();
    }
    let untracked = git::run(root, &["ls-files", "--others", "--exclude-standard", "--", &folder]).unwrap_or_default();
    if !untracked.is_empty() {
        return true;
    }
    let changed = git::run(root, &["diff", "--name-only", &base, "--", &folder]).unwrap_or_default();
    changed.lines().any(|file| {
        if file != manifest_path {
            return true;
        }
        let without_origin = |text: &str| {
            serde_json::from_str::<Map<String, Value>>(text).ok().map(|mut map| {
                map.remove("origin");
                map.remove("published");
                map
            })
        };
        let before = git::run(root, &["show", &format!("{base}:{manifest_path}")]).ok();
        let now = fs::read_to_string(root.join(&manifest_path)).ok();
        match (before.as_deref().and_then(without_origin), now.as_deref().and_then(without_origin)) {
            (Some(before), Some(now)) => before != now,
            _ => true,
        }
    })
}

fn updates(state: &AppState) -> AppResult<Value> {
    // Sans espace ouvert, il n’y a simplement rien à mettre à jour.
    let Some(space) = state.try_space() else { return Ok(json!([])) };
    let marketplaces = load(state)?;
    let mut entries = Vec::new();
    for module_id in space.module_ids() {
        let Ok(manifest) = space.module(&module_id) else { continue };
        let Some(origin) = manifest.origin.clone().filter(|origin| !origin.detached) else { continue };
        let current = if origin.version.is_empty() { manifest.version.clone() } else { origin.version.clone() };
        let mut entry = json!({
            "module": module_id,
            "name": display_name(&manifest),
            "current": current,
            "available": null,
            "pinned": origin.pinned,
            "sourceMissing": false,
            "withdrawn": false,
            "marketplace": null,
            "marketplaceName": null,
            "source": origin.marketplace,
            "notes": "",
            "changes": changes(&manifest, &manifest),
            "dependencies": [],
            "blocked": null,
            "locallyModified": locally_modified(&space, &module_id, &origin),
        });
        match source_of(state, &marketplaces, &module_id, &origin) {
            Source::Unplugged => entry["sourceMissing"] = json!(true),
            Source::Withdrawn(marketplace) => {
                entry["withdrawn"] = json!(true);
                entry["marketplace"] = json!(marketplace.id);
                entry["marketplaceName"] = json!(marketplace.name);
            }
            Source::Present { marketplace, dir, manifest: available } => {
                entry["marketplace"] = json!(marketplace.id);
                entry["marketplaceName"] = json!(marketplace.name);
                if is_newer(&available.version, &current) {
                    let clone = clone_dir(state, &marketplace.id);
                    let broken = breaking_dependents(Some(&space), &module_id, &available.version, &[]);
                    match broken_message(Some(&space), &module_id, &available.version, &broken) {
                        Some(message) => entry["blocked"] = json!(message),
                        None => match dependency_plan(Some(&space), &clone, &marketplace, &available) {
                            Ok(steps) => entry["dependencies"] = json!(steps),
                            Err(error) => entry["blocked"] = json!(error.message),
                        },
                    }
                    entry["available"] = json!(available.version);
                    entry["notes"] = json!(notes_since(&dir, Some(&current)));
                    entry["changes"] = changes(&manifest, &available);
                }
            }
        }
        entries.push(entry);
    }
    Ok(Value::Array(entries))
}

/// Remplace un module installé par la version que propose son marketplace, dans un commit de l’espace. Les
/// données du module vivent dans `.alfred/`, hors de son dossier : seul le choix de le figer est à conserver.
fn update_one(state: &AppState, space: &Space, module_id: &str) -> AppResult<Value> {
    let (manifest, origin) = installed_module(space, module_id)?;
    let name = display_name(&manifest).to_string();
    let (marketplace, dir, available) = match source_of(state, &load(state)?, module_id, &origin) {
        Source::Present { marketplace, dir, manifest } => (marketplace, dir, manifest),
        Source::Withdrawn(marketplace) => {
            return Err(AppError::new(format!(
                "Le module « {name} » n’est plus proposé par le marketplace « {} ».",
                marketplace.name
            )))
        }
        Source::Unplugged => {
            return Err(AppError::new(format!(
                "Le marketplace d’origine de « {name} » n’est plus branché. Le rebrancher pour recevoir les mises à jour."
            )))
        }
    };
    let current = if origin.version.is_empty() { manifest.version.clone() } else { origin.version.clone() };
    if !is_newer(&available.version, &current) {
        return Err(AppError::new(format!("Le module « {name} » est déjà à jour (v{current}).")));
    }
    let clone = clone_dir(state, &marketplace.id);
    let broken = breaking_dependents(Some(space), module_id, &available.version, &[]);
    if let Some(message) = broken_message(Some(space), module_id, &available.version, &broken) {
        return Err(AppError::new(message));
    }
    let steps = dependency_plan(Some(space), &clone, &marketplace, &available)?;
    let new_origin = Origin {
        marketplace: origin.marketplace.clone(),
        version: available.version.clone(),
        commit: last_commit(&clone, module_id),
        detached: false,
        pinned: origin.pinned,
    };
    checkpoint(space, "la mise à jour d’un module")?;
    apply_dependencies(space, &clone, &marketplace, &steps)?;
    place_module(space, &dir, module_id, &new_origin)?;
    let message = format!(
        "Mise à jour du module {} v{current} → v{}{}",
        display_name(&available),
        available.version,
        steps_summary(&steps)
    );
    let commit = git::commit_all(&space.root, &message)?;
    journal(state, space, module_id, &message);
    Ok(json!({ "module": module_id, "name": display_name(&available), "from": current, "to": available.version, "commit": commit, "dependencies": steps }))
}

fn update_all(state: &AppState) -> AppResult<Value> {
    let space = state.space()?;
    let pending = updates(state)?;
    let (mut updated, mut failed) = (Vec::new(), Vec::new());
    for entry in pending.as_array().into_iter().flatten() {
        // Figée, ou bloquée par un module qui demande l’ancienne version majeure : la mise à jour reste signalée.
        let held = entry["pinned"].as_bool().unwrap_or(false) || !entry["blocked"].is_null();
        let (Some(module), false, false) = (entry["module"].as_str(), entry["available"].is_null(), held) else {
            continue;
        };
        match update_one(state, &space, module) {
            Ok(result) => updated.push(result),
            Err(error) => failed.push(json!({ "module": module, "name": entry["name"], "message": error.message })),
        }
    }
    if !updated.is_empty() {
        state.emit("space:changed", Value::Null);
    }
    Ok(json!({ "updated": updated, "failed": failed }))
}

/// Réécrit l’origine d’un module dans son manifeste, sans toucher au reste.
fn write_origin(space: &Space, module_id: &str, origin: &Origin) -> AppResult<()> {
    let dir = space.module_dir(module_id);
    let mut map = read_manifest_map(&dir)?;
    map.insert("origin".to_string(), serde_json::to_value(origin)?);
    space::write_json(&dir.join(MODULE_FILE), &Value::Object(map))
}

fn pin(state: &AppState, module_id: &str, pinned: bool) -> AppResult<Value> {
    let space = state.space()?;
    let (manifest, mut origin) = installed_module(&space, module_id)?;
    if origin.pinned == pinned {
        return Ok(json!({ "module": module_id, "pinned": pinned }));
    }
    origin.pinned = pinned;
    checkpoint(&space, "le changement d’un module")?;
    write_origin(&space, module_id, &origin)?;
    let name = display_name(&manifest);
    let message = if pinned {
        format!("Module {name} figé sur la version {}", origin.version)
    } else {
        format!("Module {name} libéré : les mises à jour sont de nouveau proposées")
    };
    git::commit_all(&space.root, &message)?;
    state.emit("space:changed", Value::Null);
    Ok(json!({ "module": module_id, "pinned": pinned }))
}

fn detach(state: &AppState, module_id: &str) -> AppResult<Value> {
    let space = state.space()?;
    let (manifest, mut origin) = installed_module(&space, module_id)?;
    // L’origine reste inscrite : on sait d’où vient le module, il ne reçoit simplement plus rien.
    origin.detached = true;
    origin.pinned = false;
    checkpoint(&space, "le détachement d’un module")?;
    write_origin(&space, module_id, &origin)?;
    let message = format!("Détachement du module {}", display_name(&manifest));
    git::commit_all(&space.root, &message)?;
    journal(state, &space, module_id, &message);
    state.emit("space:changed", Value::Null);
    Ok(json!({ "module": module_id }))
}

fn uninstall(state: &AppState, module_id: &str, delete_data: bool) -> AppResult<Value> {
    let space = state.space()?;
    let manifest = space.module(module_id)?;
    let dependents = space.dependents(module_id);
    if !dependents.is_empty() {
        let names: Vec<String> = dependents
            .iter()
            .map(|id| space.module(id).map(|module| display_name(&module).to_string()).unwrap_or_else(|_| id.clone()))
            .map(|name| format!("« {name} »"))
            .collect();
        return Err(AppError::new(format!(
            "Le module « {} » est utilisé par {} : retirer d’abord {}.",
            display_name(&manifest),
            names.join(", "),
            if names.len() > 1 { "ces modules" } else { "ce module" }
        )));
    }
    checkpoint(&space, "le retrait d’un module")?;
    remove_tree(&space.module_dir(module_id))?;
    crate::permissions::forget_module(state, module_id)?;

    // La navigation et les liaisons de clients ne doivent plus désigner ce qui vient de disparaître.
    let prefix = format!("{module_id}/");
    let mut layout_owner = space.manifest()?;
    let layout = &mut layout_owner.layout;
    layout.sections.retain(|section| !section.starts_with(&prefix));
    layout.settings.retain(|page| !page.starts_with(&prefix));
    layout.tabs.retain(|section, _| !section.starts_with(&prefix));
    for pages in layout.tabs.values_mut() {
        pages.retain(|page| !page.starts_with(&prefix));
    }
    layout.overrides.retain(|key, _| {
        key != &space::module_key(module_id)
            && !key
                .strip_prefix("page:")
                .or_else(|| key.strip_prefix("section:"))
                .is_some_and(|target| target.starts_with(&prefix))
    });
    layout_owner.bindings.retain(|need, _| !need.starts_with(&prefix));
    space.write_manifest(&layout_owner)?;
    // Ses services et leurs comptes partent avec lui, sauf ceux qu’un autre module utilise encore.
    crate::clients::forget_unused(state, &space)?;

    let message = format!("Retrait du module {}", display_name(&manifest));
    let commit = git::commit_all(&space.root, &message)?;
    journal(state, &space, module_id, &message);
    // La suppression des tables est faite par le module qui tient la base de l’espace, à la réception de ceci.
    state.emit("module:uninstalled", json!({ "module": module_id, "deleteData": delete_data }));
    state.emit("space:changed", Value::Null);
    Ok(json!({ "module": module_id, "deleteData": delete_data, "commit": commit }))
}

// ---------------------------------------------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------------------------------------------

/// Ce qui empêche de publier, à l’endroit exact où le corriger. Ne porte jamais la valeur fautive elle-même.
#[derive(Debug, Clone, Serialize, PartialEq)]
struct Problem {
    file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
    message: String,
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') || byte >= 0x80
}

/// `/Users/<nom>` en début de chemin. Précédé d’un caractère d’hôte ou de chemin, c’est la suite d’une adresse web
/// (« https://api.exemple.fr/Users/12 ») ; suivi d’un nombre seul, une route d’API : ni l’un ni l’autre ne
/// désigne un dossier personnel.
fn has_user_path(line: &str) -> bool {
    let bytes = line.as_bytes();
    line.match_indices("/Users/").any(|(at, pattern)| {
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || matches!(bytes[at - 1], b'.' | b'-' | b'_' | b'}' | b'%')) {
            return false;
        }
        let name: Vec<u8> = bytes[at + pattern.len()..].iter().copied().take_while(|byte| is_name_byte(*byte)).collect();
        !name.is_empty() && !name.iter().all(u8::is_ascii_digit)
    })
}

/// `C:\Users\…`, sous ses trois écritures : barres inverses, barres inverses doublées (JSON, chaînes), barres obliques.
fn has_windows_user_path(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    [":\\users\\", ":\\\\users\\\\", ":/users/"].iter().any(|pattern| {
        lower.match_indices(pattern).any(|(at, _)| {
            at >= 1 && bytes[at - 1].is_ascii_alphabetic() && (at < 2 || !bytes[at - 2].is_ascii_alphanumeric())
        })
    })
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
}

/// « Bearer » suivi d’un long jeton écrit en dur ; `Bearer ${jeton}` n’en est pas un.
fn has_bearer_token(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let bytes = line.as_bytes();
    lower.match_indices("bearer ").any(|(at, pattern)| {
        bytes[at + pattern.len()..].iter().take_while(|byte| is_token_byte(**byte)).count() >= 20
    })
}

const SECRET_WORDS: [&str; 7] = ["password", "passwd", "secret", "token", "apikey", "api_key", "api-key"];

/// Champ dont le nom se termine par « password », « secret », « token »… et qui reçoit une longue valeur écrite en
/// dur, sans espace ni interpolation. Une description en clair ou une référence à une variable ne sont pas signalées.
fn has_literal_secret(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let bytes = line.as_bytes();
    let skip_spaces = |mut index: usize| {
        while bytes.get(index).is_some_and(|byte| *byte == b' ' || *byte == b'\t') {
            index += 1;
        }
        index
    };
    SECRET_WORDS.iter().any(|word| {
        lower.match_indices(word).any(|(at, _)| {
            let mut index = at + word.len();
            // Le mot doit terminer le nom du champ : « tokenUrl » ou « secretName » désignent autre chose.
            if bytes.get(index).is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_') {
                return false;
            }
            if matches!(bytes.get(index), Some(b'"' | b'\'')) {
                index += 1;
            }
            index = skip_spaces(index);
            if !matches!(bytes.get(index), Some(b':' | b'=')) {
                return false;
            }
            index += 1;
            // « == » compare et « => » déclare une fonction : aucune valeur n’est affectée.
            if matches!(bytes.get(index), Some(b'=' | b'>')) {
                return false;
            }
            index = skip_spaces(index);
            let Some(quote @ (b'"' | b'\'' | b'`')) = bytes.get(index).copied() else { return false };
            let rest = &bytes[index + 1..];
            let Some(end) = rest.iter().position(|byte| *byte == quote) else { return false };
            let value = &rest[..end];
            value.len() >= 12
                && !value.iter().any(u8::is_ascii_whitespace)
                && !value.windows(2).any(|pair| pair == b"${")
        })
    })
}

const TOKEN_PREFIXES: [&str; 8] = ["ghp_", "gho_", "github_pat_", "glpat-", "xoxb-", "xoxp-", "sk-", "AKIA"];

/// Jeton d’un service connu, reconnaissable à son préfixe quel que soit l’endroit où il est écrit.
fn has_known_token(line: &str) -> bool {
    let bytes = line.as_bytes();
    TOKEN_PREFIXES.iter().any(|prefix| {
        line.match_indices(prefix).any(|(at, _)| {
            if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || matches!(bytes[at - 1], b'_' | b'-')) {
                return false;
            }
            let token: Vec<u8> = bytes[at + prefix.len()..]
                .iter()
                .copied()
                .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                .collect();
            let minimum = if *prefix == "AKIA" { 16 } else { 20 };
            // Un chiffre au moins : écarte les noms de classes et d’identifiants à tirets (« sk-… »).
            token.len() >= minimum && token.iter().any(u8::is_ascii_digit)
        })
    })
}

/// Ce qu’une ligne contient et qui ne doit pas quitter le poste.
fn scan_line(line: &str, local_paths: &[String]) -> Vec<&'static str> {
    let mut found = Vec::new();
    if local_paths.iter().any(|path| line.contains(path.as_str())) {
        found.push("Chemin absolu de ce poste (dossier de l’espace de travail ou dossier personnel).");
    } else if has_user_path(line) || has_windows_user_path(line) {
        found.push("Chemin absolu d’un poste (/Users/… ou C:\\Users\\…).");
    }
    if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
        found.push("Clé privée (bloc PEM).");
    }
    if has_bearer_token(line) {
        found.push("Jeton écrit en clair après « Bearer ».");
    } else if has_literal_secret(line) {
        found.push("Valeur écrite en clair dans un champ de mot de passe, de secret ou de jeton.");
    } else if has_known_token(line) {
        found.push("Jeton d’accès reconnaissable à son préfixe.");
    }
    found
}

/// Chemins de ce poste à ne jamais publier, sous les écritures qu’ils prennent dans du code ou du JSON.
fn local_paths(space: &Space) -> Vec<String> {
    let mut paths = BTreeSet::new();
    let mut add = |path: &Path| {
        let text = path.to_string_lossy().to_string();
        // Une racine (« / », « C:\ ») figurerait dans n’importe quel fichier.
        if text.len() >= 4 {
            paths.insert(text.replace('\\', "\\\\"));
            paths.insert(text.replace('\\', "/"));
            paths.insert(text);
        }
    };
    add(&space.root);
    if let Ok(canonical) = space.root.canonicalize() {
        add(&canonical);
    }
    if let Some(home) = crate::dispatch::home_dir() {
        add(&home);
    }
    paths.into_iter().collect()
}

/// Vérifie le module tel qu’il partirait : chaque fichier TypeScript compile, chaque page et fonction déclarée a
/// son fichier, et rien ne contient de chemin du poste ni de secret. `published_manifest` est le manifeste qui
/// sera réellement publié (sans origine) : c’est lui qui est examiné, pas celui de l’espace.
fn verify(space: &Space, manifest: &ModuleManifest, published_manifest: &str, notes: &str) -> Vec<Problem> {
    let dir = space.module_dir(&manifest.id);
    let paths = local_paths(space);
    let mut problems = Vec::new();

    for page in &manifest.pages {
        let file = format!("pages/{}.tsx", page.id);
        if !dir.join(&file).is_file() {
            let message = format!("La page « {} » est déclarée mais son fichier n’existe pas.", page.title);
            problems.push(Problem { file, line: None, column: None, message });
        }
    }
    for function in &manifest.functions {
        let file = format!("functions/{}", function.file_name());
        if !dir.join(&file).is_file() {
            let message = format!("La fonction « {} » est déclarée mais son fichier n’existe pas.", function.id);
            problems.push(Problem { file, line: None, column: None, message });
        }
    }

    // Librairies (`vendor/`) : du code tiers téléchargé par Alfred, vérifié par son empreinte plutôt que ligne à ligne.
    let libraries = crate::libraries::entries(&dir);
    for file in crate::libraries::altered_files(&dir) {
        problems.push(Problem {
            file: format!("{}/{file}", crate::libraries::DIR),
            line: None,
            column: None,
            message: "Fichier de librairie modifié ou absent : réinstaller les librairies du module.".to_string(),
        });
    }
    for file in list_files(&dir) {
        if file.starts_with(&format!("{}/", crate::libraries::DIR)) {
            continue;
        }
        let Ok(bytes) = fs::read(dir.join(&file)) else {
            problems.push(Problem { file, line: None, column: None, message: "Fichier illisible.".to_string() });
            continue;
        };
        // Fichier binaire (image, police) : rien à lire ligne à ligne.
        if bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        if file.ends_with(".ts") || file.ends_with(".tsx") {
            for diagnostic in transpile::transpile_in(&text, &file, usize::MAX, &libraries).err().unwrap_or_default() {
                problems.push(Problem {
                    file: file.clone(),
                    line: diagnostic.line,
                    column: diagnostic.column,
                    message: format!("Ne compile pas : {}", diagnostic.message),
                });
            }
        }
        let is_manifest = file == MODULE_FILE;
        let scanned = if is_manifest { published_manifest } else { &*text };
        for (index, line) in scanned.lines().enumerate() {
            for message in scan_line(line, &paths) {
                // Le manifeste publié n’a pas les mêmes lignes que celui de l’espace : on y retrouve la ligne fautive.
                let line_number = if is_manifest {
                    text.lines().position(|local| local.trim() == line.trim()).map(|position| position as u32 + 1)
                } else {
                    Some(index as u32 + 1)
                };
                problems.push(Problem { file: file.clone(), line: line_number, column: None, message: message.to_string() });
            }
        }
    }

    for (index, line) in notes.lines().enumerate() {
        for message in scan_line(line, &paths) {
            problems.push(Problem {
                file: "Notes de version".to_string(),
                line: Some(index as u32 + 1),
                column: None,
                message: message.to_string(),
            });
        }
    }
    problems
}

/// Le distant a avancé depuis le dernier rafraîchissement : le push est refusé, mais il suffit de se réaligner.
pub(crate) fn remote_advanced(error: &AppError) -> bool {
    let stderr = stderr_of(error);
    stderr.contains("[rejected]") || stderr.contains("fetch first") || stderr.contains("non-fast-forward")
}

/// Ce qui part dans le marketplace pour une publication.
struct Release<'a> {
    /// Dossier du module dans l’espace.
    source: &'a Path,
    id: &'a str,
    name: &'a str,
    version: [u64; 3],
    /// Manifeste publié : sans origine, à la nouvelle version.
    manifest: &'a str,
    notes: &'a str,
}

/// Écrit la publication dans le clone (déjà aligné sur le distant), la commite et la pousse. Si le distant a
/// avancé entre-temps, le clone est réaligné et la publication rejouée une fois par-dessus. `before_push` n’existe
/// que pour reproduire cette course dans les tests.
fn publish_into_clone(clone: &Path, release: &Release<'_>, before_push: &mut dyn FnMut()) -> AppResult<String> {
    let version = format_version(release.version);
    for attempt in 0..2 {
        let target = clone.join(release.id);
        if let Ok(published) = catalog_manifest(clone, release.id) {
            if parse_version(&published.version).is_some_and(|published| release.version <= published) {
                return Err(AppError::new(format!(
                    "La version {version} n’est pas publiable : le marketplace propose déjà la v{}. Choisir un numéro strictement supérieur.",
                    published.version
                )));
            }
        }
        // Le journal des versions du marketplace fait foi ; à la première publication, celui du module s’il en a un.
        let history = fs::read_to_string(target.join(CHANGELOG))
            .or_else(|_| fs::read_to_string(release.source.join(CHANGELOG)))
            .unwrap_or_default();
        remove_tree(&target)?;
        copy_tree(release.source, &target)?;
        fs::write(target.join(MODULE_FILE), release.manifest)?;
        fs::write(target.join(CHANGELOG), with_new_entry(&history, &version, release.notes))?;
        let commit = commit_clone(clone, &format!("Publication du module {} v{version}", release.name))?
            .ok_or_else(|| AppError::new("Rien à publier : le marketplace contient déjà exactement ce contenu."))?;

        before_push();
        let branch = remote_branch(clone)
            .or_else(|| git::run(clone, &["symbolic-ref", "-q", "--short", "HEAD"]).ok())
            .unwrap_or_else(|| "main".to_string());
        match remote_git(clone, &["push", "--quiet", "origin", &format!("HEAD:refs/heads/{branch}")]) {
            Ok(_) => return Ok(commit),
            Err(error) if attempt == 0 && remote_advanced(&error) => fetch_and_align(clone)?,
            Err(error) if remote_advanced(&error) => {
                return Err(AppError::with_detail(
                    "Le marketplace a reçu d’autres publications pendant l’envoi. Réessayer.",
                    json!({ "stderr": stderr_of(&error) }),
                ))
            }
            Err(error) => return Err(explain_remote(error, "publication")),
        }
    }
    Err(AppError::new("La publication n’a pas abouti."))
}

fn publish(state: &AppState, module_id: &str, marketplace_id: &str, version: &str, notes: &str) -> AppResult<Value> {
    let space = state.space()?;
    let manifest = space.module(module_id)?;
    let name = display_name(&manifest).to_string();
    if manifest.read_only() {
        return Err(AppError::new(format!(
            "Le module « {name} » est importé d’un marketplace : seul un module local ou détaché se publie. Le détacher d’abord."
        )));
    }
    let wanted = parse_version(version)
        .ok_or_else(|| AppError::new(format!("Numéro de version invalide : « {version} ». Utiliser la forme 1.2.3.")))?;
    let version = format_version(wanted);
    let marketplace = find(state, marketplace_id)?;

    let source = space.module_dir(module_id);
    let mut local_map = read_manifest_map(&source)?;
    // Une dépendance sans version minimale part avec celle présente ici : qui importe le module reçoit une version
    // de la même majeure, celle avec laquelle il a été testé.
    let pinned_requires = pin_requirements(&space, &manifest);
    if let Some(requires) = &pinned_requires {
        local_map.insert("requires".to_string(), requires.clone());
    }
    let mut published = local_map.clone();
    // L’origine et les publications décrivent ce poste, pas le module : elles ne se publient pas.
    published.remove("origin");
    published.remove("published");
    published.insert("id".to_string(), json!(module_id));
    published.insert("version".to_string(), json!(version));
    let mut published_manifest = serde_json::to_string_pretty(&Value::Object(published))?;
    published_manifest.push('\n');

    let problems = verify(&space, &manifest, &published_manifest, notes);
    if !problems.is_empty() {
        let count = problems.len();
        return Err(AppError::with_detail(
            format!(
                "Publication bloquée : {count} problème{} à corriger avant de partager ce module.",
                if count > 1 { "s" } else { "" }
            ),
            json!({ "problems": problems }),
        ));
    }

    let clone = clone_dir(state, &marketplace.id);
    sync_clone(&clone, &marketplace.url)?;
    // Qui installe le module doit pouvoir installer ses dépendances depuis le même marketplace.
    let requires: Vec<space::Requirement> = match &pinned_requires {
        Some(requires) => serde_json::from_value(requires.clone()).unwrap_or_else(|_| manifest.requires.clone()),
        None => manifest.requires.clone(),
    };
    let missing: Vec<Problem> = requires
        .iter()
        .filter(|requirement| {
            requirement.module != module_id
                && !catalog_manifest(&clone, &requirement.module).is_ok_and(|found| requirement.accepts(&found.version))
        })
        .map(|requirement| Problem {
            file: MODULE_FILE.to_string(),
            line: None,
            column: None,
            message: format!(
                "Dépendance {} absente du marketplace « {} » (ou en version trop ancienne) : la publier d’abord.",
                requirement.describe(),
                marketplace.name
            ),
        })
        .collect();
    if !missing.is_empty() {
        let count = missing.len();
        return Err(AppError::with_detail(
            format!("Publication bloquée : {count} dépendance{} à publier d’abord.", if count > 1 { "s" } else { "" }),
            json!({ "problems": missing }),
        ));
    }
    let release =
        Release { source: &source, id: module_id, name: &name, version: wanted, manifest: &published_manifest, notes };
    let commit = match publish_into_clone(&clone, &release, &mut || {}) {
        Ok(commit) => commit,
        Err(error) => {
            // Rien ne doit rester dans le clone d’une publication qui n’est pas partie.
            let _ = align(&clone);
            return Err(error);
        }
    };

    // Le module local porte désormais la version publiée : la prochaine publication proposera la suivante.
    // Il garde aussi la trace de cette publication : l’espace de travail sait que ce module est le sien, publié.
    checkpoint(&space, "la publication d’un module")?;
    let mut local = read_manifest_map(&source)?;
    local.insert("version".to_string(), json!(version));
    if let Some(requires) = &pinned_requires {
        local.insert("requires".to_string(), requires.clone());
    }
    let mut publications: Vec<space::Publication> =
        local.get("published").and_then(|value| serde_json::from_value(value.clone()).ok()).unwrap_or_default();
    publications.retain(|publication| !same_url(&publication.marketplace, &marketplace.url));
    publications.push(space::Publication {
        marketplace: marketplace.url.clone(),
        version: version.clone(),
        commit: commit.clone(),
    });
    local.insert("published".to_string(), serde_json::to_value(&publications)?);
    space::write_json(&source.join(MODULE_FILE), &Value::Object(local))?;
    let message = format!("Publication du module {name} v{version} sur {}", marketplace.name);
    git::commit_all(&space.root, &message)?;
    journal(state, &space, module_id, &message);
    state.emit("space:changed", Value::Null);
    Ok(json!({ "version": version, "commit": commit }))
}

/// Modules développés dans l’espace de travail et publiés : sur quel marketplace, en quelle version, et s’ils ont
/// changé depuis.
fn publications(state: &AppState) -> AppResult<Value> {
    let Some(space) = state.try_space() else { return Ok(json!([])) };
    let marketplaces = load(state)?;
    let mut entries = Vec::new();
    for module_id in space.module_ids() {
        let Ok(manifest) = space.module(&module_id) else { continue };
        if manifest.read_only() {
            continue;
        }
        for publication in &manifest.published {
            let marketplace = marketplaces.iter().find(|candidate| same_url(&candidate.url, &publication.marketplace));
            entries.push(json!({
                "module": module_id,
                "marketplace": marketplace.map(|marketplace| marketplace.id.clone()),
                "marketplaceName": marketplace.map(|marketplace| marketplace.name.clone()),
                "source": publication.marketplace,
                "version": publication.version,
                "modified": changed_since(&space, &module_id, &publication.commit),
            }));
        }
    }
    Ok(Value::Array(entries))
}

/// `requires` du manifeste où chaque dépendance sans version minimale reçoit celle présente dans l’espace de
/// travail ; `None` quand il n’y a rien à compléter.
fn pin_requirements(space: &Space, manifest: &ModuleManifest) -> Option<Value> {
    let mut changed = false;
    let requires: Vec<space::Requirement> = manifest
        .requires
        .iter()
        .map(|requirement| {
            let mut requirement = requirement.clone();
            if requirement.min_version.as_deref().is_none_or(|min| min.trim().is_empty()) {
                if let Ok(local) = space.module(&requirement.module) {
                    if parse_version(&local.version).is_some() {
                        requirement.min_version = Some(local.version);
                        changed = true;
                    }
                }
            }
            requirement
        })
        .collect();
    if changed {
        serde_json::to_value(requires).ok()
    } else {
        None
    }
}

/// Version proposée pour la prochaine publication : la version locale pour une première publication, sinon le
/// correctif suivant la plus haute des versions locale et publiée.
fn suggest_version(state: &AppState, module_id: &str, marketplace_id: &str, fresh: bool) -> AppResult<Value> {
    let space = state.space()?;
    let manifest = space.module(module_id)?;
    let marketplace = find(state, marketplace_id)?;
    let clone = clone_dir(state, &marketplace.id);
    if fresh {
        // Sans réseau, la proposition repose sur le dernier état connu ; la publication revérifiera.
        let _ = sync_clone(&clone, &marketplace.url);
    }
    let local = parse_version(&manifest.version);
    let published = catalog_manifest(&clone, module_id).ok().map(|published| published.version);
    let version = match published.as_deref().map(parse_version) {
        None => local.unwrap_or([0, 1, 0]),
        Some(published) => {
            let highest = local.max(published).unwrap_or([0, 1, 0]);
            [highest[0], highest[1], highest[2] + 1]
        }
    };
    Ok(json!({ "version": format_version(version), "published": published, "local": manifest.version }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{ClientNeed, FunctionDecl, PlaceTarget};

    const PAGE: &str = "import { Page } from \"@alfred/ui\";\nexport default function Vue() {\n  return <Page>Bonjour</Page>;\n}\n";

    /// Un fichier encore tenu (violation de partage sous Windows) est réessayé ; une autre erreur ne l’est pas.
    #[test]
    fn a_briefly_locked_folder_is_retried() {
        let sharing_violation = |error: &std::io::Error| error.raw_os_error() == Some(32);
        let mut calls = 0;
        let result = retrying(sharing_violation, || {
            calls += 1;
            if calls < 3 {
                Err(std::io::Error::from_raw_os_error(32))
            } else {
                Ok(calls)
            }
        });
        assert_eq!(result.unwrap(), 3);
        let mut calls = 0;
        let result: std::io::Result<()> = retrying(sharing_violation, || {
            calls += 1;
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        });
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    /// Un poste : ses données d’Alfred et son espace ouvert.
    fn desk(root: &Path, name: &str) -> (Arc<AppState>, Space) {
        let state = AppState::new(&root.join(format!("{name}-donnees"))).unwrap();
        let space = Space::open_or_create(&root.join(format!("{name}-espace")), Some(name)).unwrap();
        state.set_space(Some(space.clone()));
        (state, space)
    }

    fn bare_remote(root: &Path) -> String {
        let path = root.join("marketplace.git");
        fs::create_dir_all(&path).unwrap();
        git::run(&path, &["init", "--bare", "-q", "-b", "main"]).unwrap();
        path.to_string_lossy().to_string()
    }

    async fn call(state: &Arc<AppState>, command: &str, args: Value) -> AppResult<Value> {
        handle(state, command, &args).await.expect("commande du module marketplace")
    }

    /// Module local « suivi » avec une page et une fonction, comme l’agent l’aurait écrit.
    fn author_module(space: &Space) {
        let page = space
            .place_page("Tableau", None, "", &PlaceTarget::Menu { label: "Suivi".into(), icon: None, color: None }, None)
            .unwrap();
        fs::write(&page.file, PAGE).unwrap();
        let mut manifest = space.module("suivi").unwrap();
        manifest.description = "Suivi des dossiers".into();
        manifest.functions.push(FunctionDecl { id: "compter".into(), description: "Compte les dossiers".into(), ..FunctionDecl::default() });
        space.write_module(&manifest).unwrap();
        fs::create_dir_all(space.module_dir("suivi").join("functions")).unwrap();
        fs::write(space.function_file("suivi", "compter"), "export default async function compter() {\n  return 3;\n}\n").unwrap();
        git::commit_all(&space.root, "Module de suivi").unwrap();
    }

    fn remote_log(remote: &str) -> Vec<String> {
        git::run(Path::new(remote), &["log", "--format=%s", "main"])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn last_message(space: &Space) -> String {
        git::run(&space.root, &["log", "-1", "--format=%s"]).unwrap()
    }

    #[tokio::test]
    async fn shares_a_module_from_publication_to_detachment() {
        let root = tempfile::tempdir().unwrap();
        let remote = bare_remote(root.path());

        // Poste A : publie son module local.
        let (author, author_space) = desk(root.path(), "auteur");
        author_module(&author_space);
        let added = call(&author, "marketplace.add", json!({ "url": remote, "name": "Équipe" })).await.unwrap();
        assert_eq!(added["id"], "equipe");
        assert!(call(&author, "marketplace.add", json!({ "url": format!("{remote}/") })).await.is_err(), "doublon refusé");

        let suggested =
            call(&author, "marketplace.suggestVersion", json!({ "module": "suivi", "marketplace": "equipe" })).await.unwrap();
        assert_eq!(suggested["version"], "0.1.0", "première publication : la version locale");
        let published = call(
            &author,
            "marketplace.publish",
            json!({ "module": "suivi", "marketplace": "equipe", "version": "1.0.0", "notes": "Première version." }),
        )
        .await
        .unwrap();
        assert_eq!(published["version"], "1.0.0");
        assert_eq!(remote_log(&remote), ["Publication du module Suivi v1.0.0"]);
        assert_eq!(author_space.module("suivi").unwrap().version, "1.0.0");
        assert!(!git::has_changes(&author_space.root).unwrap(), "l’espace de l’auteur est enregistré");
        let again = call(
            &author,
            "marketplace.publish",
            json!({ "module": "suivi", "marketplace": "equipe", "version": "1.0.0", "notes": "" }),
        )
        .await
        .unwrap_err();
        assert!(again.message.contains("strictement supérieur"), "{}", again.message);
        let next =
            call(&author, "marketplace.suggestVersion", json!({ "module": "suivi", "marketplace": "equipe" })).await.unwrap();
        assert_eq!(next["version"], "1.0.1");

        // Poste B : branche le marketplace, lit le catalogue, installe.
        let (reader, reader_space) = desk(root.path(), "lecteur");
        let mut events = reader.events.subscribe();
        call(&reader, "marketplace.add", json!({ "url": remote })).await.unwrap();
        let listed = call(&reader, "marketplace.list", json!({})).await.unwrap();
        assert_eq!(listed[0]["id"], "marketplace");
        assert!(listed[0].get("error").is_none());
        let catalog = call(&reader, "marketplace.modules", json!({ "id": "marketplace" })).await.unwrap();
        let offered = &catalog[0];
        assert_eq!((offered["id"].as_str(), offered["version"].as_str()), (Some("suivi"), Some("1.0.0")));
        assert_eq!(offered["installed"], Value::Null);
        assert_eq!(offered["pages"][0]["title"], "Tableau");
        assert_eq!(offered["functions"][0]["id"], "compter");
        assert_eq!(offered["notes"], "Première version.");
        let shared_manifest = fs::read_to_string(clone_dir(&reader, "marketplace").join("suivi").join(MODULE_FILE)).unwrap();
        assert!(!shared_manifest.contains("origin"), "l’origine ne se publie pas");

        call(&reader, "marketplace.install", json!({ "marketplace": "marketplace", "module": "suivi" })).await.unwrap();
        let installed = reader_space.module("suivi").unwrap();
        let origin = installed.origin.clone().unwrap();
        assert!(installed.read_only(), "un module installé est en lecture seule");
        assert_eq!((origin.marketplace.as_str(), origin.version.as_str()), (remote.as_str(), "1.0.0"));
        assert_eq!(origin.commit, published["commit"].as_str().unwrap());
        assert!(reader_space.page_file("suivi", "tableau").is_file());
        assert_eq!(last_message(&reader_space), "Import du module Suivi v1.0.0");
        assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|event| event.name == "space:changed"));
        assert!(reader_space.delete_page("suivi/tableau").is_err(), "pas de modification sur place");
        assert!(call(&reader, "marketplace.install", json!({ "marketplace": "marketplace", "module": "suivi" })).await.is_err());
        let refused = call(
            &reader,
            "marketplace.publish",
            json!({ "module": "suivi", "marketplace": "marketplace", "version": "2.0.0", "notes": "" }),
        )
        .await
        .unwrap_err();
        assert!(refused.message.contains("détacher"), "{}", refused.message);
        let catalog = call(&reader, "marketplace.modules", json!({ "id": "marketplace" })).await.unwrap();
        assert_eq!(catalog[0]["installed"], "1.0.0");

        let status = call(&reader, "marketplace.updates", json!({})).await.unwrap();
        assert_eq!(status.as_array().unwrap().len(), 1);
        assert_eq!(status[0]["available"], Value::Null);
        assert_eq!(status[0]["locallyModified"], false);

        // Poste A : v1.1.0 avec une page, un besoin de client et un outil pour les agents en plus.
        let details = author_space
            .place_page("Détails", None, "", &PlaceTarget::Tab { section: "suivi/principal".into() }, None)
            .unwrap();
        fs::write(&details.file, PAGE).unwrap();
        let mut manifest = author_space.module("suivi").unwrap();
        manifest.clients.push(ClientNeed { id: "crm".into(), label: "CRM de l’équipe".into(), ..ClientNeed::default() });
        manifest.functions[0].tool = true;
        author_space.write_module(&manifest).unwrap();
        call(
            &author,
            "marketplace.publish",
            json!({ "module": "suivi", "marketplace": "equipe", "version": "1.1.0", "notes": "Ajout de la page Détails et du CRM." }),
        )
        .await
        .unwrap();

        // Poste B : la mise à jour est signalée, avec ce qu’elle change et ce qu’elle demande de plus.
        let status = call(&reader, "marketplace.updates", json!({})).await.unwrap();
        assert_eq!(status[0]["available"], Value::Null, "rien n’est vu avant le rafraîchissement");
        let status = call(&reader, "marketplace.updates", json!({ "refresh": true })).await.unwrap();
        let pending = &status[0];
        assert_eq!((pending["current"].as_str(), pending["available"].as_str()), (Some("1.0.0"), Some("1.1.0")));
        assert_eq!(pending["changes"]["pagesAdded"], json!(["Détails"]));
        assert_eq!(pending["changes"]["pagesRemoved"], json!([]));
        let new_accesses: Vec<(&str, &str)> = pending["changes"]["newAccesses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|access| (access["kind"].as_str().unwrap(), access["id"].as_str().unwrap()))
            .collect();
        assert_eq!(new_accesses, [("client", "crm"), ("tool", "compter")]);
        assert_eq!(pending["notes"], "Ajout de la page Détails et du CRM.");
        assert_eq!(pending["locallyModified"], false);

        // Une retouche locale d’un module installé est signalée avant d’être écrasée.
        fs::write(reader_space.page_file("suivi", "tableau"), "export default function Vue() { return null; }\n").unwrap();
        let status = call(&reader, "marketplace.updates", json!({})).await.unwrap();
        assert_eq!(status[0]["locallyModified"], true);

        // Figé : signalé, mais laissé de côté par « Tout mettre à jour ».
        call(&reader, "marketplace.pin", json!({ "module": "suivi", "pinned": true })).await.unwrap();
        let status = call(&reader, "marketplace.updates", json!({})).await.unwrap();
        assert_eq!((status[0]["pinned"].as_bool(), status[0]["available"].as_str()), (Some(true), Some("1.1.0")));
        let all = call(&reader, "marketplace.updateAll", json!({})).await.unwrap();
        assert_eq!(all["updated"], json!([]));
        assert_eq!(reader_space.module("suivi").unwrap().origin.unwrap().version, "1.0.0");

        // Appliquée sur accord : contenu remplacé, origine à jour, choix de figer conservé, un commit annulable.
        let updated = call(&reader, "marketplace.update", json!({ "module": "suivi" })).await.unwrap();
        assert_eq!((updated["from"].as_str(), updated["to"].as_str()), (Some("1.0.0"), Some("1.1.0")));
        let installed = reader_space.module("suivi").unwrap();
        let origin = installed.origin.clone().unwrap();
        assert_eq!((installed.version.as_str(), origin.version.as_str()), ("1.1.0", "1.1.0"));
        assert!(origin.pinned && installed.read_only());
        assert_eq!(installed.clients[0].id, "crm");
        assert!(reader_space.page_file("suivi", "details").is_file());
        assert_eq!(fs::read_to_string(reader_space.page_file("suivi", "tableau")).unwrap(), PAGE, "retouche locale écrasée");
        assert_eq!(last_message(&reader_space), "Mise à jour du module Suivi v1.0.0 → v1.1.0");
        let status = call(&reader, "marketplace.updates", json!({})).await.unwrap();
        assert_eq!(status[0]["available"], Value::Null);
        assert_eq!(status[0]["locallyModified"], false);
        assert!(call(&reader, "marketplace.update", json!({ "module": "suivi" })).await.is_err(), "déjà à jour");
        call(&reader, "marketplace.pin", json!({ "module": "suivi", "pinned": false })).await.unwrap();
        assert_eq!(call(&reader, "marketplace.updates", json!({})).await.unwrap()[0]["locallyModified"], false);

        // Marketplace débranché : le module reste, signalé sans source.
        call(&reader, "marketplace.remove", json!({ "id": "marketplace" })).await.unwrap();
        assert!(!clone_dir(&reader, "marketplace").exists());
        let status = call(&reader, "marketplace.updates", json!({})).await.unwrap();
        assert_eq!(status[0]["sourceMissing"], true);
        call(&reader, "marketplace.add", json!({ "url": remote })).await.unwrap();

        // Détaché : modifiable, origine gardée, plus aucune mise à jour.
        call(&reader, "marketplace.detach", json!({ "module": "suivi" })).await.unwrap();
        let detached = reader_space.module("suivi").unwrap();
        assert!(!detached.read_only());
        assert_eq!(detached.origin.as_ref().map(|origin| (origin.detached, origin.marketplace.as_str())), Some((true, remote.as_str())));
        assert_eq!(call(&reader, "marketplace.updates", json!({})).await.unwrap(), json!([]));
        assert!(call(&reader, "marketplace.update", json!({ "module": "suivi" })).await.is_err());
        let catalog = call(&reader, "marketplace.modules", json!({ "id": "marketplace" })).await.unwrap();
        assert_eq!((catalog[0]["installed"].clone(), catalog[0]["conflict"].clone()), (Value::Null, json!(true)));

        // Désinstallation : le dossier part, le choix sur les données est transmis à qui tient la base.
        let mut events = reader.events.subscribe();
        call(&reader, "marketplace.uninstall", json!({ "module": "suivi", "deleteData": true })).await.unwrap();
        assert!(!reader_space.module_dir("suivi").exists());
        let event = std::iter::from_fn(|| events.try_recv().ok()).find(|event| event.name == "module:uninstalled").unwrap();
        assert_eq!(event.payload, json!({ "module": "suivi", "deleteData": true }));
        assert!(!git::has_changes(&reader_space.root).unwrap());
    }

    #[tokio::test]
    async fn refuses_to_publish_what_does_not_compile_or_would_leak() {
        let root = tempfile::tempdir().unwrap();
        let remote = bare_remote(root.path());
        let (state, space) = desk(root.path(), "auteur");
        author_module(&space);
        call(&state, "marketplace.add", json!({ "url": remote, "name": "Équipe" })).await.unwrap();
        let publish = |version: &str| {
            call(&state, "marketplace.publish", json!({ "module": "suivi", "marketplace": "equipe", "version": version, "notes": "" }))
        };
        let problems = |error: &AppError| -> Vec<(String, Option<u64>, String)> {
            error.detail.as_ref().unwrap()["problems"]
                .as_array()
                .unwrap()
                .iter()
                .map(|problem| {
                    (
                        problem["file"].as_str().unwrap().to_string(),
                        problem["line"].as_u64(),
                        problem["message"].as_str().unwrap().to_string(),
                    )
                })
                .collect()
        };

        // Une page qui ne compile pas.
        fs::write(space.page_file("suivi", "tableau"), "export default function Vue() {\n  return <div>;\n}\n").unwrap();
        let error = publish("1.0.0").await.unwrap_err();
        let found = problems(&error);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].0, "pages/tableau.tsx");
        assert!(found[0].1.is_some_and(|line| line >= 2) && found[0].2.starts_with("Ne compile pas"), "{found:?}");

        // Un chemin du poste et des secrets, chacun à sa ligne ; la valeur fautive n’est jamais répétée.
        let leaking = [
            "export default async function compter() {",
            "  const source = \"/Users/camille/Documents/clients.csv\";",
            "  const headers = { Authorization: \"Bearer abcdefghijklmnopqrstuvwxyz012345\" };",
            "  const apiToken = \"a1b2c3d4e5f6g7h8\";",
            "  return fetch(\"https://api.exemple.fr/Users/12\", { headers });",
            "}",
        ]
        .join("\n");
        fs::write(space.page_file("suivi", "tableau"), PAGE).unwrap();
        fs::write(space.function_file("suivi", "compter"), leaking).unwrap();
        let error = publish("1.0.0").await.unwrap_err();
        let found = problems(&error);
        let lines: Vec<Option<u64>> = found.iter().map(|problem| problem.1).collect();
        assert_eq!(lines, [Some(2), Some(3), Some(4)], "{found:?}");
        assert!(found.iter().all(|problem| problem.0 == "functions/compter.ts"));
        assert!(found[0].2.contains("Chemin absolu"));
        assert!(!error.detail.as_ref().unwrap().to_string().contains("a1b2c3d4"));

        // Le chemin de l’espace lui-même, et une fonction déclarée sans fichier.
        fs::write(space.function_file("suivi", "compter"), format!("export const dossier = \"{}\";\n", space.root.display())).unwrap();
        let mut manifest = space.module("suivi").unwrap();
        manifest.functions.push(FunctionDecl { id: "absente".into(), ..FunctionDecl::default() });
        space.write_module(&manifest).unwrap();
        let found = problems(&publish("1.0.0").await.unwrap_err());
        assert!(found.iter().any(|problem| problem.0 == "functions/absente.ts" && problem.1.is_none()), "{found:?}");
        assert!(found.iter().any(|problem| problem.0 == "functions/compter.ts" && problem.1 == Some(1)), "{found:?}");

        assert!(publish("version-deux").await.unwrap_err().message.contains("Numéro de version invalide"));
        assert!(remote_log(&remote).is_empty(), "rien n’est parti");
        assert_eq!(space.module("suivi").unwrap().version, "0.1.0", "la version locale ne bouge pas");
    }

    #[tokio::test]
    async fn replays_the_publication_when_the_remote_moved_and_leaves_no_trace_on_failure() {
        let root = tempfile::tempdir().unwrap();
        let remote = bare_remote(root.path());
        let (state, space) = desk(root.path(), "auteur");
        author_module(&space);
        call(&state, "marketplace.add", json!({ "url": remote, "name": "Équipe" })).await.unwrap();
        let clone = clone_dir(&state, "equipe");
        let source = space.module_dir("suivi");
        let manifest = fs::read_to_string(source.join(MODULE_FILE)).unwrap();
        let release = |version: [u64; 3]| Release { source: &source, id: "suivi", name: "Suivi", version, manifest: &manifest, notes: "Notes" };

        // Un collègue pousse entre notre rafraîchissement et notre envoi.
        let colleague = root.path().join("collegue");
        git::run(root.path(), &["clone", "-q", &remote, "collegue"]).unwrap();
        let mut pushes = 0;
        let mut colleague_pushes = || {
            pushes += 1;
            if pushes == 1 {
                fs::create_dir_all(colleague.join("autre")).unwrap();
                fs::write(colleague.join("autre").join(MODULE_FILE), "{\"name\":\"Autre\",\"version\":\"1.0.0\"}").unwrap();
                git::commit_all(&colleague, "Publication du module Autre v1.0.0").unwrap();
                git::run(&colleague, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();
            }
        };
        let commit = publish_into_clone(&clone, &release([1, 0, 0]), &mut colleague_pushes).unwrap();
        assert_eq!(pushes, 2, "la publication a été rejouée une fois");
        assert_eq!(remote_log(&remote), ["Publication du module Suivi v1.0.0", "Publication du module Autre v1.0.0"]);
        assert_eq!(git::run(Path::new(&remote), &["rev-parse", "main"]).unwrap(), commit);
        assert_eq!(catalog_ids(&clone), ["autre", "suivi"]);

        // Distant devenu inaccessible : l’envoi échoue et le clone revient à l’état du distant connu.
        fs::rename(&remote, root.path().join("ailleurs.git")).unwrap();
        let error = call(
            &state,
            "marketplace.publish",
            json!({ "module": "suivi", "marketplace": "equipe", "version": "1.1.0", "notes": "" }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("introuvable"), "{}", error.message);
        assert!(publish_into_clone(&clone, &release([1, 1, 0]), &mut || {}).is_err());
        align(&clone).unwrap();
        assert_eq!(git::run(&clone, &["rev-parse", "HEAD"]).unwrap(), commit);
        assert!(!git::has_changes(&clone).unwrap());
        let history = fs::read_to_string(clone.join("suivi").join(CHANGELOG)).unwrap();
        assert_eq!(changelog_entries(&history).len(), 1, "la version qui n’est pas partie n’a laissé aucune note");
        let listed = call(&state, "marketplace.refresh", json!({})).await.unwrap();
        assert!(listed[0]["error"].as_str().is_some_and(|message| message.contains("introuvable")));
        assert!(call(&state, "marketplace.refresh", json!({ "id": "equipe" })).await.is_err());
    }

    #[tokio::test]
    async fn explains_an_unreachable_repository_and_keeps_nothing_of_it() {
        let root = tempfile::tempdir().unwrap();
        let (state, _space) = desk(root.path(), "poste");
        let missing = root.path().join("absent.git").to_string_lossy().to_string();
        let error = call(&state, "marketplace.add", json!({ "url": missing })).await.unwrap_err();
        assert!(error.message.starts_with("Dépôt introuvable"), "{}", error.message);
        assert!(error.detail.is_some(), "la sortie de git reste consultable");
        let with_token = call(&state, "marketplace.add", json!({ "url": "https://camille:motdepasse@exemple.fr/modules.git" }));
        assert!(with_token.await.unwrap_err().message.contains("mot de passe"));
        assert_eq!(call(&state, "marketplace.list", json!({})).await.unwrap(), json!([]));
        let leftovers = fs::read_dir(state.data_dir.join("marketplaces")).map(|entries| entries.count()).unwrap_or(0);
        assert_eq!(leftovers, 0, "aucun clone partiel");
        assert!(handle(&state, "space.snapshot", &json!({})).await.is_none(), "les autres commandes ne sont pas les siennes");
    }

    #[test]
    fn spots_local_paths_and_secrets_without_crying_wolf() {
        let flagged = [
            "const dossier = \"/Users/camille/Projets\";",
            "open(\"C:\\\\Users\\\\Camille\\\\export.csv\")",
            "chemin: C:\\Users\\camille\\notes.txt",
            "-----BEGIN RSA PRIVATE KEY-----",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "\"clientSecret\": \"9f8e7d6c5b4a3210\"",
            "password = 'correct-horse-battery'",
            "const cle = \"ghp_0123456789abcdefghijABCDEFGHIJ\";",
        ];
        for line in flagged {
            assert_eq!(scan_line(line, &[]).len(), 1, "{line}");
        }
        let innocent = [
            "fetch(\"https://api.exemple.fr/Users/12\")",
            "const route = `${base}/Users/${id}`;",
            "tokenUrl: \"https://auth.exemple.fr/oauth/token\",",
            "headers.Authorization = `Bearer ${token}`;",
            "\"token\": { \"type\": \"string\", \"description\": \"Jeton du service\" }",
            "password: \"Mot de passe du compte\",",
            "if (token === \"aucun-jeton-defini\") return;",
            "<input type=\"password\" autoComplete=\"current-password\" />",
            "className=\"task-list-item-with-a-long-name\"",
        ];
        for line in innocent {
            assert_eq!(scan_line(line, &[]), Vec::<&str>::new(), "{line}");
        }
        assert_eq!(scan_line("racine = \"/srv/espaces/demo\"", &["/srv/espaces/demo".to_string()]).len(), 1);

        assert_eq!(parse_version("v1.2"), Some([1, 2, 0]));
        assert_eq!(parse_version("1.2.3-beta"), None);
        assert!(is_newer("1.10.0", "1.9.9") && !is_newer("1.0.0", "1.0.0"));
        let log = with_new_entry(&with_new_entry("", "1.0.0", "Début."), "1.1.0", "Suite.");
        let entries = changelog_entries(&log);
        assert_eq!(entries, [("1.1.0".to_string(), "Suite.".to_string()), ("1.0.0".to_string(), "Début.".to_string())]);
    }

    /// Un module `x-ajouts` lit les tables de `x` : c’est un accès, affiché avant l’installation comme les autres.
    #[test]
    fn reading_another_module_s_data_is_an_access_shown_before_install() {
        let extension = ModuleManifest { id: "banque-ajouts".into(), ..ModuleManifest::default() };
        let listed = accesses(&extension);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].kind, listed[0].id.as_str()), ("tables", "banque"));
        assert_eq!(describe(&extension)["extends"], json!("banque"));
        assert!(accesses(&ModuleManifest { id: "banque".into(), ..ModuleManifest::default() }).is_empty());
    }

    /// Un module qui en utilise un autre l’installe avec lui (masqué), le met à jour avec lui, et le protège.
    #[tokio::test]
    async fn installs_updates_and_protects_the_modules_a_module_requires() {
        let root = tempfile::tempdir().unwrap();
        let remote = bare_remote(root.path());
        let (author, author_space) = desk(root.path(), "auteur");
        for label in ["CRM", "Devis"] {
            let page = author_space
                .place_page("Liste", None, "", &PlaceTarget::Menu { label: label.into(), icon: None, color: None }, None)
                .unwrap();
            fs::write(&page.file, PAGE).unwrap();
        }
        let require = |min: &str| {
            let mut devis = author_space.module("devis").unwrap();
            devis.requires = vec![crate::space::Requirement { module: "crm".into(), min_version: Some(min.into()) }];
            author_space.write_module(&devis).unwrap();
            git::commit_all(&author_space.root, "Dépendance").unwrap();
        };
        require("1.0.0");
        call(&author, "marketplace.add", json!({ "url": remote, "name": "Équipe" })).await.unwrap();
        let publish = |module: &str, version: &str| {
            let author = author.clone();
            let args = json!({ "module": module, "marketplace": "equipe", "version": version, "notes": "" });
            async move { call(&author, "marketplace.publish", args).await }
        };

        // La dépendance doit être publiée d’abord.
        let blocked = publish("devis", "1.0.0").await.unwrap_err();
        assert!(blocked.message.contains("dépendance"), "{}", blocked.message);
        publish("crm", "1.0.0").await.unwrap();
        publish("devis", "1.0.0").await.unwrap();

        // Le catalogue annonce la dépendance et ce que l’installation en fera.
        let (reader, reader_space) = desk(root.path(), "lecteur");
        call(&reader, "marketplace.add", json!({ "url": remote })).await.unwrap();
        let catalog = call(&reader, "marketplace.modules", json!({ "id": "marketplace" })).await.unwrap();
        let devis = catalog.as_array().unwrap().iter().find(|entry| entry["id"] == "devis").unwrap();
        assert_eq!(devis["dependencies"], json!([{ "module": "crm", "name": "CRM", "action": "install", "version": "1.0.0" }]));
        assert_eq!(devis["requires"][0]["module"], "crm");
        assert!(accesses(&author_space.module("devis").unwrap()).iter().any(|access| access.kind == "module"));

        // Installer « devis » installe « crm », masqué du menu, dans le même enregistrement.
        call(&reader, "marketplace.install", json!({ "marketplace": "marketplace", "module": "devis" })).await.unwrap();
        assert_eq!(last_message(&reader_space), "Import du module Devis v1.0.0 (avec CRM v1.0.0)");
        let snapshot = reader_space.snapshot().unwrap();
        assert!(snapshot.problems.is_empty(), "{:?}", snapshot.problems);
        let crm = snapshot.modules.iter().find(|module| module.id == "crm").unwrap();
        assert!(crm.hidden && crm.read_only);
        assert!(snapshot.sections.iter().find(|section| section.module == "crm").unwrap().hidden);
        assert!(!snapshot.sections.iter().find(|section| section.module == "devis").unwrap().hidden);

        // « crm » ne se désinstalle pas tant que « devis » s’en sert.
        let refused = call(&reader, "marketplace.uninstall", json!({ "module": "crm", "deleteData": false })).await.unwrap_err();
        assert!(refused.message.contains("« Devis »"), "{}", refused.message);

        // Une nouvelle version de « devis » qui demande un « crm » plus récent le met à jour avec elle.
        publish("crm", "1.1.0").await.unwrap();
        require("1.1.0");
        publish("devis", "1.1.0").await.unwrap();
        let updates = call(&reader, "marketplace.updates", json!({ "refresh": true })).await.unwrap();
        let entry = updates.as_array().unwrap().iter().find(|entry| entry["module"] == "devis").unwrap();
        assert_eq!(entry["dependencies"][0]["action"], "update");
        call(&reader, "marketplace.update", json!({ "module": "devis" })).await.unwrap();
        assert_eq!(reader_space.module("crm").unwrap().version, "1.1.0");
        assert_eq!(last_message(&reader_space), "Mise à jour du module Devis v1.0.0 → v1.1.0 (avec CRM v1.1.0)");
        assert!(reader_space.snapshot().unwrap().modules.iter().find(|module| module.id == "crm").unwrap().hidden);

        // Une fois « devis » parti, « crm » se désinstalle et son réglage d’affichage disparaît avec lui.
        call(&reader, "marketplace.uninstall", json!({ "module": "devis", "deleteData": false })).await.unwrap();
        call(&reader, "marketplace.uninstall", json!({ "module": "crm", "deleteData": false })).await.unwrap();
        assert!(reader_space.manifest().unwrap().layout.overrides.is_empty());
    }
    /// Une dépendance suit les versions mineures et correctifs de son marketplace, jamais une nouvelle majeure tant
    /// qu’un module de l’espace de travail demande l’ancienne ; le module publié reste celui de son auteur.
    #[tokio::test]
    async fn dependencies_follow_minor_versions_but_never_cross_a_major_one() {
        let root = tempfile::tempdir().unwrap();
        let remote = bare_remote(root.path());
        let (author, author_space) = desk(root.path(), "auteur");
        for label in ["CRM", "Devis"] {
            let page = author_space
                .place_page("Liste", None, "", &PlaceTarget::Menu { label: label.into(), icon: None, color: None }, None)
                .unwrap();
            fs::write(&page.file, PAGE).unwrap();
        }
        let mut devis = author_space.module("devis").unwrap();
        devis.requires = vec![crate::space::Requirement { module: "crm".into(), min_version: None }];
        author_space.write_module(&devis).unwrap();
        git::commit_all(&author_space.root, "Dépendance").unwrap();
        call(&author, "marketplace.add", json!({ "url": remote, "name": "Équipe" })).await.unwrap();
        let publish = |module: &str, version: &str| {
            let author = author.clone();
            let args = json!({ "module": module, "marketplace": "equipe", "version": version, "notes": "" });
            async move { call(&author, "marketplace.publish", args).await }
        };
        publish("crm", "1.0.0").await.unwrap();
        publish("devis", "1.0.0").await.unwrap();

        // La publication fixe la version de la dépendance testée ici, et l’espace de l’auteur s’en souvient.
        let devis = author_space.module("devis").unwrap();
        assert_eq!(devis.requires[0].min_version.as_deref(), Some("1.0.0"));
        assert_eq!(devis.published.len(), 1);
        assert_eq!((devis.published[0].marketplace.as_str(), devis.published[0].version.as_str()), (remote.as_str(), "1.0.0"));
        let shared = fs::read_to_string(clone_dir(&author, "equipe").join("devis").join(MODULE_FILE)).unwrap();
        assert!(!shared.contains("published"), "les publications ne se publient pas");
        assert!(shared.contains("\"minVersion\": \"1.0.0\""), "{shared}");
        let catalog = call(&author, "marketplace.modules", json!({ "id": "equipe" })).await.unwrap();
        let own = catalog.as_array().unwrap().iter().find(|entry| entry["id"] == "devis").unwrap();
        assert_eq!(own["conflict"], false, "son propre module n’est pas un conflit");
        assert_eq!(own["own"]["version"], "1.0.0");
        let publications = call(&author, "marketplace.publications", json!({})).await.unwrap();
        let entry = publications.as_array().unwrap().iter().find(|entry| entry["module"] == "devis").unwrap();
        assert_eq!((entry["marketplace"].as_str(), entry["modified"].as_bool()), (Some("equipe"), Some(false)));
        fs::write(author_space.page_file("devis", "liste"), format!("{PAGE}// retouche\n")).unwrap();
        git::commit_all(&author_space.root, "Retouche").unwrap();
        let publications = call(&author, "marketplace.publications", json!({})).await.unwrap();
        let entry = publications.as_array().unwrap().iter().find(|entry| entry["module"] == "devis").unwrap();
        assert_eq!(entry["modified"], true, "modifié depuis sa publication");

        let (reader, reader_space) = desk(root.path(), "lecteur");
        call(&reader, "marketplace.add", json!({ "url": remote })).await.unwrap();
        call(&reader, "marketplace.install", json!({ "marketplace": "marketplace", "module": "devis" })).await.unwrap();

        // Un correctif de la dépendance arrive avec la mise à jour du module qui l’utilise.
        publish("crm", "1.0.1").await.unwrap();
        publish("devis", "1.0.1").await.unwrap();
        let updates = call(&reader, "marketplace.updates", json!({ "refresh": true })).await.unwrap();
        let devis_update = updates.as_array().unwrap().iter().find(|entry| entry["module"] == "devis").unwrap();
        assert_eq!(devis_update["dependencies"], json!([{ "module": "crm", "name": "CRM", "action": "update", "version": "1.0.1" }]));
        call(&reader, "marketplace.update", json!({ "module": "devis" })).await.unwrap();
        assert_eq!(reader_space.module("crm").unwrap().version, "1.0.1");

        // Une nouvelle majeure de la dépendance reste signalée, mais bloquée : « devis » demande la v1.
        publish("crm", "2.0.0").await.unwrap();
        let updates = call(&reader, "marketplace.updates", json!({ "refresh": true })).await.unwrap();
        let crm_update = updates.as_array().unwrap().iter().find(|entry| entry["module"] == "crm").unwrap();
        assert_eq!(crm_update["available"], "2.0.0");
        assert!(crm_update["blocked"].as_str().unwrap().contains("« Devis » demande"), "{crm_update}");
        let refused = call(&reader, "marketplace.update", json!({ "module": "crm" })).await.unwrap_err();
        assert!(refused.message.contains("nouvelle version majeure"), "{}", refused.message);
        let all = call(&reader, "marketplace.updateAll", json!({})).await.unwrap();
        assert_eq!((all["updated"].as_array().unwrap().len(), all["failed"].as_array().unwrap().len()), (0, 0));
        assert_eq!(reader_space.module("crm").unwrap().version, "1.0.1");

        // Le marketplace ne tient que la dernière version de chaque module : un « devis » pour la v1 ne s’y publie
        // plus, et le dit.
        let blocked = publish("devis", "1.0.2").await.unwrap_err();
        assert!(blocked.message.contains("dépendance"), "{}", blocked.message);
    }

    /// Un espace de travail ne s’ouvre pas sur un marketplace, et un marketplace ne se branche pas sur un espace.
    #[tokio::test]
    async fn a_workspace_and_a_marketplace_stay_apart() {
        let root = tempfile::tempdir().unwrap();
        let remote = bare_remote(root.path());
        let (author, author_space) = desk(root.path(), "auteur");
        author_module(&author_space);
        call(&author, "marketplace.add", json!({ "url": remote, "name": "Équipe" })).await.unwrap();
        call(&author, "marketplace.publish", json!({ "module": "suivi", "marketplace": "equipe", "version": "1.0.0" }))
            .await
            .unwrap();

        let clone = clone_dir(&author, "equipe");
        assert!(refuse_as_workspace(&author, &clone).is_err(), "le clone d’Alfred");
        let checkout = root.path().join("copie");
        git::run(root.path(), &["clone", "-q", &remote, &checkout.to_string_lossy()]).unwrap();
        let refused = refuse_as_workspace(&author, &checkout).unwrap_err();
        assert!(refused.message.contains("pas un espace de travail"), "{}", refused.message);
        assert!(refuse_as_workspace(&author, Path::new(&remote)).unwrap_err().message.contains("dépôt git nu"));
        assert!(refuse_as_workspace(&author, &author_space.root).is_ok());
        assert!(refuse_as_workspace(&author, &root.path().join("nouveau")).is_ok());

        let space_url = author_space.root.to_string_lossy().to_string();
        let refused = call(&author, "marketplace.add", json!({ "url": space_url })).await.unwrap_err();
        assert!(refused.message.contains("espace de travail"), "{}", refused.message);
        assert_eq!(call(&author, "marketplace.list", json!({})).await.unwrap().as_array().unwrap().len(), 1);
    }
}
