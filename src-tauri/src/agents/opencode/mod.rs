//! OpenCode : `opencode serve` privé (API v2, HTTP + SSE), piloté par le client généré depuis l’OpenAPI vendu
//! (`generated.rs`, voir `src-tauri/codegen`). Repris de OneApp (ADR 0022), avec un serveur par session d’Alfred : le
//! jeton des outils d’Alfred est propre à chaque conversation et le MCP d’`opencode serve` se déclare par processus.
//!
//! - Le mot de passe du serveur, le jeton d’appairage et le jeton des outils restent dans ce module.
//! - OpenCode fusionne des demandes envoyées à la suite dans une même exécution : une demande ne part qu’à la fin de
//!   l’exécution précédente ; la file reste celle de l’interface, et `steer` n’est pas proposé.
//! - `/api/event` est volatil et sans identifiant SSE : après une reconnexion ou un trou dans le `seq` durable, ce
//!   qui a été manqué est relu par `session.message.list`.

#[rustfmt::skip]
#[allow(clippy::all)]
mod generated;
mod mapping;
mod server;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use futures_util::StreamExt;
use generated::types;
use mapping::{ExecutionEnd, LiveMapper, ServerEvent, SseDecoder, CLIENT_ID_METADATA};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use server::{unavailable, Server};
use tokio::sync::{watch, Mutex};

use super::event::{HarnessEvent, SessionStatus};
use super::session::{message_text, Autonomy, InputFile, Launch, Model, Sink};
use crate::error::{AppError, AppResult};

/// Attente de la fin de l’exécution précédente avant d’envoyer une nouvelle demande.
const PREVIOUS_RUN_WAIT: Duration = Duration::from_secs(20);
const INSTRUCTIONS_KEY: &str = "alfred";

fn typed<T: DeserializeOwned>(value: &str) -> AppResult<T> {
    serde_json::from_value(Value::from(value)).map_err(|_| AppError::new("Identifiant OpenCode invalide."))
}

fn body<T: DeserializeOwned>(value: Value) -> AppResult<T> {
    serde_json::from_value(value).map_err(|error| {
        log::warn!("demande OpenCode refusée par les types du protocole : {error}");
        AppError::new("La demande OpenCode est invalide.")
    })
}

fn json_of(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Erreur d’API rendue lisible sans transmettre le corps brut de la réponse.
fn api_error<E>(error: generated::Error<E>) -> AppError {
    match error.status().map(|status| status.as_u16()) {
        Some(404) => AppError::new("La session OpenCode est introuvable."),
        Some(400 | 422) => AppError::new("OpenCode a refusé la demande d’Alfred."),
        _ => unavailable(),
    }
}

fn rule(action: &str, effect: &str) -> Value {
    json!({ "action": action, "resource": "*", "effect": effect })
}

/// Outils qui écrivent, lancent une commande ou sortent du dossier : refusés à un appel unique.
const WRITING_TOOLS: &[&str] = &["edit", "write", "shell", "external_directory", "webfetch", "websearch", "subagent", "task"];

/// Règles d’autorisation propres à la session. OpenCode applique la dernière règle qui correspond, après celles de
/// son agent, qui autorisent tout par défaut. Jamais de refus global « * » : il couperait aussi l’accès au fournisseur
/// du modèle.
pub(super) fn permissions(autonomy: Autonomy, one_shot: bool, tools: bool) -> Vec<Value> {
    let mut rules: Vec<Value> = if one_shot {
        WRITING_TOOLS.iter().map(|action| rule(action, "deny")).collect()
    } else {
        match autonomy {
            Autonomy::Auto => Vec::new(),
            Autonomy::Strict => ["edit", "write", "shell", "external_directory"].iter().map(|action| rule(action, "ask")).collect(),
            Autonomy::Ask => vec![rule("external_directory", "ask")],
            // Dans son dossier, tout passe sans demande ; ce qui en sort est refusé.
            Autonomy::Workspace => vec![rule("external_directory", "deny")],
        }
    };
    if tools {
        // La CLI `alfred` passe sans demande : chaque commande est vérifiée par le cœur.
        for resource in ["alfred", "alfred *"] {
            rules.push(json!({ "action": "shell", "resource": resource, "effect": "allow" }));
        }
    }
    rules
}


#[derive(Default)]
struct State {
    mapper: LiveMapper,
    last_seq: Option<i64>,
    /// Message de l’utilisateur de la demande en cours : point de départ d’un rattrapage.
    user_message_id: Option<String>,
    permissions: HashSet<String>,
}

pub struct OpenCode {
    server: Server,
    id: String,
    sink: Sink,
    autonomy: Autonomy,
    one_shot: bool,
    running: watch::Sender<bool>,
    send_lock: Mutex<()>,
    state: StdMutex<State>,
    stopped: AtomicBool,
}

impl OpenCode {
    fn emit(&self, event: HarnessEvent) {
        self.sink.emit(event);
    }

    fn opencode_id(&self) -> AppResult<types::SessionId> {
        typed(&self.id)
    }

    pub fn session_id(&self) -> String {
        self.id.clone()
    }

    pub async fn start(launch: Launch) -> AppResult<Arc<Self>> {
        let options = &launch.options;
        launch.sink.emit(HarnessEvent::status(SessionStatus::Connecting));
        // La CLI `alfred` et son jeton passent par l’environnement : rien n’est écrit dans les fichiers de l’utilisateur.
        let mut env = Vec::new();
        if let Some(token) = &launch.token {
            env.extend(crate::agent_cli::harness_env(&launch.state, launch.port, token));
        }
        let server = Server::start(&launch.program, &options.cwd, env).await?;
        let opened = open_session(&server, &launch).await;
        let id = match opened {
            Ok(id) => id,
            Err(error) => {
                server.stop();
                return Err(error);
            }
        };
        let session = Arc::new(Self {
            server,
            id,
            sink: launch.sink.clone(),
            autonomy: options.autonomy,
            one_shot: options.one_shot,
            running: watch::channel(false).0,
            send_lock: Mutex::new(()),
            state: StdMutex::new(State::default()),
            stopped: AtomicBool::new(false),
        });
        if let Err(error) = watch_events(Arc::downgrade(&session), launch.on_exit()).await {
            session.stop_now();
            return Err(error);
        }
        session.emit(HarnessEvent::Session { session_id: session.id.clone() });
        session.emit(HarnessEvent::status(SessionStatus::Ready));
        Ok(session)
    }

    fn handle_event(self: &Arc<Self>, event: &ServerEvent) {
        let mut gap = false;
        let mapped = {
            let Ok(mut state) = self.state.lock() else { return };
            if let Some(seq) = event.seq {
                gap = state.last_seq.is_some_and(|last| seq > last + 1);
                state.last_seq = Some(state.last_seq.map_or(seq, |last| last.max(seq)));
            }
            if event.kind == "permission.asked" {
                Vec::new()
            } else {
                state.mapper.map(event)
            }
        };
        for mapped in mapped {
            self.emit(mapped);
        }
        if event.kind == "permission.asked" {
            self.on_permission(&event.data);
        } else if event.kind == "permission.replied" {
            if let (Ok(mut state), Some(id)) = (self.state.lock(), event.data["requestID"].as_str()) {
                if state.permissions.remove(id) {
                    self.emit(HarnessEvent::ApprovalClosed { id: id.to_owned() });
                }
            }
        } else if let Some(end) = ExecutionEnd::from_event(&event.kind, &event.data) {
            self.finish(end);
        }
        if gap {
            tauri::async_runtime::spawn(resync(self.clone()));
        }
    }

    /// Fin de l’exécution en cours : une seule fois, même si le direct et un rattrapage la voient.
    fn finish(&self, end: ExecutionEnd) {
        if !self.running.send_replace(false) {
            return;
        }
        let pending: Vec<String> =
            self.state.lock().map(|mut state| state.permissions.drain().collect()).unwrap_or_default();
        for id in pending {
            self.emit(HarnessEvent::ApprovalClosed { id });
        }
        if let ExecutionEnd::Failed(message) = end {
            self.emit(HarnessEvent::error(super::event::with_reason("OpenCode n’a pas pu terminer sa réponse", Some(&message))));
        }
        self.emit(HarnessEvent::status(SessionStatus::Idle));
    }

    fn on_permission(self: &Arc<Self>, data: &Value) {
        let Some(request) = mapping::permission_request(data) else { return };
        let decision = match (self.one_shot, self.autonomy) {
            (true, _) | (_, Autonomy::Workspace) => Some("reject"),
            (_, Autonomy::Auto) => Some("once"),
            _ => None,
        };
        match decision {
            Some(decision) => {
                let session = self.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = session.reply(&request.id, decision).await;
                });
            }
            None => {
                let fresh = self.state.lock().map(|mut state| state.permissions.insert(request.id.clone())).unwrap_or(false);
                if fresh {
                    self.emit(HarnessEvent::Approval { request });
                }
            }
        }
    }

    async fn reply(&self, id: &str, decision: &str) -> AppResult<()> {
        let reply: types::SessionPermissionReplyBody = body(json!({ "decision": decision }))?;
        self.server.api.session_permission_reply(&self.opencode_id()?, &typed(id)?, &reply).await.map_err(api_error)?;
        if let Ok(mut state) = self.state.lock() {
            state.permissions.remove(id);
        }
        Ok(())
    }

    pub async fn send(&self, text: &str, files: &[InputFile], client_id: Option<&str>) -> AppResult<()> {
        let text = message_text(text, files);
        if text.is_empty() {
            return Ok(());
        }
        let _sending = self.send_lock.lock().await;
        // OpenCode fusionnerait cette demande avec l’exécution en cours : on attend sa fin.
        let mut running = self.running.subscribe();
        let idle = tokio::time::timeout(PREVIOUS_RUN_WAIT, running.wait_for(|running| !running))
            .await
            .is_ok_and(|ended| ended.is_ok());
        if !idle {
            return Err(AppError::new("OpenCode prépare déjà une réponse dans cette session."));
        }
        let files = files
            .iter()
            .map(|file| {
                let uri = url::Url::from_file_path(&file.path)
                    .map_err(|_| AppError::new("Le fichier joint doit être désigné par un chemin absolu."))?;
                Ok(json!({ "uri": uri.to_string(), "name": file.name }))
            })
            .collect::<AppResult<Vec<_>>>()?;
        let mut prompt = json!({ "text": text, "files": files });
        if let Some(client_id) = client_id {
            prompt["metadata"] = json!({ CLIENT_ID_METADATA: client_id });
        }
        let prompt: types::SessionPromptBody = body(prompt)?;
        self.running.send_replace(true);
        self.emit(HarnessEvent::status(SessionStatus::Responding));
        match self.server.api.session_prompt(&self.opencode_id()?, &prompt).await {
            Ok(response) => {
                let message = json_of(&response.into_inner());
                if let (Ok(mut state), Some(id)) = (self.state.lock(), message["data"]["id"].as_str()) {
                    state.user_message_id = Some(id.to_owned());
                }
                Ok(())
            }
            Err(error) => {
                // L’échec remonte à l’appelant, qui termine le tour en erreur.
                self.running.send_replace(false);
                Err(api_error(error))
            }
        }
    }

    pub async fn answer(&self, approval: &str, option: &str) -> AppResult<()> {
        let pending = self.state.lock().map(|state| state.permissions.contains(approval)).unwrap_or(false);
        if !pending || !["once", "always", "reject"].contains(&option) {
            return Err(AppError::new("Cette demande d’accord n’est plus en attente."));
        }
        self.reply(approval, option).await
    }

    pub async fn cancel(&self) -> AppResult<()> {
        if !*self.running.borrow() {
            return Ok(());
        }
        self.server.api.session_interrupt(&self.opencode_id()?, None).await.map_err(api_error)?;
        // `session.execution.interrupted` termine normalement le tour ; sans lui (flux coupé), il est clos ici.
        let mut running = self.running.subscribe();
        let ended = tokio::time::timeout(Duration::from_secs(5), running.wait_for(|running| !running))
            .await
            .is_ok_and(|ended| ended.is_ok());
        if !ended {
            self.finish(ExecutionEnd::Interrupted);
        }
        Ok(())
    }

    pub async fn close(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(id) = self.opencode_id() {
            if *self.running.borrow() {
                let _ = self.server.api.session_interrupt(&id, None).await;
            }
            // Un appel unique n’a pas sa place dans l’historique d’OpenCode.
            if self.one_shot {
                let _ = self.server.api.session_remove(&id).await;
            }
        }
        self.running.send_replace(false);
        self.server.stop();
        self.emit(HarnessEvent::status(SessionStatus::Closed));
    }

    /// Arrêt immédiat, à la fermeture d’Alfred.
    pub fn stop_now(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.server.stop();
    }
}

/// Crée ou reprend la session OpenCode ; rend son identifiant.
async fn open_session(server: &Server, launch: &Launch) -> AppResult<String> {
    let options = &launch.options;
    let api = &server.api;
    let model_ref = match &options.model {
        Some(model) => {
            let (provider, id) = model
                .split_once('/')
                .filter(|(provider, id)| !provider.is_empty() && !id.is_empty())
                .ok_or_else(|| AppError::new("Le modèle OpenCode doit être de la forme fournisseur/modèle."))?;
            let models = models_on(server, &options.cwd).await?;
            let found = models
                .iter()
                .find(|candidate| candidate["providerID"] == provider && candidate["id"] == id)
                .ok_or_else(|| AppError::new("Ce modèle n’est plus disponible dans OpenCode. Choisissez-en un autre."))?;
            if let Some(effort) = &options.effort {
                let available =
                    found["variants"].as_array().into_iter().flatten().any(|variant| variant["id"] == effort.as_str());
                if !available {
                    return Err(AppError::new("Ce niveau de raisonnement n’est plus disponible pour le modèle OpenCode."));
                }
            }
            Some(json!({ "providerID": provider, "id": id, "variant": options.effort }))
        }
        None => None,
    };
    let rules = permissions(options.autonomy, options.one_shot, launch.token.is_some());
    let id = match &options.resume_session_id {
        Some(resumed) => {
            // Reprise : l’historique reste dans OpenCode ; la politique et le modèle courants remplacent les anciens.
            let id: types::SessionId = typed(resumed)?;
            let existing = api.session_get(&id).await.map_err(api_error)?;
            let existing = json_of(&existing.into_inner());
            api.session_update(&id, &body(json!({ "permissions": rules }))?).await.map_err(api_error)?;
            if let Some(model) = &model_ref {
                if existing["data"]["model"] != *model {
                    api.session_switch_model(&id, &body(json!({ "model": model }))?).await.map_err(api_error)?;
                }
            }
            resumed.clone()
        }
        None => {
            let mut create = json!({ "location": { "directory": options.cwd }, "permissions": rules });
            if let Some(model) = &model_ref {
                create["model"] = model.clone();
            }
            if let Some(title) = options.title.as_deref().map(str::trim).filter(|title| !title.is_empty()) {
                create["title"] = Value::from(title);
            }
            let created = api.session_create(&body(create)?).await.map_err(api_error)?;
            created.into_inner().data.id.to_string()
        }
    };
    if let Some(instructions) = &options.instructions {
        let session: types::SessionId = typed(&id)?;
        api.experimental_session_instructions_entry_put(&session, &typed(INSTRUCTIONS_KEY)?, &body(json!({ "value": instructions }))?)
            .await
            .map_err(api_error)?;
    }
    Ok(id)
}

/// Suit `/api/event` du serveur de la session ; rend la main une fois le premier abonnement établi.
async fn watch_events(session: Weak<OpenCode>, on_exit: impl FnOnce() + Send + 'static) -> AppResult<()> {
    let first = {
        let session = session.upgrade().ok_or_else(unavailable)?;
        session.server.stream.event_subscribe().await.map_err(|_| unavailable())?
    };
    tauri::async_runtime::spawn(async move {
        let mut response = Some(first);
        let mut reconnected = false;
        loop {
            if let Some(stream) = response.take() {
                if reconnected {
                    if let Some(session) = session.upgrade() {
                        tauri::async_runtime::spawn(resync(session));
                    }
                }
                let mut stream = stream.into_inner().into_inner();
                let mut decoder = SseDecoder::default();
                while let Some(Ok(chunk)) = stream.next().await {
                    let Some(live) = session.upgrade() else { return };
                    for payload in decoder.push(&chunk) {
                        if let Some(event) = ServerEvent::parse(&payload) {
                            if event.session_id.as_deref() == Some(live.id.as_str()) {
                                live.handle_event(&event);
                            }
                        }
                    }
                }
            }
            let Some(live) = session.upgrade() else { return };
            if live.stopped.load(Ordering::SeqCst) {
                on_exit();
                return;
            }
            if live.server.exited() {
                live.stopped.store(true, Ordering::SeqCst);
                live.running.send_replace(false);
                live.emit(HarnessEvent::error("OpenCode s’est arrêté. Envoyer un message relance la conversation."));
                live.emit(HarnessEvent::status(SessionStatus::Closed));
                on_exit();
                return;
            }
            drop(live);
            tokio::time::sleep(Duration::from_millis(500)).await;
            reconnected = true;
            let Some(live) = session.upgrade() else { return };
            response = live.server.stream.event_subscribe().await.ok();
        }
    });
    Ok(())
}

/// Rattrapage après une coupure : relit les derniers messages depuis la demande en cours, réémet leur état (mêmes
/// éléments que le direct) et la fin d’exécution manquée, puis les autorisations encore en attente.
async fn resync(session: Arc<OpenCode>) {
    if !*session.running.borrow() {
        return;
    }
    let Some(user_message) = session.state.lock().ok().and_then(|state| state.user_message_id.clone()) else { return };
    let Ok(id) = session.opencode_id() else { return };
    let api = &session.server.api;
    let Ok(page) = api.session_message_list(&id, None, Some("50"), Some(types::SessionMessageListOrder::Desc), None).await
    else {
        return;
    };
    let page = json_of(&page.into_inner());
    let mut messages: Vec<Value> = page["data"].as_array().cloned().unwrap_or_default();
    messages.reverse();
    let Some(start) = messages.iter().position(|message| message["id"] == user_message.as_str()) else { return };
    let mut end = None;
    for message in &messages[start + 1..] {
        if message["type"] == "assistant" {
            for event in mapping::assistant_events(message) {
                session.emit(event);
            }
        } else if let Some(found) = ExecutionEnd::from_idle(message) {
            end = Some(found);
        }
    }
    if let Some(end) = end {
        session.finish(end);
        return;
    }
    if let Ok(pending) = api.session_permission_list(&id).await {
        let pending = json_of(&pending.into_inner());
        for request in pending["data"].as_array().into_iter().flatten() {
            session.on_permission(request);
        }
    }
}

async fn models_on(server: &Server, cwd: &str) -> AppResult<Vec<Value>> {
    let response = server.api.model_list(Some(cwd)).await.map_err(api_error)?.into_inner();
    // Les modèles portent les réglages du fournisseur (clés d’API comprises) : seuls l’identifiant, le nom et les
    // variantes en sortent.
    Ok(json_of(&response)["data"].as_array().cloned().unwrap_or_default())
}

/// Catalogue des modèles, lu sur un serveur de service sans outils.
pub async fn models(program: &Path, cwd: &str) -> AppResult<Vec<Model>> {
    let server = Server::start(program, cwd, Vec::new()).await?;
    let models = models_on(&server, cwd).await;
    server.stop();
    Ok(models?
        .iter()
        .filter(|model| model["enabled"] != false && model["status"] != "deprecated")
        .filter_map(|model| {
            let provider = model["providerID"].as_str()?;
            let id = model["id"].as_str()?;
            Some(Model {
                id: format!("{provider}/{id}"),
                name: model["name"].as_str().unwrap_or(id).to_owned(),
                efforts: model["variants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|variant| variant["id"].as_str().map(str::to_owned))
                    .collect(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_become_session_rules() {
        assert_eq!(permissions(Autonomy::Auto, false, false), Vec::<Value>::new());
        assert_eq!(permissions(Autonomy::Workspace, false, true)[0], rule("external_directory", "deny"));
        assert!(permissions(Autonomy::Workspace, false, true).iter().any(|rule| rule["resource"] == "alfred *" && rule["effect"] == "allow"));
        assert_eq!(permissions(Autonomy::Ask, false, false), vec![rule("external_directory", "ask")]);
        assert_eq!(permissions(Autonomy::Strict, false, false).len(), 4);
        assert!(permissions(Autonomy::Auto, true, false).iter().all(|rule| rule["effect"] == "deny"));
    }
}
