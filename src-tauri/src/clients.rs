//! Clients déclarés : les pages et les fonctions de l’espace n’ont pas de réseau. Elles nomment un client, Alfred
//! exécute la requête et y ajoute l’authentification lue dans le coffre. Le fichier d’un client est versionné avec
//! l’espace et ne contient donc aucun secret : seulement l’adresse, la façon de s’authentifier et l’identifiant de
//! l’entrée du coffre à utiliser.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, SET_COOKIE};
use reqwest::Method;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use url::Url;

use crate::app_db::{self, JournalEntry};
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::{self, Subject};
use crate::space::{slug, valid_id, write_json, Space, CLIENTS_DIR};
use crate::state::AppState;
use crate::{git, oauth, vault};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Taille maximale d’une réponse : au-delà, la page recevrait plus qu’elle ne peut raisonnablement traiter.
const MAX_BODY: usize = 20 * 1024 * 1024;
const MASK: &str = "[secret masqué]";

// ---------------------------------------------------------------------------------------------------------------
// Modèle
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    #[default]
    None,
    Bearer,
    ApiKey,
    Basic,
    Oauth2,
    ClientCredentials,
}

impl AuthKind {
    /// Type d’entrée du coffre que cette authentification attend.
    pub fn vault_kind(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Bearer | Self::ApiKey => Some(vault::KIND_TOKEN),
            Self::Basic => Some(vault::KIND_BASIC),
            Self::Oauth2 => Some(vault::KIND_OAUTH2),
            Self::ClientCredentials => Some(vault::KIND_CLIENT_CREDENTIALS),
        }
    }

    /// Jeton obtenu par Alfred auprès d’un serveur de jetons, donc renouvelable sans l’utilisateur.
    pub fn uses_token_endpoint(self) -> bool {
        matches!(self, Self::Oauth2 | Self::ClientCredentials)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Auth {
    #[serde(rename = "type")]
    pub kind: AuthKind,
    /// Identifiant de l’entrée du coffre ; jamais la valeur.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// `apiKey` : en-tête qui porte la clé…
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// … précédée de ce préfixe (« Token  », par exemple)…
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// … ou paramètre d’URL qui la porte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_param: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_url: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Client {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub auth: Auth,
    /// En-têtes fixes ajoutés à chaque requête (`Accept`…). Jamais d’authentification : elle vient du coffre.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

fn clean(value: &mut Option<String>) {
    *value = value.take().map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
}

/// En-têtes que ni le fichier d’un client ni une page ne fixent : l’authentification vient du coffre, et le reste
/// est calculé par Alfred à partir de l’adresse et du corps.
///
/// `range` et `if-range` en font partie : sur un service qui renvoie la requête en écho, une page lirait le secret
/// morceau par morceau, et aucun morceau ne serait reconnu pour être masqué.
const RESERVED_HEADERS: [&str; 10] = [
    "authorization",
    "cookie",
    "host",
    "proxy-authorization",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "range",
    "if-range",
];

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// Une adresse qui recevra un secret doit être chiffrée ; `http` n’est admis que vers le poste lui-même.
pub fn check_url(text: &str, what: &str, allow_query: bool) -> AppResult<Url> {
    let url = Url::parse(text.trim()).map_err(|_| AppError::new(format!("{what} n’est pas une adresse valide.")))?;
    let allowed = match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => is_loopback(&url),
        _ => false,
    };
    if !allowed {
        return Err(AppError::new(format!(
            "{what} doit commencer par https:// (http n’est accepté que pour localhost et 127.0.0.1)."
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::new(format!("{what} ne doit pas contenir d’identifiants : ils vont dans le coffre.")));
    }
    if url.fragment().is_some() || (!allow_query && url.query().is_some()) {
        return Err(AppError::new(format!("{what} ne doit contenir ni paramètres ni ancre.")));
    }
    Ok(url)
}

impl Client {
    /// Retire les espaces et les champs sans objet pour le type d’authentification : le fichier reste lisible et
    /// ne garde pas, par exemple, l’en-tête d’une ancienne clé d’API.
    fn normalize(&mut self) {
        self.label = self.label.trim().to_string();
        self.id = self.id.trim().to_string();
        if self.id.is_empty() && !self.label.is_empty() {
            self.id = slug(&self.label);
        }
        self.base_url = self.base_url.trim().to_string();
        self.headers = std::mem::take(&mut self.headers)
            .into_iter()
            .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
            .filter(|(name, _)| !name.is_empty())
            .collect();
        let auth = &mut self.auth;
        for value in [
            &mut auth.secret,
            &mut auth.header,
            &mut auth.query_param,
            &mut auth.authorization_url,
            &mut auth.token_url,
        ] {
            clean(value);
        }
        // Le préfixe garde ses espaces : « Token  » en a besoin.
        auth.prefix = auth.prefix.take().filter(|prefix| !prefix.is_empty());
        auth.scopes = std::mem::take(&mut auth.scopes)
            .into_iter()
            .map(|scope| scope.trim().to_string())
            .filter(|scope| !scope.is_empty())
            .collect();
        if auth.kind != AuthKind::ApiKey {
            (auth.header, auth.prefix, auth.query_param) = (None, None, None);
        }
        if auth.kind != AuthKind::Oauth2 {
            auth.authorization_url = None;
        }
        if !auth.kind.uses_token_endpoint() {
            auth.token_url = None;
            auth.scopes.clear();
        }
        if auth.kind == AuthKind::None {
            auth.secret = None;
        }
    }

    pub fn base(&self) -> AppResult<Url> {
        check_url(&self.base_url, "L’adresse de base du client", false)
    }

    pub fn validate(&self) -> AppResult<()> {
        if !valid_id(&self.id) {
            return Err(AppError::new(format!(
                "Identifiant de client invalide : « {} ». Utiliser des minuscules, des chiffres et des tirets.",
                self.id
            )));
        }
        if self.label.trim().is_empty() {
            return Err(AppError::new("Le client doit avoir un libellé."));
        }
        self.base()?;
        for (name, value) in &self.headers {
            let lower = name.to_ascii_lowercase();
            if RESERVED_HEADERS.contains(&lower.as_str()) {
                return Err(AppError::new(format!(
                    "L’en-tête « {name} » ne se fixe pas dans un client : l’authentification vient du coffre."
                )));
            }
            if HeaderName::from_bytes(name.as_bytes()).is_err() || HeaderValue::from_str(value).is_err() {
                return Err(AppError::new(format!("L’en-tête « {name} » n’est pas valide.")));
            }
        }
        let auth = &self.auth;
        if let Some(secret) = &auth.secret {
            if !valid_id(secret) {
                return Err(AppError::new(format!("Identifiant d’entrée du coffre invalide : « {secret} ».")));
            }
        }
        match auth.kind {
            AuthKind::ApiKey => match (&auth.header, &auth.query_param) {
                (Some(header), None) => {
                    if HeaderName::from_bytes(header.as_bytes()).is_err() {
                        return Err(AppError::new(format!("L’en-tête « {header} » n’est pas valide.")));
                    }
                }
                (None, Some(_)) => {}
                _ => {
                    return Err(AppError::new(
                        "Indiquer où va la clé d’API : un en-tête ou un paramètre d’URL, mais pas les deux.",
                    ))
                }
            },
            AuthKind::Oauth2 => {
                let url = auth
                    .authorization_url
                    .as_deref()
                    .ok_or_else(|| AppError::new("Saisir l’adresse d’autorisation."))?;
                check_url(url, "L’adresse d’autorisation", true)?;
            }
            _ => {}
        }
        if auth.kind.uses_token_endpoint() {
            let url =
                auth.token_url.as_deref().ok_or_else(|| AppError::new("Saisir l’adresse du serveur de jetons."))?;
            check_url(url, "L’adresse du serveur de jetons", true)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Fichiers de l’espace
// ---------------------------------------------------------------------------------------------------------------

fn clients_dir(space: &Space) -> PathBuf {
    space.root.join(CLIENTS_DIR)
}

fn client_path(space: &Space, id: &str) -> PathBuf {
    clients_dir(space).join(format!("{id}.json"))
}

/// Lit un client ; `None` s’il n’existe pas. L’identifiant est validé avant de toucher au disque : il vient d’une
/// page et ne doit pas pouvoir désigner un autre fichier.
pub fn load(space: &Space, id: &str) -> AppResult<Option<Client>> {
    if !valid_id(id) {
        return Ok(None);
    }
    let path = client_path(space, id);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)?;
    let mut client: Client = serde_json::from_str(&text)
        .map_err(|error| AppError::new(format!("Le fichier du client « {id} » est illisible : {error}")))?;
    // Le nom du fichier fait foi, comme pour les modules.
    client.id = id.to_string();
    if client.label.trim().is_empty() {
        client.label = id.to_string();
    }
    Ok(Some(client))
}

fn require(space: &Space, id: &str) -> AppResult<Client> {
    load(space, id)?.ok_or_else(|| AppError::new(format!("Le client « {id} » n’existe pas dans cet espace.")))
}

/// Tous les clients de l’espace ; un fichier illisible est rendu avec son erreur plutôt que de masquer les autres.
fn load_all(space: &Space) -> Vec<(String, AppResult<Client>)> {
    let Ok(entries) = std::fs::read_dir(clients_dir(space)) else { return Vec::new() };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| name.strip_suffix(".json").map(str::to_string))
        .filter(|id| valid_id(id))
        .collect();
    ids.sort();
    ids.into_iter()
        .filter_map(|id| match load(space, &id) {
            Ok(Some(client)) => Some((id, Ok(client))),
            Ok(None) => None,
            Err(error) => Some((id, Err(error))),
        })
        .collect()
}

/// Libellés des clients de l’espace qui utilisent cette entrée du coffre.
pub fn using_secret(space: &Space, secret: &str) -> Vec<String> {
    load_all(space)
        .into_iter()
        .filter_map(|(_, client)| client.ok())
        .filter(|client| client.auth.secret.as_deref() == Some(secret))
        .map(|client| client.label)
        .collect()
}

/// Client que désigne le nom demandé par un module : la liaison faite par l’utilisateur d’abord, sinon le client de
/// l’espace qui porte ce nom.
fn resolve(space: &Space, module: &str, name: &str) -> AppResult<Client> {
    let need = format!("{module}/{name}");
    if let Some(bound) = space.manifest()?.bindings.get(&need) {
        return load(space, bound)?.ok_or_else(|| {
            AppError::new(format!(
                "La demande « {need} » est reliée au client « {bound} », qui n’existe plus. La relier à un autre client dans Réglages → Clients."
            ))
        });
    }
    load(space, name)?.ok_or_else(|| {
        AppError::new(format!(
            "Le client « {name} » n’existe pas dans cet espace. Le créer dans Réglages → Clients, ou y relier la demande « {need} » à un client existant."
        ))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Validation par l’utilisateur
// ---------------------------------------------------------------------------------------------------------------
//
// Le fichier d’un client vit dans l’espace : l’agent peut le réécrire. Sans garde-fou, changer l’adresse d’un client
// déjà autorisé suffirait à faire partir son secret ailleurs. Alfred garde donc, hors de l’espace, l’empreinte de ce
// que l’utilisateur a validé dans les Réglages, et n’injecte un secret que si le fichier lui correspond encore.

/// Champs de l’empreinte : tout ce qui décide où part le secret et ce qu’il permet d’obtenir. Chaque valeur est un
/// texte ou `null`, pour pouvoir montrer l’avant et l’après à l’utilisateur.
const TRUST_FIELDS: [(&str, &str); 10] = [
    ("authType", "Authentification"),
    ("secret", "Entrée du coffre"),
    ("baseUrl", "Adresse de base"),
    ("authorizationUrl", "Adresse d’autorisation"),
    ("tokenUrl", "Adresse du serveur de jetons"),
    ("scopes", "Portées"),
    ("header", "En-tête de la clé"),
    ("queryParam", "Paramètre de la clé"),
    ("prefix", "Préfixe de la clé"),
    ("headers", "En-têtes fixes"),
];

/// Forme canonique d’une adresse : deux écritures de la même adresse donnent la même empreinte. Pour l’adresse de
/// base, seuls l’origine et le préfixe de chemin comptent.
fn canonical_url(text: &str, prefix_only: bool) -> String {
    match Url::parse(text.trim()) {
        Ok(url) if prefix_only => {
            format!("{}{}", url.origin().ascii_serialization(), url.path().trim_end_matches('/'))
        }
        Ok(url) => url.to_string(),
        Err(_) => text.trim().to_string(),
    }
}

pub fn fingerprint(client: &Client) -> Value {
    let auth = &client.auth;
    let api_key = auth.kind == AuthKind::ApiKey;
    let tokens = auth.kind.uses_token_endpoint();
    let headers: BTreeMap<String, &str> =
        client.headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.as_str())).collect();
    let headers: Vec<String> = headers.iter().map(|(name, value)| format!("{name}: {value}")).collect();
    let text = |value: &Option<String>, relevant: bool| value.clone().filter(|_| relevant);
    json!({
        "authType": auth.kind,
        "secret": auth.secret,
        "baseUrl": canonical_url(&client.base_url, true),
        "authorizationUrl": text(&auth.authorization_url, auth.kind == AuthKind::Oauth2).map(|url| canonical_url(&url, false)),
        "tokenUrl": text(&auth.token_url, tokens).map(|url| canonical_url(&url, false)),
        "scopes": Some(auth.scopes.join(" ")).filter(|scopes| tokens && !scopes.is_empty()),
        "header": text(&auth.header, api_key).map(|header| header.to_ascii_lowercase()),
        "queryParam": text(&auth.query_param, api_key),
        "prefix": text(&auth.prefix, api_key),
        "headers": Some(headers.join(", ")).filter(|headers| !headers.is_empty()),
    })
}

fn space_key(space: &Space) -> String {
    space.root.to_string_lossy().to_string()
}

fn trust_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    // Table créée au premier usage, dans la base d’Alfred : hors de portée d’une écriture dans l’espace.
    db.execute(
        "CREATE TABLE IF NOT EXISTS client_trust (space TEXT NOT NULL, client TEXT NOT NULL, fingerprint TEXT NOT NULL, validated_at TEXT NOT NULL, PRIMARY KEY (space, client))",
        [],
    )?;
    Ok(db)
}

fn trusted_fingerprint(state: &AppState, space: &Space, id: &str) -> AppResult<Option<Value>> {
    let db = trust_db(state)?;
    let text: Option<String> = db
        .query_row(
            "SELECT fingerprint FROM client_trust WHERE space = ?1 AND client = ?2",
            params![space_key(space), id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(text.and_then(|text| serde_json::from_str(&text).ok()))
}

fn record_trust(state: &AppState, space: &Space, client: &Client) -> AppResult<()> {
    let db = trust_db(state)?;
    db.execute(
        "INSERT INTO client_trust (space, client, fingerprint, validated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (space, client) DO UPDATE SET fingerprint = excluded.fingerprint, validated_at = excluded.validated_at",
        params![space_key(space), client.id, fingerprint(client).to_string(), app_db::now()],
    )?;
    Ok(())
}

/// Refuse d’utiliser le secret d’un client que l’utilisateur n’a pas validé dans son état actuel. À appeler avant
/// tout envoi : requête d’une page, test, demande ou rafraîchissement de jeton, départ d’une connexion.
pub fn ensure_trusted(state: &AppState, client: &Client) -> AppResult<()> {
    // Sans secret à injecter, il n’y a rien à détourner.
    if client.auth.kind == AuthKind::None {
        return Ok(());
    }
    let space = state.space()?;
    if trusted_fingerprint(state, &space, &client.id)?.as_ref() == Some(&fingerprint(client)) {
        return Ok(());
    }
    Err(AppError::new(format!(
        "Le client « {} » n’est pas validé dans son état actuel : l’agent le valide avec `validate_client`, ou l’utilisateur dans Réglages, onglet Clients.",
        client.label
    )))
}

/// Écarts entre l’empreinte validée et le fichier actuel ; sans validation antérieure, toutes les valeurs actuelles.
fn trust_changes(stored: Option<&Value>, current: &Value) -> Vec<Value> {
    TRUST_FIELDS
        .iter()
        .filter_map(|(field, label)| {
            let before = stored.and_then(|stored| stored.get(field)).filter(|value| !value.is_null());
            let after = current.get(field).filter(|value| !value.is_null());
            (before != after).then(|| json!({ "field": field, "label": label, "before": before, "after": after }))
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------------------------------------------

/// Entrée du coffre d’un client et ses champs secrets. Les erreurs disent quoi faire, jamais ce que vaut le secret.
pub async fn secret_of(state: &Arc<AppState>, client: &Client) -> AppResult<(vault::Entry, Option<Value>)> {
    let id = client.auth.secret.as_deref().ok_or_else(|| {
        AppError::new(format!(
            "Le client « {} » n’a pas d’entrée du coffre. La choisir dans Réglages → Clients.",
            client.label
        ))
    })?;
    let entry = vault::entry(state, id)?.ok_or_else(|| {
        AppError::new(format!(
            "Le client « {} » attend l’entrée « {id} » du coffre, qui n’existe pas sur ce poste. La créer dans Réglages → Coffre.",
            client.label
        ))
    })?;
    if Some(entry.kind.as_str()) != client.auth.kind.vault_kind() {
        return Err(AppError::new(format!(
            "L’entrée « {} » du coffre n’est pas du type attendu par le client « {} ».",
            entry.label, client.label
        )));
    }
    let secret = vault::read_secret_async(id).await?;
    Ok((entry, secret))
}

/// Ce qu’Alfred ajoute à la requête pour l’authentifier.
#[derive(Default)]
struct Credential {
    headers: Vec<(HeaderName, String)>,
    query: Vec<(String, String)>,
    /// Valeurs qui ne doivent ressortir nulle part : réponse qui renvoie la requête en écho, message d’erreur.
    secrets: Vec<String>,
    /// Jeton renouvelable utilisé pour cette requête : s’il est refusé (401), il est redemandé une fois.
    renewable: Option<String>,
}

fn missing_secret(client: &Client) -> AppError {
    AppError::new(format!(
        "Le secret du client « {} » n’est pas renseigné. Le saisir dans Réglages → Coffre.",
        client.label
    ))
}

async fn credential(state: &Arc<AppState>, client: &Client, stale: Option<&str>) -> AppResult<Credential> {
    let auth = &client.auth;
    if auth.kind == AuthKind::None {
        return Ok(Credential::default());
    }
    if auth.kind.uses_token_endpoint() {
        let token = oauth::access_token(state, client, stale).await?;
        return Ok(Credential {
            headers: vec![(AUTHORIZATION, format!("Bearer {token}"))],
            secrets: vec![token.clone()],
            renewable: Some(token),
            ..Credential::default()
        });
    }
    let (entry, secret) = secret_of(state, client).await?;
    let secret = secret.as_ref();
    match auth.kind {
        AuthKind::Bearer => {
            let value = vault::field(secret, "value").ok_or_else(|| missing_secret(client))?;
            Ok(Credential {
                headers: vec![(AUTHORIZATION, format!("Bearer {value}"))],
                secrets: vec![value.to_string()],
                ..Credential::default()
            })
        }
        AuthKind::ApiKey => {
            let value = vault::field(secret, "value").ok_or_else(|| missing_secret(client))?;
            let sent = format!("{}{value}", auth.prefix.as_deref().unwrap_or_default());
            let mut credential = Credential { secrets: vec![value.to_string()], ..Credential::default() };
            match (&auth.header, &auth.query_param) {
                (Some(header), _) => {
                    let name = HeaderName::from_bytes(header.as_bytes())
                        .map_err(|_| AppError::new(format!("L’en-tête « {header} » n’est pas valide.")))?;
                    credential.headers.push((name, sent));
                }
                (None, Some(param)) => credential.query.push((param.clone(), sent)),
                (None, None) => {
                    return Err(AppError::new(format!(
                        "Le client « {} » n’indique pas où placer la clé d’API.",
                        client.label
                    )))
                }
            }
            Ok(credential)
        }
        _ => {
            let username = entry.meta_text("username").ok_or_else(|| missing_secret(client))?;
            let password = vault::field(secret, "password").ok_or_else(|| missing_secret(client))?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
            Ok(Credential {
                headers: vec![(AUTHORIZATION, format!("Basic {encoded}"))],
                secrets: vec![password.to_string(), encoded],
                ..Credential::default()
            })
        }
    }
}

/// Retire d’un texte toute valeur secrète qui s’y trouverait. Les valeurs très courtes sont laissées : les
/// remplacer abîmerait le texte sans rien protéger.
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut text = text.to_string();
    for secret in secrets.iter().filter(|secret| secret.len() >= 4) {
        for form in written_forms(secret) {
            if text.contains(form.as_str()) {
                text = text.replace(form.as_str(), MASK);
            }
        }
    }
    text
}

/// Écritures sous lesquelles un service renvoie couramment une valeur : telle quelle, encodée dans une adresse,
/// échappée dans du JSON, en base64. Les plus longues d’abord, pour qu’une forme n’en coupe pas une autre.
fn written_forms(secret: &str) -> Vec<String> {
    let engine = &base64::engine::general_purpose::STANDARD;
    let form = url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>();
    let json = serde_json::to_string(secret).unwrap_or_default();
    let json = json.trim_matches('"').to_string();
    let mut forms = vec![
        secret.to_string(),
        form.replace('+', "%20"),
        form,
        json.replace('/', "\\/"),
        json,
        engine.encode(secret),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret),
    ];
    forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
    forms.dedup();
    forms
}

// ---------------------------------------------------------------------------------------------------------------
// Requête
// ---------------------------------------------------------------------------------------------------------------

/// Client HTTP partagé. Une redirection n’est suivie que vers la même origine : l’authentification ajoutée par
/// Alfred ne doit jamais partir vers un autre hôte que celui que l’utilisateur a déclaré.
pub fn http() -> AppResult<reqwest::Client> {
    fn build() -> AppResult<reqwest::Client> {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Alfred/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let same_origin =
                    attempt.previous().first().is_some_and(|first| first.origin() == attempt.url().origin());
                if same_origin && attempt.previous().len() < 10 {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|error| AppError::new(format!("Le client HTTP d’Alfred n’a pas pu démarrer : {error}")))
    }
    // Chaque test a son propre exécuteur : un client partagé y garderait des connexions d’un exécuteur arrêté.
    if cfg!(test) {
        return build();
    }
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = HTTP.get() {
        return Ok(client.clone());
    }
    let client = build()?;
    Ok(HTTP.get_or_init(|| client).clone())
}

/// Message d’un échec réseau, sans l’adresse complète : elle peut porter une clé d’API en paramètre.
pub fn network_error(error: reqwest::Error, secrets: &[String]) -> AppError {
    let error = error.without_url();
    if error.is_timeout() {
        return AppError::new(format!(
            "Délai dépassé : le service n’a pas répondu en {} s.",
            REQUEST_TIMEOUT.as_secs()
        ));
    }
    // La cause la plus profonde est la plus parlante (certificat refusé, nom introuvable, connexion refusée).
    let mut cause: &dyn std::error::Error = &error;
    while let Some(source) = cause.source() {
        cause = source;
    }
    let reason = redact(&cause.to_string(), secrets);
    AppError::new(if error.is_connect() {
        format!("Connexion au service impossible : {reason}.")
    } else {
        format!("La requête n’a pas abouti : {reason}.")
    })
}

fn decode_percent(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = (bytes[index] == b'%').then(|| bytes.get(index + 1..index + 3)).flatten();
        match hex.and_then(|hex| std::str::from_utf8(hex).ok()).and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).to_string()
}

fn outside() -> AppError {
    AppError::new(
        "Chemin refusé : il doit commencer par « / » et rester sous l’adresse de base du client (pas d’adresse complète, de « // », de « .. » ni de « @ »).",
    )
}

/// Adresse appelée = adresse de base + chemin. Le chemin vient d’une page : il ne doit pouvoir atteindre ni un
/// autre hôte ni une autre partie du service que celle déclarée par l’utilisateur.
fn build_url(
    base: &Url,
    path: &str,
    query: Option<&Map<String, Value>>,
    reserved_param: Option<&str>,
) -> AppResult<Url> {
    let (path, raw_query) = match path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path, None),
    };
    let forbidden = |character: char| character.is_control() || matches!(character, '\\' | '@' | '#');
    if !(path.is_empty() || path.starts_with('/')) || path.contains("//") || path.contains(forbidden) {
        return Err(outside());
    }
    if raw_query.is_some_and(|query| query.contains(|character: char| character.is_control() || character == '#')) {
        return Err(outside());
    }
    // Un segment encodé (« %2e%2e », « %2f ») est jugé une fois décodé, comme le fera le serveur.
    for segment in path.split('/') {
        let decoded = decode_percent(segment);
        if decoded == ".." || decoded == "." || decoded.contains(['/', '\\']) {
            return Err(outside());
        }
    }
    let prefix = base.path().trim_end_matches('/').to_string();
    let mut url = base.clone();
    url.set_path(&format!("{prefix}{path}"));
    url.set_query(raw_query.filter(|query| !query.is_empty()));
    url.set_fragment(None);
    if let Some(query) = query {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            let text = match value {
                Value::Null => continue,
                Value::String(text) => text.clone(),
                Value::Number(_) | Value::Bool(_) => value.to_string(),
                _ => {
                    return Err(AppError::new(format!(
                        "Paramètre « {name} » invalide : texte, nombre ou booléen attendu."
                    )))
                }
            };
            pairs.append_pair(name, &text);
        }
    }
    if let Some(reserved) = reserved_param {
        if url.query_pairs().any(|(name, _)| name == reserved) {
            return Err(AppError::new(format!("Le paramètre « {reserved} » est fixé par Alfred pour ce client.")));
        }
    }
    // Dernier filet : quoi qu’ait laissé passer l’analyse ci-dessus, l’adresse finale reste sous l’adresse de base.
    let inside = url.path() == prefix || url.path().starts_with(&format!("{prefix}/"));
    if url.origin() != base.origin() || !inside {
        return Err(outside());
    }
    Ok(url)
}

struct Call<'a> {
    method: Method,
    path: &'a str,
    query: Option<&'a Map<String, Value>>,
    headers: Option<&'a Map<String, Value>>,
    body: Option<&'a Value>,
}

fn method_of(name: Option<&str>) -> AppResult<Method> {
    match name.unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        "HEAD" => Ok(Method::HEAD),
        other => Err(AppError::new(format!("Méthode HTTP non prise en charge : {other}."))),
    }
}

async fn read_limited(response: &mut reqwest::Response, secrets: &[String]) -> AppResult<Vec<u8>> {
    let too_large = || AppError::new("Réponse trop volumineuse : plus de 20 Mo.");
    if response.content_length().is_some_and(|length| length > MAX_BODY as u64) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| network_error(error, secrets))? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Exécute la requête d’un client et renvoie `{status, ok, headers, body}`.
async fn perform(state: &Arc<AppState>, client: &Client, call: &Call<'_>) -> AppResult<Value> {
    client.validate()?;
    ensure_trusted(state, client)?;
    let reserved_param = client.auth.query_param.as_deref().filter(|_| client.auth.kind == AuthKind::ApiKey);
    let url = build_url(&client.base()?, call.path, call.query, reserved_param)?;

    let invalid_header = |name: &str| AppError::new(format!("L’en-tête « {name} » n’est pas valide."));
    let mut headers = HeaderMap::new();
    for (name, value) in &client.headers {
        let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid_header(name))?;
        headers.insert(header, HeaderValue::from_str(value).map_err(|_| invalid_header(name))?);
    }
    let api_header = client.auth.header.as_deref().filter(|_| client.auth.kind == AuthKind::ApiKey);
    for (name, value) in call.headers.into_iter().flatten() {
        let lower = name.to_ascii_lowercase();
        if RESERVED_HEADERS.contains(&lower.as_str())
            || api_header.is_some_and(|header| header.eq_ignore_ascii_case(name))
        {
            return Err(AppError::new(format!(
                "L’en-tête « {name} » est fixé par Alfred : une page ne peut pas le définir."
            )));
        }
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Number(_) | Value::Bool(_) => value.to_string(),
            _ => return Err(invalid_header(name)),
        };
        let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid_header(name))?;
        headers.insert(header, HeaderValue::from_str(&text).map_err(|_| invalid_header(name))?);
    }
    let body = match call.body {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone().into_bytes()),
        Some(value) => {
            headers.entry(CONTENT_TYPE).or_insert(HeaderValue::from_static("application/json"));
            Some(serde_json::to_vec(value)?)
        }
    };

    let http = http()?;
    let mut stale: Option<String> = None;
    loop {
        let credential = credential(state, client, stale.as_deref()).await?;
        let mut target = url.clone();
        for (name, value) in &credential.query {
            target.query_pairs_mut().append_pair(name, value);
        }
        let mut sent = headers.clone();
        for (name, value) in &credential.headers {
            let mut value = HeaderValue::from_str(value).map_err(|_| {
                AppError::new(format!(
                    "Le secret du client « {} » contient des caractères qu’un en-tête HTTP n’accepte pas.",
                    client.label
                ))
            })?;
            value.set_sensitive(true);
            // Posé en dernier : rien de ce qui précède ne peut remplacer l’authentification.
            sent.insert(name.clone(), value);
        }
        let mut request = http.request(call.method.clone(), target).headers(sent);
        if let Some(body) = &body {
            request = request.body(body.clone());
        }
        let mut response = request.send().await.map_err(|error| network_error(error, &credential.secrets))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && stale.is_none() && credential.renewable.is_some() {
            // Jeton refusé avant l’heure (révoqué, horloge décalée) : on en redemande un, une seule fois.
            stale = credential.renewable;
            continue;
        }

        let status = response.status();
        let mut received = Map::new();
        for (name, value) in response.headers() {
            // Alfred ne gère pas de session par cookie : une page n’a pas à en récolter.
            if name == SET_COOKIE {
                continue;
            }
            let text = redact(&String::from_utf8_lossy(value.as_bytes()), &credential.secrets);
            match received.get_mut(name.as_str()) {
                Some(Value::String(existing)) => {
                    existing.push_str(", ");
                    existing.push_str(&text);
                }
                _ => {
                    received.insert(name.as_str().to_string(), Value::String(text));
                }
            }
        }
        let is_json = received.get("content-type").and_then(Value::as_str).is_some_and(|kind| kind.contains("json"));
        let bytes = read_limited(&mut response, &credential.secrets).await?;
        // Un service qui renvoie la requête en écho ne doit pas livrer le secret à la page.
        let text = redact(&String::from_utf8_lossy(&bytes), &credential.secrets);
        let body = match serde_json::from_str::<Value>(&text) {
            Ok(value) if is_json => value,
            _ => Value::String(text),
        };
        return Ok(json!({ "status": status.as_u16(), "ok": status.is_success(), "headers": received, "body": body }));
    }
}

/// Issue d’une requête pour le journal : le statut HTTP s’il y en a un, et le texte du résumé.
fn outcome_of(result: &AppResult<Value>) -> (Option<u64>, String) {
    match result {
        Ok(value) => match value.get("status").and_then(Value::as_u64) {
            Some(status) => (Some(status), status.to_string()),
            None => (None, "échec".to_string()),
        },
        Err(error) => (None, format!("échec : {}", error.message)),
    }
}

/// Trace d’une requête au journal : qui, quoi, combien de temps. Ni paramètres, ni en-têtes, ni corps.
fn journal(
    state: &AppState,
    space: &Space,
    client: &Client,
    call: &Call<'_>,
    requester: (&str, &str),
    started: Instant,
    (status, outcome): (Option<u64>, String),
) {
    let duration = started.elapsed().as_millis() as u64;
    let path: String = call.path.split('?').next().unwrap_or_default().chars().take(200).collect();
    let path = if path.is_empty() { "/".to_string() } else { path };
    let summary = format!("{} {path} → {outcome}", call.method);
    let detail =
        json!({ "requester": requester.1, "requesterKind": requester.0, "durationMs": duration, "status": status });
    let root = space.root.to_string_lossy();
    let entry = JournalEntry {
        space: &root,
        kind: "client",
        subject: &client.id,
        status: if status.is_some_and(|status| status < 400) { "ok" } else { "error" },
        duration_ms: Some(duration),
        summary: &summary,
        detail: Some(&detail),
    };
    // Un journal indisponible ne fait pas échouer la requête qui, elle, a eu lieu.
    let recorded =
        state.app_db.lock().map_err(|_| ()).and_then(|db| app_db::record_journal(&db, &entry).map_err(|_| ()));
    if recorded.is_err() {
        log::warn!("journal indisponible pour la requête du client {}", client.id);
    }
}

fn object<'a>(args: &'a Value, name: &str) -> AppResult<Option<&'a Map<String, Value>>> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(fields)) => Ok(Some(fields)),
        Some(_) => Err(AppError::new(format!("Argument « {name} » invalide : un objet est attendu."))),
    }
}

async fn frame_request(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let name: String = arg(args, "client")?;
    let space = state.space()?;
    let client = resolve(&space, &subject.module, &name)?;
    let path: String = arg(args, "path")?;
    let call = Call {
        method: method_of(opt_arg::<String>(args, "method")?.as_deref())?,
        path: &path,
        query: object(args, "query")?,
        headers: object(args, "headers")?,
        body: args.get("body"),
    };
    let requester = (subject.kind.as_str(), subject.reference.as_str());
    let started = Instant::now();
    // Un client à valider est refusé avant même de demander l’accord : on ne fait pas autoriser à l’utilisateur
    // un client dont il n’a pas vu l’adresse.
    if let Err(error) = ensure_trusted(state, &client) {
        journal(state, &space, &client, &call, requester, started, outcome_of(&Err(error.clone())));
        return Err(error);
    }
    let resource = format!("client:{}", client.id);
    // Le libellé n’est pas dans l’empreinte validée : la question montre aussi l’identifiant et l’adresse validés.
    let label = format!("le client {} (« {} », {})", client.label, client.id, canonical_url(&client.base_url, true));
    if let Err(error) = permissions::ensure(state, &subject, &resource, &label).await {
        // Un refus est une tentative d’accès : elle doit se retrouver au journal comme une requête.
        journal(state, &space, &client, &call, requester, started, (None, "accès refusé".to_string()));
        return Err(error);
    }
    let started = Instant::now();
    let result = perform(state, &client, &call).await;
    journal(state, &space, &client, &call, requester, started, outcome_of(&result));
    result
}

// ---------------------------------------------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------------------------------------------

/// État d’un client : `ready`, `toValidate`, `missingSecret`, `toConnect` ou `invalid`, avec le détail qui
/// l’explique.
fn describe(state: &AppState, client: &Client, used_by: &[Value]) -> Value {
    let mut item = serde_json::to_value(client).unwrap_or_else(|_| json!({}));
    let auth = &client.auth;
    let mut problem = client.validate().err().map(|error| error.message);
    let (mut has_secret, mut connected) = (auth.kind == AuthKind::None, None);
    if let Some(kind) = auth.kind.vault_kind() {
        let entry = auth.secret.as_deref().and_then(|id| vault::entry(state, id).ok().flatten());
        match entry.filter(|entry| entry.kind == kind) {
            Some(entry) => match vault::secret_state(&entry) {
                Ok(secret) => {
                    // Une application OAuth publique (PKCE) n’a pas de secret client : l’entrée suffit.
                    has_secret = secret.has_secret || auth.kind == AuthKind::Oauth2;
                    if auth.kind == AuthKind::Oauth2 {
                        connected = Some(secret.connected);
                    }
                }
                Err(error) => problem = problem.or(Some(error.message)),
            },
            None if auth.kind == AuthKind::Oauth2 => connected = Some(false),
            None => {}
        }
    }
    // Validation : ce que l’utilisateur a approuvé, comparé à ce que dit le fichier aujourd’hui.
    let validation = (auth.kind != AuthKind::None).then(|| {
        let current = fingerprint(client);
        let stored = state.try_space().and_then(|space| trusted_fingerprint(state, &space, &client.id).ok().flatten());
        json!({
            "validated": stored.as_ref() == Some(&current),
            "everValidated": stored.is_some(),
            "changes": trust_changes(stored.as_ref(), &current),
            "fingerprint": current,
        })
    });
    let to_validate = validation.as_ref().is_some_and(|validation| validation["validated"] == json!(false));
    let status = if client.validate().is_err() {
        "invalid"
    } else if to_validate {
        "toValidate"
    } else if !has_secret {
        "missingSecret"
    } else if connected == Some(false) {
        "toConnect"
    } else {
        "ready"
    };
    item["status"] = json!(status);
    item["hasSecret"] = json!(has_secret);
    item["connected"] = json!(connected);
    item["usedBy"] = json!(used_by);
    item["problem"] = json!(problem);
    item["validation"] = json!(validation);
    item
}

fn list(state: &Arc<AppState>) -> AppResult<Value> {
    let space = state.space()?;
    let bindings = space.manifest()?.bindings;
    let loaded = load_all(&space);
    let exists = |id: &str| loaded.iter().any(|(known, _)| known == id);

    // Demandes des modules : ce que chaque module déclare vouloir, et le client qui y répond aujourd’hui.
    let mut needs = Vec::new();
    for module_id in space.module_ids() {
        let Ok(module) = space.module(&module_id) else { continue };
        for need in &module.clients {
            let key = format!("{module_id}/{}", need.id);
            let binding = bindings.get(&key).cloned();
            let resolved = match &binding {
                Some(bound) => exists(bound).then(|| bound.clone()),
                None => exists(&need.id).then(|| need.id.clone()),
            };
            needs.push(json!({
                "key": key,
                "module": module_id,
                "moduleName": if module.name.is_empty() { &module_id } else { &module.name },
                "id": need.id,
                "label": if need.label.is_empty() { &need.id } else { &need.label },
                "baseUrl": need.base_url,
                "auth": need.auth,
                "binding": binding,
                "client": resolved,
            }));
        }
    }

    let clients: Vec<Value> = loaded
        .iter()
        .map(|(id, client)| {
            let used_by: Vec<Value> = needs
                .iter()
                .filter(|need| need["client"].as_str() == Some(id))
                .map(|need| json!({ "key": need["key"], "module": need["module"], "moduleName": need["moduleName"], "label": need["label"] }))
                .collect();
            match client {
                Ok(client) => describe(state, client, &used_by),
                Err(error) => json!({
                    "id": id, "label": id, "baseUrl": "", "auth": { "type": "none" },
                    "status": "invalid", "hasSecret": false, "connected": null, "usedBy": used_by, "problem": error.message,
                    "validation": null,
                }),
            }
        })
        .collect();
    Ok(json!({ "clients": clients, "needs": needs, "redirectUri": oauth::redirect_uri(state).ok() }))
}

/// Écrit le fichier d’un client. `validated` distingue les deux origines : l’utilisateur, dans les Réglages, dont
/// l’enregistrement vaut validation, et l’agent, dont le client naît ou redevient « à valider ».
fn write_client(state: &Arc<AppState>, args: &Value, validated: bool) -> AppResult<Value> {
    let space = state.space()?;
    let mut client: Client = arg(args, "client")?;
    client.normalize();
    client.validate()?;
    let path = client_path(&space, &client.id);
    if opt_arg::<bool>(args, "create")?.unwrap_or(false) && path.exists() {
        return Err(AppError::new(format!("Un client porte déjà l’identifiant « {} ».", client.id)));
    }
    // Une entrée absente du coffre est admise (le fichier voyage entre postes, pas le coffre), mais pas une entrée
    // du mauvais type : la requête échouerait à chaque fois.
    if let (Some(secret), Some(kind)) = (&client.auth.secret, client.auth.kind.vault_kind()) {
        if vault::entry(state, secret)?.is_some_and(|entry| entry.kind != kind) {
            return Err(AppError::new(
                "L’entrée du coffre choisie n’est pas du type attendu par cette authentification.",
            ));
        }
    }
    std::fs::create_dir_all(clients_dir(&space))?;
    write_json(&path, &client)?;
    if validated {
        record_trust(state, &space, &client)?;
    }
    let message = if validated {
        format!("Client {}", client.label)
    } else {
        format!("Client {} (déclaré par l’agent)", client.label)
    };
    git::commit_all(&space.root, &message)?;
    state.emit("clients:changed", json!({ "client": client.id }));
    Ok(describe(state, &client, &[]))
}

/// Validation depuis les Réglages : l’utilisateur a vu les valeurs (`fingerprint`, tel que la liste le lui a
/// montré) et les approuve. Si le fichier a encore changé entre-temps, rien n’est validé.
fn validate_client(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let client = require(&space, &arg::<String>(args, "id")?)?;
    client.validate()?;
    if args.get("fingerprint") != Some(&fingerprint(&client)) {
        return Err(AppError::new(format!(
            "Le client « {} » a changé depuis l’affichage de ses valeurs. Les relire avant de le valider.",
            client.label
        )));
    }
    record_trust(state, &space, &client)?;
    state.emit("clients:changed", json!({ "client": client.id }));
    Ok(describe(state, &client, &[]))
}

/// Validation par l’agent, à la demande de l’utilisateur qui lui a confié le réglage : le client est approuvé tel que
/// son fichier le décrit aujourd’hui. Toute modification ultérieure le remettra « à valider ».
pub fn validate_by_agent(state: &Arc<AppState>, id: &str) -> AppResult<Value> {
    let space = state.space()?;
    let client = require(&space, id)?;
    client.validate()?;
    record_trust(state, &space, &client)?;
    state.emit("clients:changed", json!({ "client": client.id }));
    Ok(describe(state, &client, &[]))
}

fn delete(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let id: String = arg(args, "id")?;
    if !valid_id(&id) || !client_path(&space, &id).is_file() {
        return Err(AppError::new(format!("Le client « {id} » n’existe pas dans cet espace.")));
    }
    let label = load(&space, &id).ok().flatten().map(|client| client.label).unwrap_or_else(|| id.clone());
    std::fs::remove_file(client_path(&space, &id))?;
    // Les demandes reliées à ce client redeviennent « à relier » plutôt que de pointer dans le vide.
    let mut manifest = space.manifest()?;
    let before = manifest.bindings.len();
    manifest.bindings.retain(|_, bound| bound != &id);
    if manifest.bindings.len() != before {
        space.write_manifest(&manifest)?;
    }
    {
        // Un futur client du même identifiant ne doit hériter ni de la validation ni des accords de celui-ci.
        let db = trust_db(state)?;
        db.execute("DELETE FROM client_trust WHERE space = ?1 AND client = ?2", params![space_key(&space), id])?;
        db.execute(
            "DELETE FROM grants WHERE space = ?1 AND resource = ?2",
            params![space_key(&space), format!("client:{id}")],
        )?;
    }
    git::commit_all(&space.root, &format!("Suppression du client {label}"))?;
    state.emit("clients:changed", json!({ "client": id }));
    Ok(Value::Null)
}

fn bind(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let need: String = arg(args, "need")?;
    let client: Option<String> = opt_arg(args, "client")?;
    if !need.split_once('/').is_some_and(|(module, name)| valid_id(module) && valid_id(name)) {
        return Err(AppError::new(format!("Demande invalide : « {need} ». La forme attendue est « module/client ».")));
    }
    let mut manifest = space.manifest()?;
    match client.filter(|client| !client.is_empty()) {
        Some(client) => {
            require(&space, &client)?;
            manifest.bindings.insert(need.clone(), client);
        }
        None => {
            manifest.bindings.remove(&need);
        }
    }
    space.write_manifest(&manifest)?;
    git::commit_all(&space.root, &format!("Liaison de la demande {need}"))?;
    state.emit("clients:changed", json!({ "need": need }));
    Ok(json!({ "bindings": manifest.bindings }))
}

async fn test_client(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let client = require(&space, &arg::<String>(args, "id")?)?;
    let path = opt_arg::<String>(args, "path")?.unwrap_or_default();
    let call = Call { method: Method::GET, path: &path, query: None, headers: None, body: None };
    let started = Instant::now();
    let result = perform(state, &client, &call).await;
    journal(state, &space, &client, &call, ("settings", "Réglages"), started, outcome_of(&result));
    let duration = started.elapsed().as_millis() as u64;
    // Un test raté est un résultat, pas une erreur de commande : l’écran l’affiche à côté du client.
    Ok(match result {
        Ok(response) => {
            let status = response["status"].as_u64().unwrap_or_default();
            let message = match status {
                200..=399 => format!("Le service répond ({status})."),
                401 | 403 => format!("Le service refuse l’authentification ({status})."),
                _ => format!("Le service répond par une erreur ({status})."),
            };
            json!({ "ok": status < 400, "status": status, "durationMs": duration, "message": message })
        }
        Err(error) => json!({ "ok": false, "status": null, "durationMs": duration, "message": error.message }),
    })
}

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    let result = match command {
        "frame.clients.request" => frame_request(state, args).await,
        "clients.test" => test_client(state, args).await,
        "clients.connect" => match state.space().and_then(|space| require(&space, &arg::<String>(args, "id")?)) {
            Ok(client) => oauth::begin(state, &client).await.map(|url| json!({ "authorizationUrl": url })),
            Err(error) => Err(error),
        },
        "clients.disconnect" => match state.space().and_then(|space| require(&space, &arg::<String>(args, "id")?)) {
            Ok(client) => oauth::disconnect(state, &client).await,
            Err(error) => Err(error),
        },
        "clients.list" | "clients.save" | "clients.declare" | "clients.validate" | "clients.delete"
        | "clients.bind" => {
            // Lecture du trousseau et git : hors des fils asynchrones.
            let (state, command, args) = (state.clone(), command.to_string(), args.clone());
            vault::blocking(move || match command.as_str() {
                "clients.list" => list(&state),
                "clients.save" => write_client(&state, &args, true),
                "clients.declare" => write_client(&state, &args, false),
                "clients.validate" => validate_client(&state, &args),
                "clients.delete" => delete(&state, &args),
                _ => bind(&state, &args),
            })
            .await
        }
        _ => return None,
    };
    Some(result)
}

/// Routes HTTP locales de ce module (retour des connexions SSO).
pub fn routes() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route("/oauth/callback", axum::routing::get(oauth::callback))
}

/// Outils des tests de parcours : un espace jetable, et un serveur local qui joue le service distant et son
/// serveur de jetons.
#[cfg(test)]
mod redaction_tests {
    use super::*;

    /// Un service qui renvoie la requête en écho, sous une forme transformée, ne livre pas le secret à la page.
    #[test]
    fn a_secret_echoed_in_another_form_is_still_masked() {
        let secret = "s3cr3t/+= é&x".to_string();
        let engine = &base64::engine::general_purpose::STANDARD;
        let echoes = [
            format!("valeur {secret}"),
            format!("q={}", url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>()),
            format!("{{\"a\":{}}}", serde_json::to_string(&secret).unwrap()),
            r#"{"a":"s3cr3t\/+= é&x"}"#.to_string(),
            format!("auth {}", engine.encode(&secret)),
        ];
        for echo in echoes {
            let masked = redact(&echo, std::slice::from_ref(&secret));
            assert!(masked.contains(MASK), "{echo} → {masked}");
            assert!(!masked.contains("s3cr3t"), "{echo} → {masked}");
        }
        assert!(RESERVED_HEADERS.contains(&"range"));
    }
}

#[cfg(test)]
pub mod testing {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use axum::extract::State;
    use axum::http::{HeaderMap as AxumHeaders, Method as AxumMethod, StatusCode, Uri};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{any, get, post};
    use axum::{Json, Router};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::state::ServerInfo;

    /// Le trousseau des tests est commun à tout le processus : chaque test prend des identifiants à lui.
    pub fn unique(name: &str) -> String {
        format!("{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
    }

    pub fn test_state() -> (Arc<AppState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("alfred")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        state.set_space(Some(space));
        (state, dir)
    }

    pub async fn invoke(state: &Arc<AppState>, command: &str, args: Value) -> AppResult<Value> {
        crate::dispatch::dispatch(state.clone(), command, args).await
    }

    pub fn page_subject(module: &str) -> Subject {
        Subject { kind: "page".to_string(), module: module.to_string(), reference: format!("{module}/accueil") }
    }

    /// L’accord passe normalement par une question à l’interface ; les tests l’accordent d’avance.
    pub fn grant(state: &Arc<AppState>, subject: &Subject, client: &str) {
        let space = state.space().unwrap().root.to_string_lossy().to_string();
        let db = state.app_db.lock().unwrap();
        app_db::grant(&db, &space, &subject.key(), &format!("client:{client}")).unwrap();
    }

    pub async fn request(state: &Arc<AppState>, subject: &Subject, client: &str, call: Value) -> AppResult<Value> {
        let mut args = call;
        args["subject"] = serde_json::to_value(subject).unwrap();
        args["client"] = json!(client);
        invoke(state, "frame.clients.request", args).await
    }

    /// Démarre les routes locales d’Alfred (retour OAuth) et déclare leur port, comme le fait `server::start`.
    pub async fn local_server(state: &Arc<AppState>) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = state.server.set(ServerInfo { port });
        let router = routes().with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        port
    }

    #[derive(Debug, Clone)]
    pub struct Seen {
        pub method: String,
        pub path: String,
        pub query: String,
        pub headers: HashMap<String, String>,
        pub body: String,
    }

    #[derive(Default)]
    pub struct RemoteState {
        /// Requêtes reçues par le service (hors serveur de jetons).
        pub seen: Mutex<Vec<Seen>>,
        /// Formulaires reçus par le serveur de jetons.
        pub token_requests: Mutex<Vec<HashMap<String, String>>>,
        pub valid_tokens: Mutex<HashSet<String>>,
        pub refresh_tokens: Mutex<HashSet<String>>,
        /// Codes d’autorisation délivrés → défi PKCE annoncé à l’autorisation.
        pub codes: Mutex<HashMap<String, String>>,
        pub issued: AtomicUsize,
        /// Le serveur de jetons n’accepte l’application que par l’en-tête Basic.
        pub basic_only: AtomicBool,
    }

    pub const REMOTE_CLIENT_ID: &str = "alfred-app";
    pub const REMOTE_CLIENT_SECRET: &str = "cl13nt-s3cr3t-ZZZ";

    pub struct Remote {
        pub origin: String,
        pub state: Arc<RemoteState>,
    }

    impl Remote {
        pub fn last(&self) -> Seen {
            self.state.seen.lock().unwrap().last().cloned().expect("aucune requête reçue")
        }

        pub fn seen_paths(&self) -> Vec<String> {
            self.state.seen.lock().unwrap().iter().map(|seen| seen.path.clone()).collect()
        }

        pub fn token_grants(&self) -> Vec<String> {
            self.state.token_requests.lock().unwrap().iter().map(|form| form["grant_type"].clone()).collect()
        }

        pub fn revoke_access_tokens(&self) {
            self.state.valid_tokens.lock().unwrap().clear();
        }
    }

    fn record(remote: &RemoteState, method: &AxumMethod, uri: &Uri, headers: &AxumHeaders, body: &str) -> Seen {
        let seen = Seen {
            method: method.to_string(),
            path: uri.path().to_string(),
            query: uri.query().unwrap_or_default().to_string(),
            headers: headers
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_str().unwrap_or_default().to_string()))
                .collect(),
            body: body.to_string(),
        };
        remote.seen.lock().unwrap().push(seen.clone());
        seen
    }

    /// Renvoie la requête reçue, authentification comprise : sert aussi à vérifier qu’Alfred masque cet écho.
    async fn echo(
        State(remote): State<Arc<RemoteState>>,
        method: AxumMethod,
        uri: Uri,
        headers: AxumHeaders,
        body: String,
    ) -> Response {
        let seen = record(&remote, &method, &uri, &headers, &body);
        let mut response = Json(json!({
            "method": seen.method, "path": seen.path, "query": seen.query, "headers": seen.headers, "body": seen.body,
        }))
        .into_response();
        if let Some(authorization) = headers.get("authorization") {
            response.headers_mut().insert("x-echo-authorization", authorization.clone());
        }
        response.headers_mut().insert("set-cookie", "session=abc".parse().unwrap());
        response
    }

    async fn protected(
        State(remote): State<Arc<RemoteState>>,
        method: AxumMethod,
        uri: Uri,
        headers: AxumHeaders,
    ) -> Response {
        let seen = record(&remote, &method, &uri, &headers, "");
        let token =
            seen.headers.get("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default();
        if remote.valid_tokens.lock().unwrap().contains(token) {
            Json(json!({ "user": "alice" })).into_response()
        } else {
            (StatusCode::UNAUTHORIZED, Json(json!({ "error": "invalid_token" }))).into_response()
        }
    }

    async fn token(State(remote): State<Arc<RemoteState>>, headers: AxumHeaders, body: String) -> Response {
        let mut form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
        // Authentification Basic : identifiant et secret encodés comme un formulaire, puis en Base64.
        let basic = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()?.strip_prefix("Basic ").map(str::to_string))
            .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok());
        let in_body = form.contains_key("client_secret");
        if let Some((id, secret)) = basic.as_deref().and_then(|pair| pair.split_once(':')) {
            let decode =
                |text: &str| url::form_urlencoded::parse(format!("v={text}").as_bytes()).next().unwrap().1.into_owned();
            form.insert("client_id".to_string(), decode(id));
            form.insert("client_secret".to_string(), decode(secret));
        }
        form.insert("_auth".to_string(), if basic.is_some() { "basic" } else { "body" }.to_string());
        remote.token_requests.lock().unwrap().push(form.clone());
        if remote.basic_only.load(Ordering::SeqCst) && in_body {
            let refused = json!({ "error": "invalid_client", "error_description": "Authentification Basic exigée" });
            return (StatusCode::UNAUTHORIZED, Json(refused)).into_response();
        }
        let field = |name: &str| form.get(name).map(String::as_str).unwrap_or_default();
        let refuse = |error: &str, description: &str| {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": error, "error_description": description }))).into_response()
        };
        if field("client_id") != REMOTE_CLIENT_ID {
            return refuse("invalid_client", "Application inconnue");
        }
        let with_refresh = match field("grant_type") {
            "client_credentials" => {
                if field("client_secret") != REMOTE_CLIENT_SECRET {
                    return refuse("invalid_client", "Secret client refusé");
                }
                false
            }
            "authorization_code" => {
                let Some(challenge) = remote.codes.lock().unwrap().remove(field("code")) else {
                    return refuse("invalid_grant", "Code inconnu ou déjà utilisé");
                };
                let digest = Sha256::digest(field("code_verifier").as_bytes());
                let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
                if expected != challenge || !field("redirect_uri").ends_with("/oauth/callback") {
                    return refuse("invalid_grant", "Vérification PKCE refusée");
                }
                true
            }
            "refresh_token" => {
                if !remote.refresh_tokens.lock().unwrap().remove(field("refresh_token")) {
                    return refuse("invalid_grant", "Jeton de rafraîchissement refusé");
                }
                true
            }
            _ => return refuse("unsupported_grant_type", "Type de demande inconnu"),
        };
        let number = remote.issued.fetch_add(1, Ordering::SeqCst) + 1;
        let access = format!("acc3ss-t0k3n-{number}");
        remote.valid_tokens.lock().unwrap().insert(access.clone());
        let mut tokens = json!({ "access_token": access, "token_type": "Bearer", "expires_in": 3600 });
        if with_refresh {
            let refresh = format!("r3fr3sh-t0k3n-{number}");
            remote.refresh_tokens.lock().unwrap().insert(refresh.clone());
            tokens["refresh_token"] = json!(refresh);
        }
        Json(tokens).into_response()
    }

    /// Service distant sur `http://127.0.0.1:<port>` : l’API sous `/api`, le serveur de jetons sur `/token`, et
    /// `/prive` hors de l’adresse de base des clients.
    pub async fn remote() -> Remote {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(RemoteState::default());
        let elsewhere = format!("http://localhost:{port}/api/echo");
        let router = Router::new()
            .route("/api/echo", any(echo))
            .route("/api/echo/{*rest}", any(echo))
            .route("/prive", any(echo))
            .route("/api/protected", get(protected))
            .route("/api/texte", get(|| async { "bonjour" }))
            .route("/api/enorme", get(|| async { vec![b'x'; MAX_BODY + 1] }))
            .route(
                "/api/vers-la-meme-origine",
                get(|| async { (StatusCode::FOUND, [("location", "/api/echo?suivi=oui")]) }),
            )
            .route(
                "/api/vers-ailleurs",
                get(move || {
                    let elsewhere = elsewhere.clone();
                    async move { (StatusCode::FOUND, [("location", elsewhere)]) }
                }),
            )
            .route("/token", post(token))
            .with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Remote { origin: format!("http://127.0.0.1:{port}"), state }
    }

    /// Vérifie qu’aucun des secrets ne figure dans ce qu’une commande a renvoyé.
    pub fn assert_no_leak(what: &str, text: &str, secrets: &[&str]) {
        for secret in secrets {
            assert!(!text.contains(secret), "{what} : le secret « {secret} » a fui dans « {text} »");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    const TOKEN: &str = "t0k3n-b34r3r-AAA";
    const API_KEY: &str = "k3y-4p1-BBB";
    const PASSWORD: &str = "p4ssw0rd-CCC";
    const SECRETS: [&str; 6] =
        [TOKEN, API_KEY, PASSWORD, REMOTE_CLIENT_SECRET, "acc3ss-t0k3n", "YWxpY2U6cDRzc3cwcmQtQ0ND"];

    async fn save_client(state: &Arc<AppState>, client: Value) -> Value {
        invoke(state, "clients.save", json!({ "client": client })).await.unwrap()
    }

    #[tokio::test]
    async fn every_auth_type_reaches_the_service_without_leaking_its_secret() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let base = format!("{}/api", remote.origin);
        let subject = page_subject("crm");
        let mut outputs: Vec<Value> = Vec::new();

        let (token_id, key_id, basic_id, machine_id) =
            (unique("jeton"), unique("cle"), unique("compte"), unique("machine"));
        for entry in [
            json!({ "id": token_id, "label": "Jeton", "kind": "token", "secrets": { "value": TOKEN } }),
            json!({ "id": key_id, "label": "Clé", "kind": "token", "secrets": { "value": API_KEY } }),
            json!({ "id": basic_id, "label": "Compte", "kind": "basic", "meta": { "username": "alice" }, "secrets": { "password": PASSWORD } }),
            json!({ "id": machine_id, "label": "Machine", "kind": "clientCredentials", "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": REMOTE_CLIENT_SECRET } }),
        ] {
            outputs.push(invoke(&state, "vault.save", entry).await.unwrap());
        }
        for client in [
            json!({ "id": "public", "label": "Public", "baseUrl": base, "auth": { "type": "none" }, "headers": { "Accept": "application/json" } }),
            json!({ "id": "porteur", "label": "Porteur", "baseUrl": base, "auth": { "type": "bearer", "secret": token_id } }),
            json!({ "id": "entete", "label": "En-tête", "baseUrl": base, "auth": { "type": "apiKey", "secret": key_id, "header": "X-Api-Key", "prefix": "Token " } }),
            json!({ "id": "parametre", "label": "Paramètre", "baseUrl": base, "auth": { "type": "apiKey", "secret": key_id, "queryParam": "api_key" } }),
            json!({ "id": "basique", "label": "Basique", "baseUrl": base, "auth": { "type": "basic", "secret": basic_id } }),
            json!({ "id": "machine", "label": "Machine", "baseUrl": base, "auth": { "type": "clientCredentials", "secret": machine_id, "tokenUrl": format!("{}/token", remote.origin), "scopes": ["lecture"] } }),
        ] {
            let id = client["id"].as_str().unwrap().to_string();
            let saved = save_client(&state, client).await;
            assert_eq!(saved["status"], json!("ready"), "{id}");
            grant(&state, &subject, &id);
            outputs.push(saved);
        }

        // Sans authentification : en-têtes fixes du client, en-têtes et paramètres de la page, corps JSON.
        let response = request(
            &state,
            &subject,
            "public",
            json!({ "method": "POST", "path": "/echo/tickets?tri=date", "query": { "page": 2, "ouvert": true }, "headers": { "X-Trace": "abc" }, "body": { "titre": "Bonjour" } }),
        )
        .await
        .unwrap();
        assert_eq!((response["status"].clone(), response["ok"].clone()), (json!(200), json!(true)));
        assert_eq!(response["body"]["path"], json!("/api/echo/tickets"));
        assert_eq!(response["headers"]["content-type"], json!("application/json"));
        assert!(response["headers"].get("set-cookie").is_none());
        let seen = remote.last();
        assert_eq!(seen.method, "POST");
        assert!(seen.query.starts_with("tri=date&"), "{}", seen.query);
        assert!(seen.query.contains("page=2") && seen.query.contains("ouvert=true"), "{}", seen.query);
        assert_eq!(seen.headers["accept"], "application/json");
        assert_eq!(seen.headers["x-trace"], "abc");
        assert_eq!(seen.headers["content-type"], "application/json");
        assert_eq!(seen.body, r#"{"titre":"Bonjour"}"#);
        assert!(!seen.headers.contains_key("authorization"));
        outputs.push(response);

        // Jeton porteur. Le service renvoie la requête en écho : la page reçoit la réponse sans le secret.
        let response = request(&state, &subject, "porteur", json!({ "path": "/echo" })).await.unwrap();
        assert_eq!(remote.last().headers["authorization"], format!("Bearer {TOKEN}"));
        assert_eq!(response["body"]["headers"]["authorization"], json!(format!("Bearer {MASK}")));
        assert_eq!(response["headers"]["x-echo-authorization"], json!(format!("Bearer {MASK}")));
        outputs.push(response);

        // Clé d’API dans un en-tête, avec préfixe, puis dans un paramètre d’URL.
        outputs.push(request(&state, &subject, "entete", json!({ "path": "/echo" })).await.unwrap());
        assert_eq!(remote.last().headers["x-api-key"], format!("Token {API_KEY}"));
        outputs.push(
            request(&state, &subject, "parametre", json!({ "path": "/echo", "query": { "q": "a b" } })).await.unwrap(),
        );
        assert_eq!(remote.last().query, format!("q=a+b&api_key={API_KEY}"));

        // Identifiant et mot de passe.
        outputs.push(request(&state, &subject, "basique", json!({ "path": "/echo" })).await.unwrap());
        assert_eq!(remote.last().headers["authorization"], "Basic YWxpY2U6cDRzc3cwcmQtQ0ND");

        // Identifiants d’application : le jeton est demandé une fois puis réutilisé.
        let response = request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(response["body"], json!({ "user": "alice" }));
        request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(remote.token_grants(), ["client_credentials"]);
        assert_eq!(remote.state.token_requests.lock().unwrap()[0]["scope"], "lecture");
        outputs.push(response);

        // Une réponse qui n’est pas du JSON revient en texte.
        let response = request(&state, &subject, "public", json!({ "path": "/texte" })).await.unwrap();
        assert_eq!(response["body"], json!("bonjour"));

        // Le bouton Tester et la liste des réglages ne révèlent rien non plus.
        let tested = invoke(&state, "clients.test", json!({ "id": "porteur", "path": "/echo" })).await.unwrap();
        assert_eq!((tested["ok"].clone(), tested["status"].clone()), (json!(true), json!(200)));
        outputs.push(tested);
        outputs.push(invoke(&state, "clients.list", json!({})).await.unwrap());
        outputs.push(invoke(&state, "vault.list", json!({})).await.unwrap());

        // Journal : une ligne par requête, sans paramètres ni authentification.
        let journal = {
            let db = state.app_db.lock().unwrap();
            app_db::read_journal(&db, &state.space().unwrap().root.to_string_lossy(), Some("client"), 50).unwrap()
        };
        assert_eq!(journal.len(), 9);
        let line = journal.iter().find(|line| line["subject"] == json!("parametre")).unwrap();
        assert_eq!(line["summary"], json!("GET /echo → 200"));
        assert_eq!(line["status"], json!("ok"));
        assert_eq!(line["detail"]["requester"], json!("crm/accueil"));
        assert!(journal.iter().any(|line| line["summary"] == json!("POST /echo/tickets → 200")));
        assert!(journal.iter().any(|line| line["detail"]["requester"] == json!("Réglages")));

        assert_no_leak("réponses", &Value::Array(outputs).to_string(), &SECRETS);
        assert_no_leak("journal", &Value::Array(journal).to_string(), &SECRETS);
        // Le fichier versionné du client ne contient que l’identifiant de l’entrée du coffre.
        let file = std::fs::read_to_string(state.space().unwrap().root.join("clients/porteur.json")).unwrap();
        assert!(file.contains(&token_id));
        assert_no_leak("fichier du client", &file, &SECRETS);
    }

    #[tokio::test]
    async fn a_page_cannot_leave_the_base_address_or_set_the_authentication() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let subject = page_subject("crm");
        let key_id = unique("cle");
        invoke(
            &state,
            "vault.save",
            json!({ "id": key_id, "label": "Clé", "kind": "token", "secrets": { "value": API_KEY } }),
        )
        .await
        .unwrap();
        save_client(
            &state,
            json!({ "id": "api", "label": "API", "baseUrl": format!("{}/api/", remote.origin), "auth": { "type": "apiKey", "secret": key_id, "header": "X-Api-Key" } }),
        )
        .await;
        save_client(
            &state,
            json!({ "id": "param", "label": "Param", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "apiKey", "secret": key_id, "queryParam": "api_key" } }),
        )
        .await;
        grant(&state, &subject, "api");
        grant(&state, &subject, "param");

        // Le chemin normal passe, y compris un « @ » dans un paramètre.
        request(&state, &subject, "api", json!({ "path": "/echo/a%20b", "query": { "mail": "a@b.fr" } }))
            .await
            .unwrap();
        assert_eq!(remote.last().path, "/api/echo/a%20b");

        let elsewhere = format!("{}/prive", remote.origin);
        let escapes = [
            elsewhere.as_str(),
            "https://ailleurs.exemple.com/x",
            "//ailleurs.exemple.com/x",
            "/echo//ailleurs.exemple.com",
            "/../prive",
            "/echo/../../prive",
            "/echo/%2e%2e/%2E%2e/prive",
            "/echo/..%2f..%2fprive",
            "/.%2e/prive",
            "/echo\\..\\prive",
            "/@ailleurs.exemple.com/x",
            "/echo@ailleurs.exemple.com",
            "echo",
            "../prive",
            "/echo\t/x",
            "/echo#ancre",
        ];
        for path in escapes {
            let error = request(&state, &subject, "api", json!({ "path": path })).await.unwrap_err();
            assert!(error.message.starts_with("Chemin refusé"), "{path} : {}", error.message);
        }
        assert!(!remote.seen_paths().iter().any(|path| path.contains("prive")), "{:?}", remote.seen_paths());
        assert_eq!(remote.seen_paths().len(), 1, "aucune requête refusée ne doit partir");

        // La page ne fixe ni l’authentification, ni l’hôte, ni la clé du client.
        for header in ["Authorization", "cookie", "Host", "x-api-key", "Proxy-Authorization"] {
            let error = request(&state, &subject, "api", json!({ "path": "/echo", "headers": { header: "forgé" } }))
                .await
                .unwrap_err();
            assert!(error.message.contains("fixé par Alfred"), "{header} : {}", error.message);
        }
        let error = request(&state, &subject, "param", json!({ "path": "/echo", "query": { "api_key": "forgée" } }))
            .await
            .unwrap_err();
        assert!(error.message.contains("fixé par Alfred"), "{}", error.message);
        let error = request(&state, &subject, "param", json!({ "path": "/echo?api_key=forgée" })).await.unwrap_err();
        assert!(error.message.contains("fixé par Alfred"), "{}", error.message);
        let error = request(&state, &subject, "api", json!({ "method": "TRACE", "path": "/echo" })).await.unwrap_err();
        assert!(error.message.contains("Méthode HTTP"), "{}", error.message);
        assert_eq!(remote.seen_paths().len(), 1);

        // Un client inconnu, ou un nom qui viserait un autre fichier, donne une erreur claire.
        for name in ["inconnu", "../alfred", "api/../api"] {
            let error = request(&state, &subject, name, json!({ "path": "/echo" })).await.unwrap_err();
            assert!(error.message.contains("n’existe pas dans cet espace"), "{name} : {}", error.message);
        }

        // Les refus sont journalisés comme des échecs, sans rien de la clé.
        let journal = {
            let db = state.app_db.lock().unwrap();
            app_db::read_journal(&db, &state.space().unwrap().root.to_string_lossy(), Some("client"), 100).unwrap()
        };
        assert!(journal.iter().any(
            |line| line["status"] == json!("error") && line["summary"].as_str().unwrap().contains("Chemin refusé")
        ));
        assert_no_leak("journal", &Value::Array(journal).to_string(), &[API_KEY]);
    }

    #[tokio::test]
    async fn redirects_stay_on_the_origin_and_large_or_failed_responses_are_explicit() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let subject = page_subject("crm");
        let token_id = unique("jeton");
        invoke(
            &state,
            "vault.save",
            json!({ "id": token_id, "label": "Jeton", "kind": "token", "secrets": { "value": TOKEN } }),
        )
        .await
        .unwrap();
        save_client(
            &state,
            json!({ "id": "api", "label": "API", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "apiKey", "secret": token_id, "header": "X-Api-Key" } }),
        )
        .await;
        grant(&state, &subject, "api");

        // Même origine : la redirection est suivie.
        let response = request(&state, &subject, "api", json!({ "path": "/vers-la-meme-origine" })).await.unwrap();
        assert_eq!(response["status"], json!(200));
        assert_eq!(remote.last().query, "suivi=oui");

        // Autre origine : la redirection est rendue telle quelle, et la clé ne part pas.
        let before = remote.seen_paths().len();
        let response = request(&state, &subject, "api", json!({ "path": "/vers-ailleurs" })).await.unwrap();
        assert_eq!(response["status"], json!(302));
        assert_eq!(response["ok"], json!(false));
        assert!(response["headers"]["location"].as_str().unwrap().starts_with("http://localhost:"));
        assert_eq!(remote.seen_paths().len(), before, "la redirection vers une autre origine ne doit pas être suivie");

        // Réponse de plus de 20 Mo : refusée, avec un message clair.
        let error = request(&state, &subject, "api", json!({ "path": "/enorme" })).await.unwrap_err();
        assert!(error.message.contains("20 Mo"), "{}", error.message);

        // Service injoignable : l’erreur ne contient ni l’adresse complète ni la clé passée en paramètre.
        let closed = {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        save_client(
            &state,
            json!({ "id": "eteint", "label": "Éteint", "baseUrl": format!("http://127.0.0.1:{closed}"), "auth": { "type": "apiKey", "secret": token_id, "queryParam": "cle" } }),
        )
        .await;
        grant(&state, &subject, "eteint");
        let error = request(&state, &subject, "eteint", json!({ "path": "/x" })).await.unwrap_err();
        assert!(error.message.starts_with("Connexion au service impossible"), "{}", error.message);
        assert_no_leak("erreur réseau", &error.message, &[TOKEN, "cle="]);
        let tested = invoke(&state, "clients.test", json!({ "id": "eteint" })).await.unwrap();
        assert_eq!(tested["ok"], json!(false));
        assert_no_leak("test", &tested.to_string(), &[TOKEN, "cle="]);
    }

    #[tokio::test]
    async fn a_rejected_application_token_is_renewed_once() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let subject = page_subject("crm");
        let machine_id = unique("machine");
        invoke(
            &state,
            "vault.save",
            json!({ "id": machine_id, "label": "Machine", "kind": "clientCredentials", "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": REMOTE_CLIENT_SECRET } }),
        )
        .await
        .unwrap();
        save_client(
            &state,
            json!({ "id": "machine", "label": "Machine", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "clientCredentials", "secret": machine_id, "tokenUrl": format!("{}/token", remote.origin) } }),
        )
        .await;
        grant(&state, &subject, "machine");

        request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap();
        // Le service révoque le jeton avant son expiration : 401, nouveau jeton, nouvelle tentative.
        remote.revoke_access_tokens();
        let response = request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(response["status"], json!(200));
        assert_eq!(remote.token_grants().len(), 2);
        assert_eq!(remote.last().headers["authorization"], "Bearer acc3ss-t0k3n-2");

        // Jeton expiré d’après le coffre : renouvelé avant même d’appeler le service.
        let mut secret = vault::read_secret(&machine_id).unwrap().unwrap();
        secret["expiresAt"] = json!(1);
        vault::write_secret(&machine_id, &secret).unwrap();
        let calls = remote.seen_paths().len();
        request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(remote.token_grants().len(), 3);
        assert_eq!(remote.seen_paths().len(), calls + 1);

        // Un secret client refusé donne une erreur lisible, qui ne cite pas le secret.
        invoke(
            &state,
            "vault.save",
            json!({ "id": machine_id, "label": "Machine", "kind": "clientCredentials", "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": "m4uv41s-s3cr3t" } }),
        )
        .await
        .unwrap();
        let error = request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap_err();
        assert!(error.message.contains("Secret client refusé"), "{}", error.message);
        assert_no_leak("erreur", &format!("{} {:?}", error.message, error.detail), &["m4uv41s-s3cr3t"]);
    }

    #[tokio::test]
    async fn settings_save_list_bind_and_delete_clients() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        let subject = page_subject("crm");

        // Validation à l’enregistrement.
        let refusals = [
            (
                json!({ "id": "Jira!", "label": "Jira", "baseUrl": "https://jira.exemple.com" }),
                "Identifiant de client invalide",
            ),
            (json!({ "id": "jira", "label": " ", "baseUrl": "https://jira.exemple.com" }), "libellé"),
            (json!({ "id": "jira", "label": "Jira", "baseUrl": "http://jira.exemple.com" }), "https://"),
            (
                json!({ "id": "jira", "label": "Jira", "baseUrl": "https://alice:secret@jira.exemple.com" }),
                "identifiants",
            ),
            (json!({ "id": "jira", "label": "Jira", "baseUrl": "ftp://jira.exemple.com" }), "https://"),
            (
                json!({ "id": "jira", "label": "Jira", "baseUrl": "https://jira.exemple.com", "headers": { "Authorization": "Bearer x" } }),
                "coffre",
            ),
            (
                json!({ "id": "jira", "label": "Jira", "baseUrl": "https://jira.exemple.com", "auth": { "type": "apiKey", "secret": "cle" } }),
                "clé d’API",
            ),
            (
                json!({ "id": "jira", "label": "Jira", "baseUrl": "https://jira.exemple.com", "auth": { "type": "oauth2", "secret": "sso", "tokenUrl": "https://sso.exemple.com/token" } }),
                "adresse d’autorisation",
            ),
            (
                json!({ "id": "jira", "label": "Jira", "baseUrl": "https://jira.exemple.com", "auth": { "type": "clientCredentials", "secret": "sso", "tokenUrl": "http://sso.exemple.com/token" } }),
                "https://",
            ),
        ];
        for (client, expected) in refusals {
            let error = invoke(&state, "clients.save", json!({ "client": client })).await.unwrap_err();
            assert!(error.message.contains(expected), "{} ≠ {expected}", error.message);
        }

        // http est admis vers le poste ; les champs sans objet pour le type d’authentification sont retirés.
        let saved = save_client(
            &state,
            json!({ "label": "Jira Interne", "baseUrl": " http://localhost:8080/rest ", "auth": { "type": "bearer", "secret": "jeton-absent", "header": "X-Vieux", "tokenUrl": "https://x.exemple.com" } }),
        )
        .await;
        assert_eq!(saved["id"], json!("jira-interne"));
        assert_eq!(saved["status"], json!("missingSecret"));
        let file: Value =
            serde_json::from_str(&std::fs::read_to_string(space.root.join("clients/jira-interne.json")).unwrap())
                .unwrap();
        assert_eq!(
            file,
            json!({ "id": "jira-interne", "label": "Jira Interne", "baseUrl": "http://localhost:8080/rest", "auth": { "type": "bearer", "secret": "jeton-absent" } })
        );
        assert!(git::log(&space.root, 5, Some("clients"))
            .unwrap()
            .iter()
            .any(|commit| commit.message == "Client Jira Interne"));
        let duplicate = invoke(&state, "clients.save", json!({ "create": true, "client": { "id": "jira-interne", "label": "Autre", "baseUrl": "https://x.exemple.com" } }))
            .await
            .unwrap_err();
        assert!(duplicate.message.contains("déjà"));

        // Sans secret, la requête d’une page explique quoi faire.
        grant(&state, &subject, "jira-interne");
        let error = request(&state, &subject, "jira-interne", json!({ "path": "/x" })).await.unwrap_err();
        assert!(error.message.contains("Réglages → Coffre"), "{}", error.message);

        // Un module demande un client « jira » : sans liaison ni client de ce nom, la demande reste à relier.
        std::fs::create_dir_all(space.root.join("modules/crm")).unwrap();
        std::fs::write(
            space.root.join("modules/crm/module.json"),
            json!({ "id": "crm", "name": "CRM", "version": "0.1.0", "clients": [{ "id": "jira", "label": "Jira", "baseUrl": "https://jira.exemple.com", "auth": "bearer" }] }).to_string(),
        )
        .unwrap();
        std::fs::write(space.root.join("clients/casse.json"), "{ pas du json").unwrap();
        let listed = invoke(&state, "clients.list", json!({})).await.unwrap();
        assert_eq!(listed["needs"][0]["key"], json!("crm/jira"));
        assert_eq!(listed["needs"][0]["client"], Value::Null);
        assert_eq!(listed["needs"][0]["auth"], json!("bearer"));
        let broken =
            listed["clients"].as_array().unwrap().iter().find(|client| client["id"] == json!("casse")).unwrap();
        assert_eq!(broken["status"], json!("invalid"));
        let error = request(&state, &subject, "jira", json!({ "path": "/x" })).await.unwrap_err();
        assert!(error.message.contains("crm/jira"), "{}", error.message);

        // Liaison : la demande du module passe par le client choisi.
        let unknown =
            invoke(&state, "clients.bind", json!({ "need": "crm/jira", "client": "absent" })).await.unwrap_err();
        assert!(unknown.message.contains("n’existe pas"));
        let bound =
            invoke(&state, "clients.bind", json!({ "need": "crm/jira", "client": "jira-interne" })).await.unwrap();
        assert_eq!(bound["bindings"], json!({ "crm/jira": "jira-interne" }));
        assert_eq!(space.manifest().unwrap().bindings["crm/jira"], "jira-interne");
        let listed = invoke(&state, "clients.list", json!({})).await.unwrap();
        assert_eq!(listed["needs"][0]["client"], json!("jira-interne"));
        let client =
            listed["clients"].as_array().unwrap().iter().find(|client| client["id"] == json!("jira-interne")).unwrap();
        assert_eq!(client["usedBy"][0]["key"], json!("crm/jira"));
        let error = request(&state, &subject, "jira", json!({ "path": "/x" })).await.unwrap_err();
        assert!(
            error.message.contains("Réglages → Coffre"),
            "la liaison doit mener au client relié : {}",
            error.message
        );

        // Suppression : le fichier et la liaison disparaissent.
        invoke(&state, "clients.delete", json!({ "id": "jira-interne" })).await.unwrap();
        assert!(!space.root.join("clients/jira-interne.json").exists());
        assert!(space.manifest().unwrap().bindings.is_empty());
        assert!(invoke(&state, "clients.delete", json!({ "id": "jira-interne" })).await.is_err());
        assert!(!git::has_changes(&space.root).unwrap());
    }

    fn journal_lines(state: &Arc<AppState>) -> Vec<Value> {
        let db = state.app_db.lock().unwrap();
        app_db::read_journal(&db, &state.space().unwrap().root.to_string_lossy(), Some("client"), 100).unwrap()
    }

    fn listed(list: &Value, id: &str) -> Value {
        list["clients"].as_array().unwrap().iter().find(|client| client["id"] == json!(id)).unwrap().clone()
    }

    /// Ce que fait l’agent : réécrire le fichier d’un client dans l’espace, sans passer par les Réglages.
    fn agent_edits(state: &Arc<AppState>, id: &str, change: impl FnOnce(&mut Value)) {
        let path = state.space().unwrap().root.join(format!("clients/{id}.json"));
        let mut file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        change(&mut file);
        std::fs::write(&path, file.to_string()).unwrap();
    }

    #[tokio::test]
    async fn a_client_changed_outside_settings_sends_nothing_until_the_user_validates_it() {
        let (state, _dir) = test_state();
        let (remote, elsewhere) = (remote().await, remote().await);
        let subject = page_subject("crm");
        let (token_id, machine_id) = (unique("jeton"), unique("machine"));
        invoke(
            &state,
            "vault.save",
            json!({ "id": token_id, "label": "Jeton", "kind": "token", "secrets": { "value": TOKEN } }),
        )
        .await
        .unwrap();
        invoke(
            &state,
            "vault.save",
            json!({ "id": machine_id, "label": "Machine", "kind": "clientCredentials", "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": REMOTE_CLIENT_SECRET } }),
        )
        .await
        .unwrap();

        // Enregistré depuis les Réglages : validé d’office, la page autorisée peut l’appeler.
        let saved = save_client(
            &state,
            json!({ "id": "api", "label": "API", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "bearer", "secret": token_id } }),
        )
        .await;
        assert_eq!(saved["status"], json!("ready"));
        assert_eq!(saved["validation"]["validated"], json!(true));
        grant(&state, &subject, "api");
        request(&state, &subject, "api", json!({ "path": "/echo" })).await.unwrap();
        assert_eq!(remote.seen_paths().len(), 1);

        // L’agent détourne l’adresse dans le fichier : plus rien ne part, ni vers l’ancienne ni vers la nouvelle.
        agent_edits(&state, "api", |file| file["baseUrl"] = json!(format!("{}/api", elsewhere.origin)));
        let error = request(&state, &subject, "api", json!({ "path": "/echo" })).await.unwrap_err();
        assert!(error.message.contains("pas validé") && error.message.contains("validate_client"), "{}", error.message);
        let tested = invoke(&state, "clients.test", json!({ "id": "api", "path": "/echo" })).await.unwrap();
        assert_eq!(tested["ok"], json!(false));
        assert!(tested["message"].as_str().unwrap().contains("pas validé"));
        assert_eq!(remote.seen_paths().len(), 1);
        assert!(elsewhere.seen_paths().is_empty(), "le secret est parti vers l’adresse non validée");
        assert!(journal_lines(&state).iter().any(|line| {
            line["status"] == json!("error") && line["summary"].as_str().unwrap().contains("pas validé")
        }));

        // Les Réglages montrent ce qui a changé, avant et après.
        let client = listed(&invoke(&state, "clients.list", json!({})).await.unwrap(), "api");
        assert_eq!(client["status"], json!("toValidate"));
        assert_eq!(
            client["validation"]["changes"],
            json!([{ "field": "baseUrl", "label": "Adresse de base", "before": format!("{}/api", remote.origin), "after": format!("{}/api", elsewhere.origin) }])
        );
        assert_eq!(client["validation"]["everValidated"], json!(true));

        // Valider des valeurs qui ne sont plus celles du fichier est refusé ; valider celles affichées rouvre l’accès.
        let stale = json!({ "id": "api", "fingerprint": saved["validation"]["fingerprint"] });
        let error = invoke(&state, "clients.validate", stale).await.unwrap_err();
        assert!(error.message.contains("a changé depuis l’affichage"), "{}", error.message);
        assert!(request(&state, &subject, "api", json!({ "path": "/echo" })).await.is_err());
        let validated = invoke(
            &state,
            "clients.validate",
            json!({ "id": "api", "fingerprint": client["validation"]["fingerprint"] }),
        )
        .await
        .unwrap();
        assert_eq!(validated["status"], json!("ready"));
        request(&state, &subject, "api", json!({ "path": "/echo" })).await.unwrap();
        assert_eq!(elsewhere.last().headers["authorization"], format!("Bearer {TOKEN}"));

        // Toute autre façon de rediriger le secret est vue : entrée du coffre, type, en-têtes fixes.
        for change in [
            (|file: &mut Value| file["auth"]["secret"] = json!("autre-entree")) as fn(&mut Value),
            |file| file["auth"] = json!({ "type": "apiKey", "secret": file["auth"]["secret"], "queryParam": "token" }),
            |file| file["headers"] = json!({ "X-Forwarded-Host": "ailleurs.exemple.com" }),
        ] {
            let before = std::fs::read_to_string(state.space().unwrap().root.join("clients/api.json")).unwrap();
            agent_edits(&state, "api", change);
            let error = request(&state, &subject, "api", json!({ "path": "/echo" })).await.unwrap_err();
            assert!(error.message.contains("pas validé"), "{}", error.message);
            std::fs::write(state.space().unwrap().root.join("clients/api.json"), before).unwrap();
        }
        // Un changement sans effet sur la destination du secret (le libellé) ne demande rien.
        agent_edits(&state, "api", |file| file["label"] = json!("API renommée"));
        request(&state, &subject, "api", json!({ "path": "/echo" })).await.unwrap();

        // Serveur de jetons détourné : le secret client ne part pas non plus.
        save_client(
            &state,
            json!({ "id": "machine", "label": "Machine", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "clientCredentials", "secret": machine_id, "tokenUrl": format!("{}/token", remote.origin) } }),
        )
        .await;
        grant(&state, &subject, "machine");
        agent_edits(&state, "machine", |file| file["auth"]["tokenUrl"] = json!(format!("{}/token", elsewhere.origin)));
        let error = request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap_err();
        assert!(error.message.contains("pas validé"), "{}", error.message);
        assert!(elsewhere.state.token_requests.lock().unwrap().is_empty());
        assert!(remote.state.token_requests.lock().unwrap().is_empty());

        // Client déclaré par l’agent : le fichier existe, mais il naît « à valider » avec toutes ses valeurs à relire.
        let declared = invoke(
            &state,
            "clients.declare",
            json!({ "client": { "id": "meteo", "label": "Météo", "baseUrl": format!("{}/api", elsewhere.origin), "auth": { "type": "apiKey", "secret": token_id, "header": "X-Api-Key" } } }),
        )
        .await
        .unwrap();
        assert_eq!(declared["status"], json!("toValidate"));
        assert_eq!(declared["validation"]["everValidated"], json!(false));
        let fields: Vec<&str> = declared["validation"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|change| change["field"].as_str().unwrap())
            .collect();
        assert_eq!(fields, ["authType", "secret", "baseUrl", "header"]);
        assert!(state.space().unwrap().root.join("clients/meteo.json").is_file());
        grant(&state, &subject, "meteo");
        let sent = elsewhere.seen_paths().len();
        assert!(request(&state, &subject, "meteo", json!({ "path": "/echo" })).await.is_err());
        assert_eq!(elsewhere.seen_paths().len(), sent);
        // Redéclarer un client validé sans toucher à ce qui compte le laisse utilisable.
        let again = invoke(
            &state,
            "clients.declare",
            json!({ "client": { "id": "api", "label": "API bis", "baseUrl": format!("{}/api/", elsewhere.origin), "auth": { "type": "bearer", "secret": token_id } } }),
        )
        .await
        .unwrap();
        assert_eq!(again["status"], json!("ready"));

        // Sans secret à injecter, un client déclaré par l’agent fonctionne tout de suite.
        let open = invoke(
            &state,
            "clients.declare",
            json!({ "client": { "id": "public", "label": "Public", "baseUrl": format!("{}/api", remote.origin) } }),
        )
        .await
        .unwrap();
        assert_eq!((open["status"].clone(), open["validation"].clone()), (json!("ready"), Value::Null));
        grant(&state, &subject, "public");
        request(&state, &subject, "public", json!({ "path": "/echo" })).await.unwrap();
    }

    #[tokio::test]
    async fn deleting_a_client_revokes_its_grants_and_refusals_are_journaled() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let subject = page_subject("crm");
        let space = state.space().unwrap().root.to_string_lossy().to_string();
        let token_id = unique("jeton");
        invoke(
            &state,
            "vault.save",
            json!({ "id": token_id, "label": "Jeton", "kind": "token", "secrets": { "value": TOKEN } }),
        )
        .await
        .unwrap();
        let client = json!({ "id": "api", "label": "API", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "bearer", "secret": token_id } });
        save_client(&state, client.clone()).await;
        grant(&state, &subject, "api");
        request(&state, &subject, "api", json!({ "path": "/echo" })).await.unwrap();

        // Supprimé puis recréé sous le même identifiant : ni l’accord ni la validation de l’ancien ne lui reviennent.
        invoke(&state, "clients.delete", json!({ "id": "api" })).await.unwrap();
        {
            let db = state.app_db.lock().unwrap();
            assert!(!app_db::is_granted(&db, &space, &subject.key(), "client:api").unwrap());
        }
        let declared = invoke(&state, "clients.declare", json!({ "client": client })).await.unwrap();
        assert_eq!(declared["validation"]["everValidated"], json!(false));
        save_client(&state, client).await;

        // L’utilisateur refuse l’accès demandé par la page : rien ne part, et le refus est au journal.
        let mut events = state.events.subscribe();
        let answering = state.clone();
        let asked = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let seen = asked.clone();
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                if event.name == "permission:ask" {
                    seen.lock().unwrap().push(event.payload.clone());
                    let id = event.payload["requestId"].as_str().unwrap().to_string();
                    answering.resolve_ui(&id, Ok(json!({ "granted": false }))).unwrap();
                }
            }
        });
        let sent = remote.seen_paths().len();
        let error =
            request(&state, &subject, "api", json!({ "method": "POST", "path": "/echo?jeton=x" })).await.unwrap_err();
        assert!(error.message.starts_with("Accès refusé"), "{}", error.message);
        assert_eq!(remote.seen_paths().len(), sent);
        // La question nomme le client par ce que l’utilisateur a validé (identifiant, adresse), pas seulement par
        // son libellé, que l’agent peut changer sans nouvelle validation.
        let question = asked.lock().unwrap()[0].clone();
        assert_eq!(question["resource"], json!("client:api"));
        let label = question["label"].as_str().unwrap();
        assert!(label.contains("« api »") && label.contains(&format!("{}/api", remote.origin)), "{label}");
        let line = journal_lines(&state).into_iter().next().unwrap();
        assert_eq!(line["summary"], json!("POST /echo → accès refusé"));
        assert_eq!(
            (line["kind"].clone(), line["status"].clone(), line["subject"].clone()),
            (json!("client"), json!("error"), json!("api"))
        );
        assert_eq!(line["detail"]["requester"], json!("crm/accueil"));
    }
}
