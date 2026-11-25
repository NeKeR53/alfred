//! Claude Code : `claude -p` en `stream-json` dans les deux sens. Le processus reste ouvert d’un message à l’autre ;
//! les demandes d’autorisation arrivent comme requêtes de contrôle (`can_use_tool`) et repartent comme réponses.
//! Aucun schéma n’est publié : les messages sont lus d’après les types du SDK, et un message inconnu est ignoré.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::event::{
    with_reason, ActionType, Activity, ActivityAction, ActivityKind, ActivityStatus, ApprovalOption, ApprovalRequest,
    now_ms, plan_from_todos, AgentTask, HarnessEvent, OptionKind, SessionStatus, TaskKind, TaskStatus,
};
use super::process::{unavailable, LineProcess};
use super::session::{attached_list, message_text, write_prompt, Autonomy, InputFile, Launch, Sink};
use super::{checked_dir, command, simple_value, MCP_TOKEN_ENV};
use crate::error::{AppError, AppResult};

const ALFRED_TOOL_PREFIX: &str = "mcp__alfred__";
/// Liste de tâches de Claude Code : son plan, montré dans le panneau de la conversation et non dans le relevé.
const PLAN_TOOL: &str = "TodoWrite";

/// Ce que devient un appel d’outil de Claude Code.
#[derive(Debug, PartialEq)]
pub(super) enum ToolUse {
    Activity(Activity),
    /// Mise à jour du plan (`TodoWrite`).
    Plan(HarnessEvent),
    /// Appel sans intérêt pour l’utilisateur : le chargement de l’outil de plan (`ToolSearch` « select:TodoWrite »).
    Hidden,
}

pub(super) fn tool_use(id: &str, name: &str, input: &Value) -> ToolUse {
    if name == PLAN_TOOL {
        return match plan_from_todos(input) {
            Some(steps) => ToolUse::Plan(HarnessEvent::Plan { steps }),
            None => ToolUse::Hidden,
        };
    }
    if name == "ToolSearch" && input["query"].as_str().is_some_and(|query| query.contains(PLAN_TOOL)) {
        return ToolUse::Hidden;
    }
    ToolUse::Activity(tool_activity(id, name, input))
}

/// Options de lancement de Claude Code, construites par Rust depuis les options validées de la session.
#[derive(Debug, Default)]
pub(super) struct ClaudeOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Session à reprendre.
    pub resume: Option<String>,
    /// `manual`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`.
    pub permission_mode: Option<String>,
    pub add_dirs: Vec<String>,
    pub append_system_prompt: Option<String>,
    /// Appel unique : aucun outil, aucune demande d’autorisation, rien n’est gardé dans l’historique du CLI.
    pub one_shot: bool,
    pub json_schema: Option<Value>,
    /// Mode espace de travail : les commandes passent par le bac à sable de Claude Code, bornées au dossier.
    pub sandbox: bool,
}

/// Mode d’autorisation de Claude Code pour une autonomie.
pub(super) fn permission_mode(autonomy: Autonomy) -> &'static str {
    match autonomy {
        Autonomy::Auto => "bypassPermissions",
        Autonomy::Strict => "manual",
        // Les écritures dans les dossiers de travail passent ; le reste demande un accord (ou est refusé).
        Autonomy::Ask | Autonomy::Workspace => "acceptEdits",
    }
}

pub(super) fn claude_arguments(
    options: &ClaudeOptions,
    mcp_port: Option<u16>,
    prompt_file: Option<&Path>,
) -> AppResult<Vec<String>> {
    let mut args: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    if let Some(model) = &options.model {
        simple_value("modèle", model)?;
        args.extend(["--model".to_string(), model.clone()]);
    }
    if let Some(effort) = &options.effort {
        if !["low", "medium", "high", "xhigh", "max"].contains(&effort.as_str()) {
            return Err(AppError::new("Niveau d’effort inconnu."));
        }
        args.extend(["--effort".to_string(), effort.clone()]);
    }
    if let Some(prompt) = &options.append_system_prompt {
        if prompt.len() > 200_000 {
            return Err(AppError::new("Les consignes de l’agent sont trop longues."));
        }
        let file = prompt_file.ok_or_else(|| AppError::new("Les consignes de l’agent n’ont pas pu être préparées."))?;
        args.extend(["--append-system-prompt-file".to_string(), file.to_string_lossy().to_string()]);
    }
    if options.one_shot {
        // Aucun outil, aucune question, aucune trace : une transformation bornée, en un tour.
        args.extend(
            ["--tools", "", "--strict-mcp-config", "--permission-prompts", "none", "--no-session-persistence"]
                .iter()
                .map(|value| value.to_string()),
        );
        if let Some(schema) = &options.json_schema {
            args.extend(["--json-schema".to_string(), schema.to_string()]);
        }
        return Ok(args);
    }
    args.extend(["--include-partial-messages", "--permission-prompt-tool", "stdio"].iter().map(|v| v.to_string()));
    if let Some(resume) = &options.resume {
        if uuid::Uuid::parse_str(resume).is_err() {
            return Err(AppError::new("Identifiant de session Claude Code invalide."));
        }
        args.extend(["--resume".to_string(), resume.clone()]);
    }
    let mode = options.permission_mode.as_deref().unwrap_or("manual");
    if !["manual", "acceptEdits", "bypassPermissions", "plan", "dontAsk"].contains(&mode) {
        return Err(AppError::new("Mode d’autorisation inconnu."));
    }
    args.extend(["--permission-mode".to_string(), mode.to_string()]);
    for dir in &options.add_dirs {
        args.extend(["--add-dir".to_string(), checked_dir(dir)?.to_string()]);
    }
    if options.sandbox {
        // Bac à sable du système (Seatbelt sous macOS) : les commandes n’écrivent que dans le dossier de travail et
        // passent sans demande ; ce qui en sortirait reste refusé.
        let settings = json!({ "sandbox": { "enabled": true, "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false } });
        args.extend(["--settings".to_string(), settings.to_string()]);
    }
    if let Some(port) = mcp_port {
        // Le jeton n’est jamais sur la ligne de commande, lisible par tout processus du poste : Claude Code résout
        // `${ALFRED_MCP_TOKEN}` depuis son environnement, où il a été placé.
        let config = json!({ "mcpServers": { "alfred": {
            "type": "http",
            "url": format!("http://127.0.0.1:{port}/mcp"),
            "headers": { "Authorization": format!("Bearer ${{{MCP_TOKEN_ENV}}}") },
        }}});
        args.extend(["--mcp-config".to_string(), config.to_string()]);
    }
    Ok(args)
}

fn text(value: &Value) -> Option<&str> {
    value.as_str()
}

/// Activité affichée pour un appel d’outil de Claude Code.
pub(super) fn tool_activity(id: &str, name: &str, input: &Value) -> Activity {
    let path = text(&input["file_path"]).or(text(&input["path"])).or(text(&input["notebook_path"]));
    let pattern = text(&input["pattern"]);
    let running = |kind, title: &str| Activity::new(id, kind, title, ActivityStatus::Running);
    match name {
        "Bash" | "PowerShell" => running(ActivityKind::Command, "Commande").detail(text(&input["command"])).actions(vec![]),
        "Read" => running(ActivityKind::Command, "Lecture")
            .detail(path)
            .actions(vec![ActivityAction::new(ActionType::Read).with_path(path)]),
        "Glob" | "LS" => running(ActivityKind::Command, "Recherche")
            .detail(pattern.or(path))
            .actions(vec![ActivityAction::new(ActionType::ListFiles).with_path(path).with_query(pattern)]),
        "Grep" => {
            let detail = [pattern, path].into_iter().flatten().collect::<Vec<_>>().join(" · ");
            running(ActivityKind::Command, "Recherche")
                .detail(Some(detail))
                .actions(vec![ActivityAction::new(ActionType::Search).with_query(pattern).with_path(path)])
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => running(ActivityKind::File, "Modification de fichiers")
            .detail(path)
            .actions(path.map(|path| vec![ActivityAction::new(ActionType::Edit).with_path(Some(path))]).unwrap_or_default()),
        "WebSearch" | "WebFetch" => {
            running(ActivityKind::Search, "Recherche web").detail(text(&input["query"]).or(text(&input["url"])))
        }
        "Task" | "Agent" => {
            running(ActivityKind::Agent, "Agent · délégation").detail(text(&input["description"]).or(text(&input["prompt"])))
        }
        _ => {
            let title = if let Some(tool) = name.strip_prefix(ALFRED_TOOL_PREFIX) {
                format!("Outil · Alfred / {tool}")
            } else if let Some((server, tool)) = name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
                format!("Outil · {server} / {tool}")
            } else {
                format!("Outil · {name}")
            };
            running(ActivityKind::Tool, &title).detail(super::content::pretty(input))
        }
    }
}

fn result_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> =
                blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn approval_for(id: &str, tool: &str, input: &Value, can_remember: bool) -> ApprovalRequest {
    let path = text(&input["file_path"]).or(text(&input["path"]));
    let title = match tool {
        "Bash" | "PowerShell" => "Exécuter une commande".to_string(),
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" if path.is_some() => {
            "Modifier un fichier".to_string()
        }
        "WebFetch" | "WebSearch" => "Accéder au web".to_string(),
        _ => format!("Utiliser l’outil {tool}"),
    };
    let detail = text(&input["command"]).or(path).or(text(&input["url"])).map(str::to_owned).or_else(|| super::content::pretty(input));
    let mut options = vec![ApprovalOption::new("allow", "Autoriser", OptionKind::Allow)];
    if can_remember {
        options.push(ApprovalOption::new("allowAlways", "Toujours autoriser", OptionKind::AllowAlways));
    }
    options.push(ApprovalOption::new("deny", "Refuser", OptionKind::Deny));
    ApprovalRequest { id: id.into(), title, detail, options }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Text,
    Thinking,
    Other,
}

struct Pending {
    request_id: String,
    input: Value,
    suggestions: Option<Value>,
}

#[derive(Default)]
struct State {
    session_id: Option<String>,
    closed: bool,
    responding: bool,
    sequence: u64,
    /// Message en cours de diffusion et type de chacun de ses blocs.
    stream_message: Option<String>,
    streamed: HashSet<String>,
    blocks: HashMap<i64, Block>,
    activities: HashMap<String, Activity>,
    /// Réflexions ouvertes, terminées à leur `content_block_stop`.
    thinking: HashSet<String>,
    approvals: HashMap<String, Pending>,
    /// Motif d’un message d’erreur synthétique du CLI (non connecté, quota).
    cli_error: Option<String>,
    /// Tâches de l’agent en cours (`task_started`), par identifiant de tâche du CLI.
    tasks: HashMap<String, AgentTask>,
    /// Requêtes de contrôle d’Alfred (`stop_task`) qui attendent leur réponse.
    controls: HashMap<String, tokio::sync::oneshot::Sender<Result<(), String>>>,
}

/// État d’une tâche lu dans Claude Code : `completed`, `failed`, `stopped` (ou `killed` dans un `task_updated`).
fn task_status(status: &str) -> Option<TaskStatus> {
    match status {
        "running" | "pending" => Some(TaskStatus::Running),
        "completed" => Some(TaskStatus::Completed),
        "failed" => Some(TaskStatus::Failed),
        "stopped" | "killed" => Some(TaskStatus::Stopped),
        _ => None,
    }
}

/// Suit les tâches de Claude Code 2.1 (`system` : `task_started`, `task_updated`, `task_notification`) et rend la tâche
/// changée. Une commande lancée avec `run_in_background`, un sous-agent (`Agent`) et toute commande Bash sont des
/// tâches ; celles d’un sous-agent (`parent_task_id`) restent avec lui et ne sont pas suivies. Format relevé le
/// 2026-11-25 avec `claude` 2.1.323 (`tests_reel::claude_taches_de_fond`).
pub(super) fn track_task(tasks: &mut HashMap<String, AgentTask>, message: &Value) -> Option<AgentTask> {
    let id = message["task_id"].as_str()?;
    match message["subtype"].as_str()? {
        "task_started" => {
            if message["parent_task_id"].is_string() || message["owned_by_subagent"] == true {
                return None;
            }
            let kind = if message["task_type"] == "local_agent" { TaskKind::Agent } else { TaskKind::Command };
            let title = message["description"].as_str().map(str::trim).filter(|text| !text.is_empty()).unwrap_or("Tâche");
            let task = AgentTask {
                task_id: id.to_owned(),
                kind,
                title: title.to_owned(),
                background: message["is_backgrounded"] == true,
                status: TaskStatus::Running,
                started_at: now_ms(),
                ended_at: None,
                stoppable: true,
            };
            tasks.insert(id.to_owned(), task.clone());
            Some(task)
        }
        "task_updated" => {
            let patch = &message["patch"];
            let task = tasks.get_mut(id)?;
            let before = task.clone();
            if let Some(background) = patch["is_backgrounded"].as_bool() {
                task.background = background;
            }
            if let Some(status) = patch["status"].as_str().and_then(task_status).filter(|status| status.finished()) {
                task.finish(status, patch["end_time"].as_u64());
            }
            let task = task.clone();
            if task.status.finished() {
                tasks.remove(id);
            }
            (task != before).then_some(task)
        }
        "task_notification" => {
            let mut task = tasks.remove(id)?;
            let status = message["status"].as_str().and_then(task_status).unwrap_or(TaskStatus::Completed);
            if !task.status.finished() {
                task.finish(if status.finished() { status } else { TaskStatus::Completed }, None);
            }
            Some(task)
        }
        _ => None,
    }
}

/// Décision de Rust sur une demande d’autorisation, avant toute carte.
#[derive(Debug, PartialEq)]
enum Decision {
    Allow,
    Deny(&'static str),
    Ask,
}

fn decide(tool: &str, autonomy: Autonomy, one_shot: bool) -> Decision {
    if tool.starts_with(ALFRED_TOOL_PREFIX) {
        // Les outils d’Alfred sont les siens : pas de question pour s’en servir.
        return Decision::Allow;
    }
    if tool == PLAN_TOOL && !one_shot {
        // Le plan ne touche à rien : il ne demande jamais d’accord.
        return Decision::Allow;
    }
    if tool == "AskUserQuestion" {
        return Decision::Deny("Pose ta question directement dans ta réponse : l’utilisateur te répondra dans la conversation.");
    }
    if one_shot {
        return Decision::Deny("Aucun outil n’est disponible pour cet appel.");
    }
    match autonomy {
        Autonomy::Auto => Decision::Allow,
        Autonomy::Workspace => Decision::Deny("Refusé : en mode espace de travail, tu n’agis que dans ton dossier de travail."),
        Autonomy::Ask | Autonomy::Strict => Decision::Ask,
    }
}

pub struct Claude {
    process: Arc<LineProcess>,
    inner: Arc<Inner>,
}

struct Inner {
    sink: Sink,
    autonomy: Autonomy,
    one_shot: bool,
    state: Mutex<State>,
    process: Mutex<Option<std::sync::Weak<LineProcess>>>,
}

impl Inner {
    fn emit(&self, event: HarnessEvent) {
        self.sink.emit(event);
    }

    fn write(&self, message: &Value) -> AppResult<()> {
        let process = self.process.lock().ok().and_then(|process| process.clone()).and_then(|weak| weak.upgrade());
        process.ok_or_else(unavailable)?.write(message)
    }

    fn respond(&self, request_id: &str, response: Value) -> AppResult<()> {
        self.write(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }))
    }

    fn handle_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match message["type"].as_str() {
            Some("system") if message["task_id"].is_string() => {
                let task = self.state.lock().ok().and_then(|mut state| track_task(&mut state.tasks, &message));
                if let Some(task) = task {
                    self.emit(HarnessEvent::Task(task));
                }
            }
            Some("control_response") => {
                let response = &message["response"];
                let Some(id) = response["request_id"].as_str() else { return };
                let waiting = self.state.lock().ok().and_then(|mut state| state.controls.remove(id));
                if let Some(waiting) = waiting {
                    let outcome = if response["subtype"] == "success" {
                        Ok(())
                    } else {
                        Err(response["error"].as_str().unwrap_or("refus du CLI").to_owned())
                    };
                    let _ = waiting.send(outcome);
                }
            }
            Some("system") => {
                let id = message["session_id"].as_str();
                if message["subtype"] == "init" {
                    if let Some(id) = id {
                        let fresh = self.state.lock().is_ok_and(|mut state| {
                            let fresh = state.session_id.as_deref() != Some(id);
                            state.session_id = Some(id.to_owned());
                            fresh
                        });
                        if fresh {
                            self.emit(HarnessEvent::Session { session_id: id.to_owned() });
                        }
                    }
                }
            }
            Some("stream_event") => self.handle_stream(&message["event"]),
            Some("assistant") => self.handle_assistant(&message["message"], &message["error"]),
            Some("user") => self.handle_tool_results(&message["message"]["content"]),
            Some("control_request") => {
                self.handle_control(message["request_id"].as_str().unwrap_or_default(), &message["request"])
            }
            Some("result") => self.handle_result(&message),
            _ => {}
        }
    }

    fn handle_stream(&self, event: &Value) {
        let mut out = Vec::new();
        {
            let Ok(mut state) = self.state.lock() else { return };
            if event["type"] == "message_start" {
                state.stream_message = event["message"]["id"].as_str().map(str::to_owned);
                state.blocks.clear();
                return;
            }
            let Some(message_id) = state.stream_message.clone() else { return };
            let index = event["index"].as_i64().unwrap_or(0);
            let item = format!("{message_id}-{index}");
            match event["type"].as_str() {
                Some("content_block_start") => {
                    let block = match event["content_block"]["type"].as_str() {
                        Some("text") => Block::Text,
                        Some("thinking") => Block::Thinking,
                        _ => Block::Other,
                    };
                    state.blocks.insert(index, block);
                    if block == Block::Thinking {
                        state.thinking.insert(item.clone());
                        out.push(HarnessEvent::Activity(Activity::new(
                            item,
                            ActivityKind::Analysis,
                            "Analyse",
                            ActivityStatus::Running,
                        )));
                    }
                }
                Some("content_block_delta") => {
                    let delta = &event["delta"];
                    match (delta["type"].as_str(), delta["text"].as_str(), delta["thinking"].as_str()) {
                        (Some("text_delta"), Some(text), _) if !text.is_empty() => {
                            state.streamed.insert(message_id);
                            out.push(HarnessEvent::text(item, text, false));
                        }
                        (Some("thinking_delta"), _, Some(thinking)) if !thinking.is_empty() => {
                            out.push(HarnessEvent::delta(item, thinking));
                        }
                        _ => {}
                    }
                }
                Some("content_block_stop") if state.blocks.get(&index) == Some(&Block::Thinking) => {
                    state.thinking.remove(&item);
                    out.push(HarnessEvent::Activity(Activity::new(
                        item,
                        ActivityKind::Analysis,
                        "Analyse",
                        ActivityStatus::Completed,
                    )));
                }
                _ => {}
            }
        }
        for event in out {
            self.emit(event);
        }
    }

    fn handle_assistant(&self, message: &Value, error: &Value) {
        let mut out = Vec::new();
        {
            let Ok(mut state) = self.state.lock() else { return };
            state.sequence += 1;
            let message_id = message["id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("message-{}", state.sequence));
            let blocks = message["content"].as_array().cloned().unwrap_or_default();
            // Sans compte connecté ou sur un refus de l’API, le CLI fabrique un message assistant qui porte l’erreur :
            // ce n’est pas une réponse de l’agent, le résultat en erreur qui suit l’affiche.
            if !error.is_null() || message["model"] == "<synthetic>" {
                let reason: Vec<&str> =
                    blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect();
                if !reason.is_empty() {
                    state.cli_error = Some(reason.join("\n"));
                }
                return;
            }
            for (index, block) in blocks.iter().enumerate() {
                match (block["type"].as_str(), block["id"].as_str()) {
                    (Some("tool_use"), Some(id)) => {
                        match tool_use(id, block["name"].as_str().unwrap_or("outil"), &block["input"]) {
                            ToolUse::Activity(activity) => {
                                state.activities.insert(id.to_owned(), activity.clone());
                                out.push(HarnessEvent::Activity(activity));
                            }
                            ToolUse::Plan(plan) => out.push(plan),
                            ToolUse::Hidden => {}
                        }
                    }
                    (Some("text"), _) if !state.streamed.contains(&message_id) => {
                        if let Some(text) = block["text"].as_str().filter(|text| !text.is_empty()) {
                            // Message arrivé sans diffusion (erreur du CLI, reprise) : son texte complet.
                            out.push(HarnessEvent::text(format!("{message_id}-text-{index}"), text, true));
                        }
                    }
                    _ => {}
                }
            }
        }
        for event in out {
            self.emit(event);
        }
    }

    fn handle_tool_results(&self, content: &Value) {
        let mut out = Vec::new();
        if let Ok(mut state) = self.state.lock() {
            for block in content.as_array().into_iter().flatten() {
                let Some(id) = block["tool_use_id"].as_str() else { continue };
                if block["type"] != "tool_result" {
                    continue;
                }
                let Some(mut activity) = state.activities.remove(id) else { continue };
                if let Some(output) = result_text(&block["content"]) {
                    activity.content = Some(output);
                }
                activity.status =
                    if block["is_error"] == true { ActivityStatus::Failed } else { ActivityStatus::Completed };
                out.push(HarnessEvent::Activity(activity));
            }
        }
        for event in out {
            self.emit(event);
        }
    }

    fn handle_control(&self, request_id: &str, request: &Value) {
        if request["subtype"] != "can_use_tool" {
            let _ = self.write(&json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "Requête non prise en charge par Alfred." } }));
            return;
        }
        let tool = request["tool_name"].as_str().unwrap_or("outil");
        let input = request["input"].clone();
        match decide(tool, self.autonomy, self.one_shot) {
            Decision::Allow => {
                let _ = self.respond(request_id, json!({ "behavior": "allow", "updatedInput": input }));
            }
            Decision::Deny(message) => {
                let _ = self.respond(request_id, json!({ "behavior": "deny", "message": message }));
            }
            Decision::Ask => {
                let id = format!("claude-{request_id}");
                let suggestions = request["permission_suggestions"]
                    .as_array()
                    .filter(|suggestions| !suggestions.is_empty())
                    .map(|suggestions| Value::Array(suggestions.clone()));
                let card = approval_for(&id, tool, &input, suggestions.is_some());
                if let Ok(mut state) = self.state.lock() {
                    state.approvals.insert(id, Pending { request_id: request_id.to_owned(), input, suggestions });
                }
                self.emit(HarnessEvent::Approval { request: card });
            }
        }
    }

    /// Fin de tour (résultat, interruption, arrêt) : une réflexion ou un outil resté sans suite ne reste pas en cours.
    /// Un outil sans résultat a été interrompu : il est « Arrêté », et non en échec.
    fn settle(state: &mut State) -> Vec<HarnessEvent> {
        let mut out: Vec<HarnessEvent> =
            state.approvals.drain().map(|(id, _)| HarnessEvent::ApprovalClosed { id }).collect();
        out.extend(state.thinking.drain().map(|item| {
            HarnessEvent::Activity(Activity::new(item, ActivityKind::Analysis, "Analyse", ActivityStatus::Completed))
        }));
        out.extend(state.activities.drain().map(|(_, mut activity)| {
            activity.status = ActivityStatus::Cancelled;
            HarnessEvent::Activity(activity)
        }));
        out
    }

    fn handle_result(&self, message: &Value) {
        let mut out;
        {
            let Ok(mut state) = self.state.lock() else { return };
            state.responding = false;
            let cli_error = state.cli_error.take();
            out = Self::settle(&mut state);
            if !message["structured_output"].is_null() {
                out.push(HarnessEvent::Structured { value: message["structured_output"].clone() });
            }
            let subtype = message["subtype"].as_str().unwrap_or("success");
            if message["is_error"] == true || subtype != "success" {
                let errors = message["errors"]
                    .as_array()
                    .map(|errors| errors.iter().map(|error| error.as_str().map(str::to_owned).unwrap_or_else(|| error.to_string())).collect::<Vec<_>>().join(" · "))
                    .filter(|text| !text.is_empty());
                let reason = message["result"].as_str().filter(|text| !text.is_empty()).map(str::to_owned).or(errors).or(cli_error);
                // Une interruption demandée n’est pas une erreur à afficher.
                if subtype != "error_during_execution" || reason.is_some() {
                    out.push(HarnessEvent::error(with_reason("Claude Code n’a pas pu terminer sa réponse", reason.as_deref())));
                }
            }
            out.push(HarnessEvent::status(SessionStatus::Idle));
        }
        for event in out {
            self.emit(event);
        }
    }

    fn handle_exit(&self, reason: Option<String>) {
        let out = {
            let Ok(mut state) = self.state.lock() else { return };
            if state.closed {
                return;
            }
            state.closed = true;
            let mut out = Self::settle(&mut state);
            // Les tâches de fond meurent avec le CLI.
            out.extend(state.tasks.drain().map(|(_, mut task)| {
                task.finish(TaskStatus::Stopped, None);
                HarnessEvent::Task(task)
            }));
            state.controls.clear();
            out
        };
        for event in out {
            self.emit(event);
        }
        self.emit(HarnessEvent::error(format!(
            "Claude Code s’est arrêté{}. Envoyer un message relance la conversation.",
            reason.map(|reason| format!(" : {reason}")).unwrap_or_default()
        )));
        self.emit(HarnessEvent::status(SessionStatus::Closed));
    }
}

impl Claude {
    pub fn start(launch: Launch) -> AppResult<Arc<Self>> {
        let options = &launch.options;
        launch.sink.emit(HarnessEvent::status(SessionStatus::Connecting));
        let prompt = match &options.instructions {
            Some(text) => Some(write_prompt(&launch.state, &launch.handle, text)?),
            None => None,
        };
        let roots = options.roots();
        let claude = ClaudeOptions {
            model: options.model.clone(),
            effort: options.effort.clone(),
            resume: options.resume_session_id.clone(),
            permission_mode: Some(permission_mode(options.autonomy).into()),
            add_dirs: roots.into_iter().filter(|root| *root != options.cwd).collect(),
            append_system_prompt: options.instructions.clone(),
            one_shot: options.one_shot,
            json_schema: options.output_schema.clone(),
            sandbox: options.autonomy == Autonomy::Workspace,
        };
        let mut command = command(&launch.program, Some(&options.cwd));
        command.args(claude_arguments(&claude, launch.token.as_ref().map(|_| launch.port), prompt.as_deref())?);
        if let Some(token) = &launch.token {
            command.env(MCP_TOKEN_ENV, token);
        }
        if !options.one_shot {
            // Claude Code 2.1 ne donne sa liste de tâches (`TodoWrite`) qu’aux anciens modèles : Alfred la demande pour
            // tous, sous sa forme d’une seule liste, plutôt que les outils `TaskCreate`/`TaskUpdate`.
            command.env("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1").env("CLAUDE_CODE_ENABLE_TASKS", "0");
        }
        let inner = Arc::new(Inner {
            sink: launch.sink.clone(),
            autonomy: options.autonomy,
            one_shot: options.one_shot,
            state: Mutex::new(State::default()),
            process: Mutex::new(None),
        });
        let (reader, exiting) = (inner.clone(), inner.clone());
        let forget = launch.on_exit();
        let process = LineProcess::spawn(
            &mut command,
            "claude",
            move |line| reader.handle_line(line),
            move |_| {
                let process = exiting.process.lock().ok().and_then(|slot| slot.clone()).and_then(|weak| weak.upgrade());
                let reason = process.and_then(|process| process.stderr_reason());
                exiting.handle_exit(reason);
                forget();
            },
        )?;
        if let Ok(mut slot) = inner.process.lock() {
            *slot = Some(Arc::downgrade(&process));
        }
        // Le CLI n’annonce sa session qu’au premier message : il est prêt dès qu’il est lancé.
        launch.sink.emit(HarnessEvent::status(SessionStatus::Ready));
        Ok(Arc::new(Self { process, inner }))
    }

    pub fn send(&self, text: &str, files: &[InputFile]) -> AppResult<()> {
        let body = message_text(text, files);
        if body.is_empty() {
            return Ok(());
        }
        {
            let mut state = self.inner.state.lock().map_err(|_| unavailable())?;
            if state.closed {
                return Err(AppError::new("La conversation Claude Code est fermée."));
            }
            if state.responding {
                return Err(AppError::new("Claude Code prépare déjà une réponse."));
            }
            state.responding = true;
        }
        self.inner.emit(HarnessEvent::status(SessionStatus::Responding));
        // Les fichiers joints sont cités par leur chemin : Claude Code les lit lui-même, images comprises.
        let attached = attached_list(&files.iter().collect::<Vec<_>>());
        let written = self.process.write(&json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": format!("{body}{attached}") }] },
            "parent_tool_use_id": null,
        }));
        if written.is_err() {
            // L’échec remonte à l’appelant, qui termine le tour en erreur.
            if let Ok(mut state) = self.inner.state.lock() {
                state.responding = false;
            }
        }
        written
    }

    /// Message envoyé pendant que Claude Code travaille : il est écrit tout de suite dans le flux, sans arrêter le
    /// tour. Claude Code le prend entre deux étapes (après l’outil en cours), répond et poursuit sa tâche, et le tour
    /// se termine par un seul résultat (essai réel du 2026-11-24, `claude` 2.1 en `stream-json`). Hors réponse, c’est
    /// un envoi ordinaire.
    pub fn steer(&self, text: &str, files: &[InputFile]) -> AppResult<()> {
        let body = message_text(text, files);
        if body.is_empty() {
            return Ok(());
        }
        {
            let state = self.inner.state.lock().map_err(|_| unavailable())?;
            if state.closed {
                return Err(AppError::new("La conversation Claude Code est fermée."));
            }
            if !state.responding {
                drop(state);
                return self.send(text, files);
            }
        }
        let attached = attached_list(&files.iter().collect::<Vec<_>>());
        self.process.write(&json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": format!("{body}{attached}") }] },
            "parent_tool_use_id": null,
        }))
    }

    pub fn answer(&self, approval: &str, option: &str) -> AppResult<()> {
        let pending = self
            .inner
            .state
            .lock()
            .map_err(|_| unavailable())?
            .approvals
            .remove(approval)
            .ok_or_else(|| AppError::new("Cette demande d’accord n’est plus en attente."))?;
        let response = match option {
            "deny" => json!({ "behavior": "deny", "message": "Refusé par l’utilisateur." }),
            "allow" | "allowAlways" => {
                let mut allow = json!({ "behavior": "allow", "updatedInput": pending.input });
                if let (true, Some(suggestions)) = (option == "allowAlways", pending.suggestions) {
                    allow["updatedPermissions"] = suggestions;
                }
                allow
            }
            _ => return Err(AppError::new("Réponse d’accord inconnue.")),
        };
        self.inner.respond(&pending.request_id, response)
    }

    pub fn cancel(&self) -> AppResult<()> {
        let (approvals, responding, sequence) = {
            let mut state = self.inner.state.lock().map_err(|_| unavailable())?;
            state.sequence += 1;
            let approvals: Vec<(String, Pending)> = state.approvals.drain().collect();
            (approvals, state.responding && !state.closed, state.sequence)
        };
        for (id, pending) in approvals {
            let _ = self.inner.respond(&pending.request_id, json!({ "behavior": "deny", "message": "Tour interrompu." }));
            self.inner.emit(HarnessEvent::ApprovalClosed { id });
        }
        if !responding {
            return Ok(());
        }
        self.process.write(&json!({ "type": "control_request", "request_id": format!("alfred-{sequence}"), "request": { "subtype": "interrupt" } }))
    }

    /// Arrête une seule tâche de l’agent (commande de fond, sous-agent) par la requête de contrôle `stop_task` de
    /// Claude Code, celle de son bouton d’arrêt : le CLI tue la tâche, puis annonce sa fin (`task_notification`,
    /// `stopped`) et la signale à l’agent. Essai réel : `tests_reel::claude_taches_de_fond`.
    pub async fn stop_task(&self, task_id: &str) -> AppResult<()> {
        let (request_id, receiver) = {
            let mut state = self.inner.state.lock().map_err(|_| unavailable())?;
            if state.closed {
                return Err(AppError::new("La conversation Claude Code est fermée."));
            }
            if !state.tasks.contains_key(task_id) {
                return Err(AppError::new("Cette tâche est déjà terminée."));
            }
            state.sequence += 1;
            let request_id = format!("alfred-stop-{}", state.sequence);
            let (sender, receiver) = tokio::sync::oneshot::channel();
            state.controls.insert(request_id.clone(), sender);
            (request_id, receiver)
        };
        let written = self.inner.write(&json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "stop_task", "task_id": task_id },
        }));
        if let Err(error) = written {
            if let Ok(mut state) = self.inner.state.lock() {
                state.controls.remove(&request_id);
            }
            return Err(error);
        }
        match tokio::time::timeout(std::time::Duration::from_secs(10), receiver).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(reason))) => Err(AppError::new(with_reason(
                "Claude Code n’a pas arrêté la tâche",
                Some(&super::event::redacted(&reason)),
            ))),
            Ok(Err(_)) => Err(AppError::new("Claude Code s’est arrêté.")),
            Err(_) => {
                if let Ok(mut state) = self.inner.state.lock() {
                    state.controls.remove(&request_id);
                }
                Err(AppError::new("Claude Code n’a pas répondu à la demande d’arrêt."))
            }
        }
    }

    pub fn close(&self) {
        let first = self.inner.state.lock().is_ok_and(|mut state| !std::mem::replace(&mut state.closed, true));
        self.process.terminate();
        if first {
            self.inner.emit(HarnessEvent::status(SessionStatus::Closed));
        }
    }
}

/// Claude Code n’expose pas de catalogue : ce sont les alias que le CLI accepte, plus le modèle par défaut du compte.
pub fn models() -> Vec<super::session::Model> {
    let efforts: Vec<String> = ["low", "medium", "high", "xhigh", "max"].iter().map(|effort| effort.to_string()).collect();
    [("default", "Modèle par défaut du compte"), ("fable", "Fable"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")]
        .iter()
        .map(|(id, name)| super::session::Model { id: id.to_string(), name: name.to_string(), efforts: efforts.clone() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_arguments_come_only_from_validated_options() {
        let session = claude_arguments(
            &ClaudeOptions {
                model: Some("opus".into()),
                resume: Some("7a0c1c1e-5b0e-4a51-9d0f-0a3b0c9a1f10".into()),
                ..ClaudeOptions::default()
            },
            Some(4242),
            None,
        )
        .unwrap();
        assert!(session.windows(2).any(|pair| pair == ["--permission-mode", "manual"]));
        assert!(session
            .iter()
            .any(|value| value.contains("http://127.0.0.1:4242/mcp") && value.contains("Bearer ${ALFRED_MCP_TOKEN}")));

        let one_shot = claude_arguments(
            &ClaudeOptions { one_shot: true, json_schema: Some(json!({ "type": "object" })), ..ClaudeOptions::default() },
            Some(4242),
            None,
        )
        .unwrap();
        assert!(one_shot.windows(2).any(|pair| pair == ["--tools", ""]));
        assert!(!one_shot.iter().any(|value| value.contains("mcpServers")), "un appel unique n’a aucun outil");

        let sandboxed = claude_arguments(&ClaudeOptions { sandbox: true, ..ClaudeOptions::default() }, None, None).unwrap();
        assert!(sandboxed.windows(2).any(|pair| pair[0] == "--settings" && pair[1].contains("\"enabled\":true")));

        for invalid in [
            ClaudeOptions { model: Some("opus; rm -rf /".into()), ..ClaudeOptions::default() },
            ClaudeOptions { resume: Some("../../etc".into()), ..ClaudeOptions::default() },
            ClaudeOptions { permission_mode: Some("root".into()), ..ClaudeOptions::default() },
            ClaudeOptions { add_dirs: vec!["/dossier/absent".into()], ..ClaudeOptions::default() },
        ] {
            assert!(claude_arguments(&invalid, None, None).is_err());
        }
    }

    /// Les consignes multilignes partent par fichier : aucun argument ne porte de saut de ligne, ce qui empêcherait
    /// de lancer un `claude.cmd` sous Windows.
    #[test]
    fn instructions_go_through_a_file() {
        let options = ClaudeOptions {
            append_system_prompt: Some("Première ligne.\nDeuxième ligne.".into()),
            ..ClaudeOptions::default()
        };
        let file = Path::new("/donnees/consignes/session.md");
        let args = claude_arguments(&options, Some(4242), Some(file)).unwrap();
        assert!(args.windows(2).any(|pair| pair[0] == "--append-system-prompt-file" && pair[1] == file.to_string_lossy()));
        assert!(!args.iter().any(|value| value == "--append-system-prompt"));
        assert!(!args.iter().any(|value| value.contains('\n') || value.contains('\r')), "{args:?}");
        assert!(claude_arguments(&options, None, None).is_err(), "sans fichier, les consignes ne partent pas");
    }

    #[test]
    fn modes_become_permission_decisions() {
        assert_eq!(permission_mode(Autonomy::Auto), "bypassPermissions");
        assert_eq!(permission_mode(Autonomy::Strict), "manual");
        assert_eq!(permission_mode(Autonomy::Workspace), "acceptEdits");
        assert_eq!(decide("mcp__alfred__lire", Autonomy::Strict, false), Decision::Allow);
        assert_eq!(decide("Bash", Autonomy::Ask, false), Decision::Ask);
        assert_eq!(decide("Bash", Autonomy::Auto, false), Decision::Allow);
        assert!(matches!(decide("Write", Autonomy::Workspace, false), Decision::Deny(_)));
        assert!(matches!(decide("Bash", Autonomy::Ask, true), Decision::Deny(_)));
        assert!(matches!(decide("AskUserQuestion", Autonomy::Auto, false), Decision::Deny(_)));
        assert_eq!(decide("TodoWrite", Autonomy::Workspace, false), Decision::Allow);
        assert_eq!(decide("TodoWrite", Autonomy::Strict, false), Decision::Allow);
    }

    #[test]
    fn the_todo_list_becomes_the_plan_and_leaves_the_transcript() {
        use super::super::event::{PlanStatus, PlanStep};
        let input = json!({ "todos": [
            { "content": "un", "status": "completed", "activeForm": "un" },
            { "content": "deux", "status": "in_progress", "activeForm": "deux" },
            { "content": "trois", "status": "pending", "activeForm": "trois" },
        ] });
        assert_eq!(
            tool_use("t1", "TodoWrite", &input),
            ToolUse::Plan(HarnessEvent::Plan { steps: vec![
                PlanStep { text: "un".into(), status: PlanStatus::Completed },
                PlanStep { text: "deux".into(), status: PlanStatus::InProgress },
                PlanStep { text: "trois".into(), status: PlanStatus::Pending },
            ] })
        );
        assert_eq!(tool_use("t2", "TodoWrite", &json!({})), ToolUse::Hidden);
        assert_eq!(tool_use("t3", "ToolSearch", &json!({ "query": "select:TodoWrite", "max_results": 1 })), ToolUse::Hidden);
        assert!(matches!(tool_use("t4", "ToolSearch", &json!({ "query": "select:WebFetch" })), ToolUse::Activity(_)));
        assert!(matches!(tool_use("t5", "Bash", &json!({ "command": "ls" })), ToolUse::Activity(_)));
    }

    #[test]
    fn tools_are_described_in_french() {
        let grep = tool_activity("t1", "Grep", &json!({ "pattern": "TODO", "path": "src" }));
        assert_eq!(grep.title, "Recherche");
        assert_eq!(grep.detail.as_deref(), Some("TODO · src"));
        assert_eq!(tool_activity("t2", "mcp__alfred__lire_page", &json!({})).title, "Outil · Alfred / lire_page");
        assert_eq!(tool_activity("t3", "mcp__github__create_issue", &json!({})).title, "Outil · github / create_issue");
        let card = approval_for("c", "Bash", &json!({ "command": "rm -rf build" }), false);
        assert_eq!(card.title, "Exécuter une commande");
        assert_eq!(card.detail.as_deref(), Some("rm -rf build"));
        assert_eq!(card.options.len(), 2);
    }

    /// Lignes relevées avec `claude` 2.1.323 le 2026-11-25 (commande de fond, sous-agent et sa commande).
    #[test]
    fn background_tasks_are_followed_until_they_end() {
        let mut tasks = HashMap::new();
        let started = json!({ "type": "system", "subtype": "task_started", "task_id": "bau40v0zv", "tool_use_id": "toolu_1",
            "description": "Sleep 40 seconds then echo fini", "is_backgrounded": true, "task_type": "local_bash" });
        let task = track_task(&mut tasks, &started).unwrap();
        assert_eq!((task.kind, task.background, task.status, task.stoppable), (TaskKind::Command, true, TaskStatus::Running, true));
        assert_eq!(task.title, "Sleep 40 seconds then echo fini");
        let agent = json!({ "type": "system", "subtype": "task_started", "task_id": "a9c5", "description": "Sleep 20 then reply ok",
            "subagent_type": "general-purpose", "is_backgrounded": true, "spawn_depth": 1, "task_type": "local_agent" });
        assert_eq!(track_task(&mut tasks, &agent).unwrap().kind, TaskKind::Agent);
        // La commande du sous-agent reste avec lui.
        let nested = json!({ "type": "system", "subtype": "task_started", "task_id": "bd42", "owned_by_subagent": true,
            "description": "Wait 20 seconds", "is_backgrounded": false, "parent_task_id": "a9c5", "task_type": "local_bash" });
        assert_eq!(track_task(&mut tasks, &nested), None);
        assert_eq!(track_task(&mut tasks, &json!({ "subtype": "task_notification", "task_id": "bd42", "status": "completed" })), None);
        let updated = json!({ "subtype": "task_updated", "task_id": "a9c5", "patch": { "status": "completed", "end_time": 1795596763579u64 } });
        let done = track_task(&mut tasks, &updated).unwrap();
        assert_eq!((done.status, done.ended_at), (TaskStatus::Completed, Some(1795596763579)));
        // La notification qui suit ne répète pas une fin déjà annoncée.
        assert_eq!(track_task(&mut tasks, &json!({ "subtype": "task_notification", "task_id": "a9c5", "status": "completed" })), None);
        let stopped = track_task(&mut tasks, &json!({ "subtype": "task_notification", "task_id": "bau40v0zv", "status": "stopped" })).unwrap();
        assert_eq!(stopped.status, TaskStatus::Stopped);
        assert!(tasks.is_empty());
        let foreground = json!({ "subtype": "task_started", "task_id": "f1", "description": "Build", "is_backgrounded": false, "task_type": "local_bash" });
        assert!(!track_task(&mut tasks, &foreground).unwrap().background);
        let moved = track_task(&mut tasks, &json!({ "subtype": "task_updated", "task_id": "f1", "patch": { "is_backgrounded": true } })).unwrap();
        assert!(moved.background && moved.status == TaskStatus::Running);
    }
}
