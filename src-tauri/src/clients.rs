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
pub(crate) const MASK: &str = "[secret masqué]";

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
    /// Connexion par identifiant et mot de passe qui rend un jeton (Portainer, OpenBao userpass) : Alfred fait la
    /// requête de connexion, garde le jeton au trousseau et le pose sur chaque requête (voir `sessions`).
    Session,
    /// Toute l’adresse du compte est secrète (agenda publié dont l’adresse porte un jeton) : elle vit au trousseau.
    SecretUrl,
}

impl AuthKind {
    /// Type d’entrée du coffre que cette authentification attend.
    pub fn vault_kind(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Bearer | Self::ApiKey | Self::SecretUrl => Some(vault::KIND_TOKEN),
            Self::Basic | Self::Session => Some(vault::KIND_BASIC),
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
    /// `session` : requête de connexion qui rend le jeton.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<SessionLogin>,
    /// `session` : où poser le jeton obtenu ; à défaut, `Authorization: Bearer <jeton>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apply: Option<SessionApply>,
}

/// Requête de connexion d’une méthode `session`. Dans `path` et dans les textes de `body`, `{username}`,
/// `{password}` et les paramètres du compte (`{realm}`…) sont remplacés au moment de la connexion, jamais ailleurs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionLogin {
    /// `POST` par défaut.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub method: String,
    /// Chemin sous l’adresse du compte (`/api/auth`, `/v1/auth/userpass/login/{username}`).
    pub path: String,
    /// Corps envoyé en JSON (ou en formulaire avec `form`), modèle des champs à remplir.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub form: bool,
    /// Où lire le jeton : chemin pointé dans la réponse JSON (`jwt`, `auth.client_token`), ou `header:<nom>`.
    pub token: String,
    /// Chemin pointé de la durée de vie du jeton, en secondes (`auth.lease_duration`) ; 0 ou absent : sans échéance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionApply {
    pub header: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

/// Paramètre non secret d’un compte, déclaré par sa méthode (royaume Keycloak, montage OpenBao, endpoint
/// Portainer) : saisi avec le compte, gardé dans son fichier, lu par les fonctions par `client(id).params()`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ParamDef {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub help: String,
    /// Valeur proposée quand l’utilisateur ne saisit rien.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

/// Réponses scellées : les champs déclarés d’une réponse dont le chemin correspond ne parviennent à la fonction que
/// sous forme de références (voir `secret_refs`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SealedRule {
    /// Chemin sous l’adresse du compte : `*` vaut un segment, `**` la suite du chemin, `{param}` un paramètre du
    /// compte (ou un segment quelconque s’il n’en a pas).
    pub path: String,
    /// Méthodes HTTP concernées ; toutes à défaut.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    /// Champs scellés, en chemins pointés avec `*` (`data.data.*`) ; sans champ, toute la réponse.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

/// Ce qu’Alfred utilise pour une requête : une instance d’un client, son adresse et son authentification résolues.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Client {
    pub id: String,
    /// Instance du client ; `default` pour un client à une seule instance.
    #[serde(skip)]
    pub instance: String,
    pub label: String,
    pub base_url: String,
    pub auth: Auth,
    /// En-têtes fixes ajoutés à chaque requête (`Accept`…). Jamais d’authentification : elle vient du coffre.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// Chemin lu par le bouton Tester, celui du client (voir `ClientDef::test_path`).
    #[serde(skip)]
    pub test_path: Option<String>,
    /// Le certificat du serveur est accepté sans vérification (option avancée du compte).
    #[serde(skip)]
    pub insecure_tls: bool,
    /// Paramètres non secrets du compte (`realm`, `mount`…), déjà complétés de leurs valeurs par défaut.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    /// Réponses scellées du service (voir `SealedRule`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sealed: Vec<SealedRule>,
    /// Paramètres obligatoires que le compte n’a pas encore (leurs noms) : le compte reste invalide.
    #[serde(skip)]
    pub missing_params: Vec<String>,
}

/// Instance d’un client écrit sous sa forme simple (une adresse, une authentification), et méthode qu’elle utilise.
pub const DEFAULT_INSTANCE: &str = "default";

/// Façon de s’authentifier auprès du service, déclarée dans le client ; chaque instance en choisit une. Dans une
/// adresse d’autorisation ou de jetons, `{url}` devient l’adresse de l’instance.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthMethod {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(flatten)]
    pub auth: Auth,
    /// Aide du parcours de configuration, propre à cette méthode : une consigne de trois lignes au plus (où créer le
    /// jeton, quels droits lui donner). Jamais lue pour une requête.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub help: String,
    /// Page du service où l’utilisateur crée son jeton ou sa clé : le parcours l’ouvre par « Créer mon jeton ».
    /// `{url}` y devient l’adresse du compte. À ne pas confondre avec `tokenUrl`, le serveur de jetons d’OAuth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_page: Option<String>,
    /// Adresse d’exemple, montrée dans le champ de l’adresse du compte (`https://acme.atlassian.net`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_example: Option<String>,
    /// OAuth 2 : identifiant public de l’application que le module a déclarée chez le service. Avec lui, le
    /// parcours propose « Se connecter avec… » sans rien faire saisir : la connexion se fait par PKCE.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Paramètres non secrets que l’utilisateur saisit avec le compte (`{ "id": "realm", "label": "Royaume" }`).
    /// `{realm}` se remplace ensuite dans `authorizationUrl`, `tokenUrl`, la connexion `session`, les règles
    /// `sealed` et le chemin d’une requête.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<ParamDef>,
}

/// Compte ou installation du service : son adresse, la méthode choisie et l’entrée du coffre qui la sert. Seul
/// l’utilisateur, dans les Réglages, en crée ou en modifie une.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Instance {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// Adresse de base de l’instance ; à défaut, celle du client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub method: String,
    /// Identifiant de l’entrée du coffre ; jamais la valeur.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// Options avancées du compte, pour une subtilité que le module ne peut pas prévoir : en-têtes ajoutés à ceux
    /// du client (et prioritaires sur eux)…
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// … et certificat du serveur accepté sans vérification (serveur interne à certificat auto-signé).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub insecure_tls: bool,
    /// Valeurs des paramètres déclarés par la méthode (`realm` → `equipe`). Jamais de secret : elles sont versionnées.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
}

/// Fichier `clients/<id>.json`, sous l’une de ses deux formes : un client à une seule instance (`baseUrl`, `auth`
/// avec son entrée du coffre), ou un client à plusieurs instances (`methods`, `instances`). En mémoire, il est
/// toujours déplié : `auth` est vide, `methods` et `instances` portent tout.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientDef {
    pub id: String,
    pub label: String,
    /// Adresse par défaut des instances qui n’en ont pas.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<AuthMethod>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub instances: Vec<Instance>,
    /// Chemin lu par le bouton Tester (`/me`, `/labels`…), pour chaque instance ; sans lui, la racine de l’adresse.
    /// Beaucoup d’API n’ont rien à la racine : un chemin qui demande l’authentification vérifie aussi le secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_path: Option<String>,
    /// Réponses scellées : chemins dont certains champs (valeurs d’un coffre, jetons émis) ne parviennent aux
    /// fonctions que sous forme de références.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sealed: Vec<SealedRule>,
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

fn valid_headers(headers: &BTreeMap<String, String>) -> AppResult<()> {
    for (name, value) in headers {
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
    Ok(())
}

fn clean_headers(headers: &mut BTreeMap<String, String>) {
    *headers = std::mem::take(headers)
        .into_iter()
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .filter(|(name, _)| !name.is_empty())
        .collect();
}

impl Auth {
    /// Retire les espaces et les champs sans objet pour le type d’authentification : le fichier reste lisible et
    /// ne garde pas, par exemple, l’en-tête d’une ancienne clé d’API.
    fn normalize(&mut self) {
        for value in [
            &mut self.secret,
            &mut self.header,
            &mut self.query_param,
            &mut self.authorization_url,
            &mut self.token_url,
        ] {
            clean(value);
        }
        // Le préfixe garde ses espaces : « Token  » en a besoin.
        self.prefix = self.prefix.take().filter(|prefix| !prefix.is_empty());
        self.scopes = std::mem::take(&mut self.scopes)
            .into_iter()
            .map(|scope| scope.trim().to_string())
            .filter(|scope| !scope.is_empty())
            .collect();
        if self.kind != AuthKind::ApiKey {
            (self.header, self.prefix, self.query_param) = (None, None, None);
        }
        if self.kind != AuthKind::Oauth2 {
            self.authorization_url = None;
        }
        if !self.kind.uses_token_endpoint() {
            self.token_url = None;
            self.scopes.clear();
        }
        if self.kind == AuthKind::None {
            self.secret = None;
        }
        if self.kind == AuthKind::Session {
            crate::sessions::normalize(self);
        } else {
            (self.login, self.apply) = (None, None);
        }
    }

    fn validate(&self) -> AppResult<()> {
        if let Some(secret) = &self.secret {
            if !valid_id(secret) {
                return Err(AppError::new(format!("Identifiant d’entrée du coffre invalide : « {secret} ».")));
            }
        }
        match self.kind {
            AuthKind::ApiKey => match (&self.header, &self.query_param) {
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
                let url = self
                    .authorization_url
                    .as_deref()
                    .ok_or_else(|| AppError::new("Saisir l’adresse d’autorisation."))?;
                check_url(url, "L’adresse d’autorisation", true)?;
            }
            AuthKind::Session => crate::sessions::validate(self)?,
            _ => {}
        }
        if self.kind.uses_token_endpoint() {
            let url =
                self.token_url.as_deref().ok_or_else(|| AppError::new("Saisir l’adresse du serveur de jetons."))?;
            check_url(url, "L’adresse du serveur de jetons", true)?;
        }
        Ok(())
    }

    /// `{url}` remplacé par l’adresse de l’instance dans les adresses d’autorisation et de jetons.
    fn for_instance(&self, root: &str, params: &BTreeMap<String, String>) -> Auth {
        let mut auth = self.clone();
        for value in [&mut auth.authorization_url, &mut auth.token_url].into_iter().flatten() {
            *value = fill_params(&value.replace("{url}", root), params);
        }
        auth
    }
}

/// Remplace `{param}` par la valeur du paramètre du compte, encodée comme un segment de chemin : une valeur ne peut
/// ni ajouter de segment ni sortir de l’adresse. Un nom inconnu reste tel quel.
pub fn fill_params(text: &str, params: &BTreeMap<String, String>) -> String {
    let mut text = text.to_string();
    for (name, value) in params {
        let pattern = format!("{{{name}}}");
        if text.contains(&pattern) {
            let encoded: String = url::form_urlencoded::byte_serialize(value.as_bytes()).collect();
            text = text.replace(&pattern, &encoded.replace('+', "%20"));
        }
    }
    text
}

impl Client {
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
        if let Some(first) = self.missing_params.first() {
            return Err(AppError::new(format!("Saisir « {first} » pour ce compte.")));
        }
        // L’adresse d’un compte `secretUrl` est au trousseau : celle du fichier peut rester vide.
        if self.auth.kind == AuthKind::SecretUrl {
            if !self.base_url.trim().is_empty() {
                self.base()?;
            }
        } else {
            if self.base_url.trim().is_empty() {
                return Err(AppError::new(format!("Saisir l’adresse de « {} ».", self.label)));
            }
            self.base()?;
        }
        valid_headers(&self.headers)?;
        self.auth.validate()
    }

    /// Clé de la validation de l’utilisateur : une par instance. Celle d’un client à une seule instance est son
    /// identifiant, comme avant que les instances existent.
    fn trust_key(&self) -> String {
        trust_key(&self.id, &self.instance)
    }
}

fn trust_key(client: &str, instance: &str) -> String {
    if instance.is_empty() || instance == DEFAULT_INSTANCE {
        client.to_string()
    } else {
        format!("{client}#{instance}")
    }
}

impl Instance {
    fn normalize(&mut self) {
        self.label = self.label.trim().to_string();
        self.id = self.id.trim().to_string();
        if self.id.is_empty() && !self.label.is_empty() {
            self.id = slug(&self.label);
        }
        self.method = self.method.trim().to_string();
        clean(&mut self.url);
        clean(&mut self.secret);
        clean_headers(&mut self.headers);
        self.params = std::mem::take(&mut self.params)
            .into_iter()
            .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
            .filter(|(name, value)| !name.is_empty() && !value.is_empty())
            .collect();
    }

    /// Nom affiché : l’instance d’un client à une seule instance n’en a pas toujours.
    pub fn display_label(&self) -> &str {
        if self.label.is_empty() {
            "Principale"
        } else {
            &self.label
        }
    }
}

impl ClientDef {
    /// Déplie la forme simple : son authentification devient la méthode `default`, son adresse et son entrée du
    /// coffre l’instance `default`.
    fn expand(&mut self) {
        if self.methods.is_empty() {
            let mut auth = self.auth.take().unwrap_or_default();
            let secret = auth.secret.take();
            self.methods.push(AuthMethod { id: DEFAULT_INSTANCE.to_string(), auth, ..Default::default() });
            if self.instances.is_empty() && !self.base_url.trim().is_empty() {
                self.instances.push(Instance {
                    id: DEFAULT_INSTANCE.to_string(),
                    method: DEFAULT_INSTANCE.to_string(),
                    secret,
                    ..Instance::default()
                });
            }
        }
        self.auth = None;
    }

    /// Fichier écrit sous la forme simple, avec son instance : vrai quand c’est cette forme qui a été reçue.
    fn carries_instance(&self) -> bool {
        self.methods.is_empty()
    }

    /// Un client que la forme simple suffit à écrire : il garde le fichier qu’il avait avant les instances.
    pub fn is_simple(&self) -> bool {
        let [method] = self.methods.as_slice() else { return false };
        let [instance] = self.instances.as_slice() else { return false };
        method.id == DEFAULT_INSTANCE
            && method.label.is_empty()
            && instance.id == DEFAULT_INSTANCE
            && instance.method == DEFAULT_INSTANCE
            && instance.label.is_empty()
            && instance.url.is_none()
            && instance.headers.is_empty()
            && !instance.insecure_tls
            && instance.params.is_empty()
            && method.params.is_empty()
            && !self.base_url.is_empty()
    }

    /// Contenu écrit sur le disque : la forme simple quand elle suffit.
    fn to_file(&self) -> ClientDef {
        let mut file = self.clone();
        if self.is_simple() {
            let mut auth = file.methods.remove(0).auth;
            auth.secret = file.instances.remove(0).secret;
            file.auth = Some(auth);
        }
        file
    }

    fn normalize(&mut self) {
        self.expand();
        self.label = self.label.trim().to_string();
        self.id = self.id.trim().to_string();
        if self.id.is_empty() && !self.label.is_empty() {
            self.id = slug(&self.label);
        }
        self.base_url = self.base_url.trim().to_string();
        clean(&mut self.test_path);
        clean_headers(&mut self.headers);
        for method in &mut self.methods {
            method.id = method.id.trim().to_string();
            if method.id.is_empty() && !method.label.is_empty() {
                method.id = slug(&method.label);
            }
            method.label = method.label.trim().to_string();
            method.help = method.help.trim().to_string();
            clean(&mut method.token_page);
            clean(&mut method.url_example);
            clean(&mut method.client_id);
            if method.auth.kind != AuthKind::Oauth2 {
                method.client_id = None;
            }
            for param in &mut method.params {
                param.id = param.id.trim().to_string();
                param.label = param.label.trim().to_string();
                param.help = param.help.trim().to_string();
                clean(&mut param.example);
                clean(&mut param.default);
            }
            method.auth.normalize();
            // Le secret appartient à l’instance, jamais à la méthode.
            method.auth.secret = None;
        }
        for instance in &mut self.instances {
            instance.normalize();
        }
        for rule in &mut self.sealed {
            rule.path = rule.path.trim().to_string();
            rule.methods = rule.methods.iter().map(|method| method.trim().to_ascii_uppercase()).filter(|m| !m.is_empty()).collect();
            rule.fields = rule.fields.iter().map(|field| field.trim().to_string()).filter(|f| !f.is_empty()).collect();
        }
    }

    /// Ce que le client décrit, indépendamment de ses instances : identifiant, en-têtes, méthodes.
    pub fn validate_definition(&self) -> AppResult<()> {
        if !valid_id(&self.id) {
            return Err(AppError::new(format!(
                "Identifiant de client invalide : « {} ». Utiliser des minuscules, des chiffres et des tirets.",
                self.id
            )));
        }
        if self.label.trim().is_empty() {
            return Err(AppError::new("Le client doit avoir un libellé."));
        }
        if !self.base_url.is_empty() {
            check_url(&self.base_url, "L’adresse de base du client", false)?;
        }
        if let Some(path) = &self.test_path {
            // Vérifié contre une adresse d’exemple : chaque instance a la sienne, et le chemin reste sous chacune.
            let example = Url::parse("https://instance.exemple/base").map_err(|_| AppError::new("Adresse d’exemple."))?;
            if !path.starts_with('/') || build_url(&example, path, None, None).is_err() {
                return Err(AppError::new(format!(
                    "Chemin de test invalide : « {path} ». Il commence par « / » et reste sous l’adresse de base."
                )));
            }
        }
        valid_headers(&self.headers)?;
        if self.methods.is_empty() {
            return Err(AppError::new("Le client doit proposer au moins une méthode d’authentification."));
        }
        let mut seen = std::collections::HashSet::new();
        for method in &self.methods {
            if !valid_id(&method.id) || !seen.insert(method.id.as_str()) {
                return Err(AppError::new(format!(
                    "Identifiant de méthode invalide ou répété : « {} ».",
                    method.id
                )));
            }
            let mut names = std::collections::HashSet::new();
            for param in &method.params {
                if !valid_param(&param.id) || !names.insert(param.id.as_str()) {
                    return Err(AppError::new(format!(
                        "Méthode « {} » : identifiant de paramètre invalide ou répété : « {} » (lettres, chiffres et _).",
                        method_label(method),
                        param.id
                    )));
                }
                if matches!(param.id.as_str(), "url" | "username" | "password") {
                    return Err(AppError::new(format!(
                        "Méthode « {} » : le paramètre « {} » est réservé par Alfred.",
                        method_label(method),
                        param.id
                    )));
                }
            }
            // Les adresses relatives à l’instance sont vérifiées avec une adresse d’exemple.
            let mut auth = method.auth.for_instance("https://instance.exemple", &BTreeMap::new());
            auth.secret = None;
            auth.validate().map_err(|error| {
                AppError::new(format!("Méthode « {} » : {}", method_label(method), error.message))
            })?;
            if let Some(page) = &method.token_page {
                check_url(&page.replace("{url}", "https://instance.exemple"), "La page du jeton", true).map_err(
                    |error| AppError::new(format!("Méthode « {} » : {}", method_label(method), error.message)),
                )?;
            }
        }
        let mut seen = std::collections::HashSet::new();
        for instance in &self.instances {
            if !valid_id(&instance.id) || !seen.insert(instance.id.as_str()) {
                return Err(AppError::new(format!(
                    "Identifiant d’instance invalide ou répété : « {} ».",
                    instance.id
                )));
            }
        }
        crate::secret_refs::validate_rules(&self.sealed)?;
        Ok(())
    }

    pub fn method(&self, id: &str) -> Option<&AuthMethod> {
        self.methods.iter().find(|method| method.id == id)
    }

    fn find_instance(&self, id: &str) -> Option<&Instance> {
        self.instances.iter().find(|instance| instance.id == id)
    }

    /// L’instance demandée, ou la première (celle par défaut) quand la demande n’en nomme pas.
    pub fn instance(&self, wanted: Option<&str>) -> AppResult<&Instance> {
        match wanted.map(str::trim).filter(|wanted| !wanted.is_empty()) {
            Some(id) => self.find_instance(id).ok_or_else(|| {
                let known: Vec<&str> = self.instances.iter().map(|instance| instance.id.as_str()).collect();
                AppError::new(format!(
                    "Le client « {} » n’a pas d’instance « {id} ». Instances : {}.",
                    self.label,
                    if known.is_empty() { "aucune".to_string() } else { known.join(", ") }
                ))
            }),
            None => self.instances.first().ok_or_else(|| {
                AppError::new(format!(
                    "Le service « {} » n’a aucun compte : en ajouter un dans Réglages → Modules, dans la fiche du module.",
                    self.label
                ))
            }),
        }
    }

    /// Requête vers une instance : son adresse, la méthode qu’elle a choisie et son entrée du coffre.
    pub fn resolve_instance(&self, instance: &Instance) -> AppResult<Client> {
        let method = self.method(&instance.method).ok_or_else(|| {
            AppError::new(format!(
                "L’instance « {} » du client « {} » utilise la méthode « {} », qui n’existe plus : en choisir une autre dans Réglages → Modules, dans la fiche du module.",
                instance.display_label(),
                self.label,
                instance.method
            ))
        })?;
        let base_url = instance.url.clone().unwrap_or_else(|| self.base_url.clone());
        // Paramètres de la méthode : la valeur du compte, sinon celle par défaut ; ceux qui manquent rendent le
        // compte invalide (`Client::validate`), ceux que la méthode ne déclare pas sont ignorés.
        let mut params = BTreeMap::new();
        let mut missing_params = Vec::new();
        for param in &method.params {
            match instance.params.get(&param.id).or(param.default.as_ref()).filter(|value| !value.is_empty()) {
                Some(value) => {
                    params.insert(param.id.clone(), value.clone());
                }
                None if !param.optional => {
                    missing_params.push(if param.label.is_empty() { param.id.clone() } else { param.label.clone() })
                }
                None => {}
            }
        }
        let mut auth = method.auth.for_instance(base_url.trim_end_matches('/'), &params);
        auth.secret = instance.secret.clone().filter(|_| auth.kind != AuthKind::None);
        let label = if self.instances.len() > 1 {
            format!("{} — {}", self.label, instance.display_label())
        } else {
            self.label.clone()
        };
        Ok(Client {
            id: self.id.clone(),
            instance: instance.id.clone(),
            label,
            base_url,
            auth,
            headers: {
                let mut headers = self.headers.clone();
                // Un en-tête du compte remplace celui du client, quelle que soit sa casse.
                for (name, value) in &instance.headers {
                    headers.retain(|known, _| !known.eq_ignore_ascii_case(name));
                    headers.insert(name.clone(), value.clone());
                }
                headers
            },
            test_path: self.test_path.clone(),
            insecure_tls: instance.insecure_tls,
            params,
            missing_params,
            sealed: self.sealed.clone(),
        })
    }

    pub fn effective(&self, wanted: Option<&str>) -> AppResult<Client> {
        self.resolve_instance(self.instance(wanted)?)
    }
}

fn method_label(method: &AuthMethod) -> String {
    if method.label.is_empty() {
        crate::clients::auth_label(method.auth.kind).to_string()
    } else {
        method.label.clone()
    }
}

/// Nom d’une authentification pour l’utilisateur.
pub fn auth_label(kind: AuthKind) -> &'static str {
    match kind {
        AuthKind::None => "Aucune",
        AuthKind::Bearer => "Jeton porteur",
        AuthKind::ApiKey => "Clé d’API",
        AuthKind::Basic => "Identifiant et mot de passe",
        AuthKind::Oauth2 => "OAuth 2",
        AuthKind::ClientCredentials => "Identifiants d’application",
        AuthKind::Session => "Identifiant et mot de passe (session)",
        AuthKind::SecretUrl => "Adresse secrète",
    }
}

/// Identifiant d’un paramètre de compte : lettres, chiffres et `_`, sans commencer par un chiffre.
fn valid_param(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
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
pub fn load(space: &Space, id: &str) -> AppResult<Option<ClientDef>> {
    if !valid_id(id) {
        return Ok(None);
    }
    let path = client_path(space, id);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)?;
    let mut client: ClientDef = serde_json::from_str(&text)
        .map_err(|error| AppError::new(format!("Le fichier du client « {id} » est illisible : {error}")))?;
    client.expand();
    // Le nom du fichier fait foi, comme pour les modules.
    client.id = id.to_string();
    if client.label.trim().is_empty() {
        client.label = id.to_string();
    }
    Ok(Some(client))
}

fn require(space: &Space, id: &str) -> AppResult<ClientDef> {
    load(space, id)?.ok_or_else(|| AppError::new(format!("Le client « {id} » n’existe pas dans cet espace de travail.")))
}

/// Instance d’un client des Réglages : celle nommée, sinon celle par défaut.
fn require_instance(space: &Space, args: &Value) -> AppResult<Client> {
    let def = require(space, &arg::<String>(args, "id")?)?;
    def.effective(opt_arg::<String>(args, "instance")?.as_deref())
}

/// Tous les clients de l’espace ; un fichier illisible est rendu avec son erreur plutôt que de masquer les autres.
/// Les clients lisibles de l’espace.
pub fn all(space: &Space) -> Vec<ClientDef> {
    load_all(space).into_iter().filter_map(|(_, client)| client.ok()).collect()
}

fn load_all(space: &Space) -> Vec<(String, AppResult<ClientDef>)> {
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

/// Libellés des clients (et de leurs instances) de l’espace qui utilisent cette entrée du coffre.
pub fn using_secret(space: &Space, secret: &str) -> Vec<String> {
    load_all(space)
        .into_iter()
        .filter_map(|(_, client)| client.ok())
        .flat_map(|client| {
            client
                .instances
                .iter()
                .filter(|instance| instance.secret.as_deref() == Some(secret))
                .filter_map(|instance| client.resolve_instance(instance).ok().map(|resolved| resolved.label))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Client qui répond au besoin `need` du module : celui que suivent ses sections par instance.
pub fn client_for(space: &Space, module: &str, need: &str) -> AppResult<ClientDef> {
    resolve(space, module, need)
}

/// Client que désigne le nom demandé par un module : la liaison faite par l’utilisateur d’abord, sinon le client de
/// l’espace qui porte ce nom. `dépendance/besoin` désigne le client d’un module dont celui-ci dépend : il suit
/// toujours la liaison de ce module.
fn resolve(space: &Space, module: &str, name: &str) -> AppResult<ClientDef> {
    if let Some((owner, need)) = dependency_reference(name) {
        return resolve(space, owner, &dependency_need(space, module, owner, need)?);
    }
    let need = format!("{module}/{name}");
    if let Some(bound) = space.manifest()?.bindings.get(&need) {
        return load(space, bound)?.ok_or_else(|| {
            AppError::new(format!(
                "La demande « {need} » est reliée au client « {bound} », qui n’existe plus. La relier à un autre service dans Réglages → Modules, dans la fiche du module."
            ))
        });
    }
    load(space, name)?.ok_or_else(|| {
        AppError::new(format!(
            "Le client « {name} » n’existe pas dans cet espace de travail. Le configurer dans Réglages → Modules, ou y relier la demande « {need} » à un client existant."
        ))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------
// Validation par l’utilisateur
// ---------------------------------------------------------------------------------------------------------------
//
// Le fichier d’un client vit dans l’espace : l’agent peut le réécrire. Sans garde-fou, changer l’adresse d’un client
// déjà autorisé suffirait à faire partir son secret ailleurs. Alfred garde donc, hors de l’espace, l’empreinte de ce
// que l’utilisateur a validé dans les Réglages, et n’injecte un secret que si le fichier lui correspond encore.

/// Champs de l’empreinte : tout ce qui décide où part le secret et ce qu’il permet d’obtenir. Chaque valeur est un
/// texte ou `null`, pour pouvoir montrer l’avant et l’après à l’utilisateur.
const TRUST_FIELDS: [(&str, &str); 14] = [
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
    ("insecureTls", "Certificat accepté sans vérification"),
    ("params", "Paramètres du compte"),
    ("login", "Connexion"),
    ("sealed", "Champs scellés"),
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
    let mut print = json!({
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
    });
    // Absente tant qu’elle est désactivée : les validations déjà données restent valables.
    if client.insecure_tls {
        print["insecureTls"] = json!("oui");
    }
    // Ajoutés seulement quand ils servent, pour la même raison. Retirer une règle scellée change l’empreinte : la
    // fonction recevrait alors des valeurs en clair, ce que l’utilisateur doit approuver.
    if !client.params.is_empty() {
        let params: Vec<String> = client.params.iter().map(|(name, value)| format!("{name} = {value}")).collect();
        print["params"] = json!(params.join(", "));
    }
    if auth.kind == AuthKind::Session {
        print["login"] = json!(crate::sessions::describe(auth));
    }
    if !client.sealed.is_empty() {
        print["sealed"] = json!(crate::secret_refs::describe_rules(&client.sealed));
    }
    print
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
        params![space_key(space), client.trust_key(), fingerprint(client).to_string(), app_db::now()],
    )?;
    Ok(())
}

/// Résultats du bouton Tester, par instance, dans la base d’Alfred. Un résultat ne vaut que pour l’empreinte
/// testée : modifier l’adresse, l’authentification ou l’entrée du coffre de l’instance l’efface d’office.
fn tests_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    db.execute(
        "CREATE TABLE IF NOT EXISTS client_tests (space TEXT NOT NULL, client TEXT NOT NULL, fingerprint TEXT NOT NULL, ok INTEGER NOT NULL, message TEXT NOT NULL, tested_at TEXT NOT NULL, PRIMARY KEY (space, client))",
        [],
    )?;
    Ok(db)
}

fn record_test(state: &AppState, space: &Space, client: &Client, ok: bool, message: &str) -> AppResult<()> {
    let db = tests_db(state)?;
    db.execute(
        "INSERT INTO client_tests (space, client, fingerprint, ok, message, tested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (space, client) DO UPDATE SET fingerprint = excluded.fingerprint, ok = excluded.ok,
           message = excluded.message, tested_at = excluded.tested_at",
        params![space_key(space), client.trust_key(), fingerprint(client).to_string(), ok, message, app_db::now()],
    )?;
    Ok(())
}

/// Dernier test de l’instance dans son état actuel : `{ ok, message, testedAt }`, ou `null`.
fn last_test(state: &AppState, space: &Space, client: &Client) -> Value {
    let Ok(db) = tests_db(state) else { return Value::Null };
    let row: Option<(String, bool, String, String)> = db
        .query_row(
            "SELECT fingerprint, ok, message, tested_at FROM client_tests WHERE space = ?1 AND client = ?2",
            params![space_key(space), client.trust_key()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .ok()
        .flatten();
    match row {
        Some((stored, ok, message, at)) if serde_json::from_str::<Value>(&stored).ok() == Some(fingerprint(client)) => {
            json!({ "ok": ok, "message": message, "testedAt": at })
        }
        _ => Value::Null,
    }
}

fn forget_tests(state: &AppState, space: &Space, id: &str) -> AppResult<()> {
    let db = tests_db(state)?;
    db.execute(
        "DELETE FROM client_tests WHERE space = ?1 AND (client = ?2 OR client LIKE ?3)",
        params![space_key(space), id, format!("{id}#%")],
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
    if trusted_fingerprint(state, &space, &client.trust_key())?.as_ref() == Some(&fingerprint(client)) {
        return Ok(());
    }
    Err(AppError::new(format!(
        "Le client « {} » n’est pas validé dans son état actuel : l’agent le valide avec `validate_client`, ou l’utilisateur l’approuve dans Réglages → Modules.",
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
            "Le service « {} » n’a pas de mot de passe ou de clé. Le choisir dans Réglages → Modules, dans la fiche du module.",
            client.label
        ))
    })?;
    let entry = vault::entry(state, id)?.ok_or_else(|| {
        AppError::new(format!(
            "Le client « {} » attend l’entrée « {id} » du coffre, qui n’existe pas sur ce poste. La créer dans Réglages → Mots de passe et clés.",
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
    /// `secretUrl` : adresse complète du compte, lue au trousseau (paramètres compris).
    base: Option<Url>,
}

fn missing_secret(client: &Client) -> AppError {
    AppError::new(format!(
        "Le mot de passe ou la clé du service « {} » n’est pas renseigné. Le saisir dans Réglages → Mots de passe et clés.",
        client.label
    ))
}

async fn credential(state: &Arc<AppState>, client: &Client, stale: Option<&str>) -> AppResult<Credential> {
    let auth = &client.auth;
    if auth.kind == AuthKind::None {
        return Ok(Credential::default());
    }
    if auth.kind == AuthKind::Session {
        let session = crate::sessions::token(state, client, stale).await?;
        return Ok(Credential {
            headers: vec![(session.header, session.value)],
            secrets: session.secrets,
            renewable: Some(session.token),
            ..Credential::default()
        });
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
        AuthKind::SecretUrl => {
            let value = vault::field(secret, "value").ok_or_else(|| missing_secret(client))?;
            let url = check_url(value, "L’adresse secrète du compte", true)?;
            Ok(Credential { secrets: crate::sessions::url_secrets(&url), base: Some(url), ..Credential::default() })
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
pub(crate) fn written_forms(secret: &str) -> Vec<String> {
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

/// Usage d’un client HTTP : chacun a ses délais.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Profile {
    /// Requête ordinaire : 60 s en tout.
    Request,
    /// Téléchargement : pas de limite totale, mais un service muet plus de deux minutes est abandonné.
    Download,
    /// Flux et WebSocket : connexion longue, qui peut rester silencieuse (journal suivi, console au repos).
    Stream,
}

/// Délai d’établissement de la connexion, pour les connexions longues.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Silence au-delà duquel un téléchargement est abandonné.
const DOWNLOAD_STALL: Duration = Duration::from_secs(120);

/// Client HTTP partagé. Une redirection n’est suivie que vers la même origine : l’authentification ajoutée par
/// Alfred ne doit jamais partir vers un autre hôte que celui que l’utilisateur a déclaré.
pub fn http() -> AppResult<reqwest::Client> {
    shared_http(false, Profile::Request)
}

/// Client HTTP d’un compte : celui qui accepte un certificat non vérifié si le compte le demande.
pub fn http_for(client: &Client) -> AppResult<reqwest::Client> {
    shared_http(client.insecure_tls, Profile::Request)
}

/// Réseau d’entreprise : les certificats viennent du magasin du système (Trousseau, magasin de Windows), le proxy
/// des variables d’environnement puis des réglages du système (macOS, « Paramètres Internet » de Windows). Sous
/// Windows, un fichier PAC qui ne nomme qu’un proxy est suivi comme pour git (`git_network.rs`).
fn shared_http(insecure: bool, profile: Profile) -> AppResult<reqwest::Client> {
    let build = || -> AppResult<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .danger_accept_invalid_certs(insecure)
            .user_agent(concat!("Alfred/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let same_origin =
                    attempt.previous().first().is_some_and(|first| first.origin() == attempt.url().origin());
                if same_origin && attempt.previous().len() < 10 {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }));
        builder = match profile {
            Profile::Request => builder.timeout(REQUEST_TIMEOUT),
            Profile::Download => builder.connect_timeout(CONNECT_TIMEOUT).read_timeout(DOWNLOAD_STALL),
            // Une connexion qui passe en WebSocket sort du pool : HTTP/1.1 seulement, aucune limite de durée.
            Profile::Stream => builder.connect_timeout(CONNECT_TIMEOUT).http1_only(),
        };
        builder = windows_pac_proxy(builder);
        builder.build().map_err(|error| AppError::new(format!("Le client HTTP d’Alfred n’a pas pu démarrer : {error}")))
    };
    // Chaque test a son propre exécuteur : un client partagé y garderait des connexions d’un exécuteur arrêté.
    if cfg!(test) {
        return build();
    }
    static SHARED: [[OnceLock<reqwest::Client>; 3]; 2] =
        [[OnceLock::new(), OnceLock::new(), OnceLock::new()], [OnceLock::new(), OnceLock::new(), OnceLock::new()]];
    let shared = &SHARED[usize::from(insecure)][profile as usize];
    if let Some(client) = shared.get() {
        return Ok(client.clone());
    }
    let client = build()?;
    Ok(shared.get_or_init(|| client).clone())
}

/// Sous Windows, le proxy d’un fichier PAC (`AutoConfigURL`) que reqwest ne lit pas, quand l’environnement et les
/// « Paramètres Internet » n’en donnent pas d’autre. Ailleurs, rien ne change (`system_proxy` est vide).
fn windows_pac_proxy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    if crate::git_network::env_proxy(|name| std::env::var(name).ok()) {
        return builder;
    }
    let system = crate::git_network::system_proxy();
    let Some(pac) = system.pac_proxy.filter(|_| !system.enabled) else { return builder };
    let address = if pac.contains("://") { pac } else { format!("http://{pac}") };
    let Ok(proxy) = reqwest::Proxy::all(&address) else { return builder };
    // `ProxyOverride` : « a;b;<local> » ; reqwest attend « a,b ».
    let bypass: Vec<&str> = system
        .bypass
        .as_deref()
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && *entry != "<local>")
        .collect();
    let mut exempt = vec!["localhost", "127.0.0.1", "::1"];
    exempt.extend(bypass);
    builder.proxy(proxy.no_proxy(reqwest::NoProxy::from_string(&exempt.join(","))))
}

/// Message d’un échec réseau, sans l’adresse complète : elle peut porter une clé d’API en paramètre.
pub fn network_error(error: reqwest::Error, secrets: &[String]) -> AppError {
    let error = error.without_url();
    if error.is_timeout() {
        return AppError::with_detail(
            format!("Délai dépassé : le service n’a pas répondu en {} s.", REQUEST_TIMEOUT.as_secs()),
            json!({ "reason": "unreachable" }),
        );
    }
    // La cause la plus profonde est la plus parlante (certificat refusé, nom introuvable, connexion refusée).
    let mut cause: &dyn std::error::Error = &error;
    let mut certificate = false;
    loop {
        let text = cause.to_string().to_lowercase();
        certificate |= text.contains("certificate") || text.contains("certificat");
        match cause.source() {
            Some(source) => cause = source,
            None => break,
        }
    }
    let reason = redact(&cause.to_string(), secrets);
    // Raison en un mot, pour que le parcours de configuration dise quoi faire : certificat d’entreprise non reconnu,
    // adresse injoignable, ou autre échec.
    let kind = if certificate {
        "certificate"
    } else if error.is_connect() {
        "unreachable"
    } else {
        "error"
    };
    AppError::with_detail(
        if error.is_connect() {
            format!("Connexion au service impossible : {reason}.")
        } else {
            format!("La requête n’a pas abouti : {reason}.")
        },
        json!({ "reason": kind }),
    )
}

/// Vérifie qu’une adresse saisie dans le parcours de configuration répond, sans rien envoyer d’autre qu’une lecture
/// anonyme : `{ ok, status, reason, message }`. Toute réponse HTTP prouve que l’adresse est joignable.
async fn probe(args: &Value) -> AppResult<Value> {
    let url = check_url(&arg::<String>(args, "url")?, "L’adresse", false)?;
    let insecure = opt_arg::<bool>(args, "insecureTls")?.unwrap_or(false);
    match shared_http(insecure, Profile::Request)?.get(url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            Ok(json!({ "ok": true, "status": status, "reason": null, "message": format!("L’adresse répond ({status}).") }))
        }
        Err(error) => {
            let error = network_error(error, &[]);
            let reason = error.detail.as_ref().and_then(|detail| detail["reason"].as_str()).unwrap_or("error");
            Ok(json!({ "ok": false, "status": null, "reason": reason, "message": error.message }))
        }
    }
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
pub(crate) fn build_url(
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

/// Requête d’une fonction vers un compte, lue de ses arguments. Le transport (`transport.rs`) s’en sert aussi pour
/// les téléchargements, les flux et les WebSocket.
pub(crate) struct Call {
    pub method: Method,
    pub path: String,
    pub query: Option<Map<String, Value>>,
    pub headers: Option<Map<String, Value>>,
    pub payload: Payload,
    pub response_type: ResponseType,
    /// Clé de la poignée de main d’un WebSocket (`Sec-WebSocket-Key`) : la requête demande alors le passage au
    /// protocole WebSocket, en HTTP/1.1.
    pub handshake: Option<String>,
    /// Module de la fonction et accord explicite (`sealed: true`) pour que les références de secret du corps soient
    /// remplacées par leurs valeurs (voir `secret_refs`). Par défaut : aucune référence acceptée.
    pub sealed: crate::secret_refs::SealedUse,
}

/// Forme sous laquelle la réponse est rendue à la fonction.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ResponseType {
    /// JSON décodé si la réponse en est, sinon le texte.
    Auto,
    /// Le texte, même si c’est du JSON.
    Text,
    /// Le contenu brut en base64, pour un petit binaire (`MAX_BASE64` au plus).
    Base64,
}

impl ResponseType {
    fn parse(name: Option<&str>) -> AppResult<Self> {
        match name.unwrap_or("auto") {
            "auto" | "json" => Ok(Self::Auto),
            "text" => Ok(Self::Text),
            "base64" => Ok(Self::Base64),
            other => Err(AppError::new(format!(
                "`responseType` « {other} » inconnu : « auto », « text » ou « base64 » (pour un gros fichier, `download`)."
            ))),
        }
    }
}

/// Plus gros contenu rendu en base64 (`responseType: "base64"`) : au-delà, `download` le range dans les fichiers.
pub(crate) const MAX_BASE64: usize = 5 * 1024 * 1024;
/// Plus gros fichier envoyé (`file`, partie d’un `multipart`) ou téléchargé (`download`).
pub(crate) const MAX_TRANSFER: u64 = 2 * 1024 * 1024 * 1024;

/// Corps d’une requête. Un fichier est désigné par l’identifiant d’un fichier du module : la fonction ne nomme jamais
/// un chemin du disque, et un module n’envoie que ses propres fichiers.
pub(crate) enum Payload {
    None,
    /// JSON (`body` objet) ou texte (`body` chaîne), avec le type posé à défaut d’en-tête.
    Bytes(Vec<u8>, Option<&'static str>),
    /// `form` : formulaire `application/x-www-form-urlencoded`.
    Form(Vec<(String, String)>),
    /// `file` : un fichier du module, envoyé tel quel (dépôt d’un artefact par `PUT`).
    File(FilePart),
    /// `multipart` : formulaire `multipart/form-data` (pièces jointes).
    Multipart(Vec<(String, MultipartValue)>),
}

pub(crate) struct FilePart {
    pub path: PathBuf,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

pub(crate) enum MultipartValue {
    Text(String),
    File(FilePart),
}

fn module_file(space: &Space, module: &str, id: &str, filename: Option<String>, mime: Option<String>) -> AppResult<FilePart> {
    let info = crate::module_files::info(space, module, id)?;
    if info.size > MAX_TRANSFER {
        return Err(AppError::new("Fichier trop gros pour être envoyé : 2 Go au plus."));
    }
    Ok(FilePart {
        path: crate::module_files::path_of(space, module, id)?,
        name: filename.filter(|name| !name.trim().is_empty()).unwrap_or(info.name),
        mime: mime.filter(|mime| !mime.trim().is_empty()).unwrap_or(info.mime),
        size: info.size,
    })
}

fn scalar_text(value: &Value, what: &str) -> AppResult<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(_) | Value::Bool(_) => Ok(value.to_string()),
        _ => Err(AppError::new(format!("{what} : texte, nombre ou booléen attendu."))),
    }
}

/// Corps décrit par les arguments : `body`, `form`, `multipart` ou `file`, un seul à la fois.
pub(crate) fn payload_of(space: &Space, module: &str, args: &Value) -> AppResult<Payload> {
    let given: Vec<&str> = ["body", "form", "multipart", "file"]
        .into_iter()
        .filter(|name| args.get(*name).is_some_and(|value| !value.is_null()))
        .collect();
    if given.len() > 1 {
        return Err(AppError::new(format!(
            "Un seul corps par requête : `{}` sont donnés ensemble.",
            given.join("` et `")
        )));
    }
    Ok(match given.first().copied() {
        None => Payload::None,
        Some("body") => match &args["body"] {
            Value::String(text) => Payload::Bytes(text.clone().into_bytes(), None),
            value => Payload::Bytes(serde_json::to_vec(value)?, Some("application/json")),
        },
        Some("form") => {
            let fields = object(args, "form")?.into_iter().flatten();
            let pairs = fields
                .filter(|(_, value)| !value.is_null())
                .map(|(name, value)| Ok((name.clone(), scalar_text(value, &format!("Champ « {name} » du formulaire"))?)))
                .collect::<AppResult<Vec<_>>>()?;
            Payload::Form(pairs)
        }
        Some("file") => Payload::File(module_file(space, module, &arg::<String>(args, "file")?, None, None)?),
        _ => {
            let Some(parts) = args["multipart"].as_array() else {
                return Err(AppError::new("`multipart` : une liste de parties `{ name, value }` ou `{ name, file }` est attendue."));
            };
            let mut values = Vec::new();
            let mut total = 0u64;
            for part in parts {
                let name = part.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()).ok_or_else(|| {
                    AppError::new("Chaque partie de `multipart` a un `name`.")
                })?;
                let value = match (part.get("file").and_then(Value::as_str), part.get("value")) {
                    (Some(id), _) => {
                        let filename = part.get("filename").and_then(Value::as_str).map(str::to_string);
                        let mime = part.get("mime").and_then(Value::as_str).map(str::to_string);
                        let file = module_file(space, module, id, filename, mime)?;
                        total += file.size;
                        MultipartValue::File(file)
                    }
                    (None, Some(value)) if !value.is_null() => {
                        MultipartValue::Text(scalar_text(value, &format!("Partie « {name} »"))?)
                    }
                    _ => {
                        return Err(AppError::new(format!(
                            "La partie « {name} » de `multipart` porte `value` (texte) ou `file` (identifiant d’un fichier du module)."
                        )))
                    }
                };
                values.push((name.to_string(), value));
            }
            if total > MAX_TRANSFER {
                return Err(AppError::new("Envoi trop gros : 2 Go au plus pour tous les fichiers."));
            }
            Payload::Multipart(values)
        }
    })
}

/// Corps d’un fichier lu en flux, jamais chargé en mémoire.
async fn file_body(file: &FilePart) -> AppResult<reqwest::Body> {
    let opened = tokio::fs::File::open(&file.path)
        .await
        .map_err(|error| AppError::new(format!("Le fichier « {} » n’a pas pu être lu : {error}", file.name)))?;
    Ok(reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::with_capacity(opened, 64 * 1024)))
}

impl Payload {
    /// Pose le corps sur la requête. Rappelée à chaque essai : un corps lu en flux ne se relit pas.
    async fn apply(&self, mut request: reqwest::RequestBuilder, headers: &mut HeaderMap) -> AppResult<reqwest::RequestBuilder> {
        match self {
            Payload::None => {}
            Payload::Bytes(bytes, kind) => {
                if let Some(kind) = kind {
                    headers.entry(CONTENT_TYPE).or_insert(HeaderValue::from_static(kind));
                }
                request = request.body(bytes.clone());
            }
            Payload::Form(pairs) => {
                let encoded = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish();
                headers.entry(CONTENT_TYPE).or_insert(HeaderValue::from_static("application/x-www-form-urlencoded"));
                request = request.body(encoded);
            }
            Payload::File(file) => {
                if !headers.contains_key(CONTENT_TYPE) {
                    if let Ok(mime) = HeaderValue::from_str(&file.mime) {
                        headers.insert(CONTENT_TYPE, mime);
                    }
                }
                // Longueur annoncée : certains dépôts (Artifactory, Nexus) refusent un envoi par morceaux.
                headers.insert(reqwest::header::CONTENT_LENGTH, HeaderValue::from(file.size));
                request = request.body(file_body(file).await?);
            }
            Payload::Multipart(parts) => {
                // La frontière du formulaire est choisie par Alfred : un type posé par la fonction la contredirait.
                headers.remove(CONTENT_TYPE);
                let mut form = reqwest::multipart::Form::new();
                for (name, value) in parts {
                    form = match value {
                        MultipartValue::Text(text) => form.text(name.clone(), text.clone()),
                        MultipartValue::File(file) => {
                            let part = reqwest::multipart::Part::stream_with_length(file_body(file).await?, file.size)
                                .file_name(file.name.clone())
                                .mime_str(&file.mime)
                                .map_err(|_| AppError::new(format!("Type « {} » invalide pour « {} ».", file.mime, file.name)))?;
                            form.part(name.clone(), part)
                        }
                    };
                }
                request = request.multipart(form);
            }
        }
        Ok(request)
    }
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

pub(crate) async fn read_limited(response: &mut reqwest::Response, secrets: &[String], limit: usize) -> AppResult<Vec<u8>> {
    let too_large = || {
        AppError::new(format!(
            "Réponse trop volumineuse : plus de {} Mo. Pour un fichier, `client(id).download(...)` le range dans les fichiers du module.",
            limit / 1024 / 1024
        ))
    };
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| network_error(error, secrets))? {
        if bytes.len() + chunk.len() > limit {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Retire d’un contenu brut les secrets qui s’y trouvent tels quels (un binaire qui renverrait la requête en écho).
pub(crate) fn redact_bytes(bytes: &mut Vec<u8>, secrets: &[String]) {
    *bytes = crate::transport::Redactor::all(secrets, bytes);
}

/// En-têtes d’une réponse pour la fonction : secrets masqués, cookies retirés.
pub(crate) fn response_headers(response: &reqwest::Response, secrets: &[String]) -> Map<String, Value> {
    let mut received = Map::new();
    for (name, value) in response.headers() {
        // Alfred ne gère pas de session par cookie : une page n’a pas à en récolter.
        if name == SET_COOKIE {
            continue;
        }
        let text = redact(&String::from_utf8_lossy(value.as_bytes()), secrets);
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
    received
}

/// Réponse reçue d’un compte, et les valeurs à masquer dans tout ce qui en sera lu.
pub(crate) struct Sent {
    pub response: reqwest::Response,
    pub secrets: Vec<String>,
}

/// Envoie la requête d’un compte et rend la réponse, corps non lu. C’est le **seul point de sortie** vers un
/// service : l’adresse est bornée à celle du compte (`build_url`), les en-têtes de la fonction sont filtrés,
/// l’authentification est posée en dernier, en natif, à chaque essai (un jeton refusé est redemandé une fois).
///
/// Point d’extension : un remplacement de références de secret dans les en-têtes, l’adresse ou le corps sortants
/// se ferait ici, entre `credential` et l’envoi, en ajoutant les valeurs remplacées à `secrets` pour qu’elles
/// soient masquées dans la réponse.
pub(crate) async fn send(state: &Arc<AppState>, client: &Client, call: &Call, profile: Profile) -> AppResult<Sent> {
    client.validate()?;
    ensure_trusted(state, client)?;
    // Références de secret : jamais dans l’adresse ni les en-têtes ; un chemin scellé ne se lit que par une requête
    // ordinaire, dont `perform` scelle la réponse (un téléchargement, un flux, un WebSocket ou une réponse en base64
    // livreraient les valeurs en clair).
    crate::secret_refs::refuse_outside_body(&call.path, call.query.as_ref(), call.headers.as_ref())?;
    let sealed_rule = crate::secret_refs::matching_rule(client, &call.method, &call.path);
    if sealed_rule.is_some()
        && (profile != Profile::Request || call.handshake.is_some() || call.response_type == ResponseType::Base64)
    {
        return Err(AppError::new(format!(
            "« {} » est un chemin scellé du service « {} » : il se lit par une requête ordinaire (`client(id).get`), dont Alfred remplace les valeurs secrètes par des références.",
            call.path.split('?').next().unwrap_or_default(),
            client.label
        )));
    }
    let (substituted, placed) = substituted_payload(&call.payload, &call.sealed, sealed_rule, client)?;
    let payload = substituted.as_ref().unwrap_or(&call.payload);
    let reserved_param = client.auth.query_param.as_deref().filter(|_| client.auth.kind == AuthKind::ApiKey);
    // Sans adresse déclarée (`secretUrl`), l’adresse vient du trousseau à chaque essai.
    let url = match client.base() {
        Ok(base) => Ok(build_url(&base, &call.path, call.query.as_ref(), reserved_param)?),
        Err(error) => Err(error),
    };

    let invalid_header = |name: &str| AppError::new(format!("L’en-tête « {name} » n’est pas valide."));
    let mut headers = HeaderMap::new();
    for (name, value) in &client.headers {
        let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid_header(name))?;
        headers.insert(header, HeaderValue::from_str(value).map_err(|_| invalid_header(name))?);
    }
    let api_header = client.auth.header.as_deref().filter(|_| client.auth.kind == AuthKind::ApiKey);
    for (name, value) in call.headers.iter().flatten() {
        let lower = name.to_ascii_lowercase();
        if RESERVED_HEADERS.contains(&lower.as_str())
            || lower.starts_with("sec-websocket-") && lower != "sec-websocket-protocol"
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
    if let Some(key) = &call.handshake {
        use reqwest::header::{CONNECTION, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE};
        headers.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(SEC_WEBSOCKET_VERSION, HeaderValue::from_static("13"));
        headers.insert(SEC_WEBSOCKET_KEY, HeaderValue::from_str(key).map_err(|_| invalid_header("Sec-WebSocket-Key"))?);
    }

    let http = shared_http(client.insecure_tls, profile)?;
    let mut stale: Option<String> = None;
    loop {
        let credential = credential(state, client, stale.as_deref()).await?;
        // `secretUrl` : l’adresse complète vient du trousseau ; le chemin y reste borné de la même façon.
        let mut target = match &credential.base {
            // La query de l’adresse secrète (souvent le jeton) est gardée devant celle de la requête.
            Some(base) => crate::sessions::secret_target(base, &call.path, call.query.as_ref())?,
            None => url.clone()?,
        };
        for (name, value) in &credential.query {
            target.query_pairs_mut().append_pair(name, value);
        }
        let mut sent = headers.clone();
        let mut request = http.request(call.method.clone(), target);
        if call.handshake.is_some() {
            request = request.version(reqwest::Version::HTTP_11);
        }
        request = payload.apply(request, &mut sent).await?;
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
        let response = request.headers(sent).send().await.map_err(|error| network_error(error, &credential.secrets))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && stale.is_none() && credential.renewable.is_some() {
            // Jeton refusé avant l’heure (révoqué, horloge décalée) : on en redemande un, une seule fois.
            stale = credential.renewable;
            continue;
        }
        let mut secrets = credential.secrets;
        secrets.extend(placed.iter().cloned());
        return Ok(Sent { response, secrets });
    }
}

/// Corps dont les références de secret ont été remplacées (requête `sealed: true` vers un chemin scellé du même
/// service), et les valeurs placées ; `None` quand le corps n’en porte pas. Refusé partout ailleurs.
fn substituted_payload(
    payload: &Payload,
    sealed: &crate::secret_refs::SealedUse,
    rule: Option<&SealedRule>,
    client: &Client,
) -> AppResult<(Option<Payload>, Vec<String>)> {
    use crate::secret_refs::{refuse_in_text, substitute_body, substitute_pairs};
    Ok(match payload {
        Payload::Bytes(bytes, kind) => match substitute_body(bytes, kind.is_some(), sealed, rule, client)? {
            Some((bytes, placed)) => (Some(Payload::Bytes(bytes, *kind)), placed),
            None => (None, Vec::new()),
        },
        Payload::Form(pairs) => match substitute_pairs(pairs, sealed, rule, client)? {
            Some((pairs, placed)) => (Some(Payload::Form(pairs)), placed),
            None => (None, Vec::new()),
        },
        Payload::Multipart(parts) => {
            for (name, value) in parts {
                refuse_in_text(name)?;
                if let MultipartValue::Text(text) = value {
                    refuse_in_text(text)?;
                }
            }
            (None, Vec::new())
        }
        Payload::None | Payload::File(_) => (None, Vec::new()),
    })
}

/// Exécute la requête d’un client et renvoie `{status, ok, headers, body}`.
async fn perform(state: &Arc<AppState>, client: &Client, call: &Call) -> AppResult<Value> {
    let Sent { mut response, secrets } = send(state, client, call, Profile::Request).await?;
    let status = response.status();
    let received = response_headers(&response, &secrets);
    let body = match call.response_type {
        ResponseType::Base64 => {
            let mut bytes = read_limited(&mut response, &secrets, MAX_BASE64).await?;
            redact_bytes(&mut bytes, &secrets);
            Value::String(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        kind => {
            let is_json = kind == ResponseType::Auto
                && received.get("content-type").and_then(Value::as_str).is_some_and(|kind| kind.contains("json"));
            let bytes = read_limited(&mut response, &secrets, MAX_BODY).await?;
            // Un service qui renvoie la requête en écho ne doit pas livrer le secret à la page.
            let text = redact(&String::from_utf8_lossy(&bytes), &secrets);
            match serde_json::from_str::<Value>(&text) {
                Ok(value) if is_json => value,
                _ => Value::String(text),
            }
        }
    };
    // Chemin scellé : les champs déclarés ne repartent que sous forme de références, et leurs valeurs sont masquées
    // dans le reste de la réponse (un champ non déclaré, un en-tête qui les répéterait).
    let (body, received) = match crate::secret_refs::matching_rule(client, &call.method, &call.path) {
        Some(rule) => {
            let (body, values) = crate::secret_refs::seal_body(body, rule, &call.sealed.module, client);
            let text = redact(&body.to_string(), &values);
            let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
            let received: Map<String, Value> = received
                .into_iter()
                .map(|(name, value)| (name, Value::String(redact(&crate::secret_refs::value_text(&value), &values))))
                .collect();
            (body, received)
        }
        None => (body, received),
    };
    Ok(json!({ "status": status.as_u16(), "ok": status.is_success(), "headers": received, "body": body }))
}

/// Issue d’une requête pour le journal : le statut HTTP s’il y en a un, et le texte du résumé.
pub(crate) fn outcome_of(result: &AppResult<Value>) -> (Option<u64>, String) {
    match result {
        Ok(value) => match value.get("status").and_then(Value::as_u64) {
            Some(status) => (Some(status), status.to_string()),
            None => (None, "échec".to_string()),
        },
        Err(error) => (None, format!("échec : {}", error.message)),
    }
}

/// Trace d’une requête au journal : qui, quoi, combien de temps. Ni paramètres, ni en-têtes, ni corps.
pub(crate) fn journal(
    state: &AppState,
    space: &Space,
    client: &Client,
    call: &Call,
    requester: (&str, &str),
    started: Instant,
    (status, outcome): (Option<u64>, String),
) {
    let duration = started.elapsed().as_millis() as u64;
    let path: String = call.path.split('?').next().unwrap_or_default().chars().take(200).collect();
    let path = if path.is_empty() { "/".to_string() } else { path };
    let verb = if call.handshake.is_some() { "WS" } else { call.method.as_str() };
    let summary = format!("{verb} {path} → {outcome}");
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

/// Appel accordé : la fonction, son compte et sa requête, une fois toutes les vérifications passées.
pub(crate) struct Granted {
    pub space: Space,
    pub subject: Subject,
    pub client: Client,
    pub call: Call,
}

impl Granted {
    pub fn requester(&self) -> (&str, &str) {
        (self.subject.kind.as_str(), self.subject.reference.as_str())
    }
}

/// Vérifications communes à tout appel d’un compte (requête, téléchargement, flux, WebSocket) : seule une fonction
/// appelle, jamais en mode exemple ; le compte est celui de la page ou celui nommé ; il est validé et accordé. Un
/// refus est noté au journal.
pub(crate) async fn grant_call(state: &Arc<AppState>, args: &Value, method: Option<Method>) -> AppResult<Granted> {
    let subject: Subject = arg(args, "subject")?;
    let name: String = arg(args, "client")?;
    // Cloisonnement : un service ne se joint que par une fonction de son connecteur. Une page ou un panneau appelle
    // la fonction (`functions.call`), jamais le client lui-même.
    if subject.kind != "function" {
        return Err(AppError::new(format!(
            "Une page n’appelle pas un client directement : « {name} » se joint par une fonction du connecteur du \
             module (`declare_function`), que la page appelle avec `functions.call(\"{}/<fonction>\", …)`.",
            dependency_reference(&name).map(|(module, _)| module.to_string()).unwrap_or_else(|| subject.module.clone())
        )));
    }
    // Données d’exemple : rien ne part vers un service, quoi que tente la fonction (indicateur fixé par la coquille,
    // ou module réglé en mode exemple).
    if subject.examples || crate::examples::is_on(state, &subject.module) {
        return Err(crate::examples::blocked(&name));
    }
    let space = state.space()?;
    let mut def = resolve(&space, &subject.module, &name)?;
    // Une fonction appelée depuis une page appelle le compte que la page a choisi pour ce besoin, sauf si elle en
    // nomme un autre ; à défaut, l’instance de la page, puis celle par défaut.
    let mut instance = opt_arg::<String>(args, "instance")?
        .or_else(|| subject.accounts.get(&name).cloned())
        .or_else(|| subject.instance.clone());
    // Un compte d’un autre service du même type (`client/instance`), choisi par l’utilisateur pour la page.
    let mut borrowed = false;
    if let Some((other, id)) = instance.clone().as_deref().and_then(|value| value.split_once('/')) {
        if other != def.id {
            def = crate::menu::compatible_clients(&space, &subject.module, &name)
                .into_iter()
                .find(|candidate| candidate.id == other)
                .ok_or_else(|| {
                    AppError::new(format!("Le compte « {other}/{id} » n’est pas un compte du type de « {name} »."))
                })?;
            borrowed = true;
        }
        instance = Some(id.to_string());
    }
    let client = def.effective(instance.as_deref())?;
    let call = Call {
        method: match method {
            Some(method) => method,
            None => method_of(opt_arg::<String>(args, "method")?.as_deref())?,
        },
        // `{realm}`, `{mount}`… : les paramètres du compte, encodés comme un segment.
        path: fill_params(&arg::<String>(args, "path")?, &client.params),
        query: object(args, "query")?.cloned(),
        headers: object(args, "headers")?.cloned(),
        payload: payload_of(&space, &subject.module, args)?,
        response_type: ResponseType::parse(opt_arg::<String>(args, "responseType")?.as_deref())?,
        handshake: None,
        sealed: crate::secret_refs::SealedUse {
            module: subject.module.clone(),
            substitute: opt_arg::<bool>(args, "sealed")?.unwrap_or(false),
        },
    };
    let requester = (subject.kind.as_str(), subject.reference.as_str());
    let started = Instant::now();
    // Un client à valider est refusé avant même de demander l’accord : on ne fait pas autoriser à l’utilisateur
    // un client dont il n’a pas vu l’adresse.
    if let Err(error) = ensure_trusted(state, &client) {
        journal(state, &space, &client, &call, requester, started, outcome_of(&Err(error.clone())));
        return Err(error);
    }
    // L’accord vaut pour le client et toutes ses instances : la question montre donc chacune de leurs adresses.
    let resource = format!("client:{}", client.id);
    let addresses: Vec<String> = def
        .instances
        .iter()
        .filter_map(|instance| def.resolve_instance(instance).ok())
        .map(|resolved| canonical_url(&resolved.base_url, true))
        .collect();
    // Le libellé n’est pas dans l’empreinte validée : la question montre aussi l’identifiant et l’adresse validés.
    let label = format!("le client {} (« {} », {})", def.label, client.id, addresses.join(", "));
    // Le client d’une dépendance a été annoncé à l’installation ou déclaré dans `requires` : pas de question.
    let through_dependency = dependency_reference(&name).is_some() && !borrowed;
    let allowed =
        if through_dependency { Ok(()) } else { permissions::ensure(state, &subject, &resource, &label).await };
    if let Err(error) = allowed {
        // Un refus est une tentative d’accès : elle doit se retrouver au journal comme une requête.
        journal(state, &space, &client, &call, requester, started, (None, "accès refusé".to_string()));
        return Err(error);
    }
    Ok(Granted { space, subject, client, call })
}

async fn frame_request(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let granted = grant_call(state, args, None).await?;
    let Granted { space, subject, client, call } = &granted;
    let name: String = arg(args, "client")?;
    // Cache demandé par la requête (`cache`, en secondes) ou par le besoin du module : lectures seulement.
    let ttl = match opt_arg::<u64>(args, "cache")? {
        Some(ttl) => ttl,
        None => space
            .module(&subject.module)
            .ok()
            .and_then(|manifest| manifest.clients.iter().find(|need| need.id == name).and_then(|need| need.cache))
            .unwrap_or(0),
    }
    .min(crate::client_cache::MAX_TTL);
    // Une réponse scellée ne se garde pas : ses références expirent en cinq minutes.
    let sealed = crate::secret_refs::matching_rule(client, &call.method, &call.path).is_some();
    let cache_key = (ttl > 0 && !sealed && matches!(call.method, Method::GET | Method::HEAD)).then(|| {
        let fingerprint = format!("{}#{}", serde_json::to_string(&client).unwrap_or_default(), client.instance);
        // Un contenu rendu en base64 n’est pas la même réponse que son texte.
        let path = match call.response_type {
            ResponseType::Auto => call.path.clone(),
            kind => format!("{}#{kind:?}", call.path),
        };
        crate::client_cache::key(
            &subject.module,
            &fingerprint,
            call.method.as_str(),
            &path,
            call.query.as_ref(),
            call.headers.as_ref(),
        )
    });
    let requester = granted.requester();
    let started = Instant::now();
    if let Some(key) = &cache_key {
        if let Some(cached) = crate::client_cache::get(space, key)? {
            let status = cached.get("status").and_then(Value::as_u64);
            journal(state, space, client, call, requester, started, (status, "réponse en cache".to_string()));
            return Ok(cached);
        }
    }
    let result = perform(state, client, call).await;
    journal(state, space, client, call, requester, started, outcome_of(&result));
    if let (Some(key), Ok(response)) = (&cache_key, &result) {
        if let Err(error) = crate::client_cache::put(space, key, &subject.module, &client.id, ttl, response) {
            log::error!("cache du client {} : {}", client.id, error.message);
        }
    }
    result
}

/// Oublie les réponses gardées d’un client pour le module qui le demande.
fn frame_clear_cache(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let name: String = arg(args, "client")?;
    let space = state.space()?;
    let def = resolve(&space, &subject.module, &name)?;
    let cleared = crate::client_cache::clear(&space, &subject.module, &def.id)?;
    Ok(json!({ "cleared": cleared }))
}

/// Instances d’un client, pour qu’une page propose de choisir : identifiant et nom seulement, jamais l’adresse ni
/// l’entrée du coffre.
fn frame_instances(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let name: String = arg(args, "client")?;
    let def = resolve(&state.space()?, &subject.module, &name)?;
    Ok(Value::Array(
        def.instances
            .iter()
            .enumerate()
            .map(|(index, instance)| {
                json!({ "id": instance.id, "label": instance.display_label(), "default": index == 0 })
            })
            .collect(),
    ))
}

/// Paramètres non secrets du compte que viserait une requête (`client(id, { instance }).params()`) : même choix du
/// compte que pour une requête, sans accord à demander puisque rien ne part vers le service ni ne sort du coffre.
fn frame_params(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let name: String = arg(args, "client")?;
    let space = state.space()?;
    let mut def = resolve(&space, &subject.module, &name)?;
    let mut instance = opt_arg::<String>(args, "instance")?
        .or_else(|| subject.accounts.get(&name).cloned())
        .or_else(|| subject.instance.clone());
    if let Some((other, id)) = instance.clone().as_deref().and_then(|value| value.split_once('/')) {
        if other != def.id {
            def = crate::menu::compatible_clients(&space, &subject.module, &name)
                .into_iter()
                .find(|candidate| candidate.id == other)
                .ok_or_else(|| {
                    AppError::new(format!("Le compte « {other}/{id} » n’est pas un compte du type de « {name} »."))
                })?;
        }
        instance = Some(id.to_string());
    }
    let client = def.effective(instance.as_deref())?;
    Ok(json!({ "instance": client.instance, "params": client.params }))
}

/// `dépendance/besoin`, quand les deux sont des identifiants valides ; tout autre nom est cherché tel quel.
fn dependency_reference(name: &str) -> Option<(&str, &str)> {
    name.split_once('/').filter(|(owner, need)| crate::space::valid_id(owner) && crate::space::valid_id(need))
}

/// Besoin `need` du module `owner`, demandé par `module` qui doit en dépendre ; renvoie l’identifiant du besoin.
fn dependency_need(space: &Space, module: &str, owner: &str, need: &str) -> AppResult<String> {
    let requester = space.module(module)?;
    if !requester.requires_module(owner) {
        return Err(AppError::new(format!(
            "Le client « {owner}/{need} » appartient au module « {owner} », dont « {module} » ne dépend pas : ajouter `{{ \"module\": \"{owner}\" }}` à `requires` dans son module.json."
        )));
    }
    let provider = space.module(owner)?;
    if !provider.clients.iter().any(|declared| declared.id == need) {
        return Err(AppError::new(format!("Le module « {owner} » ne déclare pas de client « {need} » dans `clients`.")));
    }
    Ok(need.to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------------------------------------------

/// État d’une instance : `ready`, `toValidate`, `missingSecret`, `toConnect` ou `invalid`, avec le détail qui
/// l’explique.
fn instance_state(state: &AppState, client: &Client) -> Value {
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
        let stored =
            state.try_space().and_then(|space| trusted_fingerprint(state, &space, &client.trust_key()).ok().flatten());
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
    let last_test = state.try_space().map_or(Value::Null, |space| last_test(state, &space, client));
    json!({
        "status": status,
        "hasSecret": has_secret,
        "connected": connected,
        "problem": problem,
        "validation": validation,
        "lastTest": last_test,
    })
}

/// Ordre de gravité des états : celui d’un client est le pire de ses instances.
const STATUS_ORDER: [&str; 6] = ["invalid", "toValidate", "noInstance", "missingSecret", "toConnect", "ready"];

fn describe_instance(state: &AppState, def: &ClientDef, index: usize, instance: &Instance) -> Value {
    let base = json!({
        "id": instance.id,
        "label": instance.display_label(),
        "url": instance.url,
        "method": instance.method,
        "secret": instance.secret,
        "headers": instance.headers,
        "insecureTls": instance.insecure_tls,
        "params": instance.params,
        "default": index == 0,
    });
    let mut item = base;
    match def.resolve_instance(instance) {
        Ok(client) => {
            let described = instance_state(state, &client);
            for (key, value) in described.as_object().into_iter().flatten() {
                item[key] = value.clone();
            }
            item["effectiveUrl"] = json!(client.base_url);
            item["authType"] = json!(client.auth.kind);
        }
        Err(error) => {
            item["status"] = json!("invalid");
            item["problem"] = json!(error.message);
            item["hasSecret"] = json!(false);
            item["connected"] = Value::Null;
            item["validation"] = Value::Null;
            item["effectiveUrl"] = Value::Null;
            item["authType"] = Value::Null;
        }
    }
    item
}

/// Un client tel que les Réglages et l’agent le voient : sa définition, ses instances et leur état. Un client à
/// une seule instance garde aussi la forme d’avant les instances (`auth` avec son entrée du coffre, `validation`
/// avec une seule empreinte).
fn describe(state: &AppState, def: &ClientDef, used_by: &[Value]) -> Value {
    let instances: Vec<Value> =
        def.instances.iter().enumerate().map(|(index, instance)| describe_instance(state, def, index, instance)).collect();
    let definition_problem = def.validate_definition().err().map(|error| error.message);
    let status = if definition_problem.is_some() {
        "invalid"
    } else if instances.is_empty() {
        "noInstance"
    } else {
        STATUS_ORDER
            .iter()
            .find(|status| instances.iter().any(|instance| instance["status"].as_str() == Some(status)))
            .copied()
            .unwrap_or("ready")
    };
    let simple = def.is_simple();
    let checked: Vec<&Value> = instances.iter().filter(|instance| !instance["validation"].is_null()).collect();
    let validation = (!checked.is_empty()).then(|| {
        let pending: Vec<&&Value> =
            checked.iter().filter(|instance| instance["validation"]["validated"] == json!(false)).collect();
        let changes: Vec<Value> = if simple {
            checked[0]["validation"]["changes"].as_array().cloned().unwrap_or_default()
        } else {
            pending
                .iter()
                .flat_map(|instance| {
                    instance["validation"]["changes"].as_array().cloned().unwrap_or_default().into_iter().map(
                        |mut change| {
                            change["instance"] = instance["id"].clone();
                            change["instanceLabel"] = instance["label"].clone();
                            change
                        },
                    )
                })
                .collect()
        };
        let fingerprints: Map<String, Value> = checked
            .iter()
            .map(|instance| {
                (instance["id"].as_str().unwrap_or_default().to_string(), instance["validation"]["fingerprint"].clone())
            })
            .collect();
        json!({
            "validated": pending.is_empty(),
            "everValidated": if pending.is_empty() {
                true
            } else {
                pending.iter().all(|instance| instance["validation"]["everValidated"] == json!(true))
            },
            "changes": changes,
            "fingerprint": if simple { checked[0]["validation"]["fingerprint"].clone() } else { Value::Null },
            "fingerprints": fingerprints,
        })
    });
    let problem = definition_problem.or_else(|| {
        instances.iter().find_map(|instance| {
            instance["problem"].as_str().map(|problem| {
                if simple {
                    problem.to_string()
                } else {
                    format!("{} : {problem}", instance["label"].as_str().unwrap_or_default())
                }
            })
        })
    });
    let single = (instances.len() == 1).then(|| &instances[0]);
    let mut item = json!({
        "id": def.id,
        "label": def.label,
        "baseUrl": def.base_url,
        "headers": def.headers,
        "testPath": def.test_path,
        "methods": def.methods,
        "instances": instances,
        "simple": simple,
        "status": status,
        "problem": problem,
        "usedBy": used_by,
        "validation": validation,
        "hasSecret": single.map_or(json!(false), |instance| instance["hasSecret"].clone()),
        "connected": single.map_or(Value::Null, |instance| instance["connected"].clone()),
    });
    if simple {
        let mut auth = serde_json::to_value(&def.methods[0].auth).unwrap_or_else(|_| json!({}));
        if let Some(secret) = &def.instances[0].secret {
            auth["secret"] = json!(secret);
        }
        item["auth"] = auth;
    }
    item
}

/// Vue des clients et des besoins des modules, celle des Réglages (`clients.list`).
pub fn overview(state: &Arc<AppState>) -> AppResult<Value> {
    list(state)
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
                    "id": id, "label": id, "baseUrl": "", "headers": {}, "methods": [], "instances": [], "simple": false,
                    "status": "invalid", "hasSecret": false, "connected": null, "usedBy": used_by, "problem": error.message,
                    "validation": null,
                }),
            }
        })
        .collect();
    Ok(json!({ "clients": clients, "needs": needs, "redirectUri": oauth::redirect_uri(state).ok() }))
}

/// Une entrée absente du coffre est admise (le fichier voyage entre postes, pas le coffre), mais pas une entrée
/// du mauvais type : la requête échouerait à chaque fois.
fn check_entry_kind(state: &AppState, client: &Client) -> AppResult<()> {
    if let (Some(secret), Some(kind)) = (&client.auth.secret, client.auth.kind.vault_kind()) {
        if vault::entry(state, secret)?.is_some_and(|entry| entry.kind != kind) {
            return Err(AppError::new(
                "L’entrée du coffre choisie n’est pas du type attendu par cette authentification.",
            ));
        }
    }
    Ok(())
}

/// Instances dont l’empreinte actuelle est celle que l’utilisateur a validée.
fn trusted_instances(state: &AppState, space: &Space, def: &ClientDef) -> Vec<String> {
    def.instances
        .iter()
        .filter(|instance| {
            def.resolve_instance(instance).is_ok_and(|client| {
                trusted_fingerprint(state, space, &client.trust_key()).ok().flatten() == Some(fingerprint(&client))
            })
        })
        .map(|instance| instance.id.clone())
        .collect()
}

fn store(space: &Space, def: &ClientDef) -> AppResult<()> {
    std::fs::create_dir_all(clients_dir(space))?;
    write_json(&client_path(space, &def.id), &def.to_file())
}

/// Écrit le fichier d’un client. `validated` distingue les deux origines : l’utilisateur, dans les Réglages, dont
/// l’enregistrement vaut validation, et l’agent, dont le client naît ou redevient « à valider ».
///
/// Sous sa forme simple, le client porte son instance : celle de l’utilisateur est validée avec lui. Sous la forme
/// à plusieurs instances, les instances du fichier existant sont gardées telles quelles : elles se modifient une à
/// une (`clients.saveInstance`), et l’agent n’y touche jamais.
fn write_client(state: &Arc<AppState>, args: &Value, validated: bool) -> AppResult<Value> {
    let space = state.space()?;
    let mut def: ClientDef = arg(args, "client")?;
    let carried = def.carries_instance();
    def.normalize();
    def.validate_definition()?;
    let existing = load(&space, &def.id)?;
    if opt_arg::<bool>(args, "create")?.unwrap_or(false) && existing.is_some() {
        return Err(AppError::new(format!("Un client porte déjà l’identifiant « {} ».", def.id)));
    }
    let mut previously_trusted =
        existing.as_ref().map(|old| trusted_instances(state, &space, old)).unwrap_or_default();
    // Instances reçues : celle de la forme simple, ou la liste `instances` que l’agent déclare.
    let incoming = std::mem::take(&mut def.instances);
    let received = carried || !incoming.is_empty();
    match &existing {
        // L’utilisateur enregistre la forme simple : il a vu l’instance entière.
        Some(_) if validated && carried => def.instances = incoming,
        // Les autres instances du fichier restent ; celles reçues les complètent ou les remplacent, en gardant
        // l’entrée du coffre déjà reliée quand elles n’en nomment pas.
        Some(old) => def.instances = merge_instances(&old.instances, incoming),
        None if received => def.instances = incoming,
        None if !def.base_url.is_empty() => {
            // Un nouveau client à adresse fixe naît avec son instance, à relier à une entrée du coffre.
            def.instances = vec![Instance {
                id: DEFAULT_INSTANCE.to_string(),
                method: def.methods[0].id.clone(),
                ..Instance::default()
            }];
            // Créée avec le client par l’utilisateur, elle n’a rien qu’il n’ait vu.
            previously_trusted.push(DEFAULT_INSTANCE.to_string());
        }
        None => {}
    }
    // Une instance reçue avec le client est vérifiée comme une instance des Réglages ; celles gardées du fichier
    // existant montrent leurs problèmes dans la liste.
    if received {
        for instance in &def.instances {
            let client = def.resolve_instance(instance)?;
            if validated {
                client.validate()?;
            }
            check_entry_kind(state, &client)?;
        }
    }
    store(&space, &def)?;
    if validated {
        for instance in &def.instances {
            let Ok(client) = def.resolve_instance(instance) else { continue };
            // L’utilisateur a vu l’instance qu’il enregistre avec le client ; les autres ne restent validées que si
            // elles l’étaient déjà : une instance réécrite hors des Réglages le reste jusqu’à sa validation.
            if (carried || previously_trusted.contains(&instance.id)) && client.validate().is_ok() {
                record_trust(state, &space, &client)?;
            }
        }
    }
    let message = if validated {
        format!("Client {}", def.label)
    } else {
        format!("Client {} (déclaré par l’agent)", def.label)
    };
    git::commit_all(&space.root, &message)?;
    state.emit("clients:changed", json!({ "client": def.id }));
    Ok(describe(state, &def, &[]))
}

/// Instances du fichier complétées par celles reçues (même identifiant : remplacée ; sinon ajoutée à la fin). Une
/// instance reçue sans entrée du coffre garde celle qui était reliée.
fn merge_instances(old: &[Instance], incoming: Vec<Instance>) -> Vec<Instance> {
    let mut merged = old.to_vec();
    for mut instance in incoming {
        match merged.iter_mut().find(|known| known.id == instance.id) {
            Some(known) => {
                if instance.secret.is_none() {
                    instance.secret = known.secret.take();
                }
                *known = instance;
            }
            None => merged.push(instance),
        }
    }
    merged
}

/// Ajout ou modification d’une instance depuis les Réglages : l’utilisateur saisit son adresse et choisit son
/// entrée du coffre, l’enregistrement vaut validation.
fn save_instance(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let mut def = require(&space, &arg::<String>(args, "client")?)?;
    def.validate_definition()?;
    let mut instance: Instance = arg(args, "instance")?;
    instance.normalize();
    if instance.label.is_empty() && instance.id != DEFAULT_INSTANCE {
        return Err(AppError::new("Saisir le nom de l’instance."));
    }
    if !valid_id(&instance.id) {
        return Err(AppError::new(format!(
            "Identifiant d’instance invalide : « {} ». Utiliser des minuscules, des chiffres et des tirets.",
            instance.id
        )));
    }
    let Some(method) = def.method(&instance.method) else {
        return Err(AppError::new(format!("Le client « {} » n’a pas de méthode « {} ».", def.label, instance.method)));
    };
    // Seuls les paramètres que la méthode déclare sont gardés ; leur valeur reste du texte simple.
    let declared: Vec<&str> = method.params.iter().map(|param| param.id.as_str()).collect();
    instance.params.retain(|name, _| declared.contains(&name.as_str()));
    if let Some((name, _)) = instance.params.iter().find(|(_, value)| value.len() > 200 || value.contains(char::is_control)) {
        return Err(AppError::new(format!("Valeur invalide pour le paramètre « {name} » : un texte court, sur une ligne.")));
    }
    let position = def.instances.iter().position(|known| known.id == instance.id);
    let create = opt_arg::<bool>(args, "create")?.unwrap_or(false);
    match (position, create) {
        (Some(_), true) => {
            return Err(AppError::new(format!("Le client « {} » a déjà une instance « {} ».", def.label, instance.id)))
        }
        (None, false) => {
            return Err(AppError::new(format!("Le client « {} » n’a pas d’instance « {} ».", def.label, instance.id)))
        }
        (Some(index), false) => def.instances[index] = instance.clone(),
        (None, true) => def.instances.push(instance.clone()),
    }
    let client = def.resolve_instance(&instance)?;
    client.validate()?;
    check_entry_kind(state, &client)?;
    store(&space, &def)?;
    record_trust(state, &space, &client)?;
    git::commit_all(&space.root, &format!("Instance {} du client {}", instance.display_label(), def.label))?;
    state.emit("clients:changed", json!({ "client": def.id, "instance": instance.id }));
    Ok(describe(state, &def, &[]))
}

fn forget_trust(state: &AppState, space: &Space, key: &str) -> AppResult<()> {
    let db = trust_db(state)?;
    db.execute("DELETE FROM client_trust WHERE space = ?1 AND client = ?2", params![space_key(space), key])?;
    Ok(())
}

fn delete_instance(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let mut def = require(&space, &arg::<String>(args, "client")?)?;
    let id: String = arg(args, "instance")?;
    let index = def
        .instances
        .iter()
        .position(|instance| instance.id == id)
        .ok_or_else(|| AppError::new(format!("Le client « {} » n’a pas d’instance « {id} ».", def.label)))?;
    let removed = def.instances.remove(index);
    store(&space, &def)?;
    // Une future instance du même identifiant ne doit pas hériter de cette validation.
    forget_trust(state, &space, &trust_key(&def.id, &id))?;
    git::commit_all(
        &space.root,
        &format!("Suppression de l’instance {} du client {}", removed.display_label(), def.label),
    )?;
    state.emit("clients:changed", json!({ "client": def.id, "instance": id }));
    Ok(describe(state, &def, &[]))
}

/// L’instance par défaut est la première : celle qu’utilise une page qui n’en nomme pas.
fn default_instance(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let mut def = require(&space, &arg::<String>(args, "client")?)?;
    let id: String = arg(args, "instance")?;
    let index = def
        .instances
        .iter()
        .position(|instance| instance.id == id)
        .ok_or_else(|| AppError::new(format!("Le client « {} » n’a pas d’instance « {id} ».", def.label)))?;
    let instance = def.instances.remove(index);
    let label = instance.display_label().to_string();
    def.instances.insert(0, instance);
    store(&space, &def)?;
    git::commit_all(&space.root, &format!("Instance {label} par défaut pour le client {}", def.label))?;
    state.emit("clients:changed", json!({ "client": def.id, "instance": id }));
    Ok(describe(state, &def, &[]))
}

/// Validation depuis les Réglages : l’utilisateur a vu les valeurs (`fingerprints`, une par instance, telles que
/// la liste les lui a montrées ; `fingerprint` pour un client à une seule instance) et les approuve. Si le fichier
/// a encore changé entre-temps, rien n’est validé.
fn validate_client(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let def = require(&space, &arg::<String>(args, "id")?)?;
    def.validate_definition()?;
    let shown: Map<String, Value> = match (args.get("fingerprints"), args.get("fingerprint")) {
        (Some(Value::Object(map)), _) => map.clone(),
        (_, Some(single)) => {
            def.instances.first().map(|instance| (instance.id.clone(), single.clone())).into_iter().collect()
        }
        _ => Map::new(),
    };
    let mut approved = Vec::new();
    for instance in &def.instances {
        let client = def.resolve_instance(instance)?;
        if client.auth.kind == AuthKind::None {
            continue;
        }
        let current = fingerprint(&client);
        if trusted_fingerprint(state, &space, &client.trust_key())?.as_ref() == Some(&current) {
            continue;
        }
        client.validate()?;
        if shown.get(&instance.id) != Some(&current) {
            return Err(AppError::new(format!(
                "Le client « {} » a changé depuis l’affichage de ses valeurs. Les relire avant de le valider.",
                def.label
            )));
        }
        approved.push(client);
    }
    for client in &approved {
        record_trust(state, &space, client)?;
    }
    state.emit("clients:changed", json!({ "client": def.id }));
    Ok(describe(state, &def, &[]))
}

/// Validation par l’agent, à la demande de l’utilisateur qui lui a confié le réglage : le client est approuvé tel que
/// son fichier le décrit aujourd’hui. Toute modification ultérieure le remettra « à valider ».
pub fn validate_by_agent(state: &Arc<AppState>, id: &str) -> AppResult<Value> {
    let space = state.space()?;
    let def = require(&space, id)?;
    def.validate_definition()?;
    // Toutes les instances, telles que le fichier les décrit : une instance invalide empêche la validation.
    let mut approved = Vec::new();
    for instance in &def.instances {
        let client = def.resolve_instance(instance)?;
        client.validate()?;
        approved.push(client);
    }
    for client in &approved {
        record_trust(state, &space, client)?;
    }
    state.emit("clients:changed", json!({ "client": def.id }));
    Ok(describe(state, &def, &[]))
}

/// Retire un client de l’espace, avec tout ce qui s’y rattache (comptes, validation, accords, tests), sans
/// commit ; rend son nom. Les entrées du coffre restent : le coffre est commun à tous les espaces de travail.
fn forget(state: &AppState, space: &Space, id: &str) -> AppResult<String> {
    let label = load(space, id).ok().flatten().map(|client| client.label).unwrap_or_else(|| id.to_string());
    std::fs::remove_file(client_path(space, id))?;
    // Les demandes reliées à ce client redeviennent « à relier » plutôt que de pointer dans le vide.
    let mut manifest = space.manifest()?;
    let before = manifest.bindings.len();
    manifest.bindings.retain(|_, bound| bound != id);
    if manifest.bindings.len() != before {
        space.write_manifest(&manifest)?;
    }
    {
        // Un futur client du même identifiant ne doit hériter ni de la validation ni des accords de celui-ci.
        let db = trust_db(state)?;
        db.execute(
            "DELETE FROM client_trust WHERE space = ?1 AND (client = ?2 OR client LIKE ?3)",
            params![space_key(space), id, format!("{id}#%")],
        )?;
        db.execute(
            "DELETE FROM grants WHERE space = ?1 AND resource = ?2",
            params![space_key(space), format!("client:{id}")],
        )?;
    }
    forget_tests(state, space, id)?;
    Ok(label)
}

/// Clients qui répondent aujourd’hui à un besoin d’un module de l’espace (liaison, sinon même identifiant).
fn used_clients(space: &Space) -> AppResult<std::collections::BTreeSet<String>> {
    let bindings = space.manifest()?.bindings;
    let mut used = std::collections::BTreeSet::new();
    for module_id in space.module_ids() {
        let Ok(module) = space.module(&module_id) else { continue };
        for need in &module.clients {
            let key = format!("{module_id}/{}", need.id);
            used.insert(bindings.get(&key).cloned().unwrap_or_else(|| need.id.clone()));
        }
    }
    Ok(used)
}

/// Un service appartient aux modules qui s’en servent : celui qu’aucun module n’utilise plus (son module a été
/// supprimé) quitte l’espace avec ses comptes. Sans commit ; rend les noms des services retirés.
pub fn forget_unused(state: &AppState, space: &Space) -> AppResult<Vec<String>> {
    // Un module illisible garde ses services : on ne sait pas ce qu’il utilise.
    if space.module_ids().iter().any(|id| space.module(id).is_err()) {
        return Ok(Vec::new());
    }
    let used = used_clients(space)?;
    let mut labels = Vec::new();
    for (id, _) in load_all(space) {
        if !used.contains(&id) {
            labels.push(forget(state, space, &id)?);
        }
    }
    if !labels.is_empty() {
        state.emit("clients:changed", Value::Null);
    }
    Ok(labels)
}

fn delete(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let id: String = arg(args, "id")?;
    if !valid_id(&id) || !client_path(&space, &id).is_file() {
        return Err(AppError::new(format!("Le client « {id} » n’existe pas dans cet espace de travail.")));
    }
    let label = forget(state, &space, &id)?;
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
    let client = require_instance(&space, args)?;
    let path = opt_arg::<String>(args, "path")?.or_else(|| client.test_path.clone()).unwrap_or_default();
    let call = Call {
        method: Method::GET,
        path: path.clone(),
        query: None,
        headers: None,
        payload: Payload::None,
        response_type: ResponseType::Auto,
        handshake: None,
        sealed: Default::default(),
    };
    let started = Instant::now();
    let result = perform(state, &client, &call).await;
    journal(state, &space, &client, &call, ("settings", "Réglages"), started, outcome_of(&result));
    let duration = started.elapsed().as_millis() as u64;
    let outcome = test_outcome(result, &path, duration);
    // Le parcours de configuration d’un module ne le dit prêt qu’après un test réussi de l’instance.
    record_test(state, &space, &client, outcome["ok"] == json!(true), outcome["message"].as_str().unwrap_or_default())?;
    state.emit("clients:changed", json!({ "client": client.id }));
    Ok(outcome)
}

/// Teste une instance et garde le résultat (voir `test_client`).
pub async fn test_instance(state: &Arc<AppState>, id: &str, instance: &str) -> AppResult<Value> {
    test_client(state, &json!({ "id": id, "instance": instance })).await
}

/// Teste chaque instance du client `id` telle que son fichier la décrit, et garde le résultat (voir `test_client`).
pub async fn test_instances(state: &Arc<AppState>, id: &str) -> AppResult<Vec<Value>> {
    let space = state.space()?;
    let def = require(&space, id)?;
    let mut results = Vec::new();
    for instance in &def.instances {
        let args = json!({ "id": id, "instance": instance.id });
        let mut outcome = test_client(state, &args).await?;
        outcome["instance"] = json!(instance.id);
        results.push(outcome);
    }
    Ok(results)
}

/// Résultat d’un test en mots simples. Un test raté est un résultat, pas une erreur de commande : l’écran
/// l’affiche à côté du client.
fn test_outcome(result: AppResult<Value>, path: &str, duration: u64) -> Value {
    match result {
        Ok(response) => {
            let status = response["status"].as_u64().unwrap_or_default();
            let reason = match status {
                200..=399 => Value::Null,
                401 => json!("refused"),
                403 => json!("forbidden"),
                404 | 405 => json!("notFound"),
                _ => json!("error"),
            };
            let message = match status {
                200..=399 => format!("Le service répond ({status})."),
                401 | 403 => format!("Le service refuse l’authentification ({status})."),
                // La racine d’une API est souvent vide : le service est joignable, mais rien n’a été vérifié.
                404 | 405 if path.is_empty() => format!(
                    "Le service est joignable mais n’a rien à la racine ({status}). Indiquer un chemin de test, \
                     par exemple /me, pour vérifier aussi l’authentification."
                ),
                _ => format!("Le service répond par une erreur ({status})."),
            };
            json!({ "ok": status < 400, "status": status, "durationMs": duration, "message": message, "reason": reason })
        }
        Err(error) => {
            let reason = error.detail.as_ref().and_then(|detail| detail["reason"].as_str()).unwrap_or("error");
            json!({ "ok": false, "status": null, "durationMs": duration, "message": error.message, "reason": reason })
        }
    }
}

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    // Canaux ouverts par `client(id).stream` ou `client(id).socket` (`channels.rs`).
    if command.starts_with("frame.channels.") {
        return crate::channels::handle(state, command, args).await;
    }
    let result = match command {
        "frame.clients.request" => frame_request(state, args).await,
        "frame.clients.download" => crate::transport::download(state, args).await,
        "frame.clients.stream" => crate::transport::stream(state, args).await,
        "frame.clients.socket" => crate::transport::socket(state, args).await,
        "frame.clients.clearCache" => frame_clear_cache(state, args),
        "frame.clients.instances" => frame_instances(state, args),
        "frame.clients.params" => frame_params(state, args),
        "clients.test" => test_client(state, args).await,
        "clients.probe" => probe(args).await,
        "clients.connect" => match state.space().and_then(|space| require_instance(&space, args)) {
            Ok(client) => oauth::begin(state, &client).await.map(|url| json!({ "authorizationUrl": url })),
            Err(error) => Err(error),
        },
        "clients.disconnect" => match state.space().and_then(|space| require_instance(&space, args)) {
            Ok(client) => oauth::disconnect(state, &client).await,
            Err(error) => Err(error),
        },
        "clients.list" | "clients.save" | "clients.declare" | "clients.validate" | "clients.delete"
        | "clients.bind" | "clients.saveInstance" | "clients.deleteInstance" | "clients.defaultInstance" => {
            // Lecture du trousseau et git : hors des fils asynchrones.
            let (state, command, args) = (state.clone(), command.to_string(), args.clone());
            vault::blocking(move || match command.as_str() {
                "clients.list" => list(&state),
                "clients.save" => write_client(&state, &args, true),
                "clients.declare" => write_client(&state, &args, false),
                "clients.validate" => validate_client(&state, &args),
                "clients.delete" => delete(&state, &args),
                "clients.saveInstance" => save_instance(&state, &args),
                "clients.deleteInstance" => delete_instance(&state, &args),
                "clients.defaultInstance" => default_instance(&state, &args),
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
        Subject { kind: "page".to_string(), module: module.to_string(), reference: format!("{module}/accueil"), instance: None, ..Default::default() }
    }

    /// Les fonctions du module : seules à joindre ses clients.
    pub fn function_subject(module: &str) -> Subject {
        Subject { kind: "function".to_string(), module: module.to_string(), reference: format!("{module}/*"), instance: None, ..Default::default() }
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
    async fn the_test_button_reads_the_client_test_path_and_explains_an_empty_root() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let base = format!("{}/api", remote.origin);
        let client = json!({ "id": "relais", "label": "Relais", "baseUrl": base, "auth": { "type": "none" } });
        save_client(&state, client.clone()).await;

        // Sans chemin de test, la racine : le service est joignable mais n’y a rien.
        let tested = invoke(&state, "clients.test", json!({ "id": "relais" })).await.unwrap();
        assert_eq!((tested["ok"].clone(), tested["status"].clone()), (json!(false), json!(404)));
        assert!(tested["message"].as_str().unwrap().contains("chemin de test"), "{tested}");
        assert_eq!(tested["reason"], json!("notFound"));

        // Avec un chemin de test, le bouton lit ce chemin.
        let mut with_path = client.clone();
        with_path["testPath"] = json!(" /texte ");
        let saved = save_client(&state, with_path).await;
        assert_eq!(saved["testPath"], json!("/texte"));
        let tested = invoke(&state, "clients.test", json!({ "id": "relais" })).await.unwrap();
        assert_eq!((tested["ok"].clone(), tested["status"].clone()), (json!(true), json!(200)));

        // Un chemin de test ne sort pas de l’adresse de base.
        for path in ["texte", "/../prive", "//ailleurs.example/x"] {
            let mut wrong = client.clone();
            wrong["testPath"] = json!(path);
            let error = invoke(&state, "clients.save", json!({ "client": wrong })).await.unwrap_err();
            assert!(error.message.contains("Chemin de test invalide"), "{path} : {}", error.message);
        }
    }

    /// Le parcours de configuration dit pourquoi un test échoue, vérifie une adresse avant tout compte, et garde
    /// l’aide de chaque méthode (consigne, page du jeton, adresse d’exemple, application OAuth).
    #[tokio::test]
    async fn the_setup_flow_learns_why_a_test_failed_and_whether_an_address_answers() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let base = format!("{}/api", remote.origin);
        save_client(&state, json!({ "id": "garde", "label": "Garde", "baseUrl": base, "testPath": "/protected", "auth": { "type": "none" } }))
            .await;
        let tested = invoke(&state, "clients.test", json!({ "id": "garde" })).await.unwrap();
        assert_eq!((tested["ok"].clone(), tested["reason"].clone()), (json!(false), json!("refused")), "{tested}");

        // Une adresse qui répond, même par une erreur, est joignable ; une adresse fermée ne l’est pas.
        let answered = invoke(&state, "clients.probe", json!({ "url": format!("{base}/rien") })).await.unwrap();
        assert_eq!(answered["ok"], json!(true), "{answered}");
        let closed = {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let silent =
            invoke(&state, "clients.probe", json!({ "url": format!("http://127.0.0.1:{closed}/api") })).await.unwrap();
        assert_eq!((silent["ok"].clone(), silent["reason"].clone()), (json!(false), json!("unreachable")), "{silent}");
        assert!(invoke(&state, "clients.probe", json!({ "url": "http://exemple.com" })).await.is_err());

        let saved = save_client(
            &state,
            json!({ "id": "suivi", "label": "Suivi", "methods": [
                { "id": "jeton", "label": "Jeton", "type": "bearer", "help": " Profil → Jetons. ", "tokenPage": "{url}/profil/jetons", "urlExample": "https://suivi.acme.fr", "clientId": "ignoré" },
                { "id": "sso", "label": "SSO", "type": "oauth2", "authorizationUrl": "{url}/authorize", "tokenUrl": "{url}/token", "clientId": "app-publique" }
            ] }),
        )
        .await;
        let methods = &saved["methods"];
        assert_eq!(methods[0]["help"], json!("Profil → Jetons."));
        assert_eq!(methods[0]["tokenPage"], json!("{url}/profil/jetons"));
        assert_eq!(methods[0]["urlExample"], json!("https://suivi.acme.fr"));
        assert_eq!(methods[0].get("clientId"), None, "un identifiant d’application n’a de sens que pour OAuth");
        assert_eq!(methods[1]["clientId"], json!("app-publique"));
        let error = invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "suivi", "label": "Suivi", "methods": [{ "id": "jeton", "type": "bearer", "tokenPage": "javascript:alert(1)" }] } }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("page du jeton"), "{}", error.message);
    }

    /// Cloisonnement : une page ou un panneau ne joint jamais un service par son client, même accordé ; seules les
    /// fonctions du module le font, et la page reçoit la consigne de passer par elles.
    #[tokio::test]
    async fn a_page_reaches_a_service_only_through_a_function() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let client = json!({ "id": "public", "label": "Public", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "none" } });
        assert_eq!(save_client(&state, client).await["status"], json!("ready"));
        let page = page_subject("crm");
        let mut panel = page_subject("crm");
        panel.kind = "panel".to_string();
        grant(&state, &page, "public");
        for subject in [&page, &panel] {
            let error = request(&state, subject, "public", json!({ "path": "/echo" })).await.unwrap_err();
            assert!(error.message.contains("functions.call(\"crm/<fonction>\""), "{}", error.message);
        }
        assert!(remote.state.seen.lock().unwrap().is_empty(), "le service n’a pas été appelé");
        let function = function_subject("crm");
        grant(&state, &function, "public");
        assert!(request(&state, &function, "public", json!({ "path": "/echo" })).await.is_ok());
    }

    /// Une lecture demandée avec `cache` est servie par Alfred pendant sa durée, sans rappeler le service ; une
    /// écriture, une autre page de requête ou un autre module passent toujours par le service.
    #[tokio::test]
    async fn a_cached_read_spares_the_service() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let base = format!("{}/api", remote.origin);
        let subject = function_subject("crm");
        let other = function_subject("suivi");
        let client = json!({ "id": "public", "label": "Public", "baseUrl": base, "auth": { "type": "none" } });
        assert_eq!(save_client(&state, client).await["status"], json!("ready"));
        grant(&state, &subject, "public");
        grant(&state, &other, "public");
        let calls = || remote.state.seen.lock().unwrap().len();

        let first = request(&state, &subject, "public", json!({ "path": "/echo", "query": { "q": 1 }, "cache": 60 })).await.unwrap();
        assert!(first.get("cached").is_none());
        let again = request(&state, &subject, "public", json!({ "path": "/echo", "query": { "q": 1 }, "cache": 60 })).await.unwrap();
        assert_eq!(again["cached"], json!(true));
        assert_eq!(again["body"], first["body"]);
        assert_eq!(calls(), 1);

        request(&state, &subject, "public", json!({ "path": "/echo", "query": { "q": 2 }, "cache": 60 })).await.unwrap();
        request(&state, &other, "public", json!({ "path": "/echo", "query": { "q": 1 }, "cache": 60 })).await.unwrap();
        request(&state, &subject, "public", json!({ "method": "POST", "path": "/echo", "query": { "q": 1 }, "cache": 60 })).await.unwrap();
        request(&state, &subject, "public", json!({ "path": "/echo", "query": { "q": 1 } })).await.unwrap();
        assert_eq!(calls(), 5, "autre requête, autre module, écriture, sans cache : le service est appelé");

        let cleared = invoke(&state, "frame.clients.clearCache", json!({ "subject": subject, "client": "public" })).await.unwrap();
        assert_eq!(cleared["cleared"], json!(2));
        request(&state, &subject, "public", json!({ "path": "/echo", "query": { "q": 1 }, "cache": 60 })).await.unwrap();
        assert_eq!(calls(), 6);
    }

    #[tokio::test]
    async fn every_auth_type_reaches_the_service_without_leaking_its_secret() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let base = format!("{}/api", remote.origin);
        let subject = function_subject("crm");
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
        assert_eq!(line["detail"]["requester"], json!("crm/*"));
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
        let subject = function_subject("crm");
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
        let subject = function_subject("crm");
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
        assert_eq!(tested["reason"], json!("unreachable"), "{tested}");
        assert_no_leak("test", &tested.to_string(), &[TOKEN, "cle="]);
    }

    #[tokio::test]
    async fn a_rejected_application_token_is_renewed_once() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let subject = function_subject("crm");
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
        let subject = function_subject("crm");

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
        assert!(error.message.contains("Mots de passe et clés"), "{}", error.message);

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
            error.message.contains("Mots de passe et clés"),
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

    #[tokio::test(flavor = "multi_thread")]
    async fn a_module_uses_the_client_of_a_module_it_requires_without_asking() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let space = state.space().unwrap();
        let base = format!("{}/api", remote.origin);
        let saved = save_client(&state, json!({ "id": "hubspot-equipe", "label": "HubSpot", "baseUrl": base, "auth": { "type": "none" } })).await;
        assert_eq!(saved["status"], json!("ready"));
        let write = |id: &str, manifest: Value| {
            std::fs::create_dir_all(space.root.join(format!("modules/{id}"))).unwrap();
            std::fs::write(space.root.join(format!("modules/{id}/module.json")), manifest.to_string()).unwrap();
        };
        write("crm", json!({ "id": "crm", "name": "CRM", "version": "1.0.0", "clients": [{ "id": "hubspot", "label": "HubSpot" }] }));
        write("devis", json!({ "id": "devis", "name": "Devis", "version": "0.1.0", "requires": [{ "module": "crm" }] }));
        write("autre", json!({ "id": "autre", "name": "Autre", "version": "0.1.0" }));
        invoke(&state, "clients.bind", json!({ "need": "crm/hubspot", "client": "hubspot-equipe" })).await.unwrap();

        // Aucun accord n’est enregistré pour « devis » : la requête passe quand même, par la liaison de « crm ».
        let devis = function_subject("devis");
        let response = request(&state, &devis, "crm/hubspot", json!({ "path": "/echo" })).await.unwrap();
        assert_eq!(response["status"], json!(200));
        assert_eq!(remote.last().path, "/api/echo");

        // Sans dépendance déclarée, ou vers un besoin que « crm » ne déclare pas : refus qui dit quoi faire.
        let error = request(&state, &function_subject("autre"), "crm/hubspot", json!({ "path": "/echo" })).await.unwrap_err();
        assert!(error.message.contains("requires"), "{}", error.message);
        let error = request(&state, &devis, "crm/jira", json!({ "path": "/echo" })).await.unwrap_err();
        assert!(error.message.contains("ne déclare pas"), "{}", error.message);

        // Les fonctions de la dépendance sont accordées d’office, pas celles d’un autre module.
        let authorize = |subject: &Subject, function: &str| {
            let args = json!({ "subject": subject, "function": function });
            let state = state.clone();
            async move { crate::functions::handle(&state, "frame.functions.authorize", &args).await.unwrap() }
        };
        assert!(authorize(&devis, "crm/synchroniser").await.is_ok());
        let pending = tokio::time::timeout(std::time::Duration::from_millis(300), authorize(&devis, "autre/exporter")).await;
        assert!(pending.is_err(), "une fonction d’un module non requis attend l’accord de l’utilisateur");
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
        let subject = function_subject("crm");
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
        let subject = function_subject("crm");
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
        assert_eq!(line["detail"]["requester"], json!("crm/*"));
    }

    /// Un client à plusieurs instances : chaque instance a son adresse, sa méthode et son secret ; l’agent ne peut en
    /// détourner aucune, et une page choisit celle qu’elle appelle.
    #[tokio::test]
    async fn a_client_with_several_instances_sends_each_secret_to_its_own_address() {
        let (state, _dir) = test_state();
        let (acme, autre) = (remote().await, remote().await);
        let subject = function_subject("crm");
        let (token_id, key_id, machine_id) = (unique("pat"), unique("cle"), unique("machine"));
        for (id, kind, extra) in [
            (&token_id, "token", json!({ "secrets": { "value": TOKEN } })),
            (&key_id, "token", json!({ "secrets": { "value": "c13-AUTRE-instance" } })),
            (
                &machine_id,
                "clientCredentials",
                json!({ "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": REMOTE_CLIENT_SECRET } }),
            ),
        ] {
            let mut args = json!({ "id": id, "label": id, "kind": kind });
            for (key, value) in extra.as_object().unwrap() {
                args[key] = value.clone();
            }
            invoke(&state, "vault.save", args).await.unwrap();
        }

        // Le client décrit l’API et ses méthodes, sans adresse ni secret : il attend ses instances.
        let saved = save_client(
            &state,
            json!({ "id": "jira", "label": "Jira", "methods": [
                { "id": "pat", "label": "Data Center (PAT)", "type": "bearer" },
                { "id": "cle", "label": "Clé d’API", "type": "apiKey", "header": "X-Api-Key" },
                { "id": "app", "label": "Application", "type": "clientCredentials", "tokenUrl": "{url}/token" },
            ] }),
        )
        .await;
        assert_eq!((saved["status"].clone(), saved["instances"].clone()), (json!("noInstance"), json!([])));
        grant(&state, &subject, "jira");
        let error = request(&state, &subject, "jira", json!({ "path": "/api/echo" })).await.unwrap_err();
        assert!(error.message.contains("aucun compte"), "{}", error.message);

        let add = |id: &str, label: &str, url: &str, method: &str, secret: &str| {
            json!({ "client": "jira", "create": true, "instance": { "id": id, "label": label, "url": url, "method": method, "secret": secret } })
        };
        invoke(&state, "clients.saveInstance", add("acme", "Acme", &acme.origin, "pat", &token_id)).await.unwrap();
        invoke(&state, "clients.saveInstance", add("autre", "Autre", &autre.origin, "cle", &key_id)).await.unwrap();
        let listed_jira = listed(&invoke(&state, "clients.list", json!({})).await.unwrap(), "jira");
        assert_eq!(listed_jira["status"], json!("ready"));
        assert_eq!(listed_jira["instances"][1]["effectiveUrl"], json!(autre.origin));
        // Le fichier garde la forme à plusieurs instances, sans aucun secret.
        let file = std::fs::read_to_string(state.space().unwrap().root.join("clients/jira.json")).unwrap();
        let file: Value = serde_json::from_str(&file).unwrap();
        assert!(file.get("auth").is_none() && file["instances"][1]["secret"] == json!(key_id));
        assert!(!file.to_string().contains(TOKEN));

        // Sans instance nommée, la page appelle la première ; sinon celle qu’elle nomme, avec son secret à elle.
        let instances = invoke(
            &state,
            "frame.clients.instances",
            json!({ "subject": serde_json::to_value(&subject).unwrap(), "client": "jira" }),
        )
        .await
        .unwrap();
        assert_eq!(
            instances,
            json!([{ "id": "acme", "label": "Acme", "default": true }, { "id": "autre", "label": "Autre", "default": false }])
        );
        request(&state, &subject, "jira", json!({ "path": "/api/echo" })).await.unwrap();
        assert_eq!(acme.last().headers["authorization"], format!("Bearer {TOKEN}"));
        request(&state, &subject, "jira", json!({ "path": "/api/echo", "instance": "autre" })).await.unwrap();
        let seen = autre.last();
        assert_eq!(seen.headers["x-api-key"], "c13-AUTRE-instance");
        assert!(!seen.headers.contains_key("authorization"));
        let error =
            request(&state, &subject, "jira", json!({ "path": "/api/echo", "instance": "inconnue" })).await.unwrap_err();
        assert!(error.message.contains("pas d’instance « inconnue »"), "{}", error.message);

        // `{url}` suit l’adresse de l’instance : le serveur de jetons de l’instance reçoit les identifiants.
        invoke(&state, "clients.saveInstance", add("robot", "Robot", &acme.origin, "app", &machine_id)).await.unwrap();
        request(&state, &subject, "jira", json!({ "path": "/api/protected", "instance": "robot" })).await.unwrap();
        assert_eq!(acme.state.token_requests.lock().unwrap().len(), 1);

        // L’agent détourne l’adresse d’une instance dans le fichier : elle seule est bloquée, les autres répondent.
        let sent = autre.seen_paths().len();
        agent_edits(&state, "jira", |file| file["instances"][1]["url"] = json!(format!("{}/ailleurs", acme.origin)));
        let error =
            request(&state, &subject, "jira", json!({ "path": "/api/echo", "instance": "autre" })).await.unwrap_err();
        assert!(error.message.contains("n’est pas validé"), "{}", error.message);
        request(&state, &subject, "jira", json!({ "path": "/api/echo" })).await.unwrap();
        assert_eq!(autre.seen_paths().len(), sent);
        let client = listed(&invoke(&state, "clients.list", json!({})).await.unwrap(), "jira");
        assert_eq!(client["status"], json!("toValidate"));
        let change = &client["validation"]["changes"][0];
        assert_eq!((change["instance"].clone(), change["field"].clone()), (json!("autre"), json!("baseUrl")));
        // Enregistrer la définition depuis les Réglages ne valide pas en passant une instance détournée.
        save_client(&state, json!({ "id": "jira", "label": "Jira", "methods": file["methods"] })).await;
        assert_eq!(listed(&invoke(&state, "clients.list", json!({})).await.unwrap(), "jira")["status"], json!("toValidate"));
        let validated = invoke(
            &state,
            "clients.validate",
            json!({ "id": "jira", "fingerprints": client["validation"]["fingerprints"] }),
        )
        .await
        .unwrap();
        assert_eq!(validated["status"], json!("ready"));

        // L’agent redéclare le client en changeant une méthode : les instances restent celles de l’utilisateur, et
        // seules celles qui utilisent la méthode modifiée redeviennent « à valider ».
        let declared = invoke(
            &state,
            "clients.declare",
            json!({ "client": { "id": "jira", "label": "Jira", "methods": [
                { "id": "pat", "label": "Data Center (PAT)", "type": "bearer" },
                { "id": "cle", "label": "Clé d’API", "type": "apiKey", "header": "X-Autre-Cle" },
                { "id": "app", "label": "Application", "type": "clientCredentials", "tokenUrl": "{url}/token" },
            ], "instances": [] } }),
        )
        .await
        .unwrap();
        let statuses: Vec<Value> =
            declared["instances"].as_array().unwrap().iter().map(|instance| instance["status"].clone()).collect();
        assert_eq!(statuses, [json!("ready"), json!("toValidate"), json!("ready")]);

        // L’instance par défaut change, puis une instance supprimée n’est plus joignable.
        invoke(&state, "clients.defaultInstance", json!({ "client": "jira", "instance": "robot" })).await.unwrap();
        request(&state, &subject, "jira", json!({ "path": "/api/protected" })).await.unwrap();
        invoke(&state, "clients.deleteInstance", json!({ "client": "jira", "instance": "acme" })).await.unwrap();
        let error =
            request(&state, &subject, "jira", json!({ "path": "/api/echo", "instance": "acme" })).await.unwrap_err();
        assert!(error.message.contains("pas d’instance « acme »"), "{}", error.message);
        // Une instance recréée sous le même identifiant n’hérite pas de l’ancienne validation.
        agent_edits(&state, "jira", |file| {
            file["instances"].as_array_mut().unwrap().push(
                json!({ "id": "acme", "label": "Acme", "url": acme.origin, "method": "pat", "secret": token_id }),
            )
        });
        let error =
            request(&state, &subject, "jira", json!({ "path": "/api/echo", "instance": "acme" })).await.unwrap_err();
        assert!(error.message.contains("n’est pas validé"), "{}", error.message);
    }

    /// L’agent autonome déclare lui-même les instances et leur entrée du coffre, puis les valide ; une redéclaration
    /// sans secret garde celui qui était relié, et ne touche pas aux instances qu’elle ne nomme pas.
    #[tokio::test]
    async fn an_agent_declares_and_validates_the_instances_of_a_client() {
        let (state, _dir) = test_state();
        let (acme, autre) = (remote().await, remote().await);
        let subject = function_subject("crm");
        let (acme_id, autre_id) = (unique("acme"), unique("autre"));
        for (id, value) in [(&acme_id, TOKEN), (&autre_id, "j3ton-AUTRE")] {
            invoke(&state, "vault.save", json!({ "id": id, "label": id, "kind": "token", "secrets": { "value": value } }))
                .await
                .unwrap();
        }
        let declare = |instances: Value| {
            json!({ "client": { "id": "jira", "label": "Jira",
                "methods": [{ "id": "pat", "label": "PAT", "type": "bearer" }], "instances": instances } })
        };
        let declared = invoke(
            &state,
            "clients.declare",
            declare(json!([
                { "id": "acme", "label": "Acme", "url": acme.origin, "method": "pat", "secret": acme_id },
                { "id": "autre", "label": "Autre", "url": autre.origin, "method": "pat", "secret": autre_id },
            ])),
        )
        .await
        .unwrap();
        assert_eq!(declared["status"], json!("toValidate"));
        let validated = validate_by_agent(&state, "jira").unwrap();
        assert_eq!(validated["status"], json!("ready"));
        grant(&state, &subject, "jira");
        request(&state, &subject, "jira", json!({ "path": "/api/echo", "instance": "autre" })).await.unwrap();
        assert_eq!(autre.last().headers["authorization"], "Bearer j3ton-AUTRE");

        // Redéclarer une seule instance, sans secret : l’entrée reliée reste, l’autre instance aussi.
        invoke(&state, "clients.declare", declare(json!([{ "id": "acme", "label": "Acme SA", "url": acme.origin, "method": "pat" }])))
            .await
            .unwrap();
        let def = load(&state.space().unwrap(), "jira").unwrap().unwrap();
        let kept: Vec<(&str, &str, Option<&str>)> = def
            .instances
            .iter()
            .map(|instance| (instance.id.as_str(), instance.label.as_str(), instance.secret.as_deref()))
            .collect();
        assert_eq!(kept, [("acme", "Acme SA", Some(acme_id.as_str())), ("autre", "Autre", Some(autre_id.as_str()))]);
        request(&state, &subject, "jira", json!({ "path": "/api/echo" })).await.unwrap();
        assert_eq!(acme.last().headers["authorization"], format!("Bearer {TOKEN}"));
    }
}
