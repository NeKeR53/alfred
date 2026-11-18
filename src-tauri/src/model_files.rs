//! Modèles locaux téléchargés à la demande (recherche par le sens, décisions). Rien de tout cela n’est dans le
//! dépôt ni dans l’installeur.
//!
//! **Révision** : Alfred prend la dernière, celle que la source annonce pour `main` (huggingface.co, ou
//! l’identifiant que renvoie un miroir Artifactory). Elle est notée dans le cache (`refs/main`, comme Python) et
//! affichée dans Réglages. Une mise à jour ne se fait jamais toute seule : seulement quand l’utilisateur clique
//! « Télécharger » ou « Réessayer ».
//!
//! **Intégrité** : chaque gros fichier (LFS) est vérifié avec l’empreinte SHA-256 que la source annonce elle-même
//! (`lfs.sha256` dans la liste des fichiers, sinon l’en-tête `X-Linked-Etag`) ; un fichier sans empreinte
//! annoncée est accepté sur sa taille. Cela couvre les téléchargements abîmés ou tronqués.
//!
//! Le téléchargement suit `snapshot_download` (le déroulé que demande Artifactory) : la liste des fichiers, puis
//! chaque fichier par un simple GET. Les fichiers vont dans le cache Hugging Face standard, au format de Python et
//! partagé avec lui (`$HF_HOME/hub`, sinon `~/.cache/huggingface/hub`, calculé par `hf-hub`).
//!
//! **Source** : le réglage d’Alfred (Réglages → Général, « Source des modèles »), sinon la variable `HF_ENDPOINT`,
//! sinon huggingface.co. Une entreprise y met l’adresse de son miroir, par exemple un dépôt distant Hugging Face
//! d’Artifactory (`https://…/artifactory/api/huggingfaceml/<dépôt>`).
//!
//! **Jeton** : celui du réglage d’Alfred (dans le trousseau, et seulement avec l’adresse de ce réglage), sinon
//! `HF_TOKEN`, sinon le fichier de `huggingface-cli login` (`$HF_HOME/token`). Il ne part qu’à l’hôte de la
//! source, jamais vers une redirection ailleurs, et n’apparaît jamais dans un journal ni un message d’erreur.
//!
//! **Copies plus anciennes** : un modèle complet dans `<données d’Alfred>/models/<modèle>`, ou dans le cache à la
//! révision que figeaient les versions précédentes d’Alfred, reste reconnu tel quel ; rien n’est retéléchargé.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use hf_hub::{Cache, Repo};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{opt_arg, AppError, AppResult};
use crate::state::AppState;

/// Un modèle : son dépôt Hugging Face et les fichiers dont Alfred a besoin.
pub struct ModelSpec {
    pub repo: &'static str,
    /// Dossier de l’ancien emplacement, sous `<données d’Alfred>/models`.
    pub legacy_dir: &'static str,
    /// Révision que figeaient les versions précédentes d’Alfred : celle d’une copie de l’ancien dossier, ou d’une
    /// copie du cache sans `refs/main`.
    pub legacy_revision: &'static str,
    /// Chemins dans le dépôt (et sous le dossier du modèle).
    pub files: &'static [&'static str],
}

/// Un modèle installé : où le lire, et à quelle révision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
    pub dir: PathBuf,
    pub revision: String,
}

impl ModelSpec {
    fn complete(&self, dir: &Path) -> bool {
        self.files.iter().all(|file| dir.join(file).is_file())
    }

    /// `models--<org>--<nom>` dans un cache Hugging Face.
    fn model_cache(&self, hub_cache: &Path) -> PathBuf {
        hub_cache.join(Repo::model(self.repo.to_string()).folder_name())
    }

    /// Dossier d’une révision dans un cache Hugging Face : `models--<org>--<nom>/snapshots/<révision>`.
    pub fn snapshot_dir(&self, hub_cache: &Path, revision: &str) -> PathBuf {
        self.model_cache(hub_cache).join("snapshots").join(revision)
    }

    /// Le modèle installé, s’il est complet, dans cet ordre : la révision notée dans le cache (`refs/main`), la
    /// copie du cache à l’ancienne révision figée, puis l’ancien dossier d’Alfred.
    pub fn installed_in(&self, data_dir: &Path, hub_cache: &Path) -> Option<Installed> {
        let noted = std::fs::read_to_string(self.model_cache(hub_cache).join("refs/main")).ok();
        let candidates = noted
            .map(|text| text.trim().to_string())
            .filter(|revision| valid_revision(revision))
            .into_iter()
            .chain([self.legacy_revision.to_string()])
            .map(|revision| (self.snapshot_dir(hub_cache, &revision), revision))
            .chain([(data_dir.join("models").join(self.legacy_dir), self.legacy_revision.to_string())]);
        for (dir, revision) in candidates {
            if self.complete(&dir) {
                return Some(Installed { dir, revision });
            }
        }
        None
    }

    pub fn installed(&self, data_dir: &Path) -> Option<Installed> {
        self.installed_in(data_dir, &hub_cache())
    }
}

/// Une révision utilisable comme nom de dossier : lettres, chiffres, `-`, `_`, `.`, sans `..`.
fn valid_revision(revision: &str) -> bool {
    !revision.is_empty()
        && revision.len() <= 128
        && !revision.contains("..")
        && revision.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Révision courte, pour l’affichage.
pub fn short_revision(revision: &str) -> String {
    revision.chars().take(7).collect()
}

/// Un modèle installé qu’Alfred ne sait pas charger (configuration, noms ou formes de tenseurs) : une version plus
/// récente au format changé. `detail` dit ce qui manque.
pub fn unsupported(spec: &ModelSpec, installed: &Installed, detail: &str) -> String {
    format!(
        "la version {} du modèle {} n’est pas prise en charge par cette version d’Alfred ({detail}). Une mise à jour d’Alfred est nécessaire.",
        short_revision(&installed.revision),
        spec.repo
    )
}

/// Cache Hugging Face, comme `hf-hub` le calcule : `$HF_HOME/hub`, sinon `~/.cache/huggingface/hub`.
pub fn hub_cache() -> PathBuf {
    Cache::from_env().path().clone()
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

/// Jeton envoyé à la source : celui du réglage (seulement avec l’adresse du réglage, pour ne pas l’envoyer
/// ailleurs), sinon `HF_TOKEN`. `None` : le fichier de `huggingface-cli login`, s’il existe.
pub fn resolve_token(source: &Source, setting_token: Option<String>, env_token: Option<String>) -> Option<String> {
    let clean = |token: Option<String>| token.map(|token| token.trim().to_string()).filter(|token| !token.is_empty());
    clean(setting_token).filter(|_| source.origin == Origin::Setting).or_else(|| clean(env_token))
}

/// Adresse d’un fichier, comme la bibliothèque de Hugging Face la demande.
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

/// Un refus du serveur, en français.
fn status_failure(status: reqwest::StatusCode, what: &str, host: &str) -> String {
    match status.as_u16() {
        401 | 403 => format!("{host} refuse l’accès ({status}) : jeton manquant ou refusé. Renseignez le jeton dans Réglages → Général, Source des modèles."),
        404 => format!("{what} est absent de {host} (404). Vérifiez l’adresse de la source et que le miroir donne accès à ce modèle."),
        _ => format!("{host} a répondu {status} pour {what}."),
    }
}

/// Une requête qui n’a pas abouti, en français, sans adresse complète.
fn request_failure(failure: &reqwest::Error, what: &str, host: &str) -> String {
    if let Some(status) = failure.status() {
        return status_failure(status, what, host);
    }
    if certificate_refused(failure) {
        return format!("le certificat de {host} est refusé : il n’est pas reconnu par le système de cet ordinateur. Installez le certificat de l’entreprise dans le trousseau (Mac) ou le magasin de certificats (Windows).");
    }
    if failure.is_timeout() {
        return format!("{host} ne répond pas (délai dépassé).");
    }
    if failure.is_decode() || failure.is_body() {
        return format!("{host} a interrompu ou mal formé sa réponse pour {what}.");
    }
    format!("{host} est injoignable. Vérifiez l’adresse de la source et la connexion au réseau.")
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

/// La liste des fichiers d’un modèle (`/api/models/<dépôt>/revision/main`), réduite à ce qu’Alfred lit.
#[derive(Deserialize)]
struct Listing {
    sha: String,
    #[serde(default)]
    siblings: Vec<Sibling>,
}

#[derive(Deserialize)]
struct Sibling {
    rfilename: String,
    size: Option<u64>,
    lfs: Option<Lfs>,
}

#[derive(Deserialize)]
struct Lfs {
    sha256: Option<String>,
    size: Option<u64>,
}

/// Ce que la source annonce d’un fichier : son empreinte SHA-256 (fichiers LFS) et sa taille.
#[derive(Clone, Default)]
struct Announced {
    sha256: Option<String>,
    size: Option<u64>,
}

fn sha256_like(text: &str) -> Option<String> {
    let text = text.trim().trim_start_matches("W/").trim_matches('"').to_ascii_lowercase();
    (text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit())).then_some(text)
}

/// Télécharge la dernière révision du modèle vers le cache Hugging Face et la note comme installée. Renvoie la
/// révision. `progress(reçu, total)` suit l’ensemble ; `total_hint` sert tant que les tailles ne sont pas connues.
pub async fn fetch(
    spec: &ModelSpec,
    state: &AppState,
    total_hint: u64,
    error: impl Fn(String) -> AppError,
    progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> AppResult<String> {
    let source = source(state)?;
    // Ni réglage ni HF_TOKEN : le fichier de `huggingface-cli login` (`$HF_HOME/token`).
    let token = resolve_token(&source, setting_token().await?, env("HF_TOKEN")).or_else(|| Cache::from_env().token());
    download(spec, &source, token, &hub_cache(), total_hint, &error, Arc::new(progress)).await
}

/// Le client HTTP d’un téléchargement : le jeton ne part qu’à l’hôte de la source.
struct Client<'a> {
    http: reqwest::Client,
    token: Option<String>,
    source: &'a Source,
    host: String,
}

/// Réponse finale d’un fichier, et ce que la source en annonçait avant toute redirection.
struct Fetched {
    response: reqwest::Response,
    linked_etag: Option<String>,
    linked_size: Option<u64>,
    etag: Option<String>,
}

impl Client<'_> {
    fn new(source: &Source, token: Option<String>) -> Result<Client<'_>, String> {
        let host = host(&source.endpoint);
        // Les redirections sont suivies à la main : les en-têtes `X-Linked-*` sont sur la première réponse, et le
        // jeton ne doit pas suivre vers un autre hôte.
        let http = reqwest::Client::builder()
            .user_agent(format!("alfred/{}; hf-hub/0.5.0", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|failure| request_failure(&failure, "le modèle", &host))?;
        Ok(Client { http, token, source, host })
    }

    async fn get(&self, url: &url::Url, what: &str) -> Result<reqwest::Response, String> {
        let mut request = self.http.get(url.clone());
        let same_host = url::Url::parse(&self.source.endpoint).is_ok_and(|base| base.host_str() == url.host_str() && base.port_or_known_default() == url.port_or_known_default());
        if let Some(token) = self.token.as_deref().filter(|_| same_host) {
            let value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| "le jeton contient des caractères interdits.".to_string())?;
            request = request.header(reqwest::header::AUTHORIZATION, value);
        }
        request.send().await.map_err(|failure| request_failure(&failure, what, &self.host))
    }

    /// GET en suivant au plus 10 redirections. `Ok(Err(statut))` : la source refuse.
    async fn follow(&self, address: &str, what: &str) -> Result<Result<Fetched, reqwest::StatusCode>, String> {
        let mut url = url::Url::parse(address).map_err(|_| format!("adresse illisible pour {what}."))?;
        let (mut linked_etag, mut linked_size, mut etag) = (None, None, None);
        for _ in 0..10 {
            let response = self.get(&url, what).await?;
            let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
            linked_etag = linked_etag.or_else(|| header("x-linked-etag"));
            linked_size = linked_size.or_else(|| header("x-linked-size").and_then(|size| size.parse().ok()));
            etag = etag.or_else(|| header("etag"));
            let status = response.status();
            if status.is_redirection() {
                let location = header("location").ok_or_else(|| format!("{} redirige {what} sans adresse.", self.host))?;
                url = url.join(&location).map_err(|_| format!("{} redirige {what} vers une adresse illisible.", self.host))?;
                continue;
            }
            if !status.is_success() {
                return Ok(Err(status));
            }
            return Ok(Ok(Fetched { response, linked_etag, linked_size, etag }));
        }
        Err(format!("{} redirige {what} trop de fois.", self.host))
    }

    /// Première étape de `snapshot_download` : la liste des fichiers de la dernière révision. Avec `?blobs=true`
    /// (empreintes des fichiers LFS), puis sans, pour un miroir qui ne le prend pas.
    async fn listing(&self, spec: &ModelSpec) -> Result<Listing, String> {
        let what = format!("le modèle {}", spec.repo);
        let base = format!("{}/api/models/{}/revision/main", self.source.endpoint, spec.repo);
        let mut refused = reqwest::StatusCode::NOT_FOUND;
        for address in [format!("{base}?blobs=true"), base] {
            match self.follow(&address, &what).await? {
                Ok(fetched) => {
                    let body = fetched.response.bytes().await.map_err(|failure| request_failure(&failure, &what, &self.host))?;
                    return serde_json::from_slice(&body)
                        .map_err(|_| format!("{} n’a pas répondu comme un dépôt Hugging Face pour {what} (liste des fichiers illisible).", self.host));
                }
                Err(status) if matches!(status.as_u16(), 401 | 403) => return Err(status_failure(status, &what, &self.host)),
                Err(status) => refused = status,
            }
        }
        Err(status_failure(refused, &what, &self.host))
    }
}

/// Le téléchargement lui-même, vers le cache `cache`, comme `snapshot_download` de la bibliothèque Python : la liste
/// des fichiers à la dernière révision, puis chaque fichier par un simple GET sur `<source>/<dépôt>/resolve/…`, sans
/// demande de plage (Artifactory ne renvoie pas `Content-Range`) ni délai d’attente (Artifactory peut mettre
/// longtemps à répondre la première fois : l’`etag_timeout=86400` de sa documentation). `token` est le jeton final.
async fn download(
    spec: &ModelSpec,
    source: &Source,
    token: Option<String>,
    cache: &Path,
    total_hint: u64,
    error: &impl Fn(String) -> AppError,
    report: Arc<dyn Fn(u64, u64) + Send + Sync>,
) -> AppResult<String> {
    let client = Client::new(source, token).map_err(error)?;
    let listing = client.listing(spec).await.map_err(error)?;
    let revision = listing.sha.trim().to_string();
    if !valid_revision(&revision) {
        return Err(error(format!("{} annonce une révision illisible pour le modèle {}.", client.host, spec.repo)));
    }
    let mut announced = Vec::with_capacity(spec.files.len());
    for file in spec.files {
        let sibling = listing.siblings.iter().find(|sibling| sibling.rfilename == *file);
        let Some(sibling) = sibling else {
            return Err(error(format!(
                "{file} est absent de la révision {} du modèle {} sur {} : cette version du modèle n’est pas prise en charge par Alfred.",
                short_revision(&revision),
                spec.repo,
                client.host
            )));
        };
        let lfs = sibling.lfs.as_ref();
        announced.push(Announced {
            sha256: lfs.and_then(|lfs| lfs.sha256.as_deref()).and_then(sha256_like),
            size: lfs.and_then(|lfs| lfs.size).or(sibling.size),
        });
    }
    let dir = spec.snapshot_dir(cache, &revision);
    let blobs = spec.model_cache(cache).join("blobs");
    let missing: Vec<usize> = (0..spec.files.len()).filter(|index| !dir.join(spec.files[*index]).is_file()).collect();
    let sizes: Option<u64> = missing.iter().map(|index| announced[*index].size).sum();
    let total = sizes.unwrap_or(total_hint);
    let mut before = 0u64;
    for index in missing {
        let file = spec.files[index];
        let received = fetch_file(&client, spec, &revision, file, &announced[index], &blobs, &dir.join(file), total, before, &report)
            .await
            .map_err(error)?;
        before += received;
    }
    // Noté seulement une fois tous les fichiers en place : c’est la révision installée.
    let refs = spec.model_cache(cache).join("refs");
    let io = |failure: std::io::Error| error(format!("écriture impossible dans le cache des modèles ({failure})."));
    std::fs::create_dir_all(&refs).map_err(io)?;
    std::fs::write(refs.join("main.incomplete"), &revision).map_err(io)?;
    std::fs::rename(refs.join("main.incomplete"), refs.join("main")).map_err(io)?;
    Ok(revision)
}

/// Télécharge un fichier dans le cache, au format de la bibliothèque Python : le contenu dans `blobs/<etag>`, et
/// `snapshots/<révision>/<fichier>` qui le désigne. Demandé à la révision annoncée, puis à `main` si le miroir ne
/// sert pas la première ; un refus du jeton (401, 403) arrête tout de suite. Vérifié avant de prendre sa place :
/// empreinte annoncée, sinon taille ; un fichier différent est écarté. Renvoie le nombre d’octets reçus.
#[allow(clippy::too_many_arguments)]
async fn fetch_file(
    client: &Client<'_>,
    spec: &ModelSpec,
    revision: &str,
    file: &str,
    announced: &Announced,
    blobs: &Path,
    target: &Path,
    total: u64,
    before: u64,
    report: &Arc<dyn Fn(u64, u64) + Send + Sync>,
) -> Result<u64, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let host = &client.host;
    let mut refused = reqwest::StatusCode::NOT_FOUND;
    let mut fetched = None;
    let mut attempts = vec![revision];
    if revision != "main" {
        attempts.push("main");
    }
    for attempt in attempts {
        match client.follow(&file_url(&client.source.endpoint, spec.repo, attempt, file), file).await? {
            Ok(found) => {
                fetched = Some(found);
                break;
            }
            Err(status) if matches!(status.as_u16(), 401 | 403) => return Err(status_failure(status, file, host)),
            Err(status) => refused = status,
        }
    }
    let Some(Fetched { mut response, linked_etag, linked_size, etag }) = fetched else {
        return Err(status_failure(refused, file, host));
    };
    let expected_sha = announced.sha256.clone().or_else(|| linked_etag.as_deref().and_then(sha256_like));
    let expected_size = announced.size.or(linked_size).or(response.content_length());
    let io = |failure: std::io::Error| format!("écriture impossible dans le cache des modèles ({failure}).");
    tokio::fs::create_dir_all(blobs).await.map_err(io)?;
    let partial = blobs.join(format!("{}.incomplete", file.replace(['/', '\\'], "_")));
    let mut out = tokio::fs::File::create(&partial).await.map_err(io)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let total = total.max(before + expected_size.unwrap_or(0));
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(failure) => {
                let _ = tokio::fs::remove_file(&partial).await;
                return Err(request_failure(&failure, file, host));
            }
        };
        hasher.update(&chunk);
        out.write_all(&chunk).await.map_err(io)?;
        received += chunk.len() as u64;
        report(before + received, total.max(before + received));
    }
    out.flush().await.map_err(io)?;
    drop(out);
    let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    if let Some(expected) = &expected_sha {
        if digest != *expected {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(format!(
                "le fichier {file} reçu de {host} n’a pas l’empreinte que la source annonce : fichier écarté (téléchargement abîmé). Réessayez."
            ));
        }
    } else if let Some(size) = expected_size.filter(|size| *size != received) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!("le fichier {file} reçu de {host} est incomplet ({received} octets sur {size}) : fichier écarté. Réessayez."));
    }
    // Le nom du contenu, comme la bibliothèque Python : `X-Linked-Etag` (fichiers LFS), sinon `ETag`, sinon l’empreinte.
    let name = linked_etag
        .or(etag)
        .map(|etag| etag.trim_start_matches("W/").replace('"', ""))
        .filter(|etag| !etag.is_empty() && !etag.contains(['/', '\\', '.']))
        .unwrap_or(digest);
    let blob = blobs.join(name);
    tokio::fs::rename(&partial, &blob).await.map_err(io)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io)?;
    }
    link(&blob, target).map_err(io)?;
    Ok(received)
}

/// `snapshots/<révision>/<fichier>` désigne `blobs/<etag>` par un lien relatif, comme la bibliothèque Python.
/// Sous Windows, où un lien demande souvent des droits, le contenu est déplacé à la place.
fn link(blob: &Path, pointer: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(pointer);
    // Remonter du dossier du lien jusqu’au dossier du modèle (`snapshots/<révision>/…`), puis descendre dans `blobs`.
    let model = blob.parent().and_then(Path::parent).unwrap_or(Path::new("."));
    let depth = pointer.parent().and_then(|parent| parent.strip_prefix(model).ok()).map_or(0, |rest| rest.components().count());
    let mut relative = PathBuf::new();
    for _ in 0..depth {
        relative.push("..");
    }
    relative.push("blobs");
    relative.push(blob.file_name().unwrap_or_default());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&relative, pointer)
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(&relative, pointer).is_ok() {
            return Ok(());
        }
        std::fs::rename(blob, pointer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

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
        let spec = ModelSpec { repo: "intfloat/multilingual-e5-small", legacy_dir: "e5", legacy_revision: "614241f", files: &[] };
        assert_eq!(
            spec.snapshot_dir(Path::new("/cache"), "614241f"),
            Path::new("/cache/models--intfloat--multilingual-e5-small/snapshots/614241f")
        );
        assert_eq!(host(base), "jfrog.exemple.fr");
        assert_eq!(host("http://127.0.0.1:8080/hf"), "127.0.0.1:8080");
        assert!(valid_revision("9da7038f21430c6bc70956435f077c5485417055") && valid_revision("main"));
        assert!(!valid_revision("../x") && !valid_revision("a/b") && !valid_revision(""));
        assert_eq!(short_revision("9da7038f21430c6"), "9da7038");
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
        // Ni réglage ni HF_TOKEN : le fichier de `huggingface-cli login`.
        assert_eq!(resolve_token(&default, None, None), None);
    }

    #[test]
    fn older_copies_stay_recognized_and_the_noted_revision_comes_first() {
        let data = tempfile::tempdir().unwrap();
        let hub = tempfile::tempdir().unwrap();
        let spec = ModelSpec { repo: "org/modele", legacy_dir: "modele", legacy_revision: "ancienne", files: &["a.json"] };
        assert_eq!(spec.installed_in(data.path(), hub.path()), None);
        let put = |dir: PathBuf| {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("a.json"), "{}").unwrap();
            dir
        };
        // L’ancien dossier d’Alfred (le Laya déjà téléchargé), à la révision que figeait Alfred.
        let legacy = put(data.path().join("models/modele"));
        assert_eq!(spec.installed_in(data.path(), hub.path()), Some(Installed { dir: legacy, revision: "ancienne".into() }));
        // Le cache à l’ancienne révision figée, sans `refs/main` (téléchargé par la version précédente).
        let cached = put(spec.snapshot_dir(hub.path(), "ancienne"));
        assert_eq!(spec.installed_in(data.path(), hub.path()).unwrap().dir, cached);
        // La révision notée l’emporte, si elle est complète.
        let refs = spec.model_cache(hub.path()).join("refs");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(refs.join("main"), "nouvelle").unwrap();
        assert_eq!(spec.installed_in(data.path(), hub.path()).unwrap().revision, "ancienne");
        let latest = put(spec.snapshot_dir(hub.path(), "nouvelle"));
        assert_eq!(spec.installed_in(data.path(), hub.path()), Some(Installed { dir: latest, revision: "nouvelle".into() }));
        // Une révision notée qui sortirait du cache est ignorée.
        std::fs::write(refs.join("main"), "../../x").unwrap();
        assert_eq!(spec.installed_in(data.path(), hub.path()).unwrap().revision, "ancienne");
    }

    // -----------------------------------------------------------------------------------------------------------
    // Faux miroir : répond comme huggingface.co ou Artifactory (liste des fichiers, `resolve`, en-têtes `ETag` et
    // `X-Linked-Etag`, jamais de `Content-Range`).
    // -----------------------------------------------------------------------------------------------------------

    const CONTENT: &[u8] = b"{\"hidden_size\": 384}";
    /// Identifiant qu’un miroir Artifactory annonce comme révision (absent de huggingface.co).
    const OWN: &str = "9da7038f21430c6bc70956435f077c5485417055";

    fn sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[derive(Clone)]
    struct Mirror {
        /// Jeton exigé (401 sans, 403 si faux).
        token: Option<&'static str>,
        /// Contenu servi.
        body: &'static [u8],
        /// Empreinte annoncée dans la liste (`lfs.sha256`).
        listed_sha: Option<String>,
        /// Taille annoncée dans la liste.
        listed_size: Option<u64>,
        /// En-tête `X-Linked-Etag` de la réponse.
        linked_etag: Option<String>,
        /// Refuse `?blobs=true` (400), comme un miroir qui ne le connaît pas.
        no_blobs: bool,
        /// `resolve` ne sert que `main`, pas la révision annoncée.
        only_main: bool,
        /// Le fichier passe par une redirection vers une autre adresse, comme le CDN de huggingface.co.
        redirect_to: Option<String>,
        seen: Arc<std::sync::Mutex<Vec<String>>>,
    }

    fn mirror_with(token: Option<&'static str>, body: &'static [u8]) -> Mirror {
        Mirror {
            token,
            body,
            listed_sha: Some(sha(CONTENT)),
            listed_size: Some(CONTENT.len() as u64),
            linked_etag: None,
            no_blobs: false,
            only_main: false,
            redirect_to: None,
            seen: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    async fn mirror(
        axum::extract::State(mirror): axum::extract::State<Mirror>,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
    ) -> axum::response::Response {
        use axum::http::{header, StatusCode};
        use axum::response::IntoResponse;
        let auth = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).map(str::to_string);
        let path_and_query = uri.path_and_query().map(|value| value.as_str().to_string()).unwrap_or_default();
        mirror.seen.lock().unwrap().push(format!("{path_and_query} {}", auth.as_deref().unwrap_or("-")));
        if uri.path().starts_with("/cdn/") {
            return (StatusCode::OK, mirror.body.to_vec()).into_response();
        }
        if let Some(expected) = mirror.token {
            match auth {
                None => return StatusCode::UNAUTHORIZED.into_response(),
                Some(value) if value != format!("Bearer {expected}") => return StatusCode::FORBIDDEN.into_response(),
                _ => {}
            }
        }
        if uri.path() == "/mirror/api/models/org/modele/revision/main" {
            let blobs = uri.query().is_some_and(|query| query.contains("blobs=true"));
            if blobs && mirror.no_blobs {
                return StatusCode::BAD_REQUEST.into_response();
            }
            let mut sibling = serde_json::json!({ "rfilename": "config.json" });
            if blobs {
                sibling["size"] = serde_json::json!(mirror.listed_size);
                if let Some(listed) = &mirror.listed_sha {
                    sibling["lfs"] = serde_json::json!({ "sha256": listed, "size": mirror.listed_size });
                }
            }
            return axum::Json(serde_json::json!({ "sha": OWN, "siblings": [sibling] })).into_response();
        }
        let served = if mirror.only_main { "main" } else { OWN };
        if uri.path() != format!("/mirror/org/modele/resolve/{served}/config.json") {
            return StatusCode::NOT_FOUND.into_response();
        }
        let mut response = if let Some(target) = &mirror.redirect_to {
            (StatusCode::FOUND, [(header::LOCATION, target.clone())]).into_response()
        } else {
            (StatusCode::OK, [(header::ETAG, "\"git-oid\"".to_string())], mirror.body.to_vec()).into_response()
        };
        if let Some(linked) = &mirror.linked_etag {
            response.headers_mut().insert("x-linked-etag", format!("\"{linked}\"").parse().unwrap());
        }
        response
    }

    async fn serve(mirror_state: Mirror) -> String {
        let app = axum::Router::new().route("/{*path}", axum::routing::get(mirror)).with_state(mirror_state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/mirror")
    }

    const SPEC: ModelSpec = ModelSpec { repo: "org/modele", legacy_dir: "modele", legacy_revision: "ancienne", files: &["config.json"] };

    async fn run(endpoint: &str, token: Option<&str>, cache: &Path) -> AppResult<(String, Vec<(u64, u64)>)> {
        let source = resolve_source(Some(endpoint), None);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let revision = download(&SPEC, &source, token.map(str::to_string), cache, 0, &AppError::new, Arc::new(move |received, total| {
            log.lock().unwrap().push((received, total));
        }))
        .await?;
        let progress = seen.lock().unwrap().clone();
        Ok((revision, progress))
    }

    fn installed(cache: &Path) -> Option<Installed> {
        SPEC.installed_in(Path::new("/nulle-part"), cache)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn downloads_the_announced_revision_and_notes_it() {
        let state = mirror_with(Some("jeton-secret"), CONTENT);
        let endpoint = serve(state.clone()).await;
        let cache = tempfile::tempdir().unwrap();
        let (revision, progress) = run(&endpoint, Some("jeton-secret"), cache.path()).await.unwrap();
        assert_eq!(revision, OWN);
        let installed = installed(cache.path()).unwrap();
        assert_eq!(installed, Installed { dir: SPEC.snapshot_dir(cache.path(), OWN), revision: OWN.into() });
        let file = installed.dir.join("config.json");
        assert_eq!(std::fs::read(&file).unwrap(), CONTENT);
        #[cfg(unix)]
        assert_eq!(std::fs::read_link(&file).unwrap(), Path::new("../../blobs/git-oid"));
        assert_eq!(progress.last(), Some(&(CONTENT.len() as u64, CONTENT.len() as u64)));
        let seen = state.seen.lock().unwrap().clone();
        assert!(seen.iter().all(|line| line.ends_with("Bearer jeton-secret")));
        // Déroulé de `snapshot_download` : la liste des fichiers d’abord, puis le fichier à la révision annoncée.
        assert_eq!(seen[0], "/mirror/api/models/org/modele/revision/main?blobs=true Bearer jeton-secret");
        assert_eq!(seen[1], format!("/mirror/org/modele/resolve/{OWN}/config.json Bearer jeton-secret"));
        // Déjà là : seule la liste est redemandée.
        run(&endpoint, Some("jeton-secret"), cache.path()).await.unwrap();
        assert_eq!(state.seen.lock().unwrap().len(), seen.len() + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_mirror_without_blobs_or_serving_only_main_still_works() {
        // Sans `?blobs=true` ni empreinte dans la liste : `X-Linked-Etag` fait foi.
        let state = Mirror { no_blobs: true, only_main: true, linked_etag: Some(sha(CONTENT)), ..mirror_with(None, CONTENT) };
        let endpoint = serve(state.clone()).await;
        let cache = tempfile::tempdir().unwrap();
        run(&endpoint, None, cache.path()).await.unwrap();
        assert_eq!(installed(cache.path()).unwrap().revision, OWN);
        let seen = state.seen.lock().unwrap().clone();
        assert!(seen.iter().any(|line| line.starts_with("/mirror/api/models/org/modele/revision/main ")), "{seen:?}");
        assert!(seen.iter().any(|line| line.contains("/resolve/main/config.json")), "{seen:?}");
        // Le contenu est rangé sous l’empreinte (l’etag LFS), comme Python.
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_link(SPEC.snapshot_dir(cache.path(), OWN).join("config.json")).unwrap(),
            Path::new(&format!("../../blobs/{}", sha(CONTENT)))
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_damaged_file_is_named_and_discarded() {
        // L’empreinte de la liste.
        let endpoint = serve(mirror_with(None, b"{\"hidden_size\": 999}")).await;
        let cache = tempfile::tempdir().unwrap();
        let message = run(&endpoint, None, cache.path()).await.unwrap_err().message;
        assert!(message.contains("le fichier config.json") && message.contains("n’a pas l’empreinte que la source annonce"), "{message}");
        // L’empreinte de l’en-tête.
        let state = Mirror { listed_sha: None, linked_etag: Some(sha(CONTENT)), ..mirror_with(None, b"{\"hidden_size\": 999}") };
        let endpoint = serve(state).await;
        let message = run(&endpoint, None, cache.path()).await.unwrap_err().message;
        assert!(message.contains("n’a pas l’empreinte que la source annonce"), "{message}");
        assert_eq!(installed(cache.path()), None);
        let blobs = SPEC.model_cache(cache.path()).join("blobs");
        assert!(std::fs::read_dir(blobs).unwrap().next().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn without_an_announced_digest_the_size_decides() {
        let cache = tempfile::tempdir().unwrap();
        let truncated = Mirror { listed_sha: None, listed_size: Some(CONTENT.len() as u64 + 10), ..mirror_with(None, CONTENT) };
        let message = run(&serve(truncated).await, None, cache.path()).await.unwrap_err().message;
        assert!(message.contains("le fichier config.json") && message.contains("est incomplet"), "{message}");
        assert_eq!(installed(cache.path()), None);
        let whole = Mirror { listed_sha: None, ..mirror_with(None, CONTENT) };
        run(&serve(whole).await, None, cache.path()).await.unwrap();
        assert_eq!(installed(cache.path()).unwrap().revision, OWN);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_token_never_follows_a_redirect_to_another_host() {
        // Un « CDN » sur un autre port : une autre origine que la source.
        let cdn = mirror_with(None, CONTENT);
        let app = axum::Router::new().route("/{*path}", axum::routing::get(mirror)).with_state(cdn.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = Mirror {
            redirect_to: Some(format!("http://{address}/cdn/blob")),
            linked_etag: Some(sha(CONTENT)),
            ..mirror_with(Some("jeton-secret"), CONTENT)
        };
        let endpoint = serve(state.clone()).await;
        let cache = tempfile::tempdir().unwrap();
        run(&endpoint, Some("jeton-secret"), cache.path()).await.unwrap();
        assert_eq!(cdn.seen.lock().unwrap().clone(), vec!["/cdn/blob -".to_string()]);
        assert!(state.seen.lock().unwrap().iter().all(|line| line.ends_with("Bearer jeton-secret")));
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

    #[cfg(unix)]
    #[test]
    fn snapshot_entries_point_to_their_blob_like_python() {
        let cache = tempfile::tempdir().unwrap();
        let model = cache.path().join("models--org--modele");
        std::fs::create_dir_all(model.join("blobs")).unwrap();
        std::fs::write(model.join("blobs/abc"), "contenu").unwrap();
        let pointer = model.join("snapshots/rev/encoder/config.json");
        std::fs::create_dir_all(pointer.parent().unwrap()).unwrap();
        link(&model.join("blobs/abc"), &pointer).unwrap();
        assert_eq!(std::fs::read_link(&pointer).unwrap(), Path::new("../../../blobs/abc"));
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), "contenu");
    }

    /// Certificat signé par une autorité inconnue du système (réseau) : `cargo test -- --ignored certificate`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_refused_certificate_is_named() {
        let message = run("https://self-signed.badssl.com", None, tempfile::tempdir().unwrap().path()).await.unwrap_err().message;
        assert!(message.contains("le certificat de self-signed.badssl.com est refusé"), "{message}");
    }

    /// Vrai téléchargement d’e5 depuis huggingface.co (470 Mo) : `cargo test -- --ignored real_e5`. Le dossier
    /// est gardé si `ALFRED_REAL_HUB` le nomme, pour charger le modèle ensuite.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_e5_download_from_hugging_face() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = std::env::var("ALFRED_REAL_HUB").map(PathBuf::from).unwrap_or_else(|_| temporary.path().to_path_buf());
        let source = resolve_source(None, None);
        let spec = ModelSpec {
            repo: "intfloat/multilingual-e5-small",
            legacy_dir: "multilingual-e5-small",
            legacy_revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
            files: &["config.json", "tokenizer.json", "model.safetensors"],
        };
        let last = Arc::new(AtomicU64::new(0));
        let seen = last.clone();
        let revision = download(&spec, &source, None, &cache, 470 * 1024 * 1024, &AppError::new, Arc::new(move |received, _| {
            seen.store(received, Ordering::Relaxed);
        }))
        .await
        .unwrap();
        let installed = spec.installed_in(Path::new("/nulle-part"), &cache).unwrap();
        assert_eq!(installed.revision, revision);
        eprintln!("révision {revision}, reçu {} octets dans {}", last.load(Ordering::Relaxed), installed.dir.display());
    }
}
