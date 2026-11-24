//! Environnement Python d’un module. Un module qui déclare des paquets (`python.requirements` de son
//! `module.json`) ou une version de Python (`python.version`) reçoit son propre environnement, créé avec `uv` au
//! premier usage, dans le dossier local de l’espace que git ignore : `.alfred/python/<module>/`. Un module sans
//! déclaration garde le `python3` du PATH de connexion, comme avant.
//!
//! - **uv** n’est jamais téléchargé par Alfred : il est cherché dans le PATH de connexion (et `~/.local/bin`,
//!   `~/.cargo/bin`, où l’installe l’installateur d’Astral). Absent, l’appel échoue avec un message qui dit comment
//!   l’installer, et Réglages › Modules l’affiche.
//! - **Empreinte** : une somme SHA-256 des paquets (triés), de la version et, sans version, de l’interpréteur de
//!   base. L’environnement est prêt quand son marqueur porte l’empreinte du `module.json` ; sinon il est refait.
//! - **Verrou** : un appel à la fois par environnement ; un second appel attend la fin du premier et trouve
//!   l’environnement prêt.
//! - **Réseau** : uv garde sa propre configuration (`uv.toml`, variables `UV_*`), et Alfred lui passe les
//!   certificats du système (`UV_SYSTEM_CERTS`), le proxy et l’index de pip (`PIP_INDEX_URL`) quand rien ne les
//!   règle déjà. Hors ligne, l’installation échoue avec un message clair ; un environnement prêt sert sans réseau.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{arg, AppError, AppResult};
use crate::scripts::{self, Interpreter, Process, Runtime};
use crate::space::{ModuleManifest, PythonDecl, Space};
use crate::state::AppState;

/// Sous-dossier du dossier local de l’espace où vivent les environnements.
const ENVS_DIR: &str = "python";
/// Marqueur écrit dans l’environnement à la fin d’une installation réussie.
const MARKER: &str = "alfred-env.json";
/// Format de l’empreinte : à changer si la façon d’installer change, pour refaire les environnements.
const FORMAT: u32 = 1;
/// Délai d’une installation (création et paquets).
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Fin du journal montrée dans les Réglages.
const LOG_TAIL_LINES: usize = 30;
const MAX_REQUIREMENTS: usize = 100;
const MAX_REQUIREMENT_LEN: usize = 300;
/// Événement émis quand l’état d’un environnement change.
pub const CHANGED_EVENT: &str = "python:changed";

// ---------------------------------------------------------------------------------------------------------------
// Validation de la déclaration
// ---------------------------------------------------------------------------------------------------------------

/// Problèmes de `python` dans un `module.json`, pour `check` et la vue de l’espace. Vide si tout va bien.
pub fn problems(module: &ModuleManifest) -> Vec<String> {
    let decl = &module.python;
    let mut problems = Vec::new();
    for key in decl.unknown.keys() {
        problems.push(format!(
            "Champ inconnu dans `python` : « {key} ». Champs possibles : `requirements` (liste de paquets) et `version`."
        ));
    }
    if decl.requirements.len() > MAX_REQUIREMENTS {
        problems.push(format!("`python.requirements` compte plus de {MAX_REQUIREMENTS} paquets."));
    }
    for (index, requirement) in decl.requirements.iter().enumerate() {
        if let Err(reason) = check_requirement(requirement) {
            problems.push(format!("Paquet Python n° {} invalide (« {} ») : {reason}", index + 1, requirement.trim()));
        }
    }
    if let Some(version) = &decl.version {
        if !valid_version(version) {
            problems.push(format!(
                "`python.version` vaut « {version} » : écrire une version de Python 3, comme « 3.12 » ou « 3.12.4 »."
            ));
        }
    }
    if decl.needs_env() && uv().is_none() {
        problems.push(uv_missing_message());
    }
    problems
}

/// Une spécification pip acceptée : un nom de paquet, puis extras, contraintes de version, marqueurs ou
/// `@ adresse`. Pas d’option pip (`-e`, `--index-url`), pas de chemin local, pas de retour à la ligne.
fn check_requirement(requirement: &str) -> Result<(), String> {
    let text = requirement.trim();
    if text.is_empty() {
        return Err("la ligne est vide.".to_string());
    }
    if text.len() > MAX_REQUIREMENT_LEN {
        return Err(format!("plus de {MAX_REQUIREMENT_LEN} caractères."));
    }
    if text.chars().any(char::is_control) {
        return Err("un seul paquet par ligne, sans retour à la ligne.".to_string());
    }
    if text.starts_with('-') {
        return Err(
            "les options de pip ne sont pas permises : écrire seulement le paquet, comme « pandas>=2.2 ».".to_string()
        );
    }
    let name_len =
        text.char_indices().take_while(|(_, c)| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).count();
    let name = &text[..name_len];
    let starts_well = name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    let ends_well = name.chars().last().is_some_and(|c| c.is_ascii_alphanumeric());
    if !starts_well || !ends_well {
        return Err("commencer par le nom du paquet, comme « pandas » ou « python-dateutil ».".to_string());
    }
    let rest = text[name_len..].trim_start();
    if !(rest.is_empty() || rest.starts_with(['[', '<', '>', '=', '!', '~', ';', '@', '('])) {
        return Err("après le nom, mettre une contrainte de version (« >=2.2 », « ==1.0 »), des extras (« [excel] ») ou « @ adresse ».".to_string());
    }
    Ok(())
}

/// Python 3 seulement, « 3.12 » ou « 3.12.4 ».
fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.trim().split('.').collect();
    (2..=3).contains(&parts.len())
        && parts[0] == "3"
        && parts.iter().all(|part| !part.is_empty() && part.len() <= 3 && part.chars().all(|c| c.is_ascii_digit()))
}

fn valid(decl: &PythonDecl) -> AppResult<()> {
    let module =
        ModuleManifest { python: PythonDecl { unknown: Default::default(), ..decl.clone() }, ..Default::default() };
    let errors: Vec<String> =
        problems(&module).into_iter().filter(|problem| *problem != uv_missing_message()).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::new(format!("Déclaration Python du module à corriger dans `module.json` : {}", errors.join(" "))))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// uv
// ---------------------------------------------------------------------------------------------------------------

fn uv_missing_message() -> String {
    "Ce module déclare des paquets Python, qu’Alfred installe avec uv, introuvable sur cet ordinateur. Installer uv (`brew install uv` sur Mac, ou la méthode de https://docs.astral.sh/uv/getting-started/installation/), puis rouvrir Alfred.".to_string()
}

/// uv, cherché dans le PATH de connexion, puis dans les dossiers où l’installateur d’Astral le pose.
pub fn uv() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let extra: Vec<PathBuf> =
        home.map(|home| vec![home.join(".local").join("bin"), home.join(".cargo").join("bin")]).unwrap_or_default();
    find_program("uv", crate::agents::search_path(), cfg!(windows), &extra)
}

fn find_program(name: &str, path: &str, windows: bool, extra: &[PathBuf]) -> Option<PathBuf> {
    let file = if windows { format!("{name}.exe") } else { name.to_string() };
    path.split(if windows { ';' } else { ':' })
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .chain(extra.iter().cloned())
        .map(|dir| dir.join(&file))
        .find(|candidate| candidate.is_file())
}

/// Variables passées à uv en plus de l’environnement réduit des scripts : sa configuration, le réseau de
/// l’entreprise (certificats, proxy, miroir), et des sorties sans couleur. `env` lit l’environnement d’Alfred.
fn uv_env(env: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = Vec::new();
    let has = |vars: &Vec<(String, String)>, name: &str| vars.iter().any(|(key, _)| key == name);
    // Ce que l’utilisateur a réglé lui-même passe tel quel.
    let passed = [
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "SSL_CLIENT_CERT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
    ];
    for name in passed {
        if let Some(value) = env(name).filter(|value| !value.trim().is_empty()) {
            vars.push((name.to_string(), value));
        }
    }
    for (name, value) in std::env::vars().filter(|(name, _)| name.starts_with("UV_")) {
        if env(&name).is_some() {
            vars.push((name, value));
        }
    }
    // L’index de pip, si l’entreprise l’a réglé pour pip et pas pour uv.
    if !has(&vars, "UV_DEFAULT_INDEX") && !has(&vars, "UV_INDEX_URL") {
        if let Some(index) = env("PIP_INDEX_URL").filter(|value| !value.trim().is_empty()) {
            vars.push(("UV_DEFAULT_INDEX".to_string(), index));
        }
    }
    if !has(&vars, "UV_INDEX") && !has(&vars, "UV_EXTRA_INDEX_URL") {
        if let Some(index) = env("PIP_EXTRA_INDEX_URL").filter(|value| !value.trim().is_empty()) {
            vars.push(("UV_INDEX".to_string(), index));
        }
    }
    // Certificats : le magasin du système (l’autorité de l’entreprise y est), sauf si un réglage le fait déjà.
    if !["SSL_CERT_FILE", "UV_NATIVE_TLS", "UV_SYSTEM_CERTS"].iter().any(|name| has(&vars, name)) {
        vars.push(("UV_SYSTEM_CERTS".to_string(), "1".to_string()));
    }
    // Proxy du système (Windows) quand aucune variable n’en donne.
    if !crate::git_network::env_proxy(|name| vars.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())) {
        let index = vars
            .iter()
            .find(|(key, _)| key == "UV_DEFAULT_INDEX" || key == "UV_INDEX_URL")
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| "https://pypi.org/simple".to_string());
        let no_proxy =
            vars.iter().find(|(key, _)| key.eq_ignore_ascii_case("NO_PROXY")).map(|(_, value)| value.clone());
        if let Some(proxy) =
            crate::git_network::proxy_for(&index, false, &crate::git_network::system_proxy(), no_proxy.as_deref())
        {
            vars.push(("HTTPS_PROXY".to_string(), proxy.clone()));
            vars.push(("HTTP_PROXY".to_string(), proxy));
        }
    }
    vars.push(("NO_COLOR".to_string(), "1".to_string()));
    vars.push(("UV_NO_PROGRESS".to_string(), "1".to_string()));
    vars
}

// ---------------------------------------------------------------------------------------------------------------
// Empreinte, chemins, état
// ---------------------------------------------------------------------------------------------------------------

/// Empreinte de ce qui fait l’environnement : paquets triés, version, et interpréteur de base sans version.
fn fingerprint(decl: &PythonDecl, base: Option<&Path>) -> String {
    let requirements: BTreeSet<String> =
        decl.requirements.iter().map(|requirement| requirement.trim().to_string()).collect();
    let version = decl.version.as_ref().map(|version| version.trim().to_string());
    let base = if version.is_none() { base.map(|path| path.to_string_lossy().to_string()) } else { None };
    let canonical = json!({ "format": FORMAT, "requirements": requirements, "version": version, "base": base });
    let digest = Sha256::digest(canonical.to_string().as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct Paths {
    env: PathBuf,
    log: PathBuf,
    failure: PathBuf,
}

fn paths(space: &Space, module: &str) -> Paths {
    let root = space.local_dir().join(ENVS_DIR);
    Paths {
        env: root.join(module),
        log: root.join(format!("{module}.log")),
        failure: root.join(format!("{module}.echec.json")),
    }
}

fn env_python(env: &Path) -> PathBuf {
    if cfg!(windows) {
        env.join("Scripts").join("python.exe")
    } else {
        env.join("bin").join("python")
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// L’environnement porte-t-il cette empreinte, avec son interpréteur ?
fn is_ready(paths: &Paths, print: &str) -> bool {
    env_python(&paths.env).is_file()
        && read_json(&paths.env.join(MARKER)).is_some_and(|marker| marker["fingerprint"] == print)
}

/// Environnements en cours d’installation (clé : dossier de l’environnement).
fn installing() -> &'static Mutex<BTreeSet<PathBuf>> {
    static INSTALLING: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
    INSTALLING.get_or_init(Default::default)
}

/// Un verrou par environnement.
fn lock_for(env: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.entry(env.to_path_buf()).or_default().clone()
}

fn base_interpreter() -> Option<Interpreter> {
    scripts::interpreter(Runtime::Python)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvStatus {
    pub module: String,
    /// `ready`, `pending` (à installer), `installing`, `failed`, `uv-missing` ou `invalid`.
    pub status: &'static str,
    pub requirements: Vec<String>,
    pub version: Option<String>,
    /// Message de l’échec, ou de la déclaration à corriger.
    pub message: Option<String>,
    /// Fin du journal de la dernière installation.
    pub log: Option<String>,
    pub installed_at: Option<String>,
    /// Version de Python de l’environnement prêt.
    pub python: Option<String>,
}

fn log_tail(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(LOG_TAIL_LINES);
    let tail = lines[start..].join("\n");
    (!tail.trim().is_empty()).then_some(tail)
}

fn status_of(space: &Space, module: &ModuleManifest, uv_found: bool, base: Option<&Path>) -> EnvStatus {
    let decl = &module.python;
    let paths = paths(space, &module.id);
    let print = fingerprint(decl, base);
    let mut status = EnvStatus {
        module: module.id.clone(),
        status: "pending",
        requirements: decl.requirements.clone(),
        version: decl.version.clone(),
        message: None,
        log: log_tail(&paths.log),
        installed_at: None,
        python: None,
    };
    let lock = installing().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if lock.contains(&paths.env) {
        status.status = "installing";
        return status;
    }
    drop(lock);
    if let Err(error) = valid(decl) {
        status.status = "invalid";
        status.message = Some(error.message);
    } else if is_ready(&paths, &print) {
        let marker = read_json(&paths.env.join(MARKER)).unwrap_or_default();
        status.status = "ready";
        status.installed_at = marker["installedAt"].as_str().map(str::to_string);
        status.python = marker["python"].as_str().map(str::to_string);
    } else if !uv_found {
        status.status = "uv-missing";
        status.message = Some(uv_missing_message());
    } else if let Some(failure) = read_json(&paths.failure).filter(|failure| failure["fingerprint"] == print.as_str()) {
        status.status = "failed";
        status.message = failure["message"].as_str().map(str::to_string);
    }
    status
}

// ---------------------------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------------------------

/// Traduit l’échec de uv en un message qui dit quoi faire.
fn failure_message(output: &str) -> String {
    let lower = output.to_ascii_lowercase();
    let last = output.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("").to_string();
    let offline = [
        "dns error",
        "failed to lookup address",
        "error sending request",
        "connection refused",
        "network is unreachable",
        "client error (connect)",
        "operation timed out",
        "timed out",
        "no such host",
        "could not connect",
        "failed to fetch",
        "network connectivity is disabled",
    ];
    if ["certificate", "unknownissuer", "invalid peer", "tls handshake"].iter().any(|word| lower.contains(word)) {
        return format!(
            "Installation des paquets Python impossible : le certificat du serveur des paquets est refusé. Sur un réseau d’entreprise, donner à uv l’autorité de l’entreprise (`SSL_CERT_FILE`, ou `system-certs = true` dans ~/.config/uv/uv.toml), puis cliquer sur « Réinstaller ». Détail : {last}"
        );
    }
    if offline.iter().any(|word| lower.contains(word)) {
        return format!(
            "Installation des paquets Python impossible sans réseau : la première installation doit joindre le serveur des paquets (pypi.org, ou le miroir réglé pour uv dans ~/.config/uv/uv.toml). Se connecter, puis cliquer sur « Réinstaller ». Détail : {last}"
        );
    }
    if lower.contains("no solution found")
        || lower.contains("not found in the package registry")
        || lower.contains("because there is no version")
    {
        return format!("Les paquets Python déclarés ne s’installent pas ensemble ou n’existent pas : corriger `python.requirements` du module. Détail : {last}");
    }
    if lower.contains("no interpreter found") || lower.contains("no python") {
        return format!("Python introuvable pour cette version : corriger `python.version`, ou installer cette version. Détail : {last}");
    }
    format!("Installation des paquets Python impossible. Détail : {last}")
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Lance uv et ajoute sa sortie au journal. `Err` porte la sortie, pour en tirer le message.
fn run_uv(uv: &Path, args: Vec<String>, dir: &Path, log: &mut String) -> Result<(), String> {
    log.push_str(&format!("$ uv {}\n", args.join(" ")));
    let output = scripts::execute(&Process {
        program: uv.to_path_buf(),
        args,
        dir: dir.to_path_buf(),
        env: uv_env(|name| std::env::var(name).ok()),
        input: Vec::new(),
        timeout: INSTALL_TIMEOUT,
        timeout_message: format!(
            "L’installation des paquets Python a dépassé {} minutes : elle a été arrêtée.",
            INSTALL_TIMEOUT.as_secs() / 60
        ),
    })
    .map_err(|error| {
        log.push_str(&error.message);
        log.push('\n');
        error.message
    })?;
    let text = format!("{}{}", output.stdout, output.stderr);
    log.push_str(&text);
    if !log.ends_with('\n') {
        log.push('\n');
    }
    if output.success {
        Ok(())
    } else {
        Err(text)
    }
}

/// Crée l’environnement et installe les paquets. Appelé sous le verrou.
fn install(uv: &Path, paths: &Paths, decl: &PythonDecl, base: Option<&Path>, print: &str) -> AppResult<()> {
    let root = paths.env.parent().unwrap_or(&paths.env);
    fs::create_dir_all(root)?;
    let mut log = format!("Installation du {}\n", now());
    if paths.env.exists() {
        fs::remove_dir_all(&paths.env)?;
    }
    let mut venv = vec!["venv".to_string(), paths.env.to_string_lossy().to_string(), "--no-project".to_string()];
    match (&decl.version, base) {
        (Some(version), _) => venv.extend(["--python".to_string(), version.trim().to_string()]),
        (None, Some(base)) => venv.extend(["--python".to_string(), base.to_string_lossy().to_string()]),
        (None, None) => {}
    }
    let mut result = run_uv(uv, venv, root, &mut log);
    if result.is_ok() && !decl.requirements.is_empty() {
        let mut pip = vec!["pip".to_string(), "install".to_string(), "--python".to_string()];
        pip.push(env_python(&paths.env).to_string_lossy().to_string());
        pip.push("--".to_string());
        pip.extend(decl.requirements.iter().map(|requirement| requirement.trim().to_string()));
        result = run_uv(uv, pip, root, &mut log);
    }
    let python = result.is_ok().then(|| python_version(&env_python(&paths.env))).flatten();
    match &result {
        Ok(()) => log.push_str("Environnement prêt.\n"),
        Err(_) => log.push_str("Échec.\n"),
    }
    let _ = fs::write(&paths.log, &log);
    match result {
        Ok(()) => {
            let marker = json!({ "fingerprint": print, "installedAt": now(), "python": python, "requirements": decl.requirements });
            fs::write(paths.env.join(MARKER), serde_json::to_string_pretty(&marker)?)?;
            let _ = fs::remove_file(&paths.failure);
            Ok(())
        }
        Err(output) => {
            let message = failure_message(&output);
            let failure = json!({ "fingerprint": print, "at": now(), "message": message });
            let _ = fs::write(&paths.failure, serde_json::to_string_pretty(&failure)?);
            Err(AppError::new(message))
        }
    }
}

fn python_version(python: &Path) -> Option<String> {
    let output = std::process::Command::new(python).arg("--version").output().ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    text.trim().strip_prefix("Python ").map(str::to_string)
}

/// L’environnement prêt, installé au besoin. `force` le refait même s’il est prêt (« Réinstaller »).
fn ensure(
    state: Option<&AppState>,
    uv: Option<&Path>,
    space: &Space,
    module: &ModuleManifest,
    force: bool,
) -> AppResult<PathBuf> {
    let decl = &module.python;
    valid(decl)?;
    let paths = paths(space, &module.id);
    let base = if decl.version.is_none() { base_interpreter().map(|interpreter| interpreter.program) } else { None };
    let print = fingerprint(decl, base.as_deref());
    let lock = lock_for(&paths.env);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !force && is_ready(&paths, &print) {
        return Ok(env_python(&paths.env));
    }
    let uv = uv.ok_or_else(|| AppError::new(uv_missing_message()))?;
    installing().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(paths.env.clone());
    let emit = |state: Option<&AppState>| {
        if let Some(state) = state {
            state.emit(CHANGED_EVENT, json!({ "module": module.id }));
        }
    };
    emit(state);
    // Un noyau qui tourne encore sur l’ancien environnement s’arrête : il repartira sur le nouveau.
    crate::python::kernel::kernels().stop(
        &space.module_dir(&module.id),
        "Les paquets Python du module sont réinstallés : le noyau repartira avec eux. Les objets créés avant sont perdus.",
    );
    let result = install(uv, &paths, decl, base.as_deref(), &print);
    installing().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&paths.env);
    emit(state);
    result.map(|()| env_python(&paths.env))
}

/// Interpréteur Python d’un module : celui de son environnement s’il déclare `python.requirements` ou
/// `python.version` (créé et installé avec uv au premier appel, ce qui bloque : appeler hors du fil async),
/// sinon le `python3` du PATH de connexion, comme avant. `state` sert à prévenir les Réglages.
pub fn interpreter(state: Option<&AppState>, space: &Space, module: &ModuleManifest) -> AppResult<Interpreter> {
    if !module.python.needs_env() {
        return base_interpreter().ok_or_else(|| AppError::new(Runtime::Python.missing_message()));
    }
    let program = ensure(state, uv().as_deref(), space, module, false).map_err(|error| {
        AppError::new(format!(
            "Environnement Python du module « {} » : {}",
            if module.name.is_empty() { &module.id } else { &module.name },
            error.message
        ))
    })?;
    Ok(Interpreter { program, args: Vec::new() })
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes des Réglages
// ---------------------------------------------------------------------------------------------------------------

/// `python.envs` : l’état de l’environnement de chaque module qui en a un. `python.reinstall` (`module`) : le
/// refait en arrière-plan ; l’avancement arrive par l’événement `python:changed`.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !matches!(command, "python.envs" | "python.reinstall") {
        return None;
    }
    let result = async {
        let space = state.space()?;
        match command {
            "python.envs" => {
                let uv_found = uv().is_some();
                let base = base_interpreter().map(|interpreter| interpreter.program);
                let statuses: Vec<EnvStatus> = space
                    .module_ids()
                    .iter()
                    .filter_map(|id| space.module(id).ok())
                    .filter(|module| module.python.needs_env())
                    .map(|module| status_of(&space, &module, uv_found, base.as_deref()))
                    .collect();
                Ok(json!({ "uv": uv_found, "envs": statuses }))
            }
            _ => {
                let id: String = arg(args, "module")?;
                let module = space.module(&id)?;
                if !module.python.needs_env() {
                    return Err(AppError::new("Ce module ne déclare aucun paquet Python."));
                }
                valid(&module.python)?;
                let uv = uv().ok_or_else(|| AppError::new(uv_missing_message()))?;
                installing().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(paths(&space, &id).env);
                state.emit(CHANGED_EVENT, json!({ "module": id }));
                let state = state.clone();
                tokio::task::spawn_blocking(move || {
                    installing()
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&paths(&space, &id).env);
                    let _ = ensure(Some(&state), Some(&uv), &space, &module, true);
                    state.emit(CHANGED_EVENT, json!({ "module": id }));
                });
                Ok(Value::Null)
            }
        }
    }
    .await;
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(requirements: &[&str], version: Option<&str>) -> ModuleManifest {
        ModuleManifest {
            id: "analyse".into(),
            name: "Analyse".into(),
            python: PythonDecl {
                requirements: requirements.iter().map(|r| r.to_string()).collect(),
                version: version.map(str::to_string),
                unknown: Default::default(),
            },
            ..Default::default()
        }
    }

    fn space() -> (tempfile::TempDir, Space) {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        (dir, space)
    }

    #[test]
    fn le_manifeste_lit_python_et_signale_les_champs_inconnus() {
        let manifest: ModuleManifest = serde_json::from_value(json!({
            "id": "analyse", "name": "Analyse",
            "python": { "requirements": ["pandas>=2.2"], "version": "3.12", "requirement": ["numpy"] }
        }))
        .unwrap();
        assert_eq!(manifest.python.requirements, vec!["pandas>=2.2"]);
        assert_eq!(manifest.python.version.as_deref(), Some("3.12"));
        let problems = problems(&manifest);
        assert!(problems.iter().any(|problem| problem.contains("« requirement »")), "{problems:?}");
        // Sans déclaration, rien n’est écrit dans le manifeste.
        let plain = ModuleManifest { id: "a".into(), ..Default::default() };
        assert!(serde_json::to_value(&plain).unwrap().get("python").is_none());
    }

    #[test]
    fn les_specifications_pip_sont_validees() {
        for good in [
            "pandas",
            "pandas>=2.2",
            "python-dateutil==2.9.0",
            "requests[socks]>=2",
            "numpy; python_version>='3.10'",
            "zope.interface",
            "monpaquet @ https://exemple.fr/monpaquet-1.0.tar.gz",
            "a",
        ] {
            assert!(check_requirement(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "  ",
            "-e .",
            "--index-url https://x",
            "./local",
            "pandas\nnumpy",
            "pandas numpy",
            "_x",
            "x-",
            "/tmp/a.whl",
        ] {
            assert!(check_requirement(bad).is_err(), "{bad:?}");
        }
        let problems = problems(&module(&["pandas", "-r requirements.txt"], None));
        assert!(problems.iter().any(|problem| problem.starts_with("Paquet Python n° 2 invalide")), "{problems:?}");
    }

    #[test]
    fn la_version_est_python_3() {
        for good in ["3.12", "3.9", "3.12.4", " 3.13 "] {
            assert!(valid_version(good), "{good}");
        }
        for bad in ["3", "2.7", "3.x", "python3.12", ">=3.11", "3.12.4.1", ""] {
            assert!(!valid_version(bad), "{bad}");
        }
        assert!(problems(&module(&[], Some("2.7"))).iter().any(|problem| problem.contains("`python.version`")));
    }

    #[test]
    fn l_empreinte_suit_la_declaration() {
        let base = Path::new("/usr/bin/python3");
        let print = fingerprint(&module(&["pandas", "openpyxl"], None).python, Some(base));
        // L’ordre et les blancs ne comptent pas.
        assert_eq!(print, fingerprint(&module(&[" openpyxl", "pandas "], None).python, Some(base)));
        assert_ne!(print, fingerprint(&module(&["pandas"], None).python, Some(base)));
        assert_ne!(print, fingerprint(&module(&["pandas", "openpyxl"], Some("3.12")).python, Some(base)));
        // Un autre interpréteur de base refait l’environnement ; avec une version, il ne compte plus.
        assert_ne!(print, fingerprint(&module(&["pandas", "openpyxl"], None).python, Some(Path::new("/opt/python3"))));
        let pinned = module(&["pandas"], Some("3.12")).python;
        assert_eq!(fingerprint(&pinned, Some(base)), fingerprint(&pinned, None));
    }

    #[test]
    fn un_module_sans_declaration_garde_l_interpreteur_du_path() {
        let (_dir, space) = space();
        let plain = module(&[], None);
        match (interpreter(None, &space, &plain), base_interpreter()) {
            (Ok(found), Some(base)) => assert_eq!(found, base),
            (Err(error), None) => assert!(error.message.contains("Python introuvable")),
            (result, base) => panic!("{result:?} / {base:?}"),
        }
        assert!(!space.local_dir().join(ENVS_DIR).join("analyse").exists());
    }

    #[test]
    fn sans_uv_le_message_est_clair() {
        let (_dir, space) = space();
        let error = ensure(None, None, &space, &module(&["pandas"], None), false).unwrap_err();
        assert!(error.message.contains("uv"), "{}", error.message);
        let status = status_of(&space, &module(&["pandas"], None), false, None);
        assert_eq!(status.status, "uv-missing");
        // Une déclaration invalide est refusée avant même de chercher uv.
        let error = ensure(None, None, &space, &module(&["--pre pandas"], None), false).unwrap_err();
        assert!(error.message.contains("module.json"), "{}", error.message);
    }

    #[test]
    fn les_echecs_reseau_et_de_certificat_sont_traduits() {
        assert!(failure_message("error: Failed to fetch: `https://pypi.org/simple/pandas/`\n  Caused by: dns error")
            .contains("sans réseau"));
        assert!(failure_message("Caused by: invalid peer certificate: UnknownIssuer").contains("certificat"));
        assert!(failure_message("× No solution found when resolving dependencies:").contains("`python.requirements`"));
    }

    #[test]
    fn uv_recoit_les_certificats_du_systeme_et_l_index_de_pip() {
        let vars = uv_env(|name| match name {
            "PIP_INDEX_URL" => Some("https://miroir.exemple.fr/simple".to_string()),
            "HTTPS_PROXY" => Some("http://proxy:3128".to_string()),
            _ => None,
        });
        let get = |name: &str| vars.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        assert_eq!(get("UV_DEFAULT_INDEX"), Some("https://miroir.exemple.fr/simple"));
        assert_eq!(get("UV_SYSTEM_CERTS"), Some("1"));
        assert_eq!(get("HTTPS_PROXY"), Some("http://proxy:3128"));
        // Un fichier d’autorités réglé par l’utilisateur l’emporte.
        let own = uv_env(|name| (name == "SSL_CERT_FILE").then(|| "/etc/ca.pem".to_string()));
        assert!(own.iter().all(|(key, _)| key != "UV_SYSTEM_CERTS"));
    }

    /// Faux uv : `venv <dossier>` crée un `bin/python` qui renvoie au vrai Python ; chaque appel est compté.
    #[cfg(unix)]
    fn fake_uv(dir: &Path, count: &Path, python: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("uv");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"$1\" >> '{count}'\nsleep 0.3\nif [ \"$1\" = venv ]; then mkdir -p \"$2/bin\"; ln -sf '{python}' \"$2/bin/python\"; fi\nif [ \"$1\" = pip ] && [ \"$6\" = introuvable ]; then echo 'No solution found when resolving dependencies' >&2; exit 1; fi\nexit 0\n",
                count = count.display(),
                python = python.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[test]
    fn deux_appels_ensemble_n_installent_qu_une_fois_et_un_changement_refait() {
        let Some(python) = base_interpreter() else {
            return;
        };
        let (dir, space) = space();
        let count = dir.path().join("appels.txt");
        let uv = fake_uv(dir.path(), &count, &python.program);
        let module = module(&["pandas"], None);
        let handles: Vec<_> = (0..3)
            .map(|_| {
                let (space, module, uv) = (space.clone(), module.clone(), uv.clone());
                std::thread::spawn(move || ensure(None, Some(&uv), &space, &module, false).unwrap())
            })
            .collect();
        let pythons: Vec<PathBuf> = handles.into_iter().map(|handle| handle.join().unwrap()).collect();
        assert!(pythons.iter().all(|found| *found == env_python(&paths(&space, "analyse").env)));
        assert_eq!(fs::read_to_string(&count).unwrap().lines().collect::<Vec<_>>(), vec!["venv", "pip"]);
        assert_eq!(status_of(&space, &module, true, Some(&python.program)).status, "ready");
        // Le dossier est dans le dossier local de l’espace, ignoré par git.
        assert!(paths(&space, "analyse").env.starts_with(space.local_dir()));

        // Déjà prêt : rien n’est relancé.
        ensure(None, Some(&uv), &space, &module, false).unwrap();
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 2);

        // Un paquet de plus : l’environnement est refait.
        let changed = super::tests::module(&["pandas", "openpyxl"], None);
        assert_eq!(status_of(&space, &changed, true, Some(&python.program)).status, "pending");
        ensure(None, Some(&uv), &space, &changed, false).unwrap();
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 4);

        // Un échec garde le journal et le message, jusqu’à la prochaine déclaration.
        let failing = super::tests::module(&["introuvable"], None);
        let error = ensure(None, Some(&uv), &space, &failing, false).unwrap_err();
        assert!(error.message.contains("`python.requirements`"), "{}", error.message);
        let status = status_of(&space, &failing, true, Some(&python.program));
        assert_eq!(status.status, "failed");
        assert!(status.log.unwrap().contains("No solution found"));
    }

    /// Vraie installation avec uv, s’il est présent et que le réseau répond : un petit paquet pur Python.
    #[test]
    fn vraie_installation_avec_uv() {
        let Some(uv) = uv() else {
            eprintln!("uv absent : test sauté");
            return;
        };
        let (_dir, space) = space();
        let module = module(&["six==1.16.0"], None);
        let python = match ensure(None, Some(&uv), &space, &module, false) {
            Ok(python) => python,
            Err(error) if error.message.contains("sans réseau") => {
                eprintln!("hors ligne : test sauté ({})", error.message);
                return;
            }
            Err(error) => panic!("{}", error.message),
        };
        let output =
            std::process::Command::new(&python).args(["-c", "import six; print(six.__version__)"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "1.16.0");
        let found = interpreter(None, &space, &module).unwrap();
        assert_eq!(found.program, python);
    }
}
