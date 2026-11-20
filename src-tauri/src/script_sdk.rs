//! Pont du SDK pour les fonctions en script (bash, PowerShell, Python). Une page passe par le cadre isolé ; un script
//! est un processus : Alfred lui donne une adresse locale (`ALFRED_SDK_URL`) et un jeton à usage unique
//! (`ALFRED_SDK_TOKEN`), valable le temps de cet appel. Chaque requête `POST <adresse>/<méthode>` (corps JSON) est
//! traitée comme celle d’une fonction TypeScript du même module : mêmes commandes, mêmes champs, même cloisonnement.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::permissions::Subject;
use crate::state::AppState;

type Shared = Arc<AppState>;

/// Méthodes ouvertes aux scripts : la commande qui les traite et les seuls champs transmis (comme le pont des
/// cadres, `src/shell/frameBridge.ts`). Ce qui demande un geste de l’utilisateur (choisir un fichier ou un dossier,
/// l’ouvrir, l’enregistrer ailleurs) n’y est pas.
const METHODS: &[(&str, &str, &[&str])] = &[
    ("db.query", "frame.db.query", &["sql", "params"]),
    ("db.execute", "frame.db.execute", &["sql", "params"]),
    ("files.save", "frame.files.save", &["name", "data", "text", "mime"]),
    ("files.list", "frame.files.list", &["prefix", "limit"]),
    ("files.get", "frame.files.get", &["id"]),
    ("files.read", "frame.files.read", &["id"]),
    ("files.readText", "frame.files.readText", &["id"]),
    ("files.remove", "frame.files.remove", &["id"]),
    ("documents.pdf", "frame.documents.pdf", &["name", "title", "blocks"]),
    ("documents.csv", "frame.documents.csv", &["name", "columns", "rows", "separator"]),
    ("documents.xlsx", "frame.documents.xlsx", &["name", "sheets"]),
    ("documents.extractText", "frame.documents.extractText", &["id"]),
    ("search.query", "frame.search.query", &["index", "text", "limit", "offset", "raw", "prefix"]),
    ("semantic.search", "frame.semantic.search", &["index", "text", "limit"]),
    ("semantic.status", "frame.semantic.status", &["index"]),
    ("ai.decide", "frame.ai.decide", &["text", "question", "type", "choices", "questions", "preset"]),
    ("history.list", "frame.history.list", &["table", "key", "limit"]),
    ("history.revert", "frame.history.revert", &["id"]),
    ("events.publish", "frame.events.publish", &["event", "payload", "occurrence"]),
    ("jobs.start", "frame.jobs.start", &["function", "input", "title"]),
    ("jobs.get", "frame.jobs.get", &["id"]),
    ("jobs.list", "frame.jobs.list", &["status", "limit"]),
    ("jobs.cancel", "frame.jobs.cancel", &["id"]),
    ("jobs.resume", "frame.jobs.resume", &["id"]),
    (
        "clients.request",
        "frame.clients.request",
        &[
            "client", "instance", "method", "path", "query", "headers", "body", "form", "multipart", "file",
            "responseType", "cache", "sealed",
        ],
    ),
    (
        "clients.download",
        "frame.clients.download",
        &["client", "instance", "method", "path", "query", "headers", "body", "form", "multipart", "file", "name"],
    ),
    (
        "clients.stream",
        "frame.clients.stream",
        &["client", "instance", "method", "path", "query", "headers", "body", "form", "multipart", "file", "format"],
    ),
    ("clients.socket", "frame.clients.socket", &["client", "instance", "path", "query", "headers"]),
    ("channels.read", "frame.channels.read", &["channel", "after", "wait"]),
    ("channels.write", "frame.channels.write", &["channel", "text", "data"]),
    ("channels.close", "frame.channels.close", &["channel"]),
    ("clients.instances", "frame.clients.instances", &["client"]),
    ("clients.params", "frame.clients.params", &["client", "instance"]),
    ("folders.list", "frame.folders.list", &[]),
    ("folders.get", "frame.folders.get", &["folder"]),
    ("folders.entries", "frame.folders.entries", &["folder", "path", "recursive", "glob"]),
    ("folders.stat", "frame.folders.stat", &["folder", "path"]),
    ("folders.readText", "frame.folders.readText", &["folder", "path"]),
    ("folders.readFile", "frame.folders.readFile", &["folder", "path"]),
    ("folders.writeText", "frame.folders.writeText", &["folder", "path", "text"]),
    ("folders.writeFile", "frame.folders.writeFile", &["folder", "path", "data"]),
    ("folders.mkdir", "frame.folders.mkdir", &["folder", "path"]),
    ("folders.remove", "frame.folders.remove", &["folder", "path"]),
    ("folders.rename", "frame.folders.rename", &["folder", "path", "to"]),
    ("git.repositories", "frame.git.repositories", &["folder"]),
    ("git.status", "frame.git.status", &["folder", "repo"]),
    ("git.branches", "frame.git.branches", &["folder", "repo"]),
    ("git.tags", "frame.git.tags", &["folder", "repo"]),
    ("git.log", "frame.git.log", &["folder", "repo", "ref", "file", "since", "limit"]),
    ("git.compare", "frame.git.compare", &["folder", "repo", "base", "head"]),
    ("git.diff", "frame.git.diff", &["folder", "repo", "from", "to", "file", "staged"]),
    ("git.show", "frame.git.show", &["folder", "repo", "ref", "file"]),
    ("git.fetch", "frame.git.fetch", &["folder", "repo", "remote"]),
    ("git.pull", "frame.git.pull", &["folder", "repo", "rebase"]),
    ("git.push", "frame.git.push", &["folder", "repo", "remote", "branch", "tag"]),
    ("git.commit", "frame.git.commit", &["folder", "repo", "message", "paths"]),
    ("git.switch", "frame.git.switch", &["folder", "repo", "branch", "create", "start"]),
    ("git.createTag", "frame.git.createTag", &["folder", "repo", "name", "ref", "message"]),
    ("git.clone", "frame.git.clone", &["folder", "url", "path"]),
    ("clients.clearCache", "frame.clients.clearCache", &["client"]),
];

fn tokens() -> &'static Mutex<HashMap<String, Subject>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, Subject>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Jeton d’un appel de script ; il cesse de valoir quand `Grant` est abandonné (fin du script).
pub struct Grant {
    pub token: String,
}

impl Drop for Grant {
    fn drop(&mut self) {
        if let Ok(mut all) = tokens().lock() {
            all.remove(&self.token);
        }
    }
}

/// Ouvre le pont pour un appel de la fonction `module/fonction` ; `examples` : l’appel montre des données d’exemple,
/// et ce que le script demande par le pont aussi (aucune requête vers un service).
pub fn grant(module: &str, function: &str, examples: bool) -> Grant {
    use rand::Rng;
    let token: String = rand::rng().sample_iter(rand::distr::Alphanumeric).take(48).map(char::from).collect();
    let subject = Subject {
        kind: "function".into(),
        module: module.to_string(),
        reference: format!("{module}/{function}"),
        instance: None,
        accounts: Default::default(),
        examples,
    };
    if let Ok(mut all) = tokens().lock() {
        all.insert(token.clone(), subject);
    }
    Grant { token }
}

/// Adresse du pont, à passer au script.
pub fn url(state: &AppState) -> Option<String> {
    state.server().ok().map(|server| format!("http://127.0.0.1:{}/sdk", server.port))
}

fn subject_of(headers: &HeaderMap) -> Option<Subject> {
    let token = headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?.trim();
    tokens().lock().ok()?.get(token).cloned()
}

/// Traite une méthode pour le module du jeton.
pub async fn call(state: &Shared, subject: &Subject, method: &str, params: &Value) -> AppResult<Value> {
    if method == "functions.call" {
        let name = params.get("function").and_then(Value::as_str).unwrap_or_default();
        let reference = if name.contains('/') { name.to_string() } else { format!("{}/{name}", subject.module) };
        crate::dispatch::dispatch(
            state.clone(),
            "frame.functions.authorize",
            json!({ "subject": subject, "function": reference }),
        )
        .await?;
        let input = params.get("input").cloned().unwrap_or(json!({}));
        return crate::functions::call_in(state, &reference, input, &subject.reference, subject.examples).await;
    }
    let Some((_, command, fields)) = METHODS.iter().find(|(name, _, _)| *name == method) else {
        return Err(AppError::new(format!("Méthode inconnue du pont des scripts : « {method} ».")));
    };
    let mut args = Map::new();
    if let Some(object) = params.as_object() {
        for field in fields.iter() {
            if let Some(value) = object.get(*field) {
                args.insert((*field).to_string(), value.clone());
            }
        }
    }
    args.insert("subject".into(), serde_json::to_value(subject)?);
    crate::dispatch::dispatch(state.clone(), command, Value::Object(args)).await
}

async fn serve(State(state): State<Shared>, headers: HeaderMap, Path(method): Path<String>, body: Option<Json<Value>>) -> Response {
    // Ni navigateur ni page web : un script local n’envoie pas d’origine.
    if headers.contains_key(header::ORIGIN) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": { "message": "Pont réservé aux fonctions en script." } }))).into_response();
    }
    let Some(subject) = subject_of(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "message": "Jeton absent ou expiré : le pont ne sert que pendant l’appel du script." } })),
        )
            .into_response();
    };
    let params = body.map(|Json(value)| value).unwrap_or(json!({}));
    match call(&state, &subject, &method, &params).await {
        Ok(value) => Json(json!({ "ok": value })).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/sdk/{method}", post(serve))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// De bout en bout : une fonction bash appelle le pont avec curl, écrit et lit les tables de son module, et ne
    /// peut ni lire celles d’un autre module ni réutiliser son jeton après coup.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_script_reaches_its_module_through_the_bridge() {
        use crate::space::{FunctionDecl, ModuleManifest, Space};
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = state.server.set(crate::state::ServerInfo { port });
        let app = routes().with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        for (id, sql) in [("notes", "CREATE TABLE notes_n (id INTEGER PRIMARY KEY, texte TEXT);"), ("banque", "CREATE TABLE banque_c (id INTEGER);")] {
            let mut manifest = ModuleManifest { id: id.into(), name: id.into(), ..Default::default() };
            manifest.functions.push(FunctionDecl { id: "f".into(), runtime: crate::scripts::Runtime::Bash, ..Default::default() });
            space.write_module(&manifest).unwrap();
            std::fs::create_dir_all(space.module_dir(id).join("migrations")).unwrap();
            std::fs::write(space.module_dir(id).join("migrations/0001.sql"), sql).unwrap();
        }
        crate::space_db::apply_migrations(&space).unwrap();
        let script = r#"api() { curl -s -X POST "$ALFRED_SDK_URL/$1" -H "Authorization: Bearer $ALFRED_SDK_TOKEN" -H 'Content-Type: application/json' -d "$2"; }
api db.execute '{"sql":"INSERT INTO notes_n (texte) VALUES (?)","params":["depuis bash"]}' >/dev/null
lu=$(api db.query '{"sql":"SELECT texte FROM notes_n"}')
interdit=$(api db.query '{"sql":"SELECT * FROM banque_c"}')
echo "$ALFRED_SDK_TOKEN" > jeton.txt
printf '{"lu":%s,"interdit":%s}
' "$lu" "$interdit"
"#;
        std::fs::create_dir_all(space.module_dir("notes").join("functions")).unwrap();
        std::fs::write(space.module_dir("notes").join("functions/f.sh"), script).unwrap();
        state.set_space(Some(space.clone()));

        let output = crate::functions::call(&state, "notes/f", json!({}), "test").await.unwrap();
        assert_eq!(output["lu"], json!({ "ok": [{ "texte": "depuis bash" }] }), "{output}");
        assert!(output["interdit"]["error"]["message"].as_str().unwrap().contains("notes_"), "{output}");

        // Le jeton ne vaut plus une fois le script terminé.
        let token = std::fs::read_to_string(space.module_dir("notes").join("jeton.txt")).unwrap();
        let late = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/sdk/db.query"))
            .bearer_auth(token.trim())
            .json(&json!({ "sql": "SELECT 1" }))
            .send()
            .await
            .unwrap();
        assert_eq!(late.status(), 401);
    }

    #[test]
    fn a_token_lives_only_as_long_as_its_call() {
        let grant = grant("notes", "importer", false);
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, format!("Bearer {}", grant.token).parse().unwrap());
        assert_eq!(subject_of(&headers).unwrap().reference, "notes/importer");
        drop(grant);
        assert!(subject_of(&headers).is_none());
    }
}
