//! Jetons émis par un service contre un identifiant et un mot de passe (méthode `session`) : Portainer
//! (`POST /api/auth` → `jwt`), OpenBao userpass ou LDAP (`auth.client_token`), tout service à connexion par
//! formulaire. Alfred fait lui-même la requête de connexion, range le jeton dans l’entrée du coffre du compte (donc
//! au trousseau du système), le pose sur chaque requête et le redemande à l’échéance ou sur un refus (401). Aucune
//! fonction ne voit ni le mot de passe, ni la réponse de connexion, ni le jeton.
//!
//! Et l’adresse secrète (`secretUrl`) : l’adresse complète du compte, jeton compris (agenda publié), vit au trousseau.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::clients::{self, Auth, Client, SessionApply, SessionLogin};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::vault;

/// Un jeton est redemandé un peu avant son échéance, pour ne pas expirer pendant la requête.
const EXPIRY_MARGIN: u64 = 30;
/// Champs du coffre que la session y range, à côté de l’identifiant et du mot de passe.
pub const SESSION_FIELDS: [&str; 3] = ["accessToken", "expiresAt", "sessionKey"];

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_secs()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------------------------
// Déclaration
// ---------------------------------------------------------------------------------------------------------------

pub fn normalize(auth: &mut Auth) {
    if let Some(login) = &mut auth.login {
        login.method = login.method.trim().to_ascii_uppercase();
        if login.method.is_empty() {
            login.method = "POST".to_string();
        }
        login.path = login.path.trim().to_string();
        login.token = login.token.trim().to_string();
        login.expires_in = login.expires_in.take().map(|path| path.trim().to_string()).filter(|path| !path.is_empty());
        if login.body.as_ref().is_some_and(Value::is_null) {
            login.body = None;
        }
    }
    if let Some(apply) = &mut auth.apply {
        apply.header = apply.header.trim().to_string();
        apply.prefix = apply.prefix.take().filter(|prefix| !prefix.is_empty());
    }
}

/// En-tête et préfixe du jeton : `Authorization: Bearer` à défaut.
fn applied(auth: &Auth) -> (String, String) {
    match &auth.apply {
        Some(SessionApply { header, prefix }) if !header.is_empty() => {
            (header.clone(), prefix.clone().unwrap_or_default())
        }
        _ => ("Authorization".to_string(), "Bearer ".to_string()),
    }
}

pub fn validate(auth: &Auth) -> AppResult<()> {
    let login = auth.login.as_ref().ok_or_else(|| {
        AppError::new("Une méthode `session` décrit sa connexion dans `login` (`path`, `body`, `token`).")
    })?;
    if !login.path.starts_with('/') {
        return Err(AppError::new(format!(
            "Chemin de connexion invalide : « {} ». Il commence par « / », sous l’adresse du compte.",
            login.path
        )));
    }
    if !matches!(login.method.as_str(), "POST" | "PUT" | "GET") {
        return Err(AppError::new(format!("Méthode de connexion non prise en charge : {}.", login.method)));
    }
    let token_header = login.token.strip_prefix("header:").map(str::trim);
    if login.token.is_empty() || token_header.is_some_and(|name| HeaderName::from_bytes(name.as_bytes()).is_err()) {
        return Err(AppError::new(
            "Indiquer où lire le jeton dans `login.token` : un chemin pointé de la réponse (`jwt`, `auth.client_token`) ou `header:<nom>`.",
        ));
    }
    let (header, _) = applied(auth);
    let lower = header.to_ascii_lowercase();
    if HeaderName::from_bytes(header.as_bytes()).is_err()
        || (lower != "authorization" && matches!(lower.as_str(), "cookie" | "host" | "content-length" | "transfer-encoding"))
    {
        return Err(AppError::new(format!("En-tête du jeton invalide : « {header} ».")));
    }
    Ok(())
}

/// Résumé pour l’empreinte validée : où part le mot de passe, où va le jeton.
pub fn describe(auth: &Auth) -> String {
    let Some(login) = &auth.login else { return String::new() };
    let (header, prefix) = applied(auth);
    let body = login.body.as_ref().map(Value::to_string).unwrap_or_default();
    format!(
        "{} {}{} {body} → {} ; {header}: {}",
        login.method,
        login.path,
        if login.form { " (formulaire)" } else { "" },
        login.token,
        prefix.trim()
    )
}

// ---------------------------------------------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------------------------------------------

/// Jeton à poser sur une requête, et les valeurs à masquer dans tout ce qui en revient.
pub struct SessionToken {
    pub header: HeaderName,
    pub value: String,
    pub token: String,
    pub secrets: Vec<String>,
}

/// Valeurs substituées dans la requête de connexion, et seulement là.
struct Variables<'a> {
    username: &'a str,
    password: &'a str,
    params: &'a BTreeMap<String, String>,
}

impl Variables<'_> {
    fn fill(&self, text: &str) -> String {
        let mut text = text.replace("{username}", self.username).replace("{password}", self.password);
        for (name, value) in self.params {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        text
    }

    fn fill_value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.fill(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.fill_value(item)).collect()),
            Value::Object(fields) => {
                Value::Object(fields.iter().map(|(name, value)| (name.clone(), self.fill_value(value))).collect())
            }
            other => other.clone(),
        }
    }
}

fn pointed<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(value, |value, name| match value {
        Value::Array(items) => items.get(name.parse::<usize>().ok()?),
        _ => value.get(name),
    })
}

/// Empreinte de ce pour quoi le jeton a été obtenu : un jeton ne sert qu’à l’adresse, au chemin et à l’identifiant
/// de sa connexion. Changer l’un d’eux le fait redemander.
fn session_key(client: &Client, username: &str) -> String {
    let login = client.auth.login.as_ref().map(|login| login.path.as_str()).unwrap_or_default();
    let digest = Sha256::digest(format!("{}\n{login}\n{username}\n{:?}", client.base_url, client.params));
    digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

fn missing(client: &Client) -> AppError {
    AppError::new(format!(
        "L’identifiant ou le mot de passe du service « {} » n’est pas renseigné. Le saisir dans Réglages → Modules, dans la fiche du module.",
        client.label
    ))
}

fn refused(client: &Client, status: u16) -> AppError {
    let reason = if status == 403 { "forbidden" } else { "refused" };
    AppError::with_detail(
        format!("Le service « {} » a refusé l’identifiant ou le mot de passe ({status}).", client.label),
        json!({ "reason": reason, "status": status }),
    )
}

async fn login(client: &Client, login: &SessionLogin, variables: &Variables<'_>, secrets: &[String]) -> AppResult<(String, Option<u64>)> {
    // `{username}` et les paramètres dans le chemin sont encodés comme un segment : ils ne peuvent pas en ajouter.
    let mut path_params = variables.params.clone();
    path_params.insert("username".to_string(), variables.username.to_string());
    let path = clients::fill_params(&login.path, &path_params);
    if path.contains("{password}") {
        return Err(AppError::new("Le mot de passe ne se place jamais dans le chemin de connexion."));
    }
    let url = clients::build_url(&client.base()?, &path, None, None)?;
    let method = Method::from_bytes(login.method.as_bytes()).unwrap_or(Method::POST);
    let mut request = clients::http_for(client)?.request(method, url).header(ACCEPT, "application/json");
    for (name, value) in &client.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) {
            request = request.header(name, value);
        }
    }
    if let Some(body) = &login.body {
        let filled = variables.fill_value(body);
        request = if login.form {
            let pairs: Vec<(String, String)> = filled
                .as_object()
                .into_iter()
                .flatten()
                .map(|(name, value)| (name.clone(), value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())))
                .collect();
            let encoded = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(&pairs).finish();
            request.header(CONTENT_TYPE, "application/x-www-form-urlencoded").body(encoded)
        } else {
            request.header(CONTENT_TYPE, "application/json").body(serde_json::to_vec(&filled)?)
        };
    }
    let response = request.send().await.map_err(|error| clients::network_error(error, secrets))?;
    let status = response.status();
    // Portainer refuse un mauvais mot de passe par 422, OpenBao par 400 : tous disent « identifiant refusé ».
    if matches!(status.as_u16(), 400 | 401 | 403 | 422) {
        return Err(refused(client, status.as_u16()));
    }
    if !status.is_success() {
        return Err(AppError::with_detail(
            format!("La connexion au service « {} » a échoué ({}).", client.label, status.as_u16()),
            json!({ "reason": if status.as_u16() == 404 { "notFound" } else { "error" }, "status": status.as_u16() }),
        ));
    }
    let from_header = login.token.strip_prefix("header:").map(str::trim).and_then(|name| {
        response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string)
    });
    let text = response.text().await.map_err(|error| clients::network_error(error, secrets))?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let token = match from_header {
        Some(token) => Some(token),
        None if !login.token.starts_with("header:") => {
            pointed(&body, &login.token).and_then(Value::as_str).map(str::to_string)
        }
        None => None,
    }
    .filter(|token| !token.is_empty())
    .ok_or_else(|| {
        AppError::with_detail(
            format!(
                "La connexion au service « {} » a réussi, mais sa réponse ne porte pas de jeton à « {} ».",
                client.label, login.token
            ),
            json!({ "reason": "error" }),
        )
    })?;
    let expires = login
        .expires_in
        .as_deref()
        .and_then(|path| pointed(&body, path))
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|seconds| *seconds > 0)
        .map(|seconds| now() + seconds);
    Ok((token, expires))
}

/// Jeton valable pour ce compte, obtenu au besoin. `stale` est un jeton que le service vient de refuser : il n’est
/// pas resservi.
pub async fn token(state: &Arc<AppState>, client: &Client, stale: Option<&str>) -> AppResult<SessionToken> {
    // Le mot de passe part vers l’adresse de connexion : jamais sans validation de l’utilisateur.
    clients::ensure_trusted(state, client)?;
    let login_def = client.auth.login.clone().ok_or_else(|| AppError::new("La méthode `session` n’a pas de `login`."))?;
    let (entry, _) = clients::secret_of(state, client).await?;
    let lock = crate::oauth::entry_lock(&entry.id);
    let _guard = lock.lock().await;
    // Relu sous le verrou : une requête concurrente a peut-être déjà ouvert la session.
    let mut secret = vault::read_secret_async(&entry.id).await?.filter(Value::is_object).unwrap_or_else(|| json!({}));
    let username = entry.meta_text("username").ok_or_else(|| missing(client))?.to_string();
    let password = vault::field(Some(&secret), "password").ok_or_else(|| missing(client))?.to_string();
    let key = session_key(client, &username);
    let (header, prefix) = applied(&client.auth);
    let header = HeaderName::from_bytes(header.as_bytes())
        .map_err(|_| AppError::new(format!("En-tête du jeton invalide : « {header} ».")))?;
    let mut secrets = vec![password.clone()];
    let fresh = secret.get("sessionKey").and_then(Value::as_str) == Some(key.as_str())
        && secret.get("expiresAt").and_then(Value::as_u64).is_none_or(|at| now() + EXPIRY_MARGIN < at);
    if let Some(current) = vault::field(Some(&secret), "accessToken").filter(|current| fresh && Some(*current) != stale) {
        secrets.push(current.to_string());
        return Ok(SessionToken { header, value: format!("{prefix}{current}"), token: current.to_string(), secrets });
    }
    let variables = Variables { username: &username, password: &password, params: &client.params };
    let (token, expires) = login(client, &login_def, &variables, &secrets).await?;
    secret["accessToken"] = json!(token);
    secret["expiresAt"] = json!(expires);
    secret["sessionKey"] = json!(key);
    vault::write_secret_async(&entry.id, secret).await?;
    secrets.push(token.clone());
    Ok(SessionToken { header, value: format!("{prefix}{token}"), token, secrets })
}

/// Oublie le jeton de session ; l’identifiant et le mot de passe restent.
pub async fn forget(state: &Arc<AppState>, client: &Client) -> AppResult<Value> {
    let (entry, _) = clients::secret_of(state, client).await?;
    let lock = crate::oauth::entry_lock(&entry.id);
    let _guard = lock.lock().await;
    if let Some(mut secret) = vault::read_secret_async(&entry.id).await?.filter(Value::is_object) {
        if clear(&mut secret) {
            vault::write_secret_async(&entry.id, secret).await?;
        }
    }
    state.emit("clients:changed", json!({ "client": client.id, "instance": client.instance }));
    Ok(Value::Null)
}

/// Retire les champs de session d’un secret ; vrai s’il y en avait.
pub fn clear(secret: &mut Value) -> bool {
    let Some(fields) = secret.as_object_mut() else { return false };
    let mut removed = false;
    for name in SESSION_FIELDS {
        removed |= fields.remove(name).is_some();
    }
    removed
}

// ---------------------------------------------------------------------------------------------------------------
// Adresse secrète
// ---------------------------------------------------------------------------------------------------------------

/// Morceaux d’une adresse secrète à masquer partout : l’adresse entière, ses valeurs de paramètres et ses longs
/// segments de chemin (un jeton s’y loge souvent : `…/private-<jeton>/basic.ics`).
pub fn url_secrets(url: &Url) -> Vec<String> {
    let mut secrets = vec![url.as_str().to_string()];
    let mut bare = url.clone();
    bare.set_query(None);
    secrets.push(bare.as_str().to_string());
    secrets.extend(url.query_pairs().map(|(_, value)| value.into_owned()).filter(|value| value.len() >= 4));
    secrets.extend(
        url.path_segments().into_iter().flatten().filter(|segment| segment.len() >= 12).map(str::to_string),
    );
    secrets
}

/// Adresse appelée pour un compte `secretUrl` : le chemin de la fonction reste sous l’adresse secrète, et les
/// paramètres de celle-ci sont gardés devant ceux de la requête.
pub fn secret_target(base: &Url, path: &str, query: Option<&serde_json::Map<String, Value>>) -> AppResult<Url> {
    let mut bare = base.clone();
    bare.set_query(None);
    let mut url = clients::build_url(&bare, path, query, None)?;
    let added = url.query().map(str::to_string).filter(|query| !query.is_empty());
    let joined = match (base.query().filter(|query| !query.is_empty()), added) {
        (Some(base), Some(added)) => Some(format!("{base}&{added}")),
        (Some(base), None) => Some(base.to_string()),
        (None, added) => added,
    };
    url.set_query(joined.as_deref());
    Ok(url)
}

/// Parcours de bout en bout contre de faux services locaux : un Portainer (connexion par identifiant, jeton JWT), un
/// OpenBao (userpass, valeurs d’un coffre scellées, recopie vers un autre compte) et un agenda publié dont l’adresse
/// porte un jeton. Aucune valeur secrète ne doit ressortir dans une réponse, une erreur, le journal ou un fichier de
/// l’espace.
#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use axum::extract::{Path as AxumPath, State};
    use axum::http::{HeaderMap as AxumHeaders, StatusCode, Uri};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, post};
    use axum::{Json, Router};

    use super::*;
    use crate::clients::testing::*;
    use crate::permissions::Subject;

    const PORTAINER_PASSWORD: &str = "p4ss-P0RT41N3R";
    const BAO_PASSWORD: &str = "p4ss-B40-US3R";
    const DB_PASSWORD: &str = "v4l3ur-DB-AAAA";
    const API_KEY: &str = "v4l3ur-API-BBBB";
    const CAL_TOKEN: &str = "c4l3nd4r-t0k3n-0123456789";
    const CAL_KEY: &str = "K3Y-CAL-ZZZZ";
    const SECRETS: [&str; 8] =
        [PORTAINER_PASSWORD, BAO_PASSWORD, DB_PASSWORD, API_KEY, CAL_TOKEN, CAL_KEY, "jwt-P0RT-", "hvs.T0K3N-"];

    #[derive(Default)]
    struct Fake {
        logins: AtomicUsize,
        tokens: Mutex<HashSet<String>>,
        /// Corps reçus par les écritures du coffre.
        written: Mutex<Vec<Value>>,
        reads: AtomicUsize,
        calendar: Mutex<Vec<String>>,
    }

    fn issue(fake: &Fake, prefix: &str) -> String {
        let number = fake.logins.fetch_add(1, Ordering::SeqCst) + 1;
        let token = format!("{prefix}{number}-{}", "x".repeat(40));
        fake.tokens.lock().unwrap().insert(token.clone());
        token
    }

    fn bearer_ok(fake: &Fake, headers: &AxumHeaders) -> bool {
        let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
        token.is_some_and(|token| fake.tokens.lock().unwrap().contains(token))
    }

    fn vault_ok(fake: &Fake, headers: &AxumHeaders) -> bool {
        let token = headers.get("x-vault-token").and_then(|v| v.to_str().ok()).unwrap_or_default();
        fake.tokens.lock().unwrap().contains(token)
    }

    async fn portainer_auth(State(fake): State<Arc<Fake>>, Json(body): Json<Value>) -> Response {
        if body["username"] == json!("alice") && body["password"] == json!(PORTAINER_PASSWORD) {
            Json(json!({ "jwt": issue(&fake, "jwt-P0RT-") })).into_response()
        } else {
            (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "message": "Invalid credentials" }))).into_response()
        }
    }

    async fn portainer_info(State(fake): State<Arc<Fake>>, AxumPath(id): AxumPath<String>, headers: AxumHeaders) -> Response {
        if !bearer_ok(&fake, &headers) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "message": "Unauthorized" }))).into_response();
        }
        // Écho de l’authentification : Alfred doit la masquer.
        let echo = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        Json(json!({ "endpoint": id, "echo": echo })).into_response()
    }

    async fn bao_login(State(fake): State<Arc<Fake>>, AxumPath(user): AxumPath<String>, Json(body): Json<Value>) -> Response {
        if user == "bob" && body["password"] == json!(BAO_PASSWORD) {
            Json(json!({ "auth": { "client_token": issue(&fake, "hvs.T0K3N-"), "lease_duration": 3600 } })).into_response()
        } else {
            (StatusCode::BAD_REQUEST, Json(json!({ "errors": ["invalid username or password"] }))).into_response()
        }
    }

    async fn bao_read(State(fake): State<Arc<Fake>>, headers: AxumHeaders, uri: Uri) -> Response {
        if !vault_ok(&fake, &headers) {
            return (StatusCode::FORBIDDEN, Json(json!({ "errors": ["permission denied"] }))).into_response();
        }
        fake.reads.fetch_add(1, Ordering::SeqCst);
        let mut response = Json(json!({
            "data": { "data": { "DB_PASSWORD": DB_PASSWORD, "API_KEY": API_KEY }, "metadata": { "version": 1, "path": uri.path() } },
            // Un champ non déclaré qui répète une valeur : masqué quand même.
            "warnings": [format!("copie {DB_PASSWORD}")],
        }))
        .into_response();
        response.headers_mut().insert("x-echo", API_KEY.parse().unwrap());
        response
    }

    async fn bao_write(State(fake): State<Arc<Fake>>, headers: AxumHeaders, Json(body): Json<Value>) -> Response {
        if !vault_ok(&fake, &headers) {
            return (StatusCode::FORBIDDEN, Json(json!({ "errors": ["permission denied"] }))).into_response();
        }
        fake.written.lock().unwrap().push(body.clone());
        Json(json!({ "data": { "version": 2 }, "echo": body })).into_response()
    }

    async fn calendar(State(fake): State<Arc<Fake>>, uri: Uri) -> Response {
        let seen = format!("{}?{}", uri.path(), uri.query().unwrap_or_default());
        fake.calendar.lock().unwrap().push(seen.clone());
        format!("BEGIN:VCALENDAR\nX-SOURCE:{seen}\nEND:VCALENDAR").into_response()
    }

    async fn fake() -> (String, Arc<Fake>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Fake::default());
        let router = Router::new()
            .route("/portainer/api/auth", post(portainer_auth))
            .route("/portainer/api/endpoints/{id}/docker/info", get(portainer_info))
            .route("/bao/v1/auth/userpass/login/{user}", post(bao_login))
            .route("/bao/v1/{mount}/data/{*path}", get(bao_read).post(bao_write))
            .route("/bao/v1/{mount}/metadata/{*path}", get(bao_read))
            .route("/cal/{*rest}", get(calendar))
            .with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://127.0.0.1:{port}"), state)
    }

    fn page(module: &str) -> Subject {
        page_subject(module)
    }

    async fn basic_entry(state: &Arc<AppState>, user: &str, password: &str) -> String {
        let id = unique("compte");
        invoke(state, "vault.save", json!({ "id": id, "label": "Compte", "kind": "basic", "meta": { "username": user }, "secrets": { "password": password } }))
            .await
            .unwrap();
        id
    }

    fn journal_text(state: &Arc<AppState>) -> String {
        let db = state.app_db.lock().unwrap();
        Value::Array(crate::app_db::read_journal(&db, &state.space().unwrap().root.to_string_lossy(), None, 500).unwrap())
            .to_string()
    }

    fn space_files(state: &Arc<AppState>) -> String {
        let root = state.space().unwrap().root.join("clients");
        std::fs::read_dir(root)
            .unwrap()
            .filter_map(|entry| std::fs::read_to_string(entry.ok()?.path()).ok())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn a_portainer_session_token_stays_native_and_is_renewed() {
        let (state, _dir) = test_state();
        let (origin, remote) = fake().await;
        let mut outputs: Vec<String> = Vec::new();
        let saved = invoke(&state, "clients.save", json!({ "client": {
            "id": "portainer", "label": "Portainer",
            "methods": [{ "id": "motdepasse", "label": "Identifiant et mot de passe", "type": "session",
                "login": { "path": "/api/auth", "body": { "username": "{username}", "password": "{password}" }, "token": "jwt" },
                "params": [{ "id": "endpoint", "label": "Endpoint", "example": "3" }] }],
        } })).await.unwrap();
        outputs.push(saved.to_string());
        let entry = basic_entry(&state, "alice", PORTAINER_PASSWORD).await;
        let instance = json!({ "id": "prod", "label": "Prod", "url": format!("{origin}/portainer"), "method": "motdepasse", "secret": entry });

        // Un paramètre obligatoire manquant est demandé par son nom.
        let missing = invoke(&state, "clients.saveInstance", json!({ "client": "portainer", "instance": instance, "create": true })).await.unwrap_err();
        assert!(missing.message.contains("Endpoint"), "{}", missing.message);
        let mut with_param = instance.clone();
        with_param["params"] = json!({ "endpoint": "3", "inconnu": "x" });
        let saved = invoke(&state, "clients.saveInstance", json!({ "client": "portainer", "instance": with_param, "create": true })).await.unwrap();
        assert_eq!(saved["instances"][0]["params"], json!({ "endpoint": "3" }), "un paramètre non déclaré n’est pas gardé");
        outputs.push(saved.to_string());

        let function = function_subject("docker");
        grant(&state, &function, "portainer");
        let info = request(&state, &function, "portainer", json!({ "path": "/api/endpoints/{endpoint}/docker/info" })).await.unwrap();
        assert_eq!(info["status"], json!(200), "{info}");
        assert_eq!(info["body"]["endpoint"], json!("3"), "le paramètre est placé dans le chemin");
        assert!(info["body"]["echo"].as_str().unwrap().contains("[secret masqué]"), "{info}");
        outputs.push(info.to_string());
        assert_eq!(remote.logins.load(Ordering::SeqCst), 1);

        // Le jeton est au coffre (trousseau), réutilisé tant qu’il vaut, redemandé une fois s’il est refusé.
        let stored = vault::read_secret(&entry).unwrap().unwrap();
        assert!(stored["accessToken"].as_str().unwrap().starts_with("jwt-P0RT-"));
        outputs.push(request(&state, &function, "portainer", json!({ "path": "/api/endpoints/3/docker/info" })).await.unwrap().to_string());
        assert_eq!(remote.logins.load(Ordering::SeqCst), 1, "jeton réutilisé");
        remote.tokens.lock().unwrap().clear();
        let renewed = request(&state, &function, "portainer", json!({ "path": "/api/endpoints/3/docker/info" })).await.unwrap();
        assert_eq!(renewed["status"], json!(200));
        assert_eq!(remote.logins.load(Ordering::SeqCst), 2, "nouvelle connexion après un 401");
        outputs.push(renewed.to_string());

        // Les fonctions lisent les paramètres, jamais le secret.
        let params = invoke(&state, "frame.clients.params", json!({ "subject": function, "client": "portainer" })).await.unwrap();
        assert_eq!(params, json!({ "instance": "prod", "params": { "endpoint": "3" } }));

        // Modifier un paramètre remet le compte « à vérifier » (le dernier test ne vaut plus).
        invoke(&state, "clients.test", json!({ "id": "portainer", "instance": "prod" })).await.unwrap();
        let listed = invoke(&state, "clients.list", json!({})).await.unwrap();
        let account = |list: &Value| list["clients"][0]["instances"][0].clone();
        assert!(!account(&listed)["lastTest"].is_null());
        with_param["params"] = json!({ "endpoint": "4" });
        invoke(&state, "clients.saveInstance", json!({ "client": "portainer", "instance": with_param })).await.unwrap();
        let listed = invoke(&state, "clients.list", json!({})).await.unwrap();
        assert!(account(&listed)["lastTest"].is_null(), "{}", account(&listed));
        outputs.push(listed.to_string());

        // Un mauvais mot de passe : le test dit pourquoi, sans le répéter ; changer le mot de passe oublie le jeton.
        invoke(&state, "vault.save", json!({ "id": entry, "label": "Compte", "kind": "basic", "meta": { "username": "alice" }, "secrets": { "password": "f4ux-m0t-de-p4ss3" } })).await.unwrap();
        assert!(vault::read_secret(&entry).unwrap().unwrap().get("accessToken").is_none());
        let failed = invoke(&state, "clients.test", json!({ "id": "portainer", "instance": "prod" })).await.unwrap();
        assert_eq!((failed["ok"].clone(), failed["reason"].clone()), (json!(false), json!("refused")), "{failed}");
        assert!(!failed.to_string().contains("f4ux"));
        outputs.push(failed.to_string());

        let everything = format!("{} {} {}", outputs.join(" "), journal_text(&state), space_files(&state));
        assert_no_leak("parcours Portainer", &everything, &SECRETS);
    }

    async fn openbao(state: &Arc<AppState>, origin: &str) -> (String, String) {
        invoke(state, "clients.save", json!({ "client": {
            "id": "openbao", "label": "OpenBao",
            "methods": [{ "id": "userpass", "label": "Identifiant", "type": "session",
                "login": { "path": "/v1/auth/userpass/login/{username}", "body": { "password": "{password}" },
                           "token": "auth.client_token", "expiresIn": "auth.lease_duration" },
                "apply": { "header": "X-Vault-Token" },
                "params": [{ "id": "mount", "label": "Montage", "default": "secret" }] }],
            "sealed": [{ "path": "/v1/{mount}/data/**", "fields": ["data.data.*"] }],
        } })).await.unwrap();
        let mut ids = Vec::new();
        for (id, mount) in [("prod", "kv"), ("recette", "secret")] {
            let entry = basic_entry(state, "bob", BAO_PASSWORD).await;
            let mut instance = json!({ "id": id, "label": id, "url": format!("{origin}/bao"), "method": "userpass", "secret": entry });
            if mount != "secret" {
                instance["params"] = json!({ "mount": mount });
            }
            invoke(state, "clients.saveInstance", json!({ "client": "openbao", "instance": instance, "create": true })).await.unwrap();
            ids.push(entry);
        }
        (ids[0].clone(), ids[1].clone())
    }

    #[tokio::test]
    async fn openbao_values_reach_pages_only_as_references() {
        let (state, dir) = test_state();
        let (origin, remote) = fake().await;
        openbao(&state, &origin).await;
        let function = function_subject("secrets");
        grant(&state, &function, "openbao");
        let mut outputs: Vec<String> = Vec::new();

        let read = request(&state, &function, "openbao", json!({ "instance": "prod", "path": "/v1/{mount}/data/app" })).await.unwrap();
        assert_eq!(read["status"], json!(200), "{read}");
        let values = &read["body"]["data"]["data"];
        let db_ref = values["DB_PASSWORD"].as_str().unwrap().to_string();
        assert!(crate::secret_refs::is_reference(&db_ref), "{read}");
        assert!(crate::secret_refs::is_reference(values["API_KEY"].as_str().unwrap()));
        assert_eq!(read["body"]["data"]["metadata"]["version"], json!(1), "le reste reste lisible");
        assert_eq!(read["body"]["data"]["metadata"]["path"], json!("/bao/v1/kv/data/app"), "montage du compte");
        outputs.push(read.to_string());
        // Un chemin non scellé du même service n’est pas touché (et ici la valeur répétée reste masquée par la
        // requête suivante seulement si elle est scellée : le module déclare ce qu’il faut sceller).
        assert!(request(&state, &function, "openbao", json!({ "instance": "prod", "path": "/v1/kv/data/app", "query": { "v": db_ref } })).await.is_err(), "référence en paramètre");

        // Pas de cache pour un chemin scellé : chaque lecture repasse par le service.
        let reads = remote.reads.load(Ordering::SeqCst);
        for _ in 0..2 {
            outputs.push(request(&state, &function, "openbao", json!({ "instance": "prod", "path": "/v1/kv/data/app", "cache": 60 })).await.unwrap().to_string());
        }
        assert_eq!(remote.reads.load(Ordering::SeqCst), reads + 2);
        // Ni téléchargement ni base64 sur un chemin scellé.
        let download = invoke(&state, "frame.clients.download", json!({ "subject": function, "client": "openbao", "instance": "prod", "path": "/v1/kv/data/app" })).await.unwrap_err();
        assert!(download.message.contains("scellé"), "{}", download.message);
        let base64 = request(&state, &function, "openbao", json!({ "instance": "prod", "path": "/v1/kv/data/app", "responseType": "base64" })).await.unwrap_err();
        assert!(base64.message.contains("scellé"));

        // Révélation : seulement depuis une page du module, par la coquille, et journalisée sans la valeur.
        let shown = invoke(&state, "secrets.reveal", json!({ "subject": page("secrets"), "reference": db_ref, "label": "DB_PASSWORD" })).await.unwrap();
        assert_eq!(shown["value"], json!(DB_PASSWORD));
        assert!(invoke(&state, "secrets.reveal", json!({ "subject": function, "reference": db_ref })).await.is_err(), "jamais une fonction");
        assert!(invoke(&state, "secrets.reveal", json!({ "subject": page("autre"), "reference": db_ref })).await.is_err(), "jamais un autre module");
        let described = invoke(&state, "secrets.describe", json!({ "subject": page("secrets"), "reference": db_ref })).await.unwrap();
        assert_eq!(described["client"], json!("openbao"));
        outputs.push(described.to_string());

        // `.env` écrit à l’endroit choisi, lisible du seul utilisateur.
        let path = dir.path().join("app.env");
        let written = invoke(&state, "secrets.writeEnvFile", json!({ "subject": page("secrets"), "path": path, "entries": [
            { "name": "DB_PASSWORD", "ref": db_ref }, { "name": "PORT", "value": 5432 } ] })).await.unwrap();
        assert_eq!(written["written"], json!(2));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("DB_PASSWORD=\"{DB_PASSWORD}\"\nPORT=\"5432\"\n"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(invoke(&state, "secrets.writeEnvFile", json!({ "subject": page("secrets"), "path": path, "entries": [{ "name": "X", "value": db_ref }] })).await.is_err(), "une référence passe par `ref`");
        outputs.push(written.to_string());

        // Recopie vers le compte de recette : refusée sans `sealed: true`, faite en natif avec.
        let body = json!({ "data": { "DB_PASSWORD": db_ref } });
        let refused = request(&state, &function, "openbao", json!({ "instance": "recette", "method": "POST", "path": "/v1/{mount}/data/app", "body": body })).await.unwrap_err();
        assert!(refused.message.contains("sealed: true"), "{}", refused.message);
        assert!(remote.written.lock().unwrap().is_empty());
        let outside = request(&state, &function, "openbao", json!({ "instance": "recette", "method": "POST", "path": "/v1/secret/metadata/app", "body": body, "sealed": true })).await;
        assert!(outside.is_err(), "hors d’un chemin scellé");
        let copied = request(&state, &function, "openbao", json!({ "instance": "recette", "method": "POST", "path": "/v1/{mount}/data/app", "body": body, "sealed": true })).await.unwrap();
        assert_eq!(copied["status"], json!(200), "{copied}");
        assert_eq!(remote.written.lock().unwrap()[0]["data"]["DB_PASSWORD"], json!(DB_PASSWORD), "valeur placée en natif");
        outputs.push(copied.to_string());
        // Une autre fonction d’un autre module ne réutilise pas la référence.
        let stranger = function_subject("autre");
        grant(&state, &stranger, "openbao");
        assert!(request(&state, &stranger, "openbao", json!({ "instance": "recette", "method": "POST", "path": "/v1/secret/data/app", "body": body, "sealed": true })).await.is_err());

        // Le jeton de session du coffre n’est jamais rendu.
        let everything = format!("{} {} {}", outputs.join(" "), journal_text(&state), space_files(&state));
        assert_no_leak("parcours OpenBao", &everything, &SECRETS);
    }

    #[tokio::test]
    async fn a_secret_address_stays_in_the_keychain() {
        let (state, _dir) = test_state();
        let (origin, remote) = fake().await;
        invoke(&state, "clients.save", json!({ "client": { "id": "agenda", "label": "Agenda",
            "methods": [{ "id": "publie", "label": "Adresse publiée", "type": "secretUrl" }] } })).await.unwrap();
        let entry = unique("agenda");
        let address = format!("{origin}/cal/private-{CAL_TOKEN}/basic.ics?key={CAL_KEY}");
        invoke(&state, "vault.save", json!({ "id": entry, "label": "Agenda", "kind": "token", "secrets": { "value": address } })).await.unwrap();
        let saved = invoke(&state, "clients.saveInstance", json!({ "client": "agenda", "instance": { "id": "moi", "label": "Moi", "method": "publie", "secret": entry }, "create": true })).await.unwrap();
        assert_eq!(saved["instances"][0]["status"], json!("ready"), "{saved}");
        let function = function_subject("absences");
        grant(&state, &function, "agenda");
        let read = request(&state, &function, "agenda", json!({ "path": "", "query": { "depuis": "2026" } })).await.unwrap();
        assert_eq!(read["status"], json!(200), "{read}");
        let seen = remote.calendar.lock().unwrap().last().cloned().unwrap();
        assert!(seen.contains(CAL_TOKEN) && seen.contains(&format!("key={CAL_KEY}")) && seen.contains("depuis=2026"), "{seen}");
        assert!(read["body"].as_str().unwrap().starts_with("BEGIN:VCALENDAR"));
        let outside = request(&state, &function, "agenda", json!({ "path": "/../../autre" })).await.unwrap_err();
        let everything = format!("{read} {} {} {}", outside.message, journal_text(&state), space_files(&state));
        assert_no_leak("agenda publié", &everything, &SECRETS);
    }

    #[tokio::test]
    async fn an_account_realm_fills_the_keycloak_addresses() {
        let (state, _dir) = test_state();
        local_server(&state).await;
        invoke(&state, "clients.save", json!({ "client": { "id": "keycloak", "label": "Keycloak",
            "methods": [{ "id": "sso", "label": "SSO", "type": "oauth2", "clientId": "alfred",
                "authorizationUrl": "{url}/realms/{realm}/protocol/openid-connect/auth",
                "tokenUrl": "{url}/realms/{realm}/protocol/openid-connect/token", "scopes": ["openid", "offline_access"],
                "params": [{ "id": "realm", "label": "Royaume", "example": "equipe" }] }] } })).await.unwrap();
        let entry = unique("sso");
        invoke(&state, "vault.save", json!({ "id": entry, "label": "SSO", "kind": "oauth2", "meta": { "clientId": "alfred" } })).await.unwrap();
        let instance = json!({ "id": "equipe", "label": "Équipe", "url": "https://sso.acme.example", "method": "sso", "secret": entry, "params": { "realm": "mon équipe" } });
        let saved = invoke(&state, "clients.saveInstance", json!({ "client": "keycloak", "instance": instance, "create": true })).await.unwrap();
        assert_eq!(saved["instances"][0]["validation"]["fingerprint"]["params"], json!("realm = mon équipe"));
        let started = invoke(&state, "clients.connect", json!({ "id": "keycloak", "instance": "equipe" })).await.unwrap();
        let url = started["authorizationUrl"].as_str().unwrap();
        assert!(url.starts_with("https://sso.acme.example/realms/mon%20%C3%A9quipe/protocol/openid-connect/auth?"), "{url}");
        assert!(url.contains("offline_access"));
        let _: HashMap<String, String> = HashMap::new();
    }
}
