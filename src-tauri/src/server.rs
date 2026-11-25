//! Serveur HTTP local, lié à 127.0.0.1 : outils des agents (MCP), webhooks, retour des connexions SSO et, en
//! développement seulement, pont qui laisse un navigateur de test piloter le vrai backend.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::state::{AppState, ServerInfo, DEV_PORT, RELEASE_PORT};

type Shared = Arc<AppState>;

pub async fn start(state: Shared) -> AppResult<()> {
    let wanted = if cfg!(debug_assertions) { DEV_PORT } else { RELEASE_PORT };
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", wanted)).await {
        Ok(listener) => listener,
        // Une autre instance (ou un autre programme) tient déjà le port : on en prend un libre.
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let port = listener.local_addr()?.port();
    let _ = state.server.set(ServerInfo { port });

    let router = router(state, cfg!(debug_assertions));
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            log::error!("serveur local arrêté : {error}");
        }
    });
    Ok(())
}

fn router(state: Shared, dev: bool) -> Router {
    let mut router = Router::new().route("/health", get(|| async { "ok" }));
    if dev {
        router = router
            .route("/__dev/invoke", post(dev_invoke).options(preflight))
            .route("/__dev/events", get(dev_events))
            .route("/__page/{*path}", get(dev_page));
    }
    #[cfg(feature = "verify")]
    {
        router = router.merge(crate::verify::routes());
    }
    router
        .merge(crate::clients::routes())
        .merge(crate::webhooks::routes())
        .merge(crate::automations::routes())
        .merge(crate::script_sdk::routes())
        .with_state(state)
}

/// Seule la coquille de développement (Vite) pilote le pont : toute autre page web ouverte sur le poste en est
/// écartée par son origine, et un nom d’hôte autre que l’adresse locale (rebinding DNS) est refusé.
const SHELL_ORIGINS: [&str; 2] = ["http://localhost:14730", "http://127.0.0.1:14730"];

#[derive(Clone, Copy, PartialEq)]
enum Caller {
    /// La coquille elle-même : commandes et événements.
    Shell,
    /// Un cadre isolé de la coquille (origine opaque, « null ») ou sa navigation (sans origine).
    Frame,
}

fn local_host(state: &AppState, headers: &HeaderMap) -> bool {
    let port = state.server().map(|server| server.port).unwrap_or(DEV_PORT);
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"))
}

/// Origine admise pour cet appel, à renvoyer dans `Access-Control-Allow-Origin` ; `None` si l’appel est refusé.
fn admitted(state: &AppState, headers: &HeaderMap, caller: Caller) -> Option<HeaderValue> {
    if !local_host(state, headers) {
        return None;
    }
    match headers.get(header::ORIGIN).and_then(|value| value.to_str().ok()) {
        Some(origin) if SHELL_ORIGINS.contains(&origin) => HeaderValue::from_str(origin).ok(),
        Some("null") if caller == Caller::Frame => Some(HeaderValue::from_static("null")),
        None if caller == Caller::Frame => Some(HeaderValue::from_static("*")),
        _ => None,
    }
}

fn refused() -> Response {
    (StatusCode::FORBIDDEN, "Pont de développement réservé à la coquille d’Alfred.").into_response()
}

fn cors(headers: &mut HeaderMap, origin: HeaderValue) {
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("content-type"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
}

async fn preflight(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let Some(origin) = admitted(&state, &headers, Caller::Shell) else { return refused() };
    let mut response = StatusCode::NO_CONTENT.into_response();
    cors(response.headers_mut(), origin);
    response
}

async fn dev_invoke(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let Some(origin) = admitted(&state, &headers, Caller::Shell) else { return refused() };
    let command = body.get("command").and_then(Value::as_str).unwrap_or_default().to_string();
    let args = body.get("args").cloned().unwrap_or(Value::Null);
    let result = crate::dispatch::dispatch(state, &command, args).await;
    let mut response = match result {
        Ok(value) => Json(json!({ "ok": value })).into_response(),
        Err(error) => Json(json!({ "error": error })).into_response(),
    };
    cors(response.headers_mut(), origin);
    response
}

async fn dev_events(State(state): State<Shared>, headers: HeaderMap) -> Response {
    use futures_util::StreamExt;
    let Some(origin) = admitted(&state, &headers, Caller::Shell) else { return refused() };
    let stream = tokio_stream::wrappers::BroadcastStream::new(state.events.subscribe()).filter_map(|event| async {
        let event = event.ok()?;
        let data = serde_json::to_string(&event).ok()?;
        Some(Ok::<_, std::convert::Infallible>(format!("data: {data}\n\n")))
    });
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    cors(headers, origin);
    response
}

pub fn page_response(page: crate::pages::PageResponse) -> Response {
    let mut response = Response::new(Body::from(page.body));
    *response.status_mut() = StatusCode::from_u16(page.status).unwrap_or(StatusCode::OK);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(page.content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Le cadre isolé a une origine opaque : ses modules se chargent en mode CORS.
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    if let Some(csp) = page.csp.and_then(|csp| HeaderValue::from_str(&csp).ok()) {
        headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    response
}

async fn dev_page(State(state): State<Shared>, headers: HeaderMap, Path(path): Path<String>) -> Response {
    if admitted(&state, &headers, Caller::Frame).is_none() {
        return refused();
    }
    let port = state.server().map(|server| server.port).unwrap_or(DEV_PORT);
    let origin = format!("http://127.0.0.1:{port}");
    page_response(crate::pages::respond(&state, &format!("/{path}"), "/__page", &origin))
}

impl From<AppError> for Response {
    fn from(error: AppError) -> Self {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ServerInfo;

    async fn serve() -> (Shared, u16, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = state.server.set(ServerInfo { port });
        let app = router(state.clone(), true);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (state, port, dir)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_the_development_shell_drives_the_bridge() {
        let (_state, port, _dir) = serve().await;
        let http = reqwest::Client::new();
        let invoke = |origin: Option<&'static str>, host: Option<String>| {
            let mut request = http
                .post(format!("http://127.0.0.1:{port}/__dev/invoke"))
                .json(&json!({ "command": "settings.get", "args": { "key": "x" } }));
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            if let Some(host) = host {
                request = request.header("host", host);
            }
            request.send()
        };

        let shell = invoke(Some("http://localhost:14730"), None).await.unwrap();
        assert_eq!(shell.status(), 200);
        assert_eq!(shell.headers()["access-control-allow-origin"], "http://localhost:14730");

        // Une page web quelconque, un appel sans origine, un nom d’hôte rebindé : refusés.
        assert_eq!(invoke(Some("https://attaquant.example"), None).await.unwrap().status(), 403);
        assert_eq!(invoke(Some("null"), None).await.unwrap().status(), 403);
        assert_eq!(invoke(None, None).await.unwrap().status(), 403);
        let rebound = invoke(Some("http://localhost:14730"), Some(format!("attaquant.example:{port}"))).await.unwrap();
        assert_eq!(rebound.status(), 403);

        let preflight = http
            .request(reqwest::Method::OPTIONS, format!("http://127.0.0.1:{port}/__dev/invoke"))
            .header("origin", "https://attaquant.example")
            .send()
            .await
            .unwrap();
        assert!(preflight.headers().get("access-control-allow-origin").is_none());

        let get = |path: &'static str, origin: &'static str| {
            http.get(format!("http://127.0.0.1:{port}{path}")).header("origin", origin).send()
        };
        assert_eq!(get("/__dev/events", "https://attaquant.example").await.unwrap().status(), 403);
        assert_eq!(get("/__page/host/page", "https://attaquant.example").await.unwrap().status(), 403);
        // Le cadre isolé de la coquille (origine opaque) charge toujours ses scripts.
        assert_eq!(get("/__page/host/page", "null").await.unwrap().status(), 200);
    }

    async fn bench_call(port: u16, path: &str, token: Option<&str>) -> reqwest::StatusCode {
        let mut request = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}{path}"))
            .json(&json!({ "script": "return 1;", "paths": [], "page": "a/b" }));
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        request.send().await.unwrap().status()
    }

    const BENCH_ROUTES: [&str; 3] = ["/__verify/eval", "/__verify/drop", "/__verify/snapshot"];

    /// Sans la fonctionnalité `verify`, le serveur n’a aucune route du banc, même avec un jeton.
    #[cfg(not(feature = "verify"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn normal_builds_have_no_verification_bench() {
        let (_state, port, _dir) = serve().await;
        for path in BENCH_ROUTES {
            assert_eq!(bench_call(port, path, None).await, 404, "{path}");
            assert_eq!(bench_call(port, path, Some("x")).await, 404, "{path}");
        }
    }

    /// Avec `verify`, chaque route du banc exige son jeton ; sans fenêtre (ici), un appel prouvé reçoit 503.
    #[cfg(feature = "verify")]
    #[tokio::test(flavor = "multi_thread")]
    async fn the_verification_bench_requires_its_token() {
        let (_state, port, _dir) = serve().await;
        for path in BENCH_ROUTES {
            assert_eq!(bench_call(port, path, None).await, 401, "{path}");
            assert_eq!(bench_call(port, path, Some("faux")).await, 401, "{path}");
        }
        let token = crate::verify::token();
        assert_eq!(bench_call(port, "/__verify/eval", Some(token)).await, 503);
        assert_eq!(bench_call(port, "/__verify/drop", Some(token)).await, 503);
    }
}
