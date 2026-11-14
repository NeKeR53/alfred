//! Banc de vérification, compilé seulement avec la fonctionnalité Cargo `verify` (désactivée par défaut, jamais dans
//! une version distribuée). Il laisse observer la vraie fenêtre sans écran ni souris : le serveur local exécute un
//! script dans la webview principale et en renvoie le résultat, ou émet l’événement natif de dépôt de fichiers de
//! Tauri avec des chemins donnés. Chaque appel prouve connaître le jeton du banc, écrit au démarrage avec le port dans
//! `verify.json`, dans le dossier de données d’Alfred.
//!
//! La coquille ne lit pas le document d’un cadre isolé (origine opaque) : un script du banc s’appuie sur ce que le
//! cadre rapporte déjà par le pont, ou sur la route `snapshot`, qui passe par la capture de l’outil `page_snapshot`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, EventTarget, Manager};
use tokio::sync::oneshot;

use crate::state::AppState;

/// Fichier du dossier de données qui donne le port et le jeton du banc.
pub const FILE: &str = "verify.json";
const WINDOW: &str = "main";
const MAX_WAIT: Duration = Duration::from_secs(300);

struct Bench {
    token: String,
    app: OnceLock<tauri::AppHandle>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

fn bench() -> &'static Bench {
    static BENCH: OnceLock<Bench> = OnceLock::new();
    BENCH.get_or_init(|| Bench {
        token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
        app: OnceLock::new(),
        pending: Mutex::new(HashMap::new()),
    })
}

/// Jeton que chaque appel du banc présente (`Authorization: Bearer …`).
pub fn token() -> &'static str {
    &bench().token
}

/// Relie le banc à la fenêtre et écrit `verify.json` (lisible par le seul utilisateur).
pub fn attach(app: &tauri::AppHandle, data_dir: &Path, port: u16) -> std::io::Result<PathBuf> {
    let _ = bench().app.set(app.clone());
    let path = data_dir.join(FILE);
    let content = serde_json::to_vec_pretty(&json!({ "port": port, "token": token() }))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(&path)?, &content)?;
    Ok(path)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/__verify/eval", post(eval))
        .route("/__verify/drop", post(drop_files))
        .route("/__verify/snapshot", post(snapshot))
        .route("/__verify/tool", post(tool))
}

fn authorized(headers: &HeaderMap) -> bool {
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    presented.is_some_and(|presented| crate::webhooks::same(presented.as_bytes(), token().as_bytes()))
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn refused() -> Response {
    reply(StatusCode::UNAUTHORIZED, json!({ "error": "Jeton du banc de vérification absent ou invalide." }))
}

fn window() -> Option<tauri::WebviewWindow> {
    labeled(WINDOW)
}

fn labeled(label: &str) -> Option<tauri::WebviewWindow> {
    bench().app.get().and_then(|app| app.get_webview_window(label))
}

fn no_window() -> Response {
    reply(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "Aucune fenêtre d’Alfred." }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalRequest {
    /// Corps d’une fonction asynchrone : `return` donne le résultat, sérialisé en JSON.
    script: String,
    timeout_ms: Option<u64>,
    /// Étiquette d’une autre fenêtre (une fenêtre de page, `page-…`) ; à défaut, la fenêtre principale.
    window: Option<String>,
}

/// Exécute le script dans la webview principale ; il rend son résultat par la commande `verify_result`.
async fn eval(headers: HeaderMap, Json(request): Json<EvalRequest>) -> Response {
    if !authorized(&headers) {
        return refused();
    }
    let target = match &request.window {
        Some(label) => labeled(label),
        None => window(),
    };
    let Some(window) = target else { return no_window() };
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut pending) = bench().pending.lock() {
        pending.insert(id.clone(), sender);
    }
    let id_literal = Value::String(id.clone()).to_string();
    let code = format!(
        r#"(async () => {{
  const id = {id_literal};
  const send = (result) => window.__TAURI_INTERNALS__.invoke("verify_result", {{ result }});
  let result;
  try {{
    const value = await (async () => {{
{script}
    }})();
    result = {{ id, ok: true, value: value === undefined ? null : value }};
  }} catch (error) {{
    result = {{ id, ok: false, error: String((error && error.stack) || error) }};
  }}
  try {{ await send(result); }} catch (error) {{ await send({{ id, ok: false, error: "Résultat non transmis : " + String(error) }}); }}
}})();"#,
        script = request.script
    );
    if let Err(error) = window.eval(&code) {
        forget(&id);
        return reply(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": format!("Évaluation impossible : {error}") }));
    }
    let wait = request.timeout_ms.map(Duration::from_millis).unwrap_or(Duration::from_secs(30)).min(MAX_WAIT);
    let answer = tokio::time::timeout(wait, receiver).await;
    forget(&id);
    match answer {
        Ok(Ok(result)) => reply(StatusCode::OK, result),
        _ => reply(
            StatusCode::GATEWAY_TIMEOUT,
            json!({ "error": "La webview n’a pas rendu de résultat à temps (script bloqué, ou webview suspendue)." }),
        ),
    }
}

fn forget(id: &str) {
    if let Ok(mut pending) = bench().pending.lock() {
        pending.remove(id);
    }
}

/// Résultat d’un script du banc, rendu par la webview.
#[tauri::command]
pub fn verify_result(result: Value) {
    let Some(id) = result.get("id").and_then(Value::as_str) else { return };
    let sender = bench().pending.lock().ok().and_then(|mut pending| pending.remove(id));
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
}

#[derive(Deserialize)]
struct DropRequest {
    paths: Vec<PathBuf>,
    #[serde(default)]
    position: Option<Position>,
}

#[derive(Deserialize, serde::Serialize, Clone, Copy)]
struct Position {
    x: f64,
    y: f64,
}

/// Émet vers la fenêtre la séquence que Tauri émet pour un vrai dépôt (entrée, survol, dépôt), avec la même cible et
/// la même forme : l’écouteur `onDragDropEvent` de l’interface la reçoit comme un geste de souris.
async fn drop_files(headers: HeaderMap, Json(request): Json<DropRequest>) -> Response {
    if !authorized(&headers) {
        return refused();
    }
    let Some(window) = window() else { return no_window() };
    let position = request.position.unwrap_or(Position { x: 400.0, y: 400.0 });
    let target = EventTarget::labeled(WINDOW);
    let sent = window
        .emit_to(target.clone(), "tauri://drag-enter", json!({ "paths": request.paths, "position": position }))
        .and_then(|_| window.emit_to(target.clone(), "tauri://drag-over", json!({ "position": position })))
        .and_then(|_| window.emit_to(target, "tauri://drag-drop", json!({ "paths": request.paths, "position": position })));
    match sent {
        Ok(()) => reply(StatusCode::OK, json!({ "dropped": request.paths })),
        Err(error) => reply(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": error.to_string() })),
    }
}

/// Description d’une page par son cadre, par le chemin de l’outil `page_snapshot` (affichée, sinon chargée hors de
/// la vue le temps de la capture).
async fn snapshot(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if !authorized(&headers) {
        return refused();
    }
    let Some(page) = request.get("page").and_then(Value::as_str) else {
        return reply(StatusCode::BAD_REQUEST, json!({ "error": "Préciser `page` (module/page)." }));
    };
    match state.ask_ui("agent:pageSnapshot", json!({ "page": page }), Duration::from_secs(20)).await {
        Ok(captured) => reply(StatusCode::OK, captured),
        Err(error) => reply(StatusCode::GATEWAY_TIMEOUT, json!({ "error": error.message })),
    }
}

/// Appelle un outil MCP comme un agent d’une conversation ouverte par l’utilisateur (`page_logs`, `check`…).
async fn tool(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if !authorized(&headers) {
        return refused();
    }
    let Some(name) = request.get("name").and_then(Value::as_str) else {
        return reply(StatusCode::BAD_REQUEST, json!({ "error": "Préciser `name`." }));
    };
    let arguments = request.get("arguments").cloned().unwrap_or_else(|| json!({}));
    match crate::mcp::call_tool(&state, "verify-bench", name, &arguments).await {
        Ok(value) => reply(StatusCode::OK, value),
        Err(error) => reply(StatusCode::OK, json!({ "error": error.message })),
    }
}
