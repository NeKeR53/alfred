//! Codex : `codex app-server`, JSON-RPC ligne à ligne, sur les types générés depuis
//! `codex app-server generate-json-schema` (`generated.rs`, voir `src-tauri/codegen`). Les paramètres envoyés sont
//! construits puis validés par ces types ; les notifications sont lues par eux. Un message que les types ne
//! reconnaissent pas (CLI plus récent) est ignoré sans faire échouer la session.

#[rustfmt::skip]
#[allow(clippy::all)]
mod generated;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use generated as g;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::content::{content_files, is_document, pretty, readable};
use super::event::{
    with_reason, ActionType, Activity, ActivityAction, ActivityKind, ActivityStatus, ApprovalOption, ApprovalRequest,
    now_ms, AgentTask, HarnessEvent, OptionKind, PlanStatus, PlanStep, SessionStatus, TaskKind, TaskStatus,
};
use super::process::{unavailable, LineProcess};
use super::session::{attached_list, message_text, Autonomy, InputFile, Launch, Model, Sink, StartOptions};
use super::{command, MCP_TOKEN_ENV};
use crate::error::{arg, AppError, AppResult};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CLIENT: (&str, &str) = ("alfred", "Alfred");

fn protocol_error(action: &str) -> AppError {
    AppError::new(format!("Codex CLI n’a pas pu {action}. Fermez la conversation puis réessayez."))
}

/// Valeur typée par le protocole généré : les paramètres envoyés en sont validés.
fn typed<T: DeserializeOwned + Serialize>(value: Value) -> AppResult<Value> {
    let typed: T = serde_json::from_value(value).map_err(|error| {
        log::warn!("paramètres Codex refusés par les types du protocole : {error}");
        protocol_error("préparer la requête")
    })?;
    serde_json::to_value(typed).map_err(|_| protocol_error("préparer la requête"))
}

/// Lecture typée d’un message entrant ; `None` si le CLI a dérivé du schéma vendu.
fn read<T: DeserializeOwned>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

/// Politique d’approbation, bac à sable du fil et bac à sable du tour pour une autonomie.
///
/// Sous Windows, comme dans OneApp : aucune demande d’accord et jamais `workspace-write` en mode demandé, qui y prépare
/// des droits sur les dossiers avant chaque démarrage et rend Codex très lent ; le mode espace de travail le garde,
/// car c’est lui qui borne l’agent à son dossier.
pub(super) fn policy(autonomy: Autonomy, roots: &[String], read_only: bool, windows: bool) -> (Value, Value, Value) {
    let read_only_policy = || (json!("never"), json!("read-only"), json!({ "type": "readOnly" }));
    let full = || (json!("never"), json!("danger-full-access"), json!({ "type": "dangerFullAccess" }));
    // `only_roots` : ni `/tmp` ni `$TMPDIR`, que Codex ajoute sinon aux dossiers accessibles en écriture.
    let workspace = |approval: &str, only_roots: bool| {
        (
            json!(approval),
            json!("workspace-write"),
            json!({ "type": "workspaceWrite", "writableRoots": roots, "networkAccess": false,
                    "excludeSlashTmp": only_roots, "excludeTmpdirEnvVar": only_roots }),
        )
    };
    if read_only {
        return read_only_policy();
    }
    match autonomy {
        Autonomy::Auto => full(),
        // Toute demande d’accord est refusée d’office, sauf celle de lancer la CLI `alfred` hors du bac à sable.
        Autonomy::Workspace => workspace("on-request", true),
        Autonomy::Strict if windows => read_only_policy(),
        Autonomy::Strict => (json!("untrusted"), json!("read-only"), json!({ "type": "readOnly" })),
        Autonomy::Ask if windows => full(),
        Autonomy::Ask => workspace("on-request", false),
    }
}

/// Entrée d’un tour : les images partent en `localImage`, les autres fichiers sont cités par leur chemin.
fn input(text: &str, files: &[InputFile]) -> Value {
    let others: Vec<&InputFile> = files.iter().filter(|file| !file.is_image()).collect();
    let mut items = vec![json!({ "type": "text", "text": format!("{text}{}", attached_list(&others)), "text_elements": [] })];
    items.extend(files.iter().filter(|file| file.is_image()).map(|file| json!({ "type": "localImage", "path": file.path })));
    Value::Array(items)
}

/// Lignes ajoutées et retirées : un diff unifié pour une modification, le contenu entier pour un ajout ou un retrait.
fn change_counts(change: &g::FileUpdateChange) -> (u32, u32) {
    let mut lines: Vec<&str> = change.diff.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let count = lines.len() as u32;
    match change.kind {
        g::PatchChangeKind::Add => (count, 0),
        g::PatchChangeKind::Delete => (0, count),
        g::PatchChangeKind::Update { .. } => (
            lines.iter().filter(|line| line.starts_with('+') && !line.starts_with("+++ ")).count() as u32,
            lines.iter().filter(|line| line.starts_with('-') && !line.starts_with("--- ")).count() as u32,
        ),
    }
}

fn status_text(status: &impl Serialize) -> String {
    serde_json::to_value(status).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

fn activity_status(status: &str, completed: bool) -> ActivityStatus {
    match status {
        "failed" | "declined" | "interrupted" => ActivityStatus::Failed,
        "completed" => ActivityStatus::Completed,
        _ if completed => ActivityStatus::Completed,
        _ => ActivityStatus::Running,
    }
}

/// Activité affichée pour un élément du fil ; `None` pour un message (il passe par le texte) ou un élément muet.
/// Plan de `turn/plan/updated` (outil `update_plan` de Codex) : `{ plan: [{ step, status }] }`.
pub(super) fn plan_from_update(params: &Value) -> Option<Vec<PlanStep>> {
    let plan = params["plan"].as_array()?;
    Some(
        plan.iter()
            .filter_map(|step| {
                let text = step["step"].as_str()?.trim();
                let status = PlanStatus::parse(step["status"].as_str()?)?;
                (!text.is_empty()).then(|| PlanStep { text: text.to_owned(), status })
            })
            .collect(),
    )
}

pub(super) fn activity_from_item(item: &g::ThreadItem, completed: bool) -> Option<Activity> {
    use g::ThreadItem as T;
    let done = if completed { ActivityStatus::Completed } else { ActivityStatus::Running };
    Some(match item {
        T::ReasoningThreadItem { id, summary, .. } => {
            Activity::new(id, ActivityKind::Analysis, "Analyse", done).content((!summary.is_empty()).then(|| summary.join("\n")))
        }
        T::PlanThreadItem { id, text, .. } => Activity::new(id, ActivityKind::Analysis, "Plan", done).content(Some(text.clone())),
        T::CommandExecutionThreadItem { id, command, command_actions, aggregated_output, status, .. } => {
            let actions = command_actions
                .iter()
                .filter_map(|action| match action {
                    g::CommandAction::Read { path, .. } => {
                        Some(ActivityAction::new(ActionType::Read).with_path(Some(&status_text(path))))
                    }
                    g::CommandAction::ListFiles { path, .. } => {
                        Some(ActivityAction::new(ActionType::ListFiles).with_path(path.as_deref()))
                    }
                    g::CommandAction::Search { path, query, .. } => Some(
                        ActivityAction::new(ActionType::Search).with_path(path.as_deref()).with_query(query.as_deref()),
                    ),
                    _ => None,
                })
                .collect();
            Activity::new(id, ActivityKind::Command, "Commande", activity_status(&status_text(status), completed))
                .actions(actions)
                .detail(Some(command.clone()))
                .content(aggregated_output.clone())
        }
        T::FileChangeThreadItem { id, changes, status, .. } => {
            let paths: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
            let actions = changes
                .iter()
                .map(|change| {
                    let (added, removed) = change_counts(change);
                    let mut action = ActivityAction::new(ActionType::Edit).with_path(Some(&change.path));
                    action.added = Some(added);
                    action.removed = Some(removed);
                    action
                })
                .collect();
            let documents: Vec<String> = paths.iter().filter(|path| is_document(path)).take(8).cloned().collect();
            Activity::new(id, ActivityKind::File, "Modification de fichiers", activity_status(&status_text(status), completed))
                .actions(actions)
                .detail(Some(paths.join("\n")))
                .files(documents)
        }
        T::McpToolCallThreadItem { id, server, tool, arguments, result, error, status, .. } => {
            let mut activity = Activity::new(
                id,
                ActivityKind::Tool,
                format!("Outil · {server} / {tool}"),
                activity_status(&status_text(status), completed),
            )
            .detail(pretty(arguments));
            if completed {
                if let Some(error) = error {
                    activity = activity.content(Some(error.message.clone()));
                } else if let Some(result) = result {
                    // Sans le base64 d’une image renvoyée (capture d’écran) : la sortie reste lisible et légère.
                    let found = content_files(&Value::Array(result.content.clone()));
                    activity = activity.content(readable(&found.content)).images(found.images).files(found.files);
                }
            }
            activity
        }
        T::DynamicToolCallThreadItem { id, namespace, tool, arguments, content_items, status, .. } => {
            let title = format!("Outil · {}{tool}", namespace.as_ref().map(|space| format!("{space} / ")).unwrap_or_default());
            Activity::new(id, ActivityKind::Tool, title, activity_status(&status_text(status), completed))
                .detail(pretty(arguments))
                .content(if completed { content_items.as_ref().and_then(|items| pretty(&json!(items))) } else { None })
        }
        T::FunctionCallOutputThreadItem { id, namespace, name, output, .. } => {
            let title = format!("Outil · {}{name}", namespace.as_ref().map(|space| format!("{space} / ")).unwrap_or_default());
            Activity::new(id, ActivityKind::Tool, title, done).content(pretty(&json!(output)))
        }
        T::CollabAgentToolCallThreadItem { id, tool, prompt, agents_states, status, .. } => Activity::new(
            id,
            ActivityKind::Agent,
            format!("Agent · {}", status_text(tool)),
            activity_status(&status_text(status), completed),
        )
        .detail(prompt.clone())
        .content(if completed { pretty(&json!(agents_states)) } else { None }),
        T::WebSearchThreadItem { id, query, .. } => {
            Activity::new(id, ActivityKind::Search, "Recherche web", done).detail(Some(query.clone()))
        }
        T::ImageViewThreadItem { id, path, .. } => {
            let path = status_text(path);
            Activity::new(id, ActivityKind::Tool, "Lecture d’image", done).detail(Some(path.clone())).images(vec![path])
        }
        _ => return None,
    })
}

/// État d’une tâche de Codex : statut d’une commande ou d’un sous-agent (`CollabAgentStatus`).
fn task_status(status: &str) -> TaskStatus {
    match status {
        "completed" => TaskStatus::Completed,
        "failed" | "declined" | "errored" | "notFound" => TaskStatus::Failed,
        "interrupted" | "shutdown" => TaskStatus::Stopped,
        _ => TaskStatus::Running,
    }
}

/// Tâches de Codex 0.169 lues dans les éléments du fil : chaque commande en cours (`commandExecution`, qui bloque la
/// réponse), et chaque sous-agent lancé par `spawnAgent`, en arrière-plan jusqu’à ce qu’un appel suivant (`wait`,
/// `closeAgent`…) rapporte sa fin dans `agentsStates`. `codex app-server` n’offre ni liste des terminaux de fond ni
/// arrêt d’une tâche seule : aucune n’est `stoppable`.
pub(super) fn track_tasks(tasks: &mut HashMap<String, AgentTask>, item: &g::ThreadItem, completed: bool) -> Vec<AgentTask> {
    use g::ThreadItem as T;
    let mut changed = Vec::new();
    match item {
        T::CommandExecutionThreadItem { id, command, status, started_at_ms, completed_at_ms, .. } => {
            let status = if completed && task_status(&status_text(status)) == TaskStatus::Running {
                TaskStatus::Completed
            } else {
                task_status(&status_text(status))
            };
            let task = tasks.entry(id.clone()).or_insert_with(|| AgentTask {
                task_id: id.clone(),
                kind: TaskKind::Command,
                title: command.lines().next().unwrap_or(command).trim().to_owned(),
                background: false,
                status: TaskStatus::Running,
                started_at: started_at_ms.map(|at| at as u64).unwrap_or_else(now_ms),
                ended_at: None,
                stoppable: false,
            });
            if status.finished() {
                task.finish(status, completed_at_ms.map(|at| at as u64));
            }
            changed.push(task.clone());
        }
        T::CollabAgentToolCallThreadItem { tool, prompt, receiver_thread_ids, agents_states, started_at_ms, .. } => {
            if completed && status_text(tool) == "spawnAgent" {
                let title = prompt.as_deref().and_then(|prompt| prompt.lines().next()).map(str::trim).filter(|line| !line.is_empty());
                for thread in receiver_thread_ids {
                    if tasks.contains_key(thread) {
                        continue;
                    }
                    let task = AgentTask {
                        task_id: thread.clone(),
                        kind: TaskKind::Agent,
                        title: title.unwrap_or("Sous-agent").to_owned(),
                        background: true,
                        status: TaskStatus::Running,
                        started_at: started_at_ms.map(|at| at as u64).unwrap_or_else(now_ms),
                        ended_at: None,
                        stoppable: false,
                    };
                    tasks.insert(thread.clone(), task.clone());
                    changed.push(task);
                }
            }
            // État des sous-agents rapporté par cet appel ; seule une fin compte (un lancement est déjà « en cours »).
            for (thread, state) in agents_states {
                let status = task_status(&status_text(&state.status));
                let Some(task) = tasks.get_mut(thread).filter(|task| task.kind == TaskKind::Agent) else { continue };
                if status.finished() {
                    task.finish(status, None);
                    let task = task.clone();
                    changed.retain(|known| known.task_id != task.task_id);
                    changed.push(task);
                }
            }
        }
        _ => {}
    }
    tasks.retain(|_, task| !task.status.finished());
    changed
}

type Pending = Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>;

/// Liaison JSON-RPC avec un `codex app-server`.
struct Rpc {
    process: Mutex<Option<Arc<LineProcess>>>,
    next: AtomicI64,
    pending: Pending,
}

impl Rpc {
    fn process(&self) -> AppResult<Arc<LineProcess>> {
        self.process.lock().ok().and_then(|process| process.clone()).ok_or_else(unavailable)
    }

    fn write(&self, message: &Value) -> AppResult<()> {
        self.process()?.write(message)
    }

    async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().map_err(|_| unavailable())?.insert(id, sender);
        if self.write(&json!({ "method": method, "id": id, "params": params })).is_err() {
            self.pending.lock().map_err(|_| unavailable())?.remove(&id);
            return Err(protocol_error("communiquer avec le processus"));
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(detail))) => Err(AppError::new(format!(
                "Codex CLI n’a pas pu traiter la requête ({}). Fermez la conversation puis réessayez.",
                super::event::redacted(&detail)
            ))),
            Ok(Err(_)) => Err(AppError::new("Codex s’est arrêté.")),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(protocol_error("obtenir une réponse du processus"))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        self.write(&json!({ "method": method, "params": params }))
    }

    /// Range une réponse ; rend le message s’il n’en est pas une.
    fn route(&self, message: Value) -> Option<Value> {
        if message.get("method").is_some() {
            return Some(message);
        }
        let id = message["id"].as_i64()?;
        let sender = self.pending.lock().ok()?.remove(&id)?;
        let outcome = match message.get("error") {
            Some(error) => Err(error["message"].as_str().unwrap_or("erreur").to_owned()),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(outcome);
        None
    }

    fn fail_pending(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }

    fn terminate(&self) {
        self.fail_pending();
        if let Some(process) = self.process.lock().ok().and_then(|mut process| process.take()) {
            process.terminate();
        }
    }
}

/// Lance `codex app-server` et fait la poignée de main.
async fn connect(
    program: &Path,
    cwd: &str,
    token: Option<&str>,
    env: Vec<(&'static str, String)>,
    on_message: impl Fn(&Arc<Rpc>, Value) + Send + Sync + 'static,
    on_exit: impl FnOnce(Option<String>) + Send + 'static,
) -> AppResult<Arc<Rpc>> {
    let rpc = Arc::new(Rpc { process: Mutex::new(None), next: AtomicI64::new(0), pending: Mutex::new(HashMap::new()) });
    let mut command = command(program, Some(cwd));
    command.arg("app-server");
    if let Some(token) = token {
        command.env(MCP_TOKEN_ENV, token);
    }
    command.envs(env);
    let (reader, exiting) = (Arc::downgrade(&rpc), Arc::downgrade(&rpc));
    let process = LineProcess::spawn(
        &mut command,
        "codex",
        move |line| {
            let (Some(rpc), Ok(message)) = (reader.upgrade(), serde_json::from_str::<Value>(line)) else { return };
            if let Some(message) = rpc.route(message) {
                on_message(&rpc, message);
            }
        },
        move |_| {
            let reason = exiting.upgrade().and_then(|rpc| {
                rpc.fail_pending();
                rpc.process.lock().ok().and_then(|process| process.clone()).and_then(|process| process.stderr_reason())
            });
            on_exit(reason);
        },
    )?;
    if let Ok(mut slot) = rpc.process.lock() {
        *slot = Some(process);
    }
    let params = typed::<g::InitializeParams>(json!({
        "clientInfo": { "name": CLIENT.0, "title": CLIENT.1, "version": env!("CARGO_PKG_VERSION") },
        "capabilities": null,
    }))?;
    if let Err(error) = rpc.request("initialize", params).await {
        rpc.terminate();
        return Err(error);
    }
    rpc.notify("initialized", json!({}))?;
    Ok(rpc)
}

#[derive(Default)]
struct State {
    thread_id: Option<String>,
    turn_id: Option<String>,
    /// Tours interrompus par Alfred : leur fin, confirmée plus tard par le CLI, ne concerne plus le tour suivant.
    interrupted: HashSet<String>,
    /// Demandes d’accord en attente : identifiant affiché → identifiant de la requête du CLI.
    approvals: HashMap<String, Value>,
    last_error: Option<String>,
    closed: bool,
    /// Commandes et sous-agents en cours (`track_tasks`).
    tasks: HashMap<String, AgentTask>,
}

struct Inner {
    sink: Sink,
    options: StartOptions,
    state: Mutex<State>,
}

pub struct Codex {
    rpc: Arc<Rpc>,
    inner: Arc<Inner>,
}

impl Inner {
    fn emit(&self, event: HarnessEvent) {
        self.sink.emit(event);
    }

    fn policy(&self) -> (Value, Value, Value) {
        policy(self.options.autonomy, &self.options.roots(), self.options.one_shot, cfg!(windows))
    }

    fn close_approvals(&self, rpc: &Rpc, decision: Option<&str>) {
        let approvals: Vec<(String, Value)> =
            self.state.lock().map(|mut state| state.approvals.drain().collect()).unwrap_or_default();
        for (id, rpc_id) in approvals {
            if let Some(decision) = decision {
                let _ = rpc.write(&json!({ "id": rpc_id, "result": { "decision": decision } }));
            }
            self.emit(HarnessEvent::ApprovalClosed { id });
        }
    }

    fn handle(&self, rpc: &Rpc, message: Value) {
        let method = message["method"].as_str().unwrap_or_default();
        if message.get("id").is_some() {
            self.server_request(rpc, method, &message);
            return;
        }
        let params = &message["params"];
        // Les derniers éléments d’un tour interrompu arriveraient dans le tour suivant.
        if let Some(turn) = params["turnId"].as_str() {
            if self.state.lock().is_ok_and(|state| state.interrupted.contains(turn)) {
                return;
            }
        }
        match method {
            "error" => {
                let Some(error) = read::<g::ErrorNotification>(params) else { return };
                if error.will_retry {
                    self.emit(HarnessEvent::Activity(
                        Activity::new(format!("reconnect-{}", error.turn_id), ActivityKind::Analysis, "Reconnexion au modèle", ActivityStatus::Running)
                            .content(Some(error.error.message)),
                    ));
                } else if let Ok(mut state) = self.state.lock() {
                    state.last_error = Some(error.error.message);
                }
            }
            "item/agentMessage/delta" => {
                if let Some(delta) = read::<g::AgentMessageDeltaNotification>(params) {
                    self.emit(HarnessEvent::text(delta.item_id, delta.delta, false));
                }
            }
            "item/started" | "item/completed" => {
                let completed = method == "item/completed";
                let item = if completed {
                    read::<g::ItemCompletedNotification>(params).map(|notification| notification.item)
                } else {
                    read::<g::ItemStartedNotification>(params).map(|notification| notification.item)
                };
                let Some(item) = item else { return };
                let tasks = self.state.lock().map(|mut state| track_tasks(&mut state.tasks, &item, completed)).unwrap_or_default();
                for task in tasks {
                    self.emit(HarnessEvent::Task(task));
                }
                if let Some(activity) = activity_from_item(&item, completed) {
                    self.emit(HarnessEvent::Activity(activity));
                }
                if let (true, g::ThreadItem::AgentMessageThreadItem { id, text, .. }) = (completed, &item) {
                    if !text.is_empty() {
                        self.emit(HarnessEvent::text(id, text, true));
                    }
                }
            }
            "item/commandExecution/outputDelta" => {
                if let Some(delta) = read::<g::CommandExecutionOutputDeltaNotification>(params) {
                    self.emit(HarnessEvent::delta(delta.item_id, delta.delta));
                }
            }
            "item/reasoning/summaryTextDelta" | "item/plan/delta" => {
                if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str()) {
                    self.emit(HarnessEvent::delta(item, delta));
                }
            }
            "turn/plan/updated" => {
                if let Some(steps) = plan_from_update(params) {
                    self.emit(HarnessEvent::Plan { steps });
                }
            }
            "item/mcpToolCall/progress" => {
                if let Some(progress) = read::<g::McpToolCallProgressNotification>(params) {
                    self.emit(HarnessEvent::delta(progress.item_id, format!("{}\n", progress.message)));
                }
            }
            "turn/completed" => {
                let Some(done) = read::<g::TurnCompletedNotification>(params) else {
                    // Fin de tour illisible : elle termine quand même le tour, sans quoi la conversation resterait figée.
                    self.finish_turn(rpc, None, None);
                    return;
                };
                let failed = status_text(&done.turn.status) == "failed" || done.turn.error.is_some();
                let reason = done.turn.error.as_ref().map(|error| error.message.clone());
                self.finish_turn(rpc, Some(&done.turn.id), failed.then(|| reason.unwrap_or_default()));
            }
            _ => {}
        }
    }

    /// Fin d’un tour ; `failure` porte le motif d’un échec (vide s’il n’est pas connu).
    fn finish_turn(&self, rpc: &Rpc, turn: Option<&str>, failure: Option<String>) {
        let mut stopped = Vec::new();
        let last_error = {
            let Ok(mut state) = self.state.lock() else { return };
            if let Some(turn) = turn {
                if state.interrupted.remove(turn) {
                    return;
                }
            }
            state.turn_id = None;
            // Une commande sans fin annoncée ne survit pas au tour ; un sous-agent, si.
            let ended: Vec<String> =
                state.tasks.iter().filter(|(_, task)| !task.background).map(|(id, _)| id.clone()).collect();
            for id in ended {
                if let Some(mut task) = state.tasks.remove(&id) {
                    task.finish(TaskStatus::Stopped, None);
                    stopped.push(task);
                }
            }
            state.last_error.take()
        };
        for task in stopped {
            self.emit(HarnessEvent::Task(task));
        }
        self.close_approvals(rpc, None);
        if let Some(reason) = failure {
            let reason = Some(reason).filter(|reason| !reason.is_empty()).or(last_error);
            self.emit(HarnessEvent::error(format!(
                "{} Réessayez ou ouvrez une nouvelle discussion.",
                with_reason("Codex n’a pas pu terminer sa réponse", reason.as_deref())
            )));
        }
        self.emit(HarnessEvent::status(SessionStatus::Idle));
    }

    /// Requête du CLI vers Alfred : une demande d’accord devient une carte, ou une décision selon le mode ; le reste
    /// n’est pas pris en charge.
    fn server_request(&self, rpc: &Rpc, method: &str, message: &Value) {
        let id = message["id"].clone();
        let params = &message["params"];
        // La CLI `alfred` sort du bac à sable, qui coupe le réseau local : le cœur vérifie lui-même chaque commande.
        if method == "item/commandExecution/requestApproval" && !self.options.one_shot {
            let command = read::<g::CommandExecutionRequestApprovalParams>(params).and_then(|request| request.command);
            if command.as_deref().is_some_and(crate::agent_cli::is_alfred_command) {
                let _ = rpc.write(&json!({ "id": id, "result": { "decision": "accept" } }));
                return;
            }
        }
        let card = match method {
            "item/commandExecution/requestApproval" => read::<g::CommandExecutionRequestApprovalParams>(params).map(|request| {
                let detail = [
                    request.command.clone(),
                    request.cwd.as_ref().map(|cwd| format!("dans {}", status_text(cwd))),
                    request.reason.clone(),
                ];
                ("Exécuter une commande", detail.into_iter().flatten().collect::<Vec<_>>().join("\n"))
            }),
            "item/fileChange/requestApproval" => read::<g::FileChangeRequestApprovalParams>(params).map(|request| {
                ("Modifier des fichiers", request.reason.unwrap_or_default())
            }),
            _ => None,
        };
        let Some((title, detail)) = card else {
            let _ = rpc.write(&json!({ "id": id, "error": { "code": -32601, "message": "Cette interaction n’est pas prise en charge par Alfred." } }));
            // Sans quoi le CLI attend une réponse que personne ne voit venir.
            self.emit(HarnessEvent::error("Le CLI demande une interaction non prise en charge. Reprenez la tâche dans le CLI."));
            return;
        };
        let decision = match (self.options.one_shot, self.options.autonomy) {
            (true, _) | (_, Autonomy::Workspace) => Some("decline"),
            (_, Autonomy::Auto) => Some("accept"),
            _ => None,
        };
        if let Some(decision) = decision {
            let _ = rpc.write(&json!({ "id": id, "result": { "decision": decision } }));
            return;
        }
        let card_id = format!("codex-{}", id.as_i64().map(|id| id.to_string()).unwrap_or_else(|| id.as_str().unwrap_or("?").to_owned()));
        if let Ok(mut state) = self.state.lock() {
            state.approvals.insert(card_id.clone(), id);
        }
        self.emit(HarnessEvent::Approval {
            request: ApprovalRequest {
                id: card_id,
                title: title.into(),
                detail: Some(detail).filter(|detail| !detail.is_empty()),
                options: vec![
                    ApprovalOption::new("accept", "Autoriser", OptionKind::Allow),
                    ApprovalOption::new("acceptForSession", "Autoriser pour cette conversation", OptionKind::AllowAlways),
                    ApprovalOption::new("decline", "Refuser", OptionKind::Deny),
                ],
            },
        });
    }

    fn handle_exit(&self, reason: Option<String>) {
        let stopped: Vec<AgentTask>;
        let approvals: Vec<String> = {
            let Ok(mut state) = self.state.lock() else { return };
            if state.closed {
                return;
            }
            state.closed = true;
            stopped = state.tasks.drain().map(|(_, task)| task).collect();
            state.approvals.drain().map(|(id, _)| id).collect()
        };
        for id in approvals {
            self.emit(HarnessEvent::ApprovalClosed { id });
        }
        // Les commandes et sous-agents meurent avec le CLI.
        for mut task in stopped {
            task.finish(TaskStatus::Stopped, None);
            self.emit(HarnessEvent::Task(task));
        }
        self.emit(HarnessEvent::error(format!(
            "Codex s’est arrêté{}. Envoyer un message relance la conversation.",
            reason.map(|reason| format!(" : {reason}")).unwrap_or_default()
        )));
        self.emit(HarnessEvent::status(SessionStatus::Closed));
    }
}

/// Configuration propre à la session : les outils d’Alfred, ou aucun outil pour un appel unique.
fn session_config(options: &StartOptions, tools_url: &str, has_token: bool) -> Value {
    if options.one_shot {
        return json!({
            "features.shell_tool": false,
            "features.unified_exec": false,
            "features.apply_patch_freeform": false,
            "features.apps": false,
            "features.plugins": false,
            "features.multi_agent": false,
            "tools.view_image": false,
            "web_search": "disabled",
            "features.hooks": false,
            "features.memories": false,
            "project_doc_max_bytes": 0,
        });
    }
    if has_token {
        // Le jeton est fourni au CLI par Rust, dans son environnement.
        return json!({ "mcp_servers.alfred": {
            "url": tools_url,
            "enabled": true,
            "default_tools_approval_mode": "approve",
            "bearer_token_env_var": MCP_TOKEN_ENV,
        } });
    }
    json!({})
}

impl Codex {
    pub async fn start(launch: Launch) -> AppResult<Arc<Self>> {
        launch.sink.emit(HarnessEvent::status(SessionStatus::Connecting));
        let inner = Arc::new(Inner { sink: launch.sink.clone(), options: launch.options.clone(), state: Mutex::new(State::default()) });
        let (handler, exiting) = (inner.clone(), inner.clone());
        let forget = launch.on_exit();
        let rpc = connect(
            &launch.program,
            &launch.options.cwd,
            launch.token.as_deref(),
            launch
                .token
                .as_deref()
                .map(|token| crate::agent_cli::harness_env(&launch.state, launch.port, token))
                .unwrap_or_default(),
            move |rpc, message| handler.handle(rpc, message),
            move |reason| {
                exiting.handle_exit(reason);
                forget();
            },
        )
        .await?;
        let codex = Arc::new(Self { rpc, inner });
        if let Err(error) = codex.open(&launch).await {
            codex.close();
            return Err(error);
        }
        Ok(codex)
    }

    async fn open(&self, launch: &Launch) -> AppResult<()> {
        let options = &launch.options;
        let (approval, sandbox, _) = self.inner.policy();
        let mut common = json!({ "cwd": options.cwd, "approvalPolicy": approval, "sandbox": sandbox });
        let config = session_config(options, &launch.tools_url(), launch.token.is_some());
        if config.as_object().is_some_and(|config| !config.is_empty()) {
            common["config"] = config;
        }
        if let Some(model) = &options.model {
            common["model"] = json!(model);
        }
        if let Some(instructions) = &options.instructions {
            common["developerInstructions"] = json!(instructions);
        }
        // Reprise : Codex garde l’historique du fil, Alfred ne le renvoie pas.
        let thread = match &options.resume_session_id {
            Some(resume) => {
                common["threadId"] = json!(resume);
                common["excludeTurns"] = json!(true);
                self.rpc.request("thread/resume", typed::<g::ThreadResumeParams>(common)?).await?
            }
            None => {
                common["ephemeral"] = json!(options.one_shot);
                self.rpc.request("thread/start", typed::<g::ThreadStartParams>(common)?).await?
            }
        };
        let thread_id = thread["thread"]["id"].as_str().map(str::to_owned).ok_or_else(|| {
            protocol_error(if options.resume_session_id.is_some() { "reprendre la discussion" } else { "préparer la discussion" })
        })?;
        if let Ok(mut state) = self.inner.state.lock() {
            state.thread_id = Some(thread_id.clone());
        }
        self.inner.emit(HarnessEvent::Session { session_id: thread_id.clone() });
        if let (None, Some(title)) = (&options.resume_session_id, options.title.as_deref().map(str::trim).filter(|title| !title.is_empty())) {
            if let Ok(params) = typed::<g::ThreadSetNameParams>(json!({ "threadId": thread_id, "name": title })) {
                let _ = self.rpc.request("thread/name/set", params).await;
            }
        }
        self.inner.emit(HarnessEvent::status(SessionStatus::Ready));
        Ok(())
    }

    pub fn session_id(&self) -> Option<String> {
        self.inner.state.lock().ok().and_then(|state| state.thread_id.clone())
    }

    pub async fn send(&self, text: &str, files: &[InputFile], client_id: Option<&str>) -> AppResult<()> {
        let text = message_text(text, files);
        if text.is_empty() {
            return Ok(());
        }
        let thread = {
            let state = self.inner.state.lock().map_err(|_| unavailable())?;
            if state.closed {
                return Err(AppError::new("La discussion Codex est fermée."));
            }
            if state.turn_id.is_some() {
                return Err(AppError::new("Codex prépare déjà une réponse."));
            }
            state.thread_id.clone().ok_or_else(|| AppError::new("La discussion Codex est fermée."))?
        };
        self.inner.emit(HarnessEvent::status(SessionStatus::Responding));
        let (approval, _, sandbox_policy) = self.inner.policy();
        let options = &self.inner.options;
        let mut params = json!({
            "threadId": thread,
            "input": input(&text, files),
            "cwd": options.cwd,
            "approvalPolicy": approval,
            "sandboxPolicy": sandbox_policy,
        });
        if let Some(client) = client_id {
            params["clientUserMessageId"] = json!(client);
        }
        if let Some(model) = &options.model {
            params["model"] = json!(model);
        }
        if let Some(effort) = &options.effort {
            params["effort"] = json!(effort);
        }
        if let Some(schema) = &options.output_schema {
            params["outputSchema"] = schema.clone();
        }
        // L’échec remonte à l’appelant, qui termine le tour en erreur : aucune fin de tour n’est annoncée ici.
        let turn = self.rpc.request("turn/start", typed::<g::TurnStartParams>(params)?).await?;
        let turn = turn["turn"]["id"].as_str().map(str::to_owned).ok_or_else(|| protocol_error("démarrer la réponse"))?;
        if let Ok(mut state) = self.inner.state.lock() {
            state.turn_id = Some(turn);
        }
        Ok(())
    }

    pub async fn steer(&self, text: &str, files: &[InputFile], client_id: Option<&str>) -> AppResult<()> {
        let text = message_text(text, files);
        if text.is_empty() {
            return Ok(());
        }
        let (thread, turn) = {
            let state = self.inner.state.lock().map_err(|_| unavailable())?;
            match (&state.thread_id, &state.turn_id, state.closed) {
                (Some(thread), Some(turn), false) => (thread.clone(), turn.clone()),
                _ => return Err(AppError::new("Codex ne prépare plus de réponse à orienter.")),
            }
        };
        let mut params = json!({ "threadId": thread, "expectedTurnId": turn, "input": input(&text, files) });
        if let Some(client) = client_id {
            params["clientUserMessageId"] = json!(client);
        }
        self.rpc.request("turn/steer", typed::<g::TurnSteerParams>(params)?).await.map(|_| ())
    }

    pub fn answer(&self, approval: &str, option: &str) -> AppResult<()> {
        if !["accept", "acceptForSession", "decline"].contains(&option) {
            return Err(AppError::new("Réponse d’accord inconnue."));
        }
        let rpc_id = self
            .inner
            .state
            .lock()
            .map_err(|_| unavailable())?
            .approvals
            .remove(approval)
            .ok_or_else(|| AppError::new("Cette demande d’accord n’est plus en attente."))?;
        self.rpc.write(&json!({ "id": rpc_id, "result": { "decision": option } }))
    }

    pub async fn cancel(&self) -> AppResult<()> {
        self.inner.close_approvals(&self.rpc, Some("cancel"));
        let (thread, turn) = {
            let mut state = self.inner.state.lock().map_err(|_| unavailable())?;
            match (state.thread_id.clone(), state.turn_id.take(), state.closed) {
                (Some(thread), Some(turn), false) => {
                    state.interrupted.insert(turn.clone());
                    (thread, turn)
                }
                _ => return Ok(()),
            }
        };
        let result = match typed::<g::TurnInterruptParams>(json!({ "threadId": thread, "turnId": turn })) {
            Ok(params) => self.rpc.request("turn/interrupt", params).await.map(|_| ()),
            Err(error) => Err(error),
        };
        self.inner.emit(HarnessEvent::status(SessionStatus::Idle));
        result
    }

    pub fn close(&self) {
        let first = self.inner.state.lock().is_ok_and(|mut state| !std::mem::replace(&mut state.closed, true));
        self.rpc.terminate();
        if first {
            self.inner.emit(HarnessEvent::status(SessionStatus::Closed));
        }
    }
}

/// Lance un `codex app-server` de service, sans outils, le temps d’une lecture.
async fn utility<T>(program: &Path, cwd: &str, work: impl AsyncFnOnce(&Rpc) -> AppResult<T>) -> AppResult<T> {
    let rpc = connect(program, cwd, None, Vec::new(), |_, _| {}, |_| {}).await?;
    let result = work(&rpc).await;
    rpc.terminate();
    result
}

/// Catalogue des modèles du CLI installé.
pub async fn models(program: &Path, cwd: &str) -> AppResult<Vec<Model>> {
    utility(program, cwd, async |rpc: &Rpc| {
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        loop {
            let mut params = json!({ "limit": 100 });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let page = rpc.request("model/list", typed::<g::ModelListParams>(params)?).await?;
            for item in page["data"].as_array().into_iter().flatten() {
                let Some(id) = item["model"].as_str() else { continue };
                models.push(Model {
                    id: id.to_owned(),
                    name: item["displayName"].as_str().unwrap_or(id).to_owned(),
                    efforts: item["supportedReasoningEfforts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|effort| effort["reasoningEffort"].as_str().map(str::to_owned))
                        .collect(),
                });
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            match &cursor {
                Some(next) if seen.insert(next.clone()) && models.len() < 1000 => {}
                _ => break,
            }
        }
        Ok(models)
    })
    .await
}

/// Skills que Codex propose vraiment, comme OneApp : `skills/list` répond avec ceux du dossier et du compte. Les
/// skills désactivés sont écartés.
pub async fn skills(program: &Path, cwd: &str) -> AppResult<Vec<Value>> {
    utility(program, cwd, async |rpc: &Rpc| {
        let result = rpc
            .request("skills/list", typed::<g::SkillsListParams>(json!({ "cwds": [cwd], "forceReload": true }))?)
            .await?;
        let listed: Option<g::SkillsListResponse> = read(&result);
        let skills = listed
            .map(|listed| {
                listed
                    .data
                    .into_iter()
                    .flat_map(|entry| entry.skills)
                    .filter(|skill| skill.enabled)
                    .map(|skill| {
                        let mut reference = json!({ "kind": "skill", "name": skill.name, "path": status_text(&skill.path) });
                        if !skill.description.is_empty() {
                            reference["description"] = json!(skill.description);
                        }
                        reference
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(skills)
    })
    .await
}

/// `agents.skills` : skills de Codex pour le compositeur (`$`, `/`).
pub async fn skills_command(args: &Value) -> AppResult<Value> {
    let cwd: String = arg(args, "cwd")?;
    super::checked_dir(&cwd)?;
    let program = super::resolve_program("codex").ok_or_else(|| super::missing(super::Provider::Codex))?;
    Ok(Value::Array(skills(&program, &cwd).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_update_becomes_the_plan() {
        let params = json!({ "threadId": "t", "turnId": "u", "explanation": null, "plan": [
            { "step": "Lire le guide", "status": "completed" },
            { "step": "Créer la page", "status": "inProgress" },
            { "step": "Vérifier", "status": "pending" },
        ] });
        assert_eq!(
            plan_from_update(&params).unwrap(),
            vec![
                PlanStep { text: "Lire le guide".into(), status: PlanStatus::Completed },
                PlanStep { text: "Créer la page".into(), status: PlanStatus::InProgress },
                PlanStep { text: "Vérifier".into(), status: PlanStatus::Pending },
            ]
        );
        assert_eq!(plan_from_update(&json!({})), None);
    }

    #[test]
    fn modes_become_codex_policies() {
        let roots = vec!["/projet".to_string()];
        let (approval, sandbox, turn) = policy(Autonomy::Workspace, &roots, false, false);
        assert_eq!((approval, sandbox), (json!("on-request"), json!("workspace-write")));
        assert_eq!(
            turn,
            json!({ "type": "workspaceWrite", "writableRoots": ["/projet"], "networkAccess": false,
                    "excludeSlashTmp": true, "excludeTmpdirEnvVar": true })
        );
        assert_eq!(policy(Autonomy::Auto, &roots, false, false).1, json!("danger-full-access"));
        assert_eq!(policy(Autonomy::Strict, &roots, false, false).0, json!("untrusted"));
        assert_eq!(policy(Autonomy::Ask, &roots, false, false).0, json!("on-request"));
        assert_eq!(policy(Autonomy::Ask, &roots, false, true).1, json!("danger-full-access"));
        assert_eq!(policy(Autonomy::Workspace, &roots, false, true).1, json!("workspace-write"));
        assert_eq!(policy(Autonomy::Auto, &roots, true, false).1, json!("read-only"));
    }

    #[test]
    fn sent_parameters_are_checked_by_the_generated_types() {
        assert!(typed::<g::TurnStartParams>(json!({ "threadId": "t", "input": input("Bonjour", &[]) })).is_ok());
        assert!(typed::<g::TurnStartParams>(json!({ "input": "pas une liste" })).is_err());
        let files = [
            InputFile { path: "/tmp/a.png".into(), name: "a.png".into(), mime_type: None },
            InputFile { path: "/tmp/b.pdf".into(), name: "b.pdf".into(), mime_type: None },
        ];
        let sent = input("Regarde", &files);
        assert_eq!(sent[1], json!({ "type": "localImage", "path": "/tmp/a.png" }));
        assert!(sent[0]["text"].as_str().unwrap().ends_with("Fichiers joints :\n- /tmp/b.pdf"));
    }

    #[test]
    fn thread_items_become_activities() {
        let item: g::ThreadItem = serde_json::from_value(json!({
            "type": "fileChange", "id": "f1", "status": "completed",
            "changes": [
                { "path": "a.txt", "kind": { "type": "update" }, "diff": "--- a\n+++ b\n-x\n+y\n+z\n" },
                { "path": "rapport.pdf", "kind": { "type": "add" }, "diff": "1\n2\n" }
            ]
        }))
        .unwrap();
        let activity = activity_from_item(&item, true).unwrap();
        assert_eq!(activity.kind, ActivityKind::File);
        let actions = activity.actions.unwrap();
        assert_eq!((actions[0].added, actions[0].removed), (Some(2), Some(1)));
        assert_eq!((actions[1].added, actions[1].removed), (Some(2), Some(0)));
        assert_eq!(activity.files, Some(vec!["rapport.pdf".to_string()]));

        let command: g::ThreadItem = serde_json::from_value(json!({
            "type": "commandExecution", "id": "c1", "command": "cat a.txt", "cwd": "/projet", "status": "inProgress",
            "source": "agent", "commandActions": [{ "type": "read", "command": "cat a.txt", "name": "a.txt", "path": "/projet/a.txt" }]
        }))
        .unwrap();
        let activity = activity_from_item(&command, false).unwrap();
        assert_eq!(activity.status, ActivityStatus::Running);
        assert_eq!(activity.actions.unwrap()[0].path.as_deref(), Some("/projet/a.txt"));
    }

    #[test]
    fn commands_and_spawned_agents_become_tasks() {
        let mut tasks = HashMap::new();
        let item = |value: Value| serde_json::from_value::<g::ThreadItem>(value).unwrap();
        let running = item(json!({ "type": "commandExecution", "id": "c1", "command": "npm run dev\n", "cwd": "/projet",
            "status": "inProgress", "source": "agent", "commandActions": [] }));
        let task = track_tasks(&mut tasks, &running, false).pop().unwrap();
        assert_eq!((task.kind, task.title.as_str(), task.background, task.stoppable), (TaskKind::Command, "npm run dev", false, false));
        let failed = item(json!({ "type": "commandExecution", "id": "c1", "command": "npm run dev", "cwd": "/projet",
            "status": "failed", "exitCode": 1, "source": "agent", "commandActions": [] }));
        assert_eq!(track_tasks(&mut tasks, &failed, true)[0].status, TaskStatus::Failed);
        assert!(tasks.is_empty());

        let spawn = item(json!({ "type": "collabAgentToolCall", "id": "s1", "tool": "spawnAgent", "status": "completed",
            "prompt": "Relis le module\npuis réponds", "senderThreadId": "t0", "receiverThreadIds": ["t1"],
            "agentsStates": { "t1": { "status": "pendingInit" } } }));
        let agent = track_tasks(&mut tasks, &spawn, true).pop().unwrap();
        assert_eq!((agent.kind, agent.title.as_str(), agent.background, agent.status), (TaskKind::Agent, "Relis le module", true, TaskStatus::Running));
        let wait = item(json!({ "type": "collabAgentToolCall", "id": "w1", "tool": "wait", "status": "completed",
            "senderThreadId": "t0", "receiverThreadIds": ["t1"], "agentsStates": { "t1": { "status": "completed", "message": "ok" } } }));
        assert_eq!(track_tasks(&mut tasks, &wait, true)[0].status, TaskStatus::Completed);
        assert!(tasks.is_empty());
    }
}
