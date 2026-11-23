//! Outils communs des parcours d’intégration : un poste Alfred complet sans fenêtre (données, espace, serveur local),
//! une interface simulée qui répond aux demandes du backend comme le ferait la coquille, un trousseau en mémoire et
//! un petit service distant.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use alfred_lib::testing::{self, AppEvent, AppState};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------------------------------
// Trousseau en mémoire
// ---------------------------------------------------------------------------------------------------------------
//
// Le coffre ne choisit son trousseau en mémoire que sous `cfg!(test)`, qui ne vaut pas pour la bibliothèque compilée
// au profit de `tests/`. Sans ceci, ces parcours écriraient dans le trousseau du poste. Le trousseau par défaut de
// la bibliothèque `keyring` est donc remplacé, pour tout le processus, avant le premier poste.

type Secrets = Arc<Mutex<HashMap<String, Vec<u8>>>>;

struct MemoryCredential {
    key: String,
    secrets: Secrets,
}

impl keyring::credential::CredentialApi for MemoryCredential {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        self.secrets.lock().unwrap().insert(self.key.clone(), secret.to_vec());
        Ok(())
    }

    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        self.secrets.lock().unwrap().get(&self.key).cloned().ok_or(keyring::Error::NoEntry)
    }

    fn delete_credential(&self) -> keyring::Result<()> {
        self.secrets.lock().unwrap().remove(&self.key).map(|_| ()).ok_or(keyring::Error::NoEntry)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

struct MemoryBuilder(Secrets);

impl keyring::credential::CredentialBuilderApi for MemoryBuilder {
    fn build(
        &self,
        _target: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<keyring::credential::Credential>> {
        Ok(Box::new(MemoryCredential { key: format!("{service}/{user}"), secrets: self.0.clone() }))
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Trousseau en mémoire du processus, installé au premier appel.
pub fn memory_keyring() -> &'static Secrets {
    static SECRETS: OnceLock<Secrets> = OnceLock::new();
    SECRETS.get_or_init(|| {
        let secrets = Secrets::default();
        keyring::set_default_credential_builder(Box::new(MemoryBuilder(secrets.clone())));
        secrets
    })
}

/// Le trousseau étant commun au processus, chaque parcours prend des identifiants d’entrées à lui.
pub fn unique(name: &str) -> String {
    format!("{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

// ---------------------------------------------------------------------------------------------------------------
// Interface simulée
// ---------------------------------------------------------------------------------------------------------------

pub type Output = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type Handler = Arc<dyn Fn(Frame, Value) -> Output + Send + Sync>;

/// Ce que la coquille sait d’un cadre : son identité, fixée par elle, jamais par le cadre.
#[derive(Clone)]
pub struct Frame {
    pub state: Arc<AppState>,
    pub ui: Arc<Ui>,
    pub subject: Value,
}

impl Frame {
    pub fn page(desk: &Desk, reference: &str) -> Self {
        let module = reference.split('/').next().unwrap();
        Self {
            state: desk.state.clone(),
            ui: desk.ui.clone(),
            subject: json!({ "kind": "page", "module": module, "reference": reference }),
        }
    }

    /// Les fonctions d’un module : seules à joindre ses clients.
    pub fn functions(desk: &Desk, module: &str) -> Self {
        Self::functions_of(&desk.state, &desk.ui, module)
    }

    fn functions_of(state: &Arc<AppState>, ui: &Arc<Ui>, module: &str) -> Self {
        Self {
            state: state.clone(),
            ui: ui.clone(),
            subject: json!({ "kind": "function", "module": module, "reference": format!("{module}/*") }),
        }
    }

    pub fn module(&self) -> String {
        self.subject["module"].as_str().unwrap().to_string()
    }

    async fn invoke(&self, command: &str, mut args: Value) -> Result<Value, String> {
        args["subject"] = self.subject.clone();
        testing::dispatch(self.state.clone(), command, args).await.map_err(|error| error.message)
    }

    /// `db.query` du SDK.
    pub async fn query(&self, sql: &str, params: Value) -> Result<Value, String> {
        self.invoke("frame.db.query", json!({ "sql": sql, "params": params })).await
    }

    /// `db.execute` du SDK.
    pub async fn execute(&self, sql: &str, params: Value) -> Result<Value, String> {
        self.invoke("frame.db.execute", json!({ "sql": sql, "params": params })).await
    }

    /// `clients.request` du SDK.
    pub async fn request(&self, client: &str, call: Value) -> Result<Value, String> {
        let mut args = call;
        args["client"] = json!(client);
        self.invoke("frame.clients.request", args).await
    }

    /// `functions.call` du SDK : accord pour une fonction d’un autre module, puis exécution par la coquille.
    pub async fn call(&self, function: &str, input: Value) -> Result<Value, String> {
        let reference = if function.contains('/') { function.to_string() } else { format!("{}/{function}", self.module()) };
        self.invoke("frame.functions.authorize", json!({ "function": reference })).await?;
        let caller = self.subject["reference"].as_str().unwrap().to_string();
        self.ui.call_function(&self.state, &reference, input, &caller).await
    }
}

/// Une demande d’accord telle que la boîte de dialogue la montre.
#[derive(Debug, Clone)]
pub struct Asked {
    pub subject: String,
    pub resource: String,
    pub label: String,
}

/// L’interface absente : elle exécute les fonctions (comme les cadres invisibles), répond aux demandes d’accord et
/// aux cartes de l’agent selon ce que le parcours a prévu, et garde la trace de tout ce qu’elle a vu.
#[derive(Default)]
pub struct Ui {
    functions: Mutex<HashMap<String, Handler>>,
    /// Réponses de l’utilisateur aux prochaines demandes d’accord, dans l’ordre ; vide → refus.
    permission_answers: Mutex<VecDeque<bool>>,
    pub asked: Mutex<Vec<Asked>>,
    /// Réponses aux prochaines cartes de l’agent (placement d’une page).
    question_answers: Mutex<VecDeque<Value>>,
    pub questions: Mutex<Vec<Value>>,
    /// Erreurs d’exécution que rapportent les pages affichées.
    pub frame_errors: Mutex<Vec<Value>>,
    pub events: Mutex<Vec<AppEvent>>,
}

impl Ui {
    /// Fournit le code d’une fonction de l’espace, comme le fichier que le cadre invisible chargerait.
    pub fn define<F, Fut>(&self, reference: &str, body: F)
    where
        F: Fn(Frame, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        let handler: Handler = Arc::new(move |frame, input| Box::pin(body(frame, input)));
        self.functions.lock().unwrap().insert(reference.to_string(), handler);
    }

    pub fn answer_permissions(&self, answers: &[bool]) {
        self.permission_answers.lock().unwrap().extend(answers.iter().copied());
    }

    #[allow(dead_code)]
    pub fn answer_question(&self, answer: Value) {
        self.question_answers.lock().unwrap().push_back(answer);
    }

    pub fn asked_resources(&self) -> Vec<String> {
        self.asked.lock().unwrap().iter().map(|asked| format!("{} → {}", asked.subject, asked.resource)).collect()
    }

    pub fn event_names(&self) -> Vec<String> {
        self.events.lock().unwrap().iter().map(|event| event.name.clone()).collect()
    }

    /// `callFunction` de la coquille : exécute la fonction dans le cadre de son module et l’inscrit au journal.
    pub async fn call_function(
        self: &Arc<Self>,
        state: &Arc<AppState>,
        reference: &str,
        input: Value,
        caller: &str,
    ) -> Result<Value, String> {
        let handler = self.functions.lock().unwrap().get(reference).cloned();
        let module = reference.split('/').next().unwrap_or_default();
        let started = Instant::now();
        let result = match handler {
            Some(handler) => handler(Frame::functions_of(state, self, module), input).await,
            None => Err(format!("La fonction « {reference} » n’existe pas.")),
        };
        let (ok, summary, detail) = match &result {
            Ok(_) => (true, format!("Appelée par {caller}"), json!({ "caller": caller })),
            Err(error) => {
                (false, format!("Échec (appelée par {caller}) : {error}"), json!({ "caller": caller, "error": error }))
            }
        };
        let _ = testing::dispatch(
            state.clone(),
            "journal.record",
            json!({
                "kind": "function", "subject": reference, "ok": ok, "summary": summary, "detail": detail,
                "durationMs": started.elapsed().as_millis() as u64,
            }),
        )
        .await;
        result
    }

    fn start(self: &Arc<Self>, state: &Arc<AppState>) {
        let mut events = state.events.subscribe();
        let (ui, weak) = (self.clone(), Arc::downgrade(state));
        tokio::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                let Some(state) = weak.upgrade() else { break };
                ui.events.lock().unwrap().push(event.clone());
                let ui = ui.clone();
                // Chaque demande a sa tâche : une fonction qui demande un accord ne bloque pas la réception.
                tokio::spawn(async move { ui.react(&state, event).await });
            }
        });
    }

    async fn react(self: Arc<Self>, state: &Arc<AppState>, event: AppEvent) {
        let Some(id) = event.payload.get("requestId").and_then(Value::as_str).map(str::to_string) else { return };
        let answer = match event.name.as_str() {
            "function:call" => {
                let claimed = testing::dispatch(state.clone(), "ui.claim", json!({ "requestId": id })).await;
                if claimed.ok() != Some(Value::Bool(true)) {
                    return;
                }
                let reference = event.payload["function"].as_str().unwrap_or_default().to_string();
                let caller = event.payload["caller"].as_str().unwrap_or_default().to_string();
                self.call_function(state, &reference, event.payload["input"].clone(), &caller).await
            }
            "permission:ask" => {
                let payload = &event.payload;
                self.asked.lock().unwrap().push(Asked {
                    subject: payload["subject"]["reference"].as_str().unwrap_or_default().to_string(),
                    resource: payload["resource"].as_str().unwrap_or_default().to_string(),
                    label: payload["label"].as_str().unwrap_or_default().to_string(),
                });
                let granted = self.permission_answers.lock().unwrap().pop_front().unwrap_or(false);
                Ok(json!({ "granted": granted }))
            }
            "agent:question" => {
                self.questions.lock().unwrap().push(event.payload.clone());
                match self.question_answers.lock().unwrap().pop_front() {
                    Some(answer) => Ok(answer),
                    None => Err("Carte fermée par l’utilisateur.".to_string()),
                }
            }
            "agent:frameErrors" => Ok(Value::Array(self.frame_errors.lock().unwrap().clone())),
            _ => return,
        };
        let args = match answer {
            Ok(result) => json!({ "requestId": id, "result": result }),
            Err(error) => json!({ "requestId": id, "error": error }),
        };
        let _ = testing::dispatch(state.clone(), "ui.resolve", args).await;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Poste
// ---------------------------------------------------------------------------------------------------------------

/// Un poste Alfred : ses données, son espace ouvert, son serveur local et son interface simulée.
pub struct Desk {
    pub state: Arc<AppState>,
    pub ui: Arc<Ui>,
    pub port: u16,
    pub space: PathBuf,
    _dir: Option<tempfile::TempDir>,
}

impl Desk {
    pub async fn open(name: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut desk = Self::open_in(dir.path(), name).await;
        desk._dir = Some(dir);
        desk
    }

    /// Un poste de plus dans un dossier commun (deux postes qui partagent un marketplace).
    pub async fn open_in(root: &Path, name: &str) -> Self {
        memory_keyring();
        let state = AppState::new(&root.join(format!("{name}-donnees"))).unwrap();
        let port = testing::start_server(&state).await;
        testing::start_core_events(&state);
        let ui = Arc::new(Ui::default());
        ui.start(&state);
        let space = root.join(format!("{name}-espace"));
        let desk = Self { state, ui, port, space: space.clone(), _dir: None };
        desk.invoke("space.open", json!({ "path": space.to_string_lossy(), "name": name })).await;
        desk
    }

    pub async fn try_invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        testing::dispatch(self.state.clone(), command, args).await.map_err(|error| error.message)
    }

    pub async fn invoke(&self, command: &str, args: Value) -> Value {
        self.try_invoke(command, args.clone())
            .await
            .unwrap_or_else(|error| panic!("{command} {args} a échoué : {error}"))
    }

    pub async fn refused(&self, command: &str, args: Value) -> String {
        match self.try_invoke(command, args.clone()).await {
            Ok(value) => panic!("{command} {args} aurait dû échouer, a renvoyé {value}"),
            Err(error) => error,
        }
    }

    pub async fn snapshot(&self) -> Value {
        self.invoke("space.snapshot", json!({})).await
    }

    pub fn write(&self, relative: &str, content: &str) {
        let path = self.space.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    pub fn read(&self, relative: &str) -> Option<String> {
        std::fs::read_to_string(self.space.join(relative)).ok()
    }

    /// Messages des commits de l’espace, du plus récent au plus ancien.
    pub async fn history(&self) -> Vec<String> {
        let log = self.invoke("space.history", json!({ "limit": 100 })).await;
        log.as_array().unwrap().iter().map(|commit| commit["message"].as_str().unwrap().to_string()).collect()
    }

    pub async fn last_commit(&self) -> String {
        let log = self.invoke("space.history", json!({ "limit": 1 })).await;
        log[0]["id"].as_str().unwrap().to_string()
    }

    /// Lignes du journal d’un type, de la plus récente à la plus ancienne.
    pub async fn journal(&self, kind: &str) -> Vec<Value> {
        self.invoke("journal.list", json!({ "kind": kind })).await.as_array().unwrap().clone()
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

/// Attend qu’une condition devienne vraie (événements traités dans d’autres tâches).
pub async fn eventually<F, Fut>(what: &str, mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition().await {
        assert!(Instant::now() < deadline, "délai dépassé : {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Section du menu d’un instantané, par identifiant.
pub fn section<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|section| section["id"] == json!(id))
        .unwrap_or_else(|| panic!("section {id} absente de {}", snapshot["sections"]))
}

pub fn references(pages: &Value) -> Vec<String> {
    pages.as_array().unwrap().iter().map(|page| page["reference"].as_str().unwrap().to_string()).collect()
}

/// Lance `git` dans un dossier (dépôt du marketplace, vérifications de l’historique).
pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git").args(args).current_dir(dir).output().expect("git lancé");
    assert!(output.status.success(), "git {args:?} : {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Vérifie qu’aucun secret ne figure dans un texte renvoyé ou persisté.
pub fn assert_no_leak(what: &str, text: &str, secrets: &[&str]) {
    for secret in secrets {
        assert!(!text.contains(secret), "{what} : le secret « {secret} » a fui dans {text}");
    }
}

pub const PAGE: &str = "import { Page, PageSection } from \"socle-ui\";\n\nexport default function Vue() {\n  return <Page><PageSection title=\"Vue\" /></Page>;\n}\n";

// ---------------------------------------------------------------------------------------------------------------
// Service distant
// ---------------------------------------------------------------------------------------------------------------

pub const REMOTE_CLIENT_ID: &str = "alfred-app";
pub const REMOTE_CLIENT_SECRET: &str = "cl13nt-s3cr3t-ZZZ";

/// Requête reçue par le service distant.
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
    pub seen: Mutex<Vec<Seen>>,
    /// Formulaires reçus par le serveur de jetons.
    pub token_requests: Mutex<Vec<HashMap<String, String>>>,
    /// Codes d’autorisation délivrés par la page de connexion du fournisseur.
    pub codes: Mutex<Vec<String>>,
    pub tokens: Mutex<Vec<String>>,
}

/// Un service web local qui renvoie chaque requête en écho, avec un serveur de jetons OAuth.
pub struct Remote {
    pub origin: String,
    pub state: Arc<RemoteState>,
}

impl Remote {
    pub async fn start() -> Self {
        use axum::routing::{any, get, post};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(RemoteState::default());
        let router = axum::Router::new()
            .route("/api/echo", any(remote_echo))
            .route("/api/echo/{*rest}", any(remote_echo))
            .route("/api/protege", get(remote_protected))
            .route("/token", post(remote_token))
            .with_state(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Self { origin: format!("http://127.0.0.1:{port}"), state }
    }

    pub fn last(&self) -> Seen {
        self.state.seen.lock().unwrap().last().cloned().expect("aucune requête reçue par le service")
    }

    pub fn requests(&self) -> usize {
        self.state.seen.lock().unwrap().len()
    }

    /// Le fournisseur reconnaît l’utilisateur et délivre un code d’autorisation.
    pub fn issue_code(&self) -> String {
        let code = unique("code");
        self.state.codes.lock().unwrap().push(code.clone());
        code
    }
}

type RemoteShared = axum::extract::State<Arc<RemoteState>>;

fn remote_record(remote: &RemoteState, method: &axum::http::Method, uri: &axum::http::Uri, headers: &axum::http::HeaderMap, body: &str) -> Seen {
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

async fn remote_echo(
    axum::extract::State(remote): RemoteShared,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::Json<Value> {
    let seen = remote_record(&remote, &method, &uri, &headers, &body);
    axum::Json(json!({ "path": seen.path, "query": seen.query, "headers": seen.headers, "body": seen.body }))
}

async fn remote_protected(
    axum::extract::State(remote): RemoteShared,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let seen = remote_record(&remote, &method, &uri, &headers, "");
    let token = seen.headers.get("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default();
    if remote.tokens.lock().unwrap().iter().any(|issued| issued == token) {
        axum::Json(json!({ "utilisateur": "lea" })).into_response()
    } else {
        (axum::http::StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": "invalid_token" }))).into_response()
    }
}

async fn remote_token(
    axum::extract::State(remote): RemoteShared,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use base64::Engine;
    let mut form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
    // L’application peut s’authentifier par l’en-tête Basic plutôt que dans le formulaire.
    if let Some(pair) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok()?.strip_prefix("Basic ").map(str::to_string))
        .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
    {
        if let Some((id, secret)) = pair.split_once(':') {
            let decode = |text: &str| url::form_urlencoded::parse(format!("v={text}").as_bytes()).next().unwrap().1.into_owned();
            form.insert("client_id".into(), decode(id));
            form.insert("client_secret".into(), decode(secret));
        }
    }
    remote.token_requests.lock().unwrap().push(form.clone());
    let field = |name: &str| form.get(name).cloned().unwrap_or_default();
    let accepted = field("client_id") == REMOTE_CLIENT_ID
        && match field("grant_type").as_str() {
            "client_credentials" => field("client_secret") == REMOTE_CLIENT_SECRET,
            "authorization_code" => {
                let mut codes = remote.codes.lock().unwrap();
                let known = codes.iter().position(|code| *code == field("code"));
                known.map(|index| codes.remove(index)).is_some() && !field("code_verifier").is_empty()
            }
            _ => false,
        };
    if !accepted {
        let refused = json!({ "error": "invalid_grant", "error_description": "Demande refusée" });
        return (axum::http::StatusCode::BAD_REQUEST, axum::Json(refused)).into_response();
    }
    let token = unique("acc3ss-t0k3n");
    remote.tokens.lock().unwrap().push(token.clone());
    axum::Json(json!({ "access_token": token, "token_type": "Bearer", "expires_in": 3600 })).into_response()
}

/// Paramètres d’une adresse.
pub fn query_of(address: &str) -> HashMap<String, String> {
    url::Url::parse(address).unwrap().query_pairs().into_owned().collect()
}
