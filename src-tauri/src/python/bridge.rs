//! Pont du SDK Python (`import alfred`). Le code Python d’un module (fonction en `runtime: "python"`, noyau du
//! module) parle au cœur par le serveur local d’Alfred, sur 127.0.0.1 : `POST /sdk/<méthode>`, corps JSON.
//!
//! Sécurité :
//! - chaque processus reçoit son propre jeton (48 caractères aléatoires), lié à un seul module ; il cesse de valoir
//!   quand le processus s’arrête (`Bridge` abandonné) ;
//! - le jeton dit qui appelle : chaque demande passe par les mêmes commandes, champs et contrôles d’accès que le
//!   code TypeScript de ce module (`script_sdk::call`, `Subject` de type `function`), accès accordés compris ;
//! - le SDK envoie aussi le module qu’il croit être (`X-Alfred-Module`) : un jeton pris à un autre module est refusé ;
//! - une demande portant une origine (navigateur, page web) est refusée ;
//! - le jeton passe par l’environnement (`ALFRED_SDK_TOKEN`), jamais par la ligne de commande, et il est effacé de
//!   ce qui part au journal (`script_sdk::redact`).
//!
//! Le paquet `alfred` est embarqué dans le binaire et écrit au premier usage dans le dossier de données d’Alfred ;
//! `PYTHONPATH` le désigne.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::permissions::Subject;
use crate::script_sdk::{self, Grant};
use crate::state::AppState;

/// Fichiers du paquet `alfred`, embarqués dans le binaire.
const PACKAGE: &[(&str, &str)] = &[
    ("alfred/__init__.py", include_str!("../../python/alfred/__init__.py")),
    ("alfred/py.typed", ""),
];

/// Accès d’un processus Python au cœur : ses variables d’environnement, et le jeton qui les rend valables. Garder
/// la valeur tant que le processus tourne ; l’abandonner retire le jeton.
pub struct Bridge {
    /// `ALFRED_MODULE`, `ALFRED_SDK_URL`, `ALFRED_SDK_TOKEN`, `PYTHONPATH` (et `ALFRED_EXAMPLES` en mode exemple).
    pub env: Vec<(String, String)>,
    grant: Grant,
}

impl Bridge {
    /// Le jeton de ce processus (pour l’effacer d’un texte).
    pub fn token(&self) -> &str {
        &self.grant.token
    }
}

/// Variables d’environnement du SDK Python pour un processus du module `module`. `function` : la fonction appelée
/// (`module/fonction`) ; sans elle, le noyau du module (`module/python`). `examples` : l’appel montre des données
/// d’exemple, et ce que le code demande aussi (aucune requête vers un service).
///
/// `PYTHONPATH` ne contient que le paquet `alfred` : pour y ajouter un dossier (environnement du module), le
/// joindre avec le séparateur du système (`:` ou `;`).
///
/// Sans serveur local (tests), `ALFRED_SDK_URL` manque : le SDK le dit à la première demande.
pub fn env(state: &AppState, module: &str, function: Option<&str>, examples: bool) -> AppResult<Bridge> {
    let grant = script_sdk::grant_subject(subject(module, function, examples));
    let mut env = vec![
        ("ALFRED_MODULE".to_string(), module.to_string()),
        ("ALFRED_SDK_TOKEN".to_string(), grant.token.clone()),
        ("PYTHONPATH".to_string(), package_dir(state)?.to_string_lossy().to_string()),
    ];
    if let Some(url) = script_sdk::url(state) {
        env.push(("ALFRED_SDK_URL".to_string(), url));
    }
    if examples {
        env.push(("ALFRED_EXAMPLES".to_string(), "1".to_string()));
    }
    Ok(Bridge { env, grant })
}

fn subject(module: &str, function: Option<&str>, examples: bool) -> Subject {
    Subject {
        kind: "function".into(),
        module: module.to_string(),
        reference: format!("{module}/{}", function.unwrap_or("python")),
        instance: None,
        accounts: Default::default(),
        examples,
    }
}

/// Dossier qui contient le paquet `alfred`, écrit au premier usage (un dossier par contenu : une mise à jour
/// d’Alfred n’écrase pas le paquet d’un processus encore lancé).
pub fn package_dir(state: &AppState) -> AppResult<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    PACKAGE.hash(&mut hasher);
    let dir = state.data_dir.join("python").join(format!("sdk-{:016x}", hasher.finish()));
    for (path, content) in PACKAGE {
        let file = dir.join(path);
        if std::fs::read_to_string(&file).ok().as_deref() == Some(*content) {
            continue;
        }
        let parent = file.parent().ok_or_else(|| AppError::new("Chemin du SDK Python invalide."))?;
        std::fs::create_dir_all(parent)?;
        // Écrit à côté puis renommé : un autre processus ne lit jamais un fichier à moitié écrit.
        let partial = parent.join(format!(".{}.{}", std::process::id(), file.file_name().unwrap_or_default().to_string_lossy()));
        std::fs::write(&partial, content)?;
        std::fs::rename(&partial, &file)?;
    }
    Ok(dir)
}

/// Efface `token` du message et du détail d’une erreur (stderr d’un script), avant le journal.
pub fn redact_error(error: AppError, token: &str) -> AppError {
    if token.is_empty() {
        return error;
    }
    let clean = |text: &str| text.replace(token, "[jeton]");
    let detail = error.detail.map(|detail| serde_json::from_str(&clean(&detail.to_string())).unwrap_or(Value::Null));
    AppError { message: clean(&error.message), detail }
}

const TONES: &[&str] = &["info", "success", "warning", "error"];
const LEVELS: &[&str] = &["info", "warning", "error"];

fn text(params: &Value, field: &str, max: usize) -> Option<String> {
    let value = params.get(field)?.as_str()?.trim();
    (!value.is_empty()).then(|| script_sdk::redact(&value.chars().take(max).collect::<String>()))
}

/// Méthodes propres au code d’un module hors de toute page : `notify` et `log`. Les autres vont à `script_sdk`.
pub fn handle(state: &Arc<AppState>, subject: &Subject, method: &str, params: &Value) -> Option<AppResult<Value>> {
    match method {
        "notify" => Some(notify(state, subject, params)),
        "log" => Some(log(state, subject, params)),
        _ => None,
    }
}

fn notify(state: &AppState, subject: &Subject, params: &Value) -> AppResult<Value> {
    let title = text(params, "title", 200).ok_or_else(|| AppError::new("Une notification a besoin d’un titre (`title`)."))?;
    let tone = params.get("tone").and_then(Value::as_str).unwrap_or("info");
    if !TONES.contains(&tone) {
        return Err(AppError::new("`tone` vaut « info », « success », « warning » ou « error »."));
    }
    // L’interface l’affiche comme une notification de la page (surimpression, cloche, système en arrière-plan).
    state.emit(
        "module:notify",
        json!({ "module": subject.module, "source": subject.reference, "title": title, "description": text(params, "description", 1000), "tone": tone }),
    );
    Ok(Value::Null)
}

fn log(state: &AppState, subject: &Subject, params: &Value) -> AppResult<Value> {
    let message = text(params, "message", 2000).ok_or_else(|| AppError::new("Rien à écrire au journal (`message` vide)."))?;
    let level = params.get("level").and_then(Value::as_str).unwrap_or("info");
    if !LEVELS.contains(&level) {
        return Err(AppError::new("`level` vaut « info », « warning » ou « error »."));
    }
    let data = params.get("data").filter(|data| !data.is_null()).map(|data| script_sdk::redact(&data.to_string()));
    let data = data.and_then(|data| serde_json::from_str::<Value>(&data).ok());
    let detail = json!({ "level": level, "data": data });
    crate::functions::journal(state, "log", &subject.reference, level != "error", None, &message, Some(&detail));
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{FunctionDecl, ModuleManifest, Space};

    /// Un espace avec deux modules à tables propres, le serveur local en route.
    async fn setup() -> (tempfile::TempDir, Arc<AppState>, Space, u16) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = state.server.set(crate::state::ServerInfo { port });
        let app = script_sdk::routes().with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        for (id, sql) in [
            ("notes", "CREATE TABLE notes_n (id INTEGER PRIMARY KEY, texte TEXT);"),
            ("banque", "CREATE TABLE banque_c (id INTEGER);"),
        ] {
            let mut manifest = ModuleManifest { id: id.into(), name: id.into(), ..Default::default() };
            manifest.functions.push(FunctionDecl { id: "f".into(), runtime: crate::scripts::Runtime::Python, ..Default::default() });
            space.write_module(&manifest).unwrap();
            std::fs::create_dir_all(space.module_dir(id).join("migrations")).unwrap();
            std::fs::write(space.module_dir(id).join("migrations/0001.sql"), sql).unwrap();
        }
        crate::space_db::apply_migrations(&space).unwrap();
        state.set_space(Some(space.clone()));
        (dir, state, space, port)
    }

    async fn post(port: u16, method: &str, token: Option<&str>, module: Option<&str>, body: Value) -> (u16, Value) {
        let mut request = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/sdk/{method}")).json(&body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(module) = module {
            request = request.header(script_sdk::MODULE_HEADER, module);
        }
        let response = request.send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap_or(Value::Null))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_bridge_refuses_a_missing_wrong_or_foreign_token() {
        let (_dir, state, _space, port) = setup().await;
        let notes = env(&state, "notes", None, false).unwrap();
        let banque = env(&state, "banque", None, false).unwrap();
        let sql = json!({ "sql": "SELECT 1 AS un" });

        assert_eq!(post(port, "db.query", None, Some("notes"), sql.clone()).await.0, 401, "sans jeton");
        assert_eq!(post(port, "db.query", Some("faux-jeton"), Some("notes"), sql.clone()).await.0, 401, "mauvais jeton");
        // Le jeton du module « banque » utilisé par le code du module « notes ».
        let (status, body) = post(port, "db.query", Some(banque.token()), Some("notes"), sql.clone()).await;
        assert_eq!(status, 403, "{body}");
        assert!(body["error"]["message"].as_str().unwrap().contains("autre module"));
        let (status, body) = post(port, "db.query", Some(notes.token()), Some("notes"), sql.clone()).await;
        assert_eq!((status, body), (200, json!({ "ok": [{ "un": 1 }] })));

        // Une fois le processus arrêté, son jeton ne vaut plus.
        let token = notes.token().to_string();
        drop(notes);
        assert_eq!(post(port, "db.query", Some(&token), Some("notes"), sql).await.0, 401);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_bridge_applies_the_module_access_rules() {
        let (_dir, state, _space, port) = setup().await;
        let notes = env(&state, "notes", None, false).unwrap();
        let token = Some(notes.token());
        let write = json!({ "sql": "INSERT INTO notes_n (texte) VALUES (?)", "params": ["a"] });
        assert_eq!(post(port, "db.execute", token, Some("notes"), write).await.0, 200);
        // Les tables d’un autre module restent fermées, en lecture comme en écriture.
        let (status, body) = post(port, "db.query", token, Some("notes"), json!({ "sql": "SELECT * FROM banque_c" })).await;
        assert_eq!(status, 400, "{body}");
        assert!(body["error"]["message"].as_str().unwrap().contains("notes_"), "{body}");
        let (status, _) = post(port, "db.execute", token, Some("notes"), json!({ "sql": "DELETE FROM banque_c" })).await;
        assert_eq!(status, 400);
        // Un compte non déclaré par le module est refusé ; un secret ne s’affiche pas depuis Python.
        let (status, body) = post(port, "clients.request", token, Some("notes"), json!({ "client": "jira", "path": "/" })).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(post(port, "secrets.reveal", token, Some("notes"), json!({ "ref": "x" })).await.0, 400);
        // Une page web (origine) n’atteint pas le pont.
        let refused = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/sdk/db.query"))
            .bearer_auth(notes.token())
            .header("Origin", "https://exemple.org")
            .json(&json!({ "sql": "SELECT 1" }))
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), 403);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logs_never_carry_the_token() {
        let (_dir, state, space, port) = setup().await;
        let notes = env(&state, "notes", None, false).unwrap();
        let message = format!("jeton {} fuité", notes.token());
        let (status, _) = post(port, "log", Some(notes.token()), Some("notes"), json!({ "message": message, "data": { "t": notes.token() } })).await;
        assert_eq!(status, 200);
        let db = state.app_db.lock().unwrap();
        let entries = crate::app_db::read_journal(&db, &space.root.to_string_lossy(), Some("log"), 10).unwrap();
        let text = serde_json::to_string(&entries).unwrap();
        assert!(text.contains("[jeton]") && !text.contains(notes.token()), "{text}");
        assert!(text.contains("notes/python"), "{text}");
    }

    #[test]
    fn the_package_lands_on_disk_once() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let first = package_dir(&state).unwrap();
        assert!(first.join("alfred/__init__.py").is_file());
        assert_eq!(package_dir(&state).unwrap(), first);
    }

    fn python() -> Option<crate::scripts::Interpreter> {
        let found = crate::scripts::interpreter(crate::scripts::Runtime::Python);
        if found.is_none() {
            eprintln!("Python absent : test sauté.");
        }
        found
    }

    /// Les tests du paquet (`src-tauri/python/tests`), contre un faux pont : formes des appels et erreurs.
    #[test]
    fn the_python_package_passes_its_own_tests() {
        let Some(python) = python() else { return };
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("python");
        let output = std::process::Command::new(&python.program)
            .args(&python.args)
            .args(["-m", "unittest", "discover", "-s", "tests"])
            .current_dir(&root)
            .env("PYTHONPATH", &root)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .output()
            .unwrap();
        let report = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{report}");
        assert!(report.contains("OK"), "{report}");
    }

    /// De bout en bout : une fonction Python du module écrit et lit sa base, publie dans un canal, écrit au journal,
    /// et ne lit pas les tables d’un autre module.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_python_function_uses_import_alfred() {
        if python().is_none() {
            return;
        }
        let (_dir, state, space, _port) = setup().await;
        let script = r#"import json, sys
import alfred
entree = json.load(sys.stdin)
alfred.db.execute("INSERT INTO notes_n (texte) VALUES (?)", [entree["texte"]])
lu = alfred.db.query("SELECT texte FROM notes_n")
try:
    alfred.db.query("SELECT * FROM banque_c")
    interdit = None
except alfred.AlfredError as error:
    interdit = error.message
canal = alfred.channels.open("import")
canal.publish({"fait": 1, "total": 1})
alfred.log.info("import fini", lignes=len(lu))
print(json.dumps({"lu": lu, "interdit": interdit, "canal": canal.id, "module": alfred.module}))
"#;
        std::fs::create_dir_all(space.module_dir("notes").join("functions")).unwrap();
        std::fs::write(space.module_dir("notes").join("functions/f.py"), script).unwrap();
        let output = crate::functions::call(&state, "notes/f", json!({ "texte": "depuis Python" }), "test").await.unwrap();
        assert_eq!(output["lu"], json!([{ "texte": "depuis Python" }]), "{output}");
        assert!(output["interdit"].as_str().unwrap().contains("notes_"), "{output}");
        assert_eq!(output["canal"], "notes:import");
        assert_eq!(output["module"], "notes");
        let page = Subject { kind: "page".into(), module: "notes".into(), reference: "notes/liste".into(), instance: None, accounts: Default::default(), examples: false };
        let read = crate::channels::read(&space.root.to_string_lossy(), &page, None, "notes:import", 0, 0).await.unwrap();
        assert_eq!(read["events"][0]["data"], json!(r#"{"fait":1,"total":1}"#), "{read}");
        let db = state.app_db.lock().unwrap();
        let logs = crate::app_db::read_journal(&db, &space.root.to_string_lossy(), Some("log"), 10).unwrap();
        assert_eq!(logs[0]["subject"], "notes/f", "{logs:?}");
    }

    /// Le noyau d’un module (processus Python durable) reçoit ses variables par `env` : un objet Python s’en sert.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_long_lived_python_process_reaches_its_module() {
        let Some(python) = python() else { return };
        let (_dir, state, _space, _port) = setup().await;
        let bridge = env(&state, "notes", None, false).unwrap();
        let code = r#"import alfred
class Carnet:
    def ajouter(self, texte):
        alfred.db.execute("INSERT INTO notes_n (texte) VALUES (?)", [texte])
        return alfred.db.query("SELECT count(*) AS n FROM notes_n")[0]["n"]
print(Carnet().ajouter("noyau"))
"#;
        let mut command = tokio::process::Command::new(&python.program);
        command.args(&python.args).args(["-c", code]).env_clear().envs(crate::scripts::base_env()).envs(bridge.env.iter().cloned());
        let output = command.output().await.unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "1");
    }
}
