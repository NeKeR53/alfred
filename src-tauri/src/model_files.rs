//! Modèles locaux téléchargés à la demande (recherche par le sens, décisions) : chaque fichier à une révision
//! figée, son empreinte SHA-256 vérifiée avant usage. Rien de tout cela n’est dans le dépôt ni dans l’installeur.
//!
//! Le téléchargement passe par `hf-hub` (bibliothèque de Hugging Face) : les fichiers vont dans le cache
//! Hugging Face standard, partagé avec Python (`$HF_HOME/hub`, sinon `~/.cache/huggingface/hub`).
//!
//! **Source** : le réglage d’Alfred (Réglages → Général, « Source des modèles »), sinon la variable `HF_ENDPOINT`,
//! sinon huggingface.co. Une entreprise y met l’adresse de son miroir, par exemple un dépôt distant Hugging Face
//! d’Artifactory (`https://…/artifactory/api/huggingfaceml/<dépôt>`).
//!
//! **Jeton** : celui du réglage d’Alfred (dans le trousseau, et seulement avec l’adresse de ce réglage), sinon
//! `HF_TOKEN`, sinon le fichier de `huggingface-cli login` (`$HF_HOME/token`), que `hf-hub` lit lui-même. Le
//! jeton n’apparaît jamais dans un journal ni un message d’erreur.
//!
//! **Ancien emplacement** : un modèle déjà complet dans `<données d’Alfred>/models/<modèle>` (téléchargé avant
//! `hf-hub`) y reste et y est lu tel quel ; rien n’est téléchargé à nouveau ni déplacé.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use hf_hub::api::tokio::{ApiBuilder, ApiError, Progress};
use hf_hub::{Cache, Repo, RepoType};
use serde_json::{json, Value};

use crate::error::{opt_arg, AppError, AppResult};
use crate::state::AppState;

/// Un modèle : le dépôt Hugging Face, sa révision figée, et chaque fichier avec son empreinte.
pub struct ModelSpec {
    pub repo: &'static str,
    pub revision: &'static str,
    /// Dossier de l’ancien emplacement, sous `<données d’Alfred>/models`.
    pub legacy_dir: &'static str,
    /// Chemin dans le dépôt (et sous le dossier du modèle), empreinte SHA-256.
    pub files: &'static [(&'static str, &'static str)],
}

impl ModelSpec {
    /// Tous les fichiers sont là (leur empreinte n’est pas relue ici : c’est au chargement).
    pub fn installed(&self, dir: &Path) -> bool {
        self.files.iter().all(|(file, _)| dir.join(file).is_file())
    }

    fn hf_repo(&self) -> Repo {
        Repo::with_revision(self.repo.to_string(), RepoType::Model, self.revision.to_string())
    }

    /// Dossier du modèle dans un cache Hugging Face : `models--<org>--<nom>/snapshots/<révision>`.
    pub fn snapshot_dir(&self, hub_cache: &Path) -> PathBuf {
        hub_cache.join(self.hf_repo().folder_name()).join("snapshots").join(self.revision)
    }

    /// Où lire le modèle : l’ancien dossier s’il y est complet, sinon le cache Hugging Face.
    pub fn dir(&self, data_dir: &Path) -> PathBuf {
        let legacy = data_dir.join("models").join(self.legacy_dir);
        if self.installed(&legacy) {
            legacy
        } else {
            self.snapshot_dir(&hub_cache())
        }
    }
}

/// Cache Hugging Face, comme `hf-hub` le calcule : `$HF_HOME/hub`, sinon `~/.cache/huggingface/hub`.
pub fn hub_cache() -> PathBuf {
    Cache::from_env().path().clone()
}

pub fn sha256_file(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

// ---------------------------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------------------------

pub const DEFAULT_ENDPOINT: &str = "https://huggingface.co";
/// Réglage d’Alfred : l’adresse saisie, absente pour Hugging Face.
const SETTING: &str = "models.endpoint";
/// Entrée du trousseau qui garde le jeton du réglage (`{"token": …}`).
const TOKEN_SECRET: &str = "models-source-token";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Setting,
    Env,
    Default,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::Setting => "setting",
            Origin::Env => "env",
            Origin::Default => "default",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub endpoint: String,
    pub origin: Origin,
}

/// Une adresse de source valide, sans `/` final : http ou https, sans identifiants dans l’adresse (le jeton a
/// son propre champ, pour ne jamais finir dans un message).
pub fn normalize_endpoint(text: &str) -> Result<String, String> {
    let text = text.trim().trim_end_matches('/');
    let parsed = url::Url::parse(text).map_err(|_| format!("« {text} » n’est pas une adresse web (https://…)."))?;
    if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
        return Err(format!("« {text} » n’est pas une adresse web (https://…)."));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("L’adresse ne doit pas contenir d’identifiant ni de mot de passe : mettez le jeton dans son champ.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("L’adresse ne doit contenir ni « ? » ni « # ».".into());
    }
    Ok(text.to_string())
}

/// Le réglage d’Alfred, puis `HF_ENDPOINT`, puis huggingface.co. Une valeur vide ou invalide est ignorée.
pub fn resolve_source(setting: Option<&str>, env: Option<&str>) -> Source {
    if let Some(endpoint) = setting.and_then(|value| normalize_endpoint(value).ok()) {
        return Source { endpoint, origin: Origin::Setting };
    }
    if let Some(endpoint) = env.filter(|value| !value.trim().is_empty()).and_then(|value| normalize_endpoint(value).ok()) {
        return Source { endpoint, origin: Origin::Env };
    }
    Source { endpoint: DEFAULT_ENDPOINT.to_string(), origin: Origin::Default }
}

/// Jeton à passer explicitement à `hf-hub` : celui du réglage (seulement avec l’adresse du réglage, pour ne pas
/// l’envoyer ailleurs), sinon `HF_TOKEN`. `None` : `hf-hub` se rabat sur le fichier de `huggingface-cli login`.
pub fn resolve_token(source: &Source, setting_token: Option<String>, env_token: Option<String>) -> Option<String> {
    let clean = |token: Option<String>| token.map(|token| token.trim().to_string()).filter(|token| !token.is_empty());
    clean(setting_token).filter(|_| source.origin == Origin::Setting).or_else(|| clean(env_token))
}

/// Adresse d’un fichier, comme `hf-hub` la demande (vérifiée par les tests).
#[cfg(test)]
fn file_url(endpoint: &str, repo: &str, revision: &str, file: &str) -> String {
    format!("{endpoint}/{repo}/resolve/{revision}/{file}")
}

/// Nom court d’une source, pour les messages : l’hôte (et le port), jamais d’identifiant.
pub fn host(endpoint: &str) -> String {
    url::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(|host| match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        }))
        .unwrap_or_else(|| "la source des modèles".to_string())
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn setting(state: &AppState) -> AppResult<Option<String>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    Ok(crate::app_db::get_setting(&db, SETTING)?.and_then(|value| value.as_str().map(str::to_string)))
}

pub fn source(state: &AppState) -> AppResult<Source> {
    Ok(resolve_source(setting(state)?.as_deref(), env("HF_ENDPOINT").as_deref()))
}

async fn setting_token() -> AppResult<Option<String>> {
    let secret = crate::vault::read_secret_async(TOKEN_SECRET).await?;
    Ok(crate::vault::field(secret.as_ref(), "token").map(str::to_string))
}

/// État de la source, pour Réglages : jamais la valeur d’un jeton, seulement sa présence.
async fn source_status(state: &AppState) -> AppResult<Value> {
    let source = source(state)?;
    let has_token = setting_token().await?.is_some();
    let login_file = Cache::from_env().token_path().is_file();
    Ok(json!({
        "endpoint": source.endpoint,
        "host": host(&source.endpoint),
        "origin": source.origin.as_str(),
        "custom": setting(state)?,
        "hasToken": has_token,
        "envEndpoint": env("HF_ENDPOINT").is_some(),
        "envToken": env("HF_TOKEN").is_some(),
        "loginToken": login_file,
        "cacheDir": hub_cache().to_string_lossy(),
    }))
}

/// Enregistre le réglage. `endpoint` nul ou vide : Hugging Face (ou `HF_ENDPOINT`). `token` absent : inchangé ;
/// nul ou vide : effacé. Revenir à Hugging Face efface aussi le jeton, qui allait avec l’adresse.
async fn set_source(state: &AppState, args: &Value) -> AppResult<Value> {
    let endpoint: Option<String> = opt_arg(args, "endpoint")?;
    let endpoint = match endpoint.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => Some(normalize_endpoint(text).map_err(AppError::new)?),
        None => None,
    };
    {
        let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
        crate::app_db::set_setting(&db, SETTING, &endpoint.clone().map(Value::String).unwrap_or(Value::Null))?;
    }
    let token = args.get("token");
    let clear = endpoint.is_none() || token.is_some_and(|token| token.as_str().is_none_or(|text| text.trim().is_empty()));
    if clear {
        crate::vault::blocking(|| crate::vault::delete_secret(TOKEN_SECRET)).await?;
    } else if let Some(text) = token.and_then(Value::as_str) {
        crate::vault::write_secret_async(TOKEN_SECRET, json!({ "token": text.trim() })).await?;
    }
    source_status(state).await
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "models.source" => Some(source_status(state).await),
        "models.setSource" => Some(set_source(state, args).await),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------------------------------------

/// Progression de l’ensemble : `report(reçu, total)`, avec le total annoncé tant que les tailles ne sont pas connues.
#[derive(Clone)]
struct Tracker {
    received: Arc<AtomicU64>,
    file_size: Arc<AtomicU64>,
    before: u64,
    hint: u64,
    report: Arc<dyn Fn(u64, u64) + Send + Sync>,
}

impl Progress for Tracker {
    async fn init(&mut self, size: usize, _filename: &str) {
        self.file_size.store(size as u64, Ordering::Relaxed);
    }

    async fn update(&mut self, size: usize) {
        let received = self.received.fetch_add(size as u64, Ordering::Relaxed) + size as u64;
        let total = (self.before + self.file_size.load(Ordering::Relaxed)).max(self.hint);
        (self.report)(self.before + received, total);
    }

    async fn finish(&mut self) {}
}

/// Une erreur de `hf-hub` en français, sans jeton ni adresse complète.
pub fn explain(error: &ApiError, file: &str, source: &Source) -> String {
    let host = host(&source.endpoint);
    match error {
        ApiError::TooManyRetries(inner) => explain(inner, file, source),
        ApiError::RequestError(failure) => {
            if let Some(status) = failure.status() {
                return match status.as_u16() {
                    401 | 403 => format!("{host} refuse l’accès ({status}) : jeton manquant ou refusé. Renseignez le jeton dans Réglages → Général, Source des modèles."),
                    404 => format!("{file} ou sa révision est absent de {host} (404). Vérifiez l’adresse de la source et que le miroir donne accès à ce modèle."),
                    _ => format!("{host} a répondu {status} pour {file}."),
                };
            }
            if certificate_refused(failure) {
                return format!("le certificat de {host} est refusé : il n’est pas reconnu par le système de cet ordinateur. Installez le certificat de l’entreprise dans le trousseau (Mac) ou le magasin de certificats (Windows).");
            }
            if failure.is_timeout() {
                return format!("{host} ne répond pas (délai dépassé).");
            }
            format!("{host} est injoignable. Vérifiez l’adresse de la source et la connexion au réseau.")
        }
        ApiError::MissingHeader(header) => format!(
            "{host} ne répond pas comme un dépôt Hugging Face (en-tête « {header} » absent) : vérifiez l’adresse de la source."
        ),
        ApiError::InvalidHeader(header) => format!("{host} a envoyé un en-tête « {header} » illisible."),
        ApiError::InvalidHeaderValue(_) => "le jeton contient des caractères interdits.".to_string(),
        ApiError::IoError(failure) => format!("écriture impossible dans le cache des modèles ({failure})."),
        ApiError::LockAcquisition(_) => format!("{file} est déjà en cours de téléchargement par un autre programme."),
        _ => format!("le téléchargement de {file} depuis {host} a échoué."),
    }
}

fn certificate_refused(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(failure) = current {
        let text = failure.to_string().to_lowercase();
        if text.contains("certificate") || text.contains("unknownissuer") || text.contains("certificat") {
            return true;
        }
        current = failure.source();
    }
    false
}

/// Retire un fichier du cache : le lien du dossier du modèle et le contenu qu’il désigne.
fn discard(path: &Path) {
    if let Ok(blob) = std::fs::canonicalize(path) {
        if blob != path {
            let _ = std::fs::remove_file(blob);
        }
    }
    let _ = std::fs::remove_file(path);
}

async fn digest(path: &Path) -> AppResult<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || sha256_file(&path)).await.map_err(|_| AppError::new("Le calcul d’empreinte a échoué."))?
}

/// Télécharge les fichiers manquants ou abîmés, l’un après l’autre, vers le cache Hugging Face. Un modèle complet
/// dans l’ancien dossier n’est pas téléchargé. `progress(reçu, total)` suit l’ensemble ; `total_hint` est la
/// taille annoncée, tant que les tailles réelles ne sont pas connues.
pub async fn fetch(
    spec: &ModelSpec,
    state: &AppState,
    total_hint: u64,
    error: impl Fn(String) -> AppError,
    progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> AppResult<()> {
    if spec.dir(&state.data_dir) != spec.snapshot_dir(&hub_cache()) {
        return Ok(());
    }
    let source = source(state)?;
    let token = resolve_token(&source, setting_token().await?, env("HF_TOKEN"));
    download(spec, &source, token, &hub_cache(), total_hint, &error, Arc::new(progress)).await
}

/// Le téléchargement lui-même, vers le cache `cache` : `token` est passé à `hf-hub` s’il y en a un, sinon
/// `hf-hub` lit le fichier de `huggingface-cli login`.
async fn download(
    spec: &ModelSpec,
    source: &Source,
    token: Option<String>,
    cache: &Path,
    total_hint: u64,
    error: &impl Fn(String) -> AppError,
    report: Arc<dyn Fn(u64, u64) + Send + Sync>,
) -> AppResult<()> {
    let mut builder = ApiBuilder::from_env()
        .with_cache_dir(cache.to_path_buf())
        .with_endpoint(source.endpoint.clone())
        .with_progress(false)
        .with_user_agent("alfred", env!("CARGO_PKG_VERSION"));
    if token.is_some() {
        builder = builder.with_token(token);
    }
    let api = builder.build().map_err(|failure| error(explain(&failure, spec.repo, source)))?;
    let repo = api.repo(spec.hf_repo());
    let dir = spec.snapshot_dir(cache);
    let mut before = 0u64;
    for (file, expected) in spec.files {
        let target = dir.join(file);
        if target.is_file() {
            if digest(&target).await? == *expected {
                continue;
            }
            discard(&target);
        }
        let tracker = Tracker {
            received: Arc::new(AtomicU64::new(0)),
            file_size: Arc::new(AtomicU64::new(0)),
            before,
            hint: total_hint,
            report: report.clone(),
        };
        let path = repo
            .download_with_progress(file, tracker.clone())
            .await
            .map_err(|failure| error(explain(&failure, file, source)))?;
        if path != target {
            discard(&path);
            return Err(error(format!(
                "{} a servi {file} pour une autre révision que celle attendue ({}) : fichier écarté.",
                host(&source.endpoint),
                spec.revision
            )));
        }
        if digest(&path).await? != *expected {
            discard(&path);
            return Err(error(format!(
                "{file} reçu de {} n’a pas l’empreinte attendue : fichier écarté. Le miroir sert peut-être une autre version du modèle.",
                host(&source.endpoint)
            )));
        }
        before += tracker.file_size.load(Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(endpoint: &str, origin: Origin) -> Source {
        Source { endpoint: endpoint.to_string(), origin }
    }

    #[test]
    fn setting_wins_over_env_and_default() {
        let artifactory = "https://jfrog.exemple.fr/artifactory/api/huggingfaceml/hf-remote";
        assert_eq!(resolve_source(Some(artifactory), Some("https://env.exemple.fr")), source(artifactory, Origin::Setting));
        assert_eq!(resolve_source(None, Some("https://env.exemple.fr/")), source("https://env.exemple.fr", Origin::Env));
        assert_eq!(resolve_source(Some("  "), Some("https://env.exemple.fr")), source("https://env.exemple.fr", Origin::Env));
        assert_eq!(resolve_source(None, None), source(DEFAULT_ENDPOINT, Origin::Default));
        assert_eq!(resolve_source(None, Some("")), source(DEFAULT_ENDPOINT, Origin::Default));
        // Une valeur invalide est ignorée plutôt que de casser le téléchargement.
        assert_eq!(resolve_source(Some("pas une adresse"), None), source(DEFAULT_ENDPOINT, Origin::Default));
    }

    #[test]
    fn endpoints_are_checked() {
        assert_eq!(normalize_endpoint(" https://hf.exemple.fr/api/ ").unwrap(), "https://hf.exemple.fr/api");
        assert!(normalize_endpoint("ftp://hf.exemple.fr").is_err());
        assert!(normalize_endpoint("hf.exemple.fr").is_err());
        assert!(normalize_endpoint("https://moi:secret@hf.exemple.fr").is_err());
        assert!(normalize_endpoint("https://hf.exemple.fr/?token=x").is_err());
    }

    #[test]
    fn urls_follow_the_hub_layout() {
        let base = "https://jfrog.exemple.fr/artifactory/api/huggingfaceml/hf-remote";
        assert_eq!(
            file_url(base, "intfloat/multilingual-e5-small", "614241f", "config.json"),
            "https://jfrog.exemple.fr/artifactory/api/huggingfaceml/hf-remote/intfloat/multilingual-e5-small/resolve/614241f/config.json"
        );
        let spec = ModelSpec { repo: "intfloat/multilingual-e5-small", revision: "614241f", legacy_dir: "e5", files: &[] };
        let api = ApiBuilder::new().with_endpoint(base.to_string()).with_progress(false).build().unwrap();
        assert_eq!(api.repo(spec.hf_repo()).url("config.json"), file_url(base, spec.repo, spec.revision, "config.json"));
        assert_eq!(
            spec.snapshot_dir(Path::new("/cache")),
            Path::new("/cache/models--intfloat--multilingual-e5-small/snapshots/614241f")
        );
        assert_eq!(host(base), "jfrog.exemple.fr");
        assert_eq!(host("http://127.0.0.1:8080/hf"), "127.0.0.1:8080");
    }

    #[test]
    fn token_comes_from_the_setting_then_hf_token() {
        let setting = source("https://jfrog.exemple.fr", Origin::Setting);
        let env = source("https://env.exemple.fr", Origin::Env);
        let default = source(DEFAULT_ENDPOINT, Origin::Default);
        assert_eq!(resolve_token(&setting, Some("alfred".into()), Some("env".into())).as_deref(), Some("alfred"));
        assert_eq!(resolve_token(&setting, Some(" ".into()), Some("env".into())).as_deref(), Some("env"));
        // Le jeton du réglage va avec l’adresse du réglage : jamais envoyé à une autre source.
        assert_eq!(resolve_token(&env, Some("alfred".into()), None), None);
        assert_eq!(resolve_token(&default, Some("alfred".into()), Some(" env ".into())).as_deref(), Some("env"));
        // Ni réglage ni HF_TOKEN : hf-hub lit le fichier de `huggingface-cli login`.
        assert_eq!(resolve_token(&default, None, None), None);
    }

    #[test]
    fn local_spec_dir_prefers_a_complete_legacy_copy() {
        let data = tempfile::tempdir().unwrap();
        let spec = ModelSpec { repo: "org/modele", revision: "abc", legacy_dir: "modele", files: &[("a.json", "x")] };
        assert_ne!(spec.dir(data.path()), data.path().join("models/modele"));
        std::fs::create_dir_all(data.path().join("models/modele")).unwrap();
        std::fs::write(data.path().join("models/modele/a.json"), "{}").unwrap();
        assert_eq!(spec.dir(data.path()), data.path().join("models/modele"));
    }

    // -----------------------------------------------------------------------------------------------------------
    // Faux miroir : répond comme huggingface.co ou Artifactory (`resolve`, en-têtes `ETag` et `X-Repo-Commit`,
    // requêtes par plages).
    // -----------------------------------------------------------------------------------------------------------

    const CONTENT: &[u8] = b"{\"hidden_size\": 384}";
    const REVISION: &str = "614241f622f53c4eeff9890bdc4f31cfecc418b3";

    fn content_sha() -> &'static str {
        use sha2::{Digest, Sha256};
        static SHA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        SHA.get_or_init(|| Sha256::digest(CONTENT).iter().map(|byte| format!("{byte:02x}")).collect())
    }

    #[derive(Clone)]
    struct Mirror {
        /// Jeton exigé (401 sans, 403 si faux).
        token: Option<&'static str>,
        /// Contenu servi (un autre que `CONTENT` pour éprouver l’empreinte).
        body: &'static [u8],
        seen: Arc<std::sync::Mutex<Vec<String>>>,
    }

    async fn mirror(
        axum::extract::State(mirror): axum::extract::State<Mirror>,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
    ) -> axum::response::Response {
        use axum::http::{header, StatusCode};
        use axum::response::IntoResponse;
        let auth = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).map(str::to_string);
        mirror.seen.lock().unwrap().push(format!("{} {}", uri.path(), auth.as_deref().unwrap_or("-")));
        if let Some(expected) = mirror.token {
            match auth {
                None => return StatusCode::UNAUTHORIZED.into_response(),
                Some(value) if value != format!("Bearer {expected}") => return StatusCode::FORBIDDEN.into_response(),
                _ => {}
            }
        }
        if uri.path() != format!("/mirror/org/modele/resolve/{REVISION}/config.json") {
            return StatusCode::NOT_FOUND.into_response();
        }
        let body = mirror.body;
        let range = headers.get(header::RANGE).and_then(|value| value.to_str().ok()).unwrap_or("bytes=0-");
        let (start, stop) = range.trim_start_matches("bytes=").split_once('-').unwrap();
        let start: usize = start.parse().unwrap();
        let stop: usize = stop.parse::<usize>().unwrap_or(body.len() - 1).min(body.len() - 1);
        (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::ETAG, format!("\"{}\"", content_sha())),
                (header::HeaderName::from_static("x-repo-commit"), REVISION.to_string()),
                (header::CONTENT_RANGE, format!("bytes {start}-{stop}/{}", body.len())),
            ],
            body[start..=stop].to_vec(),
        )
            .into_response()
    }

    async fn serve(mirror_state: Mirror) -> String {
        let app = axum::Router::new().route("/{*path}", axum::routing::get(mirror)).with_state(mirror_state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/mirror")
    }

    const SPEC: ModelSpec = ModelSpec {
        repo: "org/modele",
        revision: REVISION,
        legacy_dir: "modele",
        files: &[("config.json", "")],
    };

    fn spec() -> ModelSpec {
        // L’empreinte est calculée : la constante n’en garde que la forme.
        let files: &'static [(&'static str, &'static str)] = Box::leak(Box::new([("config.json", content_sha())]));
        ModelSpec { files, ..SPEC }
    }

    async fn run(endpoint: &str, token: Option<&str>, cache: &Path) -> AppResult<Vec<(u64, u64)>> {
        let source = resolve_source(Some(endpoint), None);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        download(&spec(), &source, token.map(str::to_string), cache, 0, &AppError::new, Arc::new(move |received, total| {
            log.lock().unwrap().push((received, total));
        }))
        .await?;
        let progress = seen.lock().unwrap().clone();
        Ok(progress)
    }

    fn mirror_with(token: Option<&'static str>, body: &'static [u8]) -> Mirror {
        Mirror { token, body, seen: Arc::new(std::sync::Mutex::new(Vec::new())) }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn downloads_from_a_mirror_into_the_hub_cache() {
        let state = mirror_with(Some("jeton-secret"), CONTENT);
        let endpoint = serve(state.clone()).await;
        let cache = tempfile::tempdir().unwrap();
        let progress = run(&endpoint, Some("jeton-secret"), cache.path()).await.unwrap();
        let file = spec().snapshot_dir(cache.path()).join("config.json");
        assert_eq!(std::fs::read(&file).unwrap(), CONTENT);
        assert_eq!(progress.last(), Some(&(CONTENT.len() as u64, CONTENT.len() as u64)));
        assert!(state.seen.lock().unwrap().iter().all(|line| line.ends_with("Bearer jeton-secret")));
        // Déjà là et intact : rien n’est redemandé.
        let before = state.seen.lock().unwrap().len();
        run(&endpoint, Some("jeton-secret"), cache.path()).await.unwrap();
        assert_eq!(state.seen.lock().unwrap().len(), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mirror_errors_are_readable_and_never_show_the_token() {
        let endpoint = serve(mirror_with(Some("jeton-secret"), CONTENT)).await;
        let cache = tempfile::tempdir().unwrap();
        let missing = run(&endpoint, None, cache.path()).await.unwrap_err().message;
        assert!(missing.contains("jeton manquant ou refusé") && missing.contains("401"), "{missing}");
        let refused = run(&endpoint, Some("mauvais-jeton"), cache.path()).await.unwrap_err().message;
        assert!(refused.contains("jeton manquant ou refusé") && refused.contains("403"), "{refused}");
        assert!(!refused.contains("mauvais-jeton"));

        let open = serve(mirror_with(None, CONTENT)).await;
        let absent = run(&format!("{open}/ailleurs"), None, cache.path()).await.unwrap_err().message;
        assert!(absent.contains("absent de 127.0.0.1") && absent.contains("404"), "{absent}");

        let unreachable = run("http://127.0.0.1:9/hf", None, cache.path()).await.unwrap_err().message;
        assert!(unreachable.contains("127.0.0.1:9 est injoignable"), "{unreachable}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_file_with_the_wrong_digest_is_discarded() {
        let endpoint = serve(mirror_with(None, b"{\"hidden_size\": 999}")).await;
        let cache = tempfile::tempdir().unwrap();
        let message = run(&endpoint, None, cache.path()).await.unwrap_err().message;
        assert!(message.contains("n’a pas l’empreinte attendue"), "{message}");
        let file = spec().snapshot_dir(cache.path()).join("config.json");
        assert!(!file.exists());
        let blobs = cache.path().join("models--org--modele/blobs");
        assert!(std::fs::read_dir(blobs).unwrap().flatten().all(|entry| entry.path().extension().is_some()));
    }

    /// Certificat signé par une autorité inconnue du système (réseau) : `cargo test -- --ignored certificate`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_refused_certificate_is_named() {
        let message = run("https://self-signed.badssl.com", None, tempfile::tempdir().unwrap().path()).await.unwrap_err().message;
        assert!(message.contains("le certificat de self-signed.badssl.com est refusé"), "{message}");
    }

    /// Vrai téléchargement d’e5 depuis huggingface.co (470 Mo) : `cargo test -- --ignored real_e5`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_e5_download_from_hugging_face() {
        let cache = tempfile::tempdir().unwrap();
        let source = resolve_source(None, None);
        let spec = ModelSpec {
            repo: "intfloat/multilingual-e5-small",
            revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
            legacy_dir: "multilingual-e5-small",
            files: &[
                ("config.json", "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959"),
                ("tokenizer.json", "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
                ("model.safetensors", "1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477"),
            ],
        };
        let last = Arc::new(AtomicU64::new(0));
        let seen = last.clone();
        download(&spec, &source, None, cache.path(), 470 * 1024 * 1024, &AppError::new, Arc::new(move |received, _| {
            seen.store(received, Ordering::Relaxed);
        }))
        .await
        .unwrap();
        assert!(spec.installed(&spec.snapshot_dir(cache.path())));
        eprintln!("reçu {} octets dans {}", last.load(Ordering::Relaxed), cache.path().display());
    }
}
