//! Jetons OAuth 2 des clients : connexion de l’utilisateur par code d’autorisation et PKCE avec retour sur le
//! serveur local, rafraîchissement, et identifiants d’application (`client_credentials`). Les jetons obtenus ne
//! quittent jamais le coffre : ce module les y écrit et les y relit pour le compte de `clients`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::clients::{self, check_url, AuthKind, Client};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::vault;

/// Durée de vie d’une demande de connexion : au-delà, le retour du navigateur est refusé.
const FLOW_TTL: u64 = 600;
/// Un jeton est renouvelé un peu avant son échéance, pour ne pas expirer pendant la requête.
const EXPIRY_MARGIN: u64 = 30;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_secs()).unwrap_or_default()
}

/// Demande de connexion en attente du retour du navigateur. Tout ce qui sert à l’échange est figé ici au départ :
/// modifier le fichier du client pendant la connexion ne change pas le serveur auquel le code sera envoyé.
struct Flow {
    client: String,
    label: String,
    secret: String,
    client_id: String,
    verifier: String,
    redirect_uri: String,
    token_url: String,
    started: u64,
}

fn flows() -> MutexGuard<'static, HashMap<String, Flow>> {
    static FLOWS: OnceLock<Mutex<HashMap<String, Flow>>> = OnceLock::new();
    FLOWS.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Un seul rafraîchissement à la fois par entrée du coffre : deux requêtes simultanées ne doivent pas présenter
/// le même jeton de rafraîchissement, que beaucoup de serveurs invalident à sa première utilisation.
fn entry_lock(secret: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.entry(secret.to_string()).or_default().clone()
}

fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

/// Adresse de retour à déclarer chez le fournisseur d’identité.
pub fn redirect_uri(state: &AppState) -> AppResult<String> {
    Ok(format!("http://127.0.0.1:{}/oauth/callback", state.server()?.port))
}

fn not_connected(client: &Client) -> AppError {
    AppError::new(format!(
        "Le client « {} » n’est pas connecté. Ouvrir Réglages → Clients et choisir « Se connecter ».",
        client.label
    ))
}

fn client_id_of(entry: &vault::Entry) -> AppResult<String> {
    entry
        .meta_text("clientId")
        .map(str::to_string)
        .ok_or_else(|| AppError::new(format!("L’entrée « {} » du coffre n’a pas d’identifiant client.", entry.label)))
}

// ---------------------------------------------------------------------------------------------------------------
// Serveur de jetons
// ---------------------------------------------------------------------------------------------------------------

struct Tokens {
    access: String,
    refresh: Option<String>,
    expires_at: Option<u64>,
    /// Le serveur a accepté l’application par l’en-tête Basic plutôt que par le corps de la demande.
    basic: bool,
}

/// Erreur OAuth renvoyée par le serveur de jetons (`invalid_grant`…), rangée dans le détail de l’erreur.
fn oauth_error(error: &AppError) -> Option<&str> {
    error.detail.as_ref()?.get("oauthError")?.as_str()
}

/// Le serveur n’a pas reconnu l’application : c’est le signe qu’il attend l’autre façon de s’authentifier.
fn client_rejected(error: &AppError) -> bool {
    oauth_error(error) == Some("invalid_client")
        || error.detail.as_ref().and_then(|detail| detail.get("status")).and_then(Value::as_u64) == Some(401)
}

/// Application qui demande un jeton : son identifiant, son secret s’il y en a un, et la façon de les présenter
/// qui a fonctionné la dernière fois.
struct Application<'a> {
    id: &'a str,
    secret: Option<&'a str>,
    prefer_basic: bool,
}

/// Demande un jeton. Les serveurs ne s’accordent pas sur la façon d’authentifier l’application : identifiants dans
/// le corps, ou en-tête Basic. Si la première est refusée, l’autre est essayée une fois.
async fn token_request(
    token_url: &str,
    application: &Application<'_>,
    grant: &[(&str, &str)],
    secrets: &[String],
) -> AppResult<Tokens> {
    let basic_first = application.prefer_basic && application.secret.is_some();
    match token_attempt(token_url, application, grant, basic_first, secrets).await {
        Err(error) if application.secret.is_some() && client_rejected(&error) => {
            let second = token_attempt(token_url, application, grant, !basic_first, secrets).await;
            // Quand une méthode a déjà fonctionné avec ce serveur, c’est son refus qui dit la vraie cause (secret
            // changé ou révoqué), pas celui de la méthode que le serveur n’accepte de toute façon pas.
            if basic_first && second.is_err() {
                return Err(error);
            }
            second
        }
        result => result,
    }
}

async fn token_attempt(
    token_url: &str,
    application: &Application<'_>,
    grant: &[(&str, &str)],
    basic: bool,
    secrets: &[String],
) -> AppResult<Tokens> {
    let url = check_url(token_url, "L’adresse du serveur de jetons", true)?;
    let mut form: Vec<(&str, &str)> = grant.to_vec();
    let mut request = clients::http()?
        .post(url)
        // Certains serveurs répondent en formulaire tant qu’on ne demande pas du JSON.
        .header(header::ACCEPT, "application/json");
    match application.secret.filter(|_| basic) {
        Some(secret) => {
            // RFC 6749 §2.3.1 : identifiant et secret sont encodés comme un formulaire avant le Base64.
            let encode = |text: &str| url::form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>();
            let pair = format!("{}:{}", encode(application.id), encode(secret));
            let mut value = HeaderValue::from_str(&format!("Basic {}", STANDARD.encode(pair)))
                .map_err(|_| AppError::new("Le secret client ne peut pas être transmis au serveur de jetons."))?;
            value.set_sensitive(true);
            request = request.header(header::AUTHORIZATION, value);
        }
        None => {
            form.push(("client_id", application.id));
            if let Some(secret) = application.secret {
                form.push(("client_secret", secret));
            }
        }
    }
    let response = request.form(&form).send().await.map_err(|error| clients::network_error(error, secrets))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| clients::network_error(error, secrets))?;
    let body: Value = serde_json::from_str(&text).unwrap_or_else(|_| {
        let fields: Map<String, Value> = url::form_urlencoded::parse(text.as_bytes())
            .map(|(name, value)| (name.into_owned(), json!(value)))
            .collect();
        Value::Object(fields)
    });
    let field = |name: &str| body.get(name).and_then(Value::as_str).filter(|value| !value.is_empty());
    let Some(access) = field("access_token").filter(|_| status.is_success()) else {
        let reason = field("error_description")
            .or(field("error"))
            .map(|reason| clients::redact(reason, secrets))
            .unwrap_or_else(|| format!("réponse {}", status.as_u16()));
        return Err(AppError::with_detail(
            format!("Le serveur de jetons a refusé la demande : {reason}."),
            json!({ "oauthError": field("error"), "status": status.as_u16() }),
        ));
    };
    let expires_in = body.get("expires_in").and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()));
    Ok(Tokens {
        access: access.to_string(),
        refresh: field("refresh_token").map(str::to_string),
        expires_at: expires_in.map(|seconds| now() + seconds),
        basic: application.secret.is_some() && basic,
    })
}

fn store_tokens(secret: &mut Value, tokens: &Tokens) {
    secret["accessToken"] = json!(tokens.access);
    secret["expiresAt"] = json!(tokens.expires_at);
    // Un serveur qui ne renvoie pas de nouveau jeton de rafraîchissement laisse l’ancien valable.
    if let Some(refresh) = &tokens.refresh {
        secret["refreshToken"] = json!(refresh);
    }
    // La façon de s’authentifier qui a fonctionné est retenue : la prochaine demande commence par elle, sans
    // tentative refusée que le serveur pourrait prendre pour une attaque.
    if let Some(fields) = secret.as_object_mut() {
        if tokens.basic {
            fields.insert("tokenAuth".to_string(), json!("basic"));
        } else {
            fields.remove("tokenAuth");
        }
    }
}

fn prefers_basic(secret: &Value) -> bool {
    secret.get("tokenAuth").and_then(Value::as_str) == Some("basic")
}

fn clear_tokens(secret: &mut Value) -> bool {
    let Some(fields) = secret.as_object_mut() else { return false };
    let mut removed = false;
    for name in vault::TOKEN_FIELDS {
        removed |= fields.remove(name).is_some();
    }
    removed
}

async fn read_fields(id: &str) -> AppResult<Value> {
    Ok(vault::read_secret_async(id).await?.filter(Value::is_object).unwrap_or_else(|| json!({})))
}

/// Jeton d’accès valide pour ce client, renouvelé au besoin. `stale` est un jeton que le service vient de refuser :
/// il n’est pas resservi, même s’il n’a pas atteint son échéance.
pub async fn access_token(state: &Arc<AppState>, client: &Client, stale: Option<&str>) -> AppResult<String> {
    // Le secret client et le jeton de rafraîchissement partent vers `tokenUrl` : jamais sans validation.
    clients::ensure_trusted(state, client)?;
    let (entry, _) = clients::secret_of(state, client).await?;
    let lock = entry_lock(&entry.id);
    let _guard = lock.lock().await;
    // Relu sous le verrou : une requête concurrente a peut-être déjà renouvelé le jeton.
    let mut secret = read_fields(&entry.id).await?;
    let expired = secret.get("expiresAt").and_then(Value::as_u64).is_some_and(|at| now() + EXPIRY_MARGIN >= at);
    if let Some(current) = vault::field(Some(&secret), "accessToken") {
        if !expired && Some(current) != stale {
            return Ok(current.to_string());
        }
    }

    let client_id = client_id_of(&entry)?;
    let client_secret = vault::field(Some(&secret), "clientSecret").map(str::to_string);
    let token_url = client.auth.token_url.clone().unwrap_or_default();
    let scope = client.auth.scopes.join(" ");
    let mut known: Vec<String> = client_secret.iter().cloned().collect();
    let application =
        Application { id: &client_id, secret: client_secret.as_deref(), prefer_basic: prefers_basic(&secret) };
    let refresh = vault::field(Some(&secret), "refreshToken").map(str::to_string);
    let result = if client.auth.kind == AuthKind::ClientCredentials {
        if client_secret.is_none() {
            return Err(AppError::new(format!(
                "Le secret du client « {} » n’est pas renseigné. Le saisir dans Réglages → Coffre.",
                client.label
            )));
        }
        let mut grant = vec![("grant_type", "client_credentials")];
        if !scope.is_empty() {
            grant.push(("scope", scope.as_str()));
        }
        token_request(&token_url, &application, &grant, &known).await
    } else {
        let Some(refresh) = &refresh else { return Err(not_connected(client)) };
        known.push(refresh.clone());
        let grant = [("grant_type", "refresh_token"), ("refresh_token", refresh.as_str())];
        token_request(&token_url, &application, &grant, &known).await
    };
    match result {
        Ok(tokens) => {
            store_tokens(&mut secret, &tokens);
            vault::write_secret_async(&entry.id, secret).await?;
            Ok(tokens.access)
        }
        Err(error) if client.auth.kind == AuthKind::Oauth2 && oauth_error(&error) == Some("invalid_grant") => {
            // La session est terminée côté fournisseur : garder ces jetons ferait échouer chaque requête de la
            // même façon. Le client repasse « à connecter ».
            if clear_tokens(&mut secret) {
                vault::write_secret_async(&entry.id, secret).await?;
            }
            state.emit("clients:changed", json!({ "client": client.id, "connected": false }));
            Err(AppError::new(format!(
                "La connexion du client « {} » a expiré. Ouvrir Réglages → Clients et choisir « Se connecter ».",
                client.label
            )))
        }
        Err(error) => Err(error),
    }
}

/// Oublie les jetons obtenus ; le secret saisi par l’utilisateur reste en place.
pub async fn disconnect(state: &Arc<AppState>, client: &Client) -> AppResult<Value> {
    if !client.auth.kind.uses_token_endpoint() {
        return Err(AppError::new(format!("Le client « {} » n’a pas de connexion à fermer.", client.label)));
    }
    let (entry, _) = clients::secret_of(state, client).await?;
    let lock = entry_lock(&entry.id);
    let _guard = lock.lock().await;
    let mut secret = read_fields(&entry.id).await?;
    if clear_tokens(&mut secret) {
        vault::write_secret_async(&entry.id, secret).await?;
    }
    state.emit("clients:changed", json!({ "client": client.id, "connected": false }));
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------------------------------------------
// Connexion de l’utilisateur (code d’autorisation + PKCE)
// ---------------------------------------------------------------------------------------------------------------

/// Prépare une connexion et renvoie l’adresse à ouvrir dans le navigateur.
pub async fn begin(state: &Arc<AppState>, client: &Client) -> AppResult<String> {
    if client.auth.kind != AuthKind::Oauth2 {
        return Err(AppError::new(format!("Le client « {} » ne se connecte pas par OAuth 2.", client.label)));
    }
    client.validate()?;
    // Les adresses d’autorisation et de jetons viennent du fichier : elles doivent être celles que l’utilisateur
    // a validées avant qu’on lui ouvre une page de connexion.
    clients::ensure_trusted(state, client)?;
    let (entry, _) = clients::secret_of(state, client).await?;
    let client_id = client_id_of(&entry)?;
    let redirect_uri = redirect_uri(state)?;
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let key = random_token();

    let authorization_url = client.auth.authorization_url.as_deref().unwrap_or_default();
    let mut url = check_url(authorization_url, "L’adresse d’autorisation", true)?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &key)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        if !client.auth.scopes.is_empty() {
            query.append_pair("scope", &client.auth.scopes.join(" "));
        }
    }

    let mut flows = flows();
    let oldest = now().saturating_sub(FLOW_TTL);
    flows.retain(|_, flow| flow.started > oldest);
    flows.insert(
        key,
        Flow {
            client: client.id.clone(),
            label: client.label.clone(),
            secret: entry.id,
            client_id,
            verifier,
            redirect_uri,
            token_url: client.auth.token_url.clone().unwrap_or_default(),
            started: now(),
        },
    );
    Ok(url.into())
}

async fn exchange(flow: &Flow, params: &HashMap<String, String>) -> AppResult<()> {
    if let Some(error) = params.get("error") {
        let reason = params.get("error_description").filter(|text| !text.is_empty()).unwrap_or(error);
        return Err(AppError::new(if error == "access_denied" {
            format!("La connexion a été refusée ou annulée ({reason}).")
        } else {
            format!("Le service a refusé la connexion : {reason}.")
        }));
    }
    let code = params
        .get("code")
        .filter(|code| !code.is_empty())
        .ok_or_else(|| AppError::new("Le service n’a pas renvoyé de code d’autorisation."))?;
    let lock = entry_lock(&flow.secret);
    let _guard = lock.lock().await;
    let mut secret = read_fields(&flow.secret).await?;
    let client_secret = vault::field(Some(&secret), "clientSecret").map(str::to_string);
    let grant = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", flow.redirect_uri.as_str()),
        ("code_verifier", flow.verifier.as_str()),
    ];
    let application =
        Application { id: &flow.client_id, secret: client_secret.as_deref(), prefer_basic: prefers_basic(&secret) };
    let known: Vec<String> = client_secret.iter().cloned().chain([flow.verifier.clone()]).collect();
    let tokens = token_request(&flow.token_url, &application, &grant, &known).await?;
    // Une nouvelle connexion repart de zéro : l’ancien jeton de rafraîchissement n’appartient plus à cette session.
    clear_tokens(&mut secret);
    store_tokens(&mut secret, &tokens);
    vault::write_secret_async(&flow.secret, secret).await
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn page(status: StatusCode, title: &str, message: &str) -> Response {
    let html = format!(
        r#"<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Alfred</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; background: #faf9f6; color: #26251f; }}
  main {{ max-width: 440px; padding: 32px; }}
  h1 {{ margin: 0 0 8px; font-size: 20px; }}
  p {{ margin: 0; color: #6b695f; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #1c1b18; color: #ecebe6; }} p {{ color: #a3a196; }} }}
</style>
</head>
<body><main><h1>{title}</h1><p>{message}</p></main></body>
</html>"#,
        title = escape(title),
        message = escape(message),
    );
    let mut response = Response::new(html.into());
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Le texte du fournisseur est échappé ; cette politique interdit en plus tout script sur la page.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"),
    );
    response
}

/// `GET /oauth/callback` : retour du navigateur après la connexion. Le paramètre `state`, aléatoire et à usage
/// unique, est la seule preuve que ce retour répond à une demande d’Alfred.
pub async fn callback(State(state): State<Arc<AppState>>, Query(params): Query<HashMap<String, String>>) -> Response {
    let flow = params.get("state").and_then(|key| flows().remove(key)).filter(|flow| flow.started + FLOW_TTL > now());
    let Some(flow) = flow else {
        return page(
            StatusCode::BAD_REQUEST,
            "Connexion impossible",
            "Cette demande de connexion est inconnue, déjà utilisée ou a expiré (10 minutes). Relancez la connexion depuis Alfred.",
        );
    };
    match exchange(&flow, &params).await {
        Ok(()) => {
            state.emit("clients:changed", json!({ "client": flow.client, "connected": true }));
            page(
                StatusCode::OK,
                "Connexion réussie",
                &format!(
                    "Le client « {} » est connecté. Vous pouvez fermer cet onglet et revenir dans Alfred.",
                    flow.label
                ),
            )
        }
        Err(error) => {
            state.emit("clients:changed", json!({ "client": flow.client, "connected": false, "error": error.message }));
            page(StatusCode::BAD_REQUEST, "Connexion impossible", &error.message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::testing::*;

    fn query_of(url: &str) -> HashMap<String, String> {
        url::Url::parse(url).unwrap().query_pairs().into_owned().collect()
    }

    async fn browse(url: &str) -> (u16, String) {
        let response = reqwest::get(url).await.unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }

    /// Enregistre une entrée OAuth 2 et un client relié au faux service ; renvoie l’identifiant de l’entrée.
    async fn oauth_client(state: &Arc<AppState>, remote: &Remote, client_secret: Option<&str>) -> String {
        let entry = unique("sso");
        let mut args =
            json!({ "id": entry, "label": "SSO", "kind": "oauth2", "meta": { "clientId": REMOTE_CLIENT_ID } });
        if let Some(client_secret) = client_secret {
            args["secrets"] = json!({ "clientSecret": client_secret });
        }
        invoke(state, "vault.save", args).await.unwrap();
        let saved = invoke(
            state,
            "clients.save",
            json!({ "client": {
                "id": "portail", "label": "Portail", "baseUrl": format!("{}/api", remote.origin),
                "auth": {
                    "type": "oauth2", "secret": entry,
                    "authorizationUrl": format!("{}/authorize?prompt=login", remote.origin),
                    "tokenUrl": format!("{}/token", remote.origin),
                    "scopes": ["lire", "ecrire"],
                },
            } }),
        )
        .await
        .unwrap();
        assert_eq!(saved["status"], json!("toConnect"));
        entry
    }

    fn status_of(list: &Value, id: &str) -> Value {
        list["clients"].as_array().unwrap().iter().find(|client| client["id"] == json!(id)).unwrap()["status"].clone()
    }

    #[tokio::test]
    async fn pkce_flow_connects_the_client_then_refreshes_its_token() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let port = local_server(&state).await;
        let callback = format!("http://127.0.0.1:{port}/oauth/callback");
        let subject = page_subject("crm");
        let entry = oauth_client(&state, &remote, None).await;
        grant(&state, &subject, "portail");
        let mut outputs: Vec<String> = Vec::new();

        // Avant la connexion, une page reçoit une consigne claire.
        let error = request(&state, &subject, "portail", json!({ "path": "/protected" })).await.unwrap_err();
        assert!(error.message.contains("Se connecter"), "{}", error.message);

        // Départ : l’adresse à ouvrir porte le défi PKCE, jamais le vérificateur.
        let started = invoke(&state, "clients.connect", json!({ "id": "portail" })).await.unwrap();
        let authorization_url = started["authorizationUrl"].as_str().unwrap().to_string();
        assert!(authorization_url.starts_with(&format!("{}/authorize?prompt=login&", remote.origin)));
        let query = query_of(&authorization_url);
        assert_eq!(query["response_type"], "code");
        assert_eq!(query["client_id"], REMOTE_CLIENT_ID);
        assert_eq!(query["redirect_uri"], callback);
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["scope"], "lire ecrire");
        assert_eq!(query["code_challenge"].len(), 43);
        assert!(query["state"].len() >= 43);
        outputs.push(started.to_string());

        // Le fournisseur valide l’utilisateur, délivre un code et renvoie le navigateur vers Alfred.
        remote.state.codes.lock().unwrap().insert("c0de-1".to_string(), query["code_challenge"].clone());
        let mut events = state.events.subscribe();
        let (status, html) = browse(&format!("{callback}?code=c0de-1&state={}", query["state"])).await;
        assert_eq!(status, 200, "{html}");
        assert!(html.contains("Connexion réussie") && html.contains("revenir dans Alfred"), "{html}");
        let event = events.try_recv().unwrap();
        assert_eq!(event.name, "clients:changed");
        assert_eq!(event.payload, json!({ "client": "portail", "connected": true }));
        outputs.push(html);

        // L’échange a prouvé la possession du vérificateur, sans secret client pour cette application publique.
        let exchange = remote.state.token_requests.lock().unwrap()[0].clone();
        assert_eq!(exchange["grant_type"], "authorization_code");
        assert_eq!(exchange["redirect_uri"], callback);
        assert!(!exchange.contains_key("client_secret"));
        let verifier = exchange["code_verifier"].clone();
        assert!(verifier.len() >= 43);

        // Le même retour rejoué est refusé : `state` ne sert qu’une fois.
        let (status, html) = browse(&format!("{callback}?code=c0de-1&state={}", query["state"])).await;
        assert_eq!(status, 400);
        assert!(html.contains("déjà utilisée"), "{html}");
        outputs.push(html);

        // Connecté : les réglages le disent, et la page appelle le service avec le jeton obtenu.
        let list = invoke(&state, "clients.list", json!({})).await.unwrap();
        assert_eq!(status_of(&list, "portail"), json!("ready"));
        assert_eq!(list["redirectUri"], json!(callback));
        outputs.push(list.to_string());
        let response = request(&state, &subject, "portail", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(response["body"], json!({ "user": "alice" }));
        assert_eq!(remote.last().headers["authorization"], "Bearer acc3ss-t0k3n-1");
        outputs.push(response.to_string());

        // Jeton refusé par le service (401) : rafraîchi une fois, puis la requête est rejouée.
        remote.revoke_access_tokens();
        let response = request(&state, &subject, "portail", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(response["status"], json!(200));
        assert_eq!(remote.token_grants(), ["authorization_code", "refresh_token"]);
        assert_eq!(remote.last().headers["authorization"], "Bearer acc3ss-t0k3n-2");
        // Le serveur a fait tourner le jeton de rafraîchissement : le nouveau est au coffre.
        assert_eq!(vault::read_secret(&entry).unwrap().unwrap()["refreshToken"], json!("r3fr3sh-t0k3n-2"));
        outputs.push(response.to_string());

        // Jeton arrivé à échéance : rafraîchi avant l’appel, qui n’est donc fait qu’une fois.
        let mut secret = vault::read_secret(&entry).unwrap().unwrap();
        secret["expiresAt"] = json!(now() + 5);
        vault::write_secret(&entry, &secret).unwrap();
        let calls = remote.seen_paths().len();
        request(&state, &subject, "portail", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(remote.token_grants().len(), 3);
        assert_eq!(remote.seen_paths().len(), calls + 1);

        // Session terminée côté fournisseur : erreur explicite, et le client repasse « à connecter ».
        remote.revoke_access_tokens();
        remote.state.refresh_tokens.lock().unwrap().clear();
        let error = request(&state, &subject, "portail", json!({ "path": "/protected" })).await.unwrap_err();
        assert!(error.message.contains("a expiré") && error.message.contains("Se connecter"), "{}", error.message);
        outputs.push(format!("{} {:?}", error.message, error.detail));
        let list = invoke(&state, "clients.list", json!({})).await.unwrap();
        assert_eq!(status_of(&list, "portail"), json!("toConnect"));
        outputs.push(list.to_string());
        outputs.push(invoke(&state, "vault.list", json!({})).await.unwrap().to_string());

        let everything = outputs.join("\n");
        assert_no_leak("réponses", &everything, &["acc3ss-t0k3n", "r3fr3sh-t0k3n", verifier.as_str()]);
    }

    #[tokio::test]
    async fn refused_expired_and_forged_returns_fail_explicitly() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let port = local_server(&state).await;
        let callback = format!("http://127.0.0.1:{port}/oauth/callback");
        let entry = oauth_client(&state, &remote, Some(REMOTE_CLIENT_SECRET)).await;
        let connect = || async {
            let started = invoke(&state, "clients.connect", json!({ "id": "portail" })).await.unwrap();
            query_of(started["authorizationUrl"].as_str().unwrap())
        };

        // Retour sans `state`, ou avec un `state` inventé.
        for url in [format!("{callback}?code=x"), format!("{callback}?code=x&state=invente")] {
            let (status, html) = browse(&url).await;
            assert_eq!(status, 400);
            assert!(html.contains("Connexion impossible") && html.contains("inconnue"), "{html}");
        }

        // L’utilisateur refuse chez le fournisseur ; son message est affiché, échappé.
        let query = connect().await;
        let mut events = state.events.subscribe();
        let (status, html) = browse(&format!(
            "{callback}?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state={}",
            query["state"]
        ))
        .await;
        assert_eq!(status, 400);
        assert!(html.contains("refusée ou annulée"), "{html}");
        assert!(html.contains("&lt;script&gt;") && !html.contains("<script>"), "{html}");
        let event = events.try_recv().unwrap();
        assert_eq!(event.payload["connected"], json!(false));

        // Code refusé par le serveur de jetons : l’erreur du serveur est rendue, sans le secret client envoyé.
        let query = connect().await;
        let (status, html) = browse(&format!("{callback}?code=inconnu&state={}", query["state"])).await;
        assert_eq!(status, 400);
        assert!(html.contains("Code inconnu ou déjà utilisé"), "{html}");
        assert_eq!(remote.state.token_requests.lock().unwrap().last().unwrap()["client_secret"], REMOTE_CLIENT_SECRET);
        assert_no_leak("page de retour", &html, &[REMOTE_CLIENT_SECRET]);

        // Demande vieille de plus de dix minutes : refusée même avec un code valable.
        let query = connect().await;
        remote.state.codes.lock().unwrap().insert("c0de-2".to_string(), query["code_challenge"].clone());
        flows().get_mut(&query["state"]).unwrap().started = now() - FLOW_TTL - 1;
        let (status, html) = browse(&format!("{callback}?code=c0de-2&state={}", query["state"])).await;
        assert_eq!(status, 400);
        assert!(html.contains("a expiré"), "{html}");
        assert!(vault::read_secret(&entry).unwrap().unwrap().get("accessToken").is_none());

        // Une connexion réussie puis « Se déconnecter » : les jetons partent, le secret client reste.
        let query = connect().await;
        remote.state.codes.lock().unwrap().insert("c0de-3".to_string(), query["code_challenge"].clone());
        let (status, _) = browse(&format!("{callback}?code=c0de-3&state={}", query["state"])).await;
        assert_eq!(status, 200);
        assert!(vault::read_secret(&entry).unwrap().unwrap().get("refreshToken").is_some());
        invoke(&state, "clients.disconnect", json!({ "id": "portail" })).await.unwrap();
        let secret = vault::read_secret(&entry).unwrap().unwrap();
        assert_eq!(secret, json!({ "clientSecret": REMOTE_CLIENT_SECRET }));
        let list = invoke(&state, "clients.list", json!({})).await.unwrap();
        assert_eq!(status_of(&list, "portail"), json!("toConnect"));

        // Seuls les clients OAuth 2 se connectent.
        invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "simple", "label": "Simple", "baseUrl": "https://exemple.com" } }),
        )
        .await
        .unwrap();
        let error = invoke(&state, "clients.connect", json!({ "id": "simple" })).await.unwrap_err();
        assert!(error.message.contains("OAuth 2"), "{}", error.message);
    }

    #[tokio::test]
    async fn a_token_endpoint_that_wants_basic_authentication_is_retried_once() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        remote.state.basic_only.store(true, std::sync::atomic::Ordering::SeqCst);
        let port = local_server(&state).await;
        let subject = page_subject("crm");
        let attempts = || -> Vec<(String, String)> {
            let requests = remote.state.token_requests.lock().unwrap();
            requests.iter().map(|form| (form["grant_type"].clone(), form["_auth"].clone())).collect()
        };
        let pair = |grant: &str, auth: &str| (grant.to_string(), auth.to_string());

        // Identifiants d’application : le corps est refusé (401 invalid_client), l’en-tête Basic est accepté.
        let machine = unique("machine");
        invoke(
            &state,
            "vault.save",
            json!({ "id": machine, "label": "Machine", "kind": "clientCredentials", "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": REMOTE_CLIENT_SECRET } }),
        )
        .await
        .unwrap();
        invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "machine", "label": "Machine", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "clientCredentials", "secret": machine, "tokenUrl": format!("{}/token", remote.origin) } } }),
        )
        .await
        .unwrap();
        grant(&state, &subject, "machine");
        let response = request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(response["status"], json!(200));
        assert_eq!(attempts(), [pair("client_credentials", "body"), pair("client_credentials", "basic")]);
        // En Basic, le secret n’est plus dans le corps (le faux serveur l’a relu dans l’en-tête).
        assert_eq!(remote.state.token_requests.lock().unwrap()[1]["client_secret"], REMOTE_CLIENT_SECRET);

        // La méthode qui a fonctionné est retenue : la demande suivante ne repasse pas par un refus.
        remote.revoke_access_tokens();
        request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(attempts().len(), 3);
        assert_eq!(attempts()[2], pair("client_credentials", "basic"));

        // Un mauvais secret reste une erreur, après une seule nouvelle tentative, et n’est cité nulle part.
        invoke(
            &state,
            "vault.save",
            json!({ "id": machine, "label": "Machine", "kind": "clientCredentials", "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": "m4uv41s+s3cr3t/==" } }),
        )
        .await
        .unwrap();
        let error = request(&state, &subject, "machine", json!({ "path": "/protected" })).await.unwrap_err();
        assert!(error.message.contains("Secret client refusé"), "{}", error.message);
        assert_eq!(attempts().len(), 5);
        // Le secret est encodé puis décodé sans altération, caractères spéciaux compris.
        assert_eq!(remote.state.token_requests.lock().unwrap()[3]["client_secret"], "m4uv41s+s3cr3t/==");
        assert_no_leak("erreur", &format!("{} {:?}", error.message, error.detail), &["m4uv41s"]);

        // Échange du code puis rafraîchissement d’un client confidentiel : même repli, puis Basic d’emblée.
        let entry = oauth_client(&state, &remote, Some(REMOTE_CLIENT_SECRET)).await;
        grant(&state, &subject, "portail");
        let started = invoke(&state, "clients.connect", json!({ "id": "portail" })).await.unwrap();
        let query = query_of(started["authorizationUrl"].as_str().unwrap());
        remote.state.codes.lock().unwrap().insert("c0de-9".to_string(), query["code_challenge"].clone());
        let (status, html) =
            browse(&format!("http://127.0.0.1:{port}/oauth/callback?code=c0de-9&state={}", query["state"])).await;
        assert_eq!(status, 200, "{html}");
        assert_eq!(attempts()[5..], [pair("authorization_code", "body"), pair("authorization_code", "basic")]);
        assert_eq!(vault::read_secret(&entry).unwrap().unwrap()["tokenAuth"], json!("basic"));
        remote.revoke_access_tokens();
        let response = request(&state, &subject, "portail", json!({ "path": "/protected" })).await.unwrap();
        assert_eq!(response["status"], json!(200));
        assert_eq!(attempts()[7..], [pair("refresh_token", "basic")]);
    }

    #[tokio::test]
    async fn connecting_or_refreshing_a_client_changed_outside_settings_is_refused() {
        let (state, _dir) = test_state();
        let (remote, elsewhere) = (remote().await, remote().await);
        let port = local_server(&state).await;
        let subject = page_subject("crm");
        let entry = oauth_client(&state, &remote, Some(REMOTE_CLIENT_SECRET)).await;
        grant(&state, &subject, "portail");
        let path = state.space().unwrap().root.join("clients/portail.json");
        let original = std::fs::read_to_string(&path).unwrap();
        let rewrite = |field: &str, value: String| {
            let mut file: Value = serde_json::from_str(&original).unwrap();
            file["auth"][field] = json!(value);
            std::fs::write(&path, file.to_string()).unwrap();
        };

        // Page de connexion détournée : la connexion ne démarre pas.
        rewrite("authorizationUrl", format!("{}/authorize", elsewhere.origin));
        let error = invoke(&state, "clients.connect", json!({ "id": "portail" })).await.unwrap_err();
        assert!(error.message.contains("pas validé"), "{}", error.message);
        let list = invoke(&state, "clients.list", json!({})).await.unwrap();
        assert_eq!(status_of(&list, "portail"), json!("toValidate"));

        // Connexion faite sur le client validé, puis serveur de jetons détourné : le jeton de rafraîchissement et
        // le secret client ne partent pas.
        std::fs::write(&path, &original).unwrap();
        let started = invoke(&state, "clients.connect", json!({ "id": "portail" })).await.unwrap();
        let query = query_of(started["authorizationUrl"].as_str().unwrap());
        remote.state.codes.lock().unwrap().insert("c0de-7".to_string(), query["code_challenge"].clone());
        let (status, _) =
            browse(&format!("http://127.0.0.1:{port}/oauth/callback?code=c0de-7&state={}", query["state"])).await;
        assert_eq!(status, 200);
        rewrite("tokenUrl", format!("{}/token", elsewhere.origin));
        let mut secret = vault::read_secret(&entry).unwrap().unwrap();
        secret["expiresAt"] = json!(1);
        vault::write_secret(&entry, &secret).unwrap();
        let error = request(&state, &subject, "portail", json!({ "path": "/protected" })).await.unwrap_err();
        assert!(error.message.contains("pas validé"), "{}", error.message);
        assert!(elsewhere.state.token_requests.lock().unwrap().is_empty());
        assert!(elsewhere.seen_paths().is_empty() && remote.seen_paths().is_empty());
    }
}
