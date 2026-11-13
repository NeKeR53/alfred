//! Réception des webhooks : un service extérieur appelle `http://127.0.0.1:<port>/hooks/<module>/<id>` et Alfred
//! déclenche la fonction que le module a associée à ce webhook.
//!
//! L’écoute reste locale (127.0.0.1) : pour un service sur Internet, l’utilisateur branche le tunnel de son choix.
//! Un appel n’est accepté que s’il prouve connaître le secret du webhook. Ce secret est généré par Alfred et rangé
//! dans sa base, jamais dans le dossier de l’espace, qui est versionné par git.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Json;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{valid_id, ModuleManifest, Space, WebhookDecl};
use crate::state::AppState;

/// Taille maximale du corps d’un appel.
const BODY_LIMIT: usize = 2 * 1024 * 1024;

/// Au-delà, l’émetteur reçoit 202 et la fonction continue : la plupart des services abandonnent après 30 secondes et
/// renvoient alors l’appel, ce qui la déclencherait deux fois.
const SYNC_WAIT: Duration = if cfg!(test) { Duration::from_millis(400) } else { Duration::from_secs(25) };

/// En-têtes qui portent une preuve ou une session : la fonction ne les voit jamais.
const HIDDEN_HEADERS: [&str; 5] =
    ["authorization", "cookie", "x-alfred-secret", "x-hub-signature-256", "x-alfred-signature"];

// ---------------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------------

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    // Table créée au premier usage : les webhooks n’imposent aucune migration au reste de la base.
    db.execute(
        "CREATE TABLE IF NOT EXISTS webhook_secrets (space TEXT, hook TEXT, secret TEXT, created_at TEXT, last_received_at TEXT, PRIMARY KEY (space, hook))",
        [],
    )?;
    Ok(db)
}

fn space_key(space: &Space) -> String {
    space.root.to_string_lossy().to_string()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn generate_secret() -> String {
    hex(&rand::random::<[u8; 32]>())
}

fn read_secret(state: &AppState, space: &str, hook: &str) -> AppResult<Option<String>> {
    let db = lock_db(state)?;
    Ok(db
        .query_row("SELECT secret FROM webhook_secrets WHERE space = ?1 AND hook = ?2", params![space, hook], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten())
}

/// Renvoie le secret du webhook, en le créant au premier appel.
fn ensure_secret(state: &AppState, space: &str, hook: &str) -> AppResult<String> {
    if let Some(secret) = read_secret(state, space, hook)? {
        return Ok(secret);
    }
    let db = lock_db(state)?;
    db.execute(
        "INSERT INTO webhook_secrets (space, hook, secret, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (space, hook) DO UPDATE SET secret = COALESCE(webhook_secrets.secret, excluded.secret)",
        params![space, hook, generate_secret(), crate::app_db::now()],
    )?;
    // Relu plutôt que renvoyé : si deux appels se croisent, tous deux obtiennent le secret réellement enregistré.
    Ok(db.query_row(
        "SELECT secret FROM webhook_secrets WHERE space = ?1 AND hook = ?2",
        params![space, hook],
        |row| row.get(0),
    )?)
}

fn rotate_secret(state: &AppState, space: &str, hook: &str) -> AppResult<String> {
    let secret = generate_secret();
    let db = lock_db(state)?;
    db.execute(
        "INSERT INTO webhook_secrets (space, hook, secret, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (space, hook) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at",
        params![space, hook, secret, crate::app_db::now()],
    )?;
    Ok(secret)
}

fn mark_received(state: &AppState, space: &str, hook: &str) {
    if let Ok(db) = lock_db(state) {
        let _ = db.execute(
            "UPDATE webhook_secrets SET last_received_at = ?3 WHERE space = ?1 AND hook = ?2",
            params![space, hook, crate::app_db::now()],
        );
    }
}

fn last_received(db: &Connection, space: &str, hook: &str) -> Option<String> {
    db.query_row(
        "SELECT last_received_at FROM webhook_secrets WHERE space = ?1 AND hook = ?2",
        params![space, hook],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
}

// ---------------------------------------------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------------------------------------------

/// Comparaison à temps constant : la durée ne révèle pas jusqu’où deux valeurs coïncident.
pub(crate) fn same(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

/// HMAC-SHA256 (RFC 2104), écrit sur `sha2` pour ne pas ajouter de dépendance.
pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|value| value ^ byte);
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok()).map(str::trim)
}

/// L’appel est accepté si l’une des preuves acceptées est valide ; on n’indique jamais laquelle a échoué.
fn verified(secret: &str, headers: &HeaderMap, query: &[(String, String)], body: &[u8]) -> bool {
    let expected = secret.as_bytes();
    let mut ok = false;
    if let Some(value) = header(headers, "x-alfred-secret") {
        ok |= same(value.as_bytes(), expected);
    }
    if let Some(token) = header(headers, "authorization").and_then(|value| {
        value.get(..7).filter(|scheme| scheme.eq_ignore_ascii_case("bearer ")).map(|_| value[7..].trim())
    }) {
        ok |= same(token.as_bytes(), expected);
    }
    for (_, value) in query.iter().filter(|(name, _)| name == "secret") {
        ok |= same(value.as_bytes(), expected);
    }
    let signature = hex(&hmac_sha256(expected, body));
    for name in ["x-hub-signature-256", "x-alfred-signature"] {
        if let Some(value) = header(headers, name) {
            let value = value.strip_prefix("sha256=").unwrap_or(value).to_ascii_lowercase();
            ok |= same(value.as_bytes(), signature.as_bytes());
        }
    }
    ok
}

// ---------------------------------------------------------------------------------------------------------------
// Réception
// ---------------------------------------------------------------------------------------------------------------

/// Routes HTTP locales de ce module.
pub fn routes() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        // GET est accepté pour les services qui vérifient l’adresse avant d’y envoyer leurs événements.
        .route("/hooks/{module}/{id}", get(receive).post(receive))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn not_found() -> Response {
    reply(StatusCode::NOT_FOUND, json!({ "error": "Webhook inconnu." }))
}

fn input_of(method: &Method, headers: &HeaderMap, query: &[(String, String)], body: &[u8]) -> Value {
    let query: Map<String, Value> =
        query.iter().filter(|(name, _)| name != "secret").map(|(name, value)| (name.clone(), json!(value))).collect();
    let mut visible = Map::new();
    for name in headers.keys() {
        let name = name.as_str();
        if HIDDEN_HEADERS.contains(&name) {
            continue;
        }
        let values: Vec<&str> = headers.get_all(name).iter().filter_map(|value| value.to_str().ok()).collect();
        visible.insert(name.to_string(), json!(values.join(", ")));
    }
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(body)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(body).into_owned()))
    };
    json!({ "method": method.as_str(), "query": query, "headers": visible, "body": body })
}

async fn receive(
    State(state): State<Arc<AppState>>,
    Path((module, id)): Path<(String, String)>,
    method: Method,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Espace fermé, module ou webhook non déclaré : 404, sans distinguer les cas.
    let Some(space) = state.try_space() else { return not_found() };
    if !valid_id(&module) || !valid_id(&id) {
        return not_found();
    }
    let Some(declaration) =
        space.module(&module).ok().and_then(|manifest| manifest.webhooks.into_iter().find(|hook| hook.id == id))
    else {
        return not_found();
    };
    let key = space_key(&space);
    let hook = format!("{module}/{id}");
    let query: Vec<(String, String)> = raw_query
        .as_deref()
        .map(|raw| url::form_urlencoded::parse(raw.as_bytes()).into_owned().collect())
        .unwrap_or_default();

    let secret = read_secret(&state, &key, &hook).ok().flatten();
    if !secret.is_some_and(|secret| verified(&secret, &headers, &query, &body)) {
        crate::functions::journal(
            &state,
            "webhook",
            &hook,
            false,
            None,
            "refusé : preuve du secret absente ou invalide",
            None,
        );
        return reply(StatusCode::UNAUTHORIZED, json!({ "error": "Non autorisé." }));
    }
    mark_received(&state, &key, &hook);

    let input = input_of(&method, &headers, &query, &body);
    let reference = format!("{module}/{}", declaration.function);
    let summary = format!("reçu → fonction {reference}");
    let started = Instant::now();
    // La fonction tourne dans sa propre tâche : si l’émetteur n’attend plus, elle continue et se journalise seule.
    let task = tokio::spawn({
        let state = state.clone();
        let reference = reference.clone();
        async move {
            let result = crate::functions::call(&state, &reference, input, "webhook").await;
            let duration = Some(started.elapsed().as_millis() as u64);
            match &result {
                Ok(_) => crate::functions::journal(&state, "webhook", &hook, true, duration, &summary, None),
                Err(error) => crate::functions::journal(
                    &state,
                    "webhook",
                    &hook,
                    false,
                    duration,
                    &summary,
                    Some(&json!({ "error": error.message })),
                ),
            }
            result
        }
    });
    match tokio::time::timeout(SYNC_WAIT, task).await {
        Ok(Ok(Ok(output))) => reply(StatusCode::OK, output),
        Ok(Ok(Err(_))) | Ok(Err(_)) => {
            reply(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "La fonction du webhook a échoué." }))
        }
        Err(_) => reply(StatusCode::ACCEPTED, json!({ "accepted": true })),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

fn split_hook(hook: &str) -> AppResult<(&str, &str)> {
    hook.split_once('/')
        .filter(|(module, id)| valid_id(module) && valid_id(id))
        .ok_or_else(|| AppError::new(format!("Webhook désigné par « module/identifiant » attendu : « {hook} ».")))
}

/// Webhook déclaré dans le module, ou erreur.
fn declared(space: &Space, hook: &str) -> AppResult<(ModuleManifest, WebhookDecl)> {
    let (module, id) = split_hook(hook)?;
    let manifest = space.module(module)?;
    let declaration = manifest
        .webhooks
        .iter()
        .find(|declared| declared.id == id)
        .cloned()
        .ok_or_else(|| AppError::new(format!("Le webhook « {hook} » n’est pas déclaré dans son module.")))?;
    Ok((manifest, declaration))
}

fn writable(space: &Space, module: &str) -> AppResult<ModuleManifest> {
    let manifest = space.module(module)?;
    if manifest.read_only() {
        return Err(AppError::new(format!(
            "Le module « {} » est installé depuis un marketplace : le détacher pour modifier ses webhooks.",
            manifest.name
        )));
    }
    Ok(manifest)
}

fn function_exists(space: &Space, manifest: &ModuleManifest, function: &str) -> bool {
    manifest.functions.iter().any(|declared| declared.id == function)
        && space.function_file(&manifest.id, function).is_file()
}

fn hook_url(state: &AppState, hook: &str) -> Option<String> {
    state.server().ok().map(|server| format!("http://127.0.0.1:{}/hooks/{hook}", server.port))
}

fn list(state: &AppState) -> AppResult<Value> {
    let space = state.space()?;
    let key = space_key(&space);
    let mut items = Vec::new();
    for module in space.module_ids() {
        let Ok(manifest) = space.module(&module) else { continue };
        for webhook in &manifest.webhooks {
            let hook = format!("{module}/{}", webhook.id);
            let last = lock_db(state).ok().and_then(|db| last_received(&db, &key, &hook));
            items.push(json!({
                "module": module,
                "id": webhook.id,
                "description": webhook.description,
                "function": webhook.function,
                "url": hook_url(state, &hook),
                "lastReceivedAt": last,
                "functionExists": function_exists(&space, &manifest, &webhook.function),
            }));
        }
    }
    Ok(Value::Array(items))
}

/// Accepte « fonction » ou « module/fonction » du même module : un webhook ne déclenche que son propre module.
fn local_function(module: &str, function: &str) -> AppResult<String> {
    let local = match function.split_once('/') {
        Some((owner, local)) if owner == module => local,
        Some(_) => return Err(AppError::new("Un webhook ne peut déclencher qu’une fonction de son propre module.")),
        None => function,
    };
    if !valid_id(local) {
        return Err(AppError::new(format!("Fonction invalide : « {function} ».")));
    }
    Ok(local.to_string())
}

fn declare(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let module: String = arg(args, "module")?;
    let id: String = arg(args, "id")?;
    if !valid_id(&id) {
        return Err(AppError::new("Identifiant de webhook invalide : minuscules, chiffres et tirets uniquement."));
    }
    let function = local_function(&module, &arg::<String>(args, "function")?)?;
    let description = opt_arg::<String>(args, "description")?.unwrap_or_default();
    let mut manifest = writable(&space, &module)?;
    let declaration = WebhookDecl { id: id.clone(), description, function };
    match manifest.webhooks.iter_mut().find(|declared| declared.id == id) {
        Some(existing) => *existing = declaration,
        None => manifest.webhooks.push(declaration),
    }
    space.write_module(&manifest)?;
    let hook = format!("{module}/{id}");
    crate::git::commit_all(&space.root, &format!("Webhook {hook}"))?;
    state.emit("space:changed", Value::Null);
    Ok(json!({ "hook": hook, "url": hook_url(state, &hook) }))
}

fn remove(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let hook: String = arg(args, "hook")?;
    let (module, id) = split_hook(&hook)?;
    let mut manifest = writable(&space, module)?;
    manifest.webhooks.retain(|declared| declared.id != id);
    space.write_module(&manifest)?;
    // Un webhook recréé plus tard sous le même nom recevra un nouveau secret.
    lock_db(state)?
        .execute("DELETE FROM webhook_secrets WHERE space = ?1 AND hook = ?2", params![space_key(&space), hook])?;
    crate::git::commit_all(&space.root, &format!("Suppression du webhook {hook}"))?;
    state.emit("space:changed", Value::Null);
    Ok(Value::Null)
}

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "webhooks.list" => list(state),
        "webhooks.secret" => (|| {
            let space = state.space()?;
            let hook: String = arg(args, "hook")?;
            declared(&space, &hook)?;
            Ok(json!({ "secret": ensure_secret(state, &space_key(&space), &hook)? }))
        })(),
        "webhooks.rotate" => (|| {
            let space = state.space()?;
            let hook: String = arg(args, "hook")?;
            declared(&space, &hook)?;
            Ok(json!({ "secret": rotate_secret(state, &space_key(&space), &hook)? }))
        })(),
        "webhooks.declare" => declare(state, args),
        "webhooks.remove" => remove(state, args),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::FunctionDecl;
    use crate::state::ServerInfo;

    /// Joue l’interface : chaque `function:call` reçoit l’entrée en écho, sauf deux entrées spéciales qui font
    /// échouer la fonction ou la rendent trop lente.
    fn fake_ui(state: &Arc<AppState>) -> Arc<std::sync::Mutex<Vec<Value>>> {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut events = state.events.subscribe();
        let (state, seen) = (state.clone(), calls.clone());
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                if event.name != "function:call" {
                    continue;
                }
                seen.lock().unwrap().push(event.payload.clone());
                let id = event.payload["requestId"].as_str().unwrap().to_string();
                let body = event.payload["input"]["body"].clone();
                let state = state.clone();
                tokio::spawn(async move {
                    if body == json!("lent") {
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                    }
                    let result =
                        if body == json!("échec") { Err("boum".to_string()) } else { Ok(json!({ "echo": body })) };
                    let _ = state.resolve_ui(&id, result);
                });
            }
        });
        calls
    }

    async fn serve(state: &Arc<AppState>) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = state.server.set(ServerInfo { port });
        let router = routes().with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        port
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn receives_only_proven_calls_and_runs_the_function() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        space
            .write_module(&ModuleManifest {
                id: "ventes".into(),
                name: "Ventes".into(),
                functions: vec![FunctionDecl { id: "encaisser".into(), ..FunctionDecl::default() }],
                ..ModuleManifest::default()
            })
            .unwrap();
        std::fs::create_dir_all(space.function_file("ventes", "encaisser").parent().unwrap()).unwrap();
        std::fs::write(space.function_file("ventes", "encaisser"), "export default () => 1;").unwrap();
        state.set_space(Some(space.clone()));
        let port = serve(&state).await;
        let calls = fake_ui(&state);
        let http = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{port}/hooks/ventes/paiement");

        // Avant la déclaration : inconnu.
        assert_eq!(http.post(&url).send().await.unwrap().status(), 404);

        let declared = handle(
            &state,
            "webhooks.declare",
            &json!({ "module": "ventes", "id": "paiement", "description": "Paiement reçu", "function": "encaisser" }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(declared["url"], json!(url));
        assert_eq!(space.module("ventes").unwrap().webhooks[0].function, "encaisser");
        // Le secret n’est jamais écrit dans l’espace.
        let secret = handle(&state, "webhooks.secret", &json!({ "hook": "ventes/paiement" })).await.unwrap().unwrap()
            ["secret"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(secret.len(), 64);
        let again = handle(&state, "webhooks.secret", &json!({ "hook": "ventes/paiement" })).await.unwrap().unwrap();
        assert_eq!(again["secret"], json!(secret));
        let manifest_text = std::fs::read_to_string(space.module_dir("ventes").join("module.json")).unwrap();
        assert!(!manifest_text.contains(&secret));

        // Sans preuve, ou avec une mauvaise : 401 et la fonction n’est pas appelée.
        assert_eq!(http.post(&url).body("{}").send().await.unwrap().status(), 401);
        assert_eq!(http.post(&url).header("X-Alfred-Secret", "faux").send().await.unwrap().status(), 401);
        assert_eq!(
            http.post(&url).header("X-Hub-Signature-256", "sha256=00").body("x").send().await.unwrap().status(),
            401
        );
        assert!(calls.lock().unwrap().is_empty());

        // Chaque forme de preuve est acceptée.
        let body = r#"{"montant":42}"#;
        let signature = hex(&hmac_sha256(secret.as_bytes(), body.as_bytes()));
        let requests = [
            http.post(&url).header("X-Alfred-Secret", &secret),
            http.post(&url).header("Authorization", format!("Bearer {secret}")),
            http.post(format!("{url}?secret={secret}&source=test")),
            http.post(&url).header("X-Hub-Signature-256", format!("sha256={signature}")),
            http.post(&url).header("X-Alfred-Signature", &signature),
        ];
        for request in requests {
            let response = request
                .header("Content-Type", "application/json")
                .header("Cookie", "session=1")
                .body(body)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.json::<Value>().await.unwrap(), json!({ "echo": { "montant": 42 } }));
        }
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 5);
            assert_eq!(calls[0]["function"], "ventes/encaisser");
            assert_eq!(calls[0]["caller"], "webhook");
            let input = &calls[2]["input"];
            assert_eq!(input["method"], "POST");
            assert_eq!(input["query"], json!({ "source": "test" }));
            let headers = input["headers"].as_object().unwrap();
            assert!(headers.contains_key("content-type"));
            for hidden in HIDDEN_HEADERS {
                assert!(!headers.contains_key(hidden), "{hidden} ne doit pas être transmis");
            }
            assert!(!calls.iter().any(|call| call.to_string().contains(&secret)));
        }

        // GET, corps texte, échec de la fonction, fonction trop lente.
        let response = http.get(format!("{url}?secret={secret}")).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(calls.lock().unwrap().last().unwrap()["input"]["method"], "GET");
        let response = http.post(&url).header("X-Alfred-Secret", &secret).body("échec").send().await.unwrap();
        assert_eq!(response.status(), 500);
        assert!(!response.text().await.unwrap().contains("boum"));
        let response = http.post(&url).header("X-Alfred-Secret", &secret).body("lent").send().await.unwrap();
        assert_eq!(response.status(), 202);
        assert_eq!(response.json::<Value>().await.unwrap(), json!({ "accepted": true }));

        // Corps trop gros.
        let big = vec![b'a'; BODY_LIMIT + 1];
        assert_eq!(http.post(&url).header("X-Alfred-Secret", &secret).body(big).send().await.unwrap().status(), 413);

        // Journal et dernière réception.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let listed = handle(&state, "webhooks.list", &Value::Null).await.unwrap().unwrap();
        assert_eq!(listed[0]["functionExists"], json!(true));
        assert!(listed[0]["lastReceivedAt"].is_string());
        let journal = {
            let db = state.app_db.lock().unwrap();
            crate::app_db::read_journal(&db, &space_key(&space), Some("webhook"), 100).unwrap()
        };
        assert!(journal.iter().any(|entry| entry["summary"] == "reçu → fonction ventes/encaisser"));
        assert!(journal.iter().any(|entry| entry["status"] == "error"));
        assert!(!serde_json::to_string(&journal).unwrap().contains(&secret));

        // Régénérer invalide l’ancien secret.
        let rotated = handle(&state, "webhooks.rotate", &json!({ "hook": "ventes/paiement" })).await.unwrap().unwrap();
        assert_ne!(rotated["secret"], json!(secret));
        assert_eq!(http.post(&url).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 401);

        // Retirer le webhook : 404, et le secret disparaît.
        handle(&state, "webhooks.remove", &json!({ "hook": "ventes/paiement" })).await.unwrap().unwrap();
        assert_eq!(http.post(&url).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 404);
        assert!(read_secret(&state, &space_key(&space), "ventes/paiement").unwrap().is_none());

        // Espace fermé : 404.
        state.set_space(None);
        assert_eq!(http.post(&url).send().await.unwrap().status(), 404);
    }

    #[test]
    fn hmac_matches_the_rfc_4231_vector() {
        let key = [0x0b; 20];
        assert_eq!(
            hex(&hmac_sha256(&key, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // Clé plus longue qu’un bloc (cas 6 de la RFC).
        let long = [0xaa; 131];
        assert_eq!(
            hex(&hmac_sha256(&long, b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[tokio::test]
    async fn refuses_to_declare_in_an_installed_module() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        space
            .write_module(&ModuleManifest {
                id: "crm".into(),
                name: "CRM".into(),
                origin: Some(crate::space::Origin { marketplace: "mp".into(), ..Default::default() }),
                ..ModuleManifest::default()
            })
            .unwrap();
        state.set_space(Some(space));
        let refused = handle(
            &state,
            "webhooks.declare",
            &json!({ "module": "crm", "id": "x", "description": "", "function": "f" }),
        )
        .await
        .unwrap();
        assert!(refused.is_err());
        let cross = handle(
            &state,
            "webhooks.declare",
            &json!({ "module": "crm", "id": "x", "description": "", "function": "autre/f" }),
        )
        .await
        .unwrap();
        assert!(cross.is_err());
    }
}
