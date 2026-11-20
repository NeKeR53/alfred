//! Traduction de l'API v2 d'OpenCode en événements normalisés.
//!
//! Le flux SSE (`/api/event`) n'est pas typé par l'OpenAPI (`V2EventEncoded` est une chaîne
//! opaque) : les événements utiles sont lus ici à la main. Les messages relus
//! (`session.message.list`) produisent les mêmes identifiants d'éléments que le direct, pour que le
//! moteur remplace un élément plutôt que de le dupliquer après un rattrapage.
use crate::agents::content::MAX_IMAGE_DATA_URL;
use crate::agents::event::{
    ActionType as AgentActionType, Activity as AgentActivity, ActivityAction as AgentActivityAction,
    ActivityKind as AgentActivityKind, ActivityStatus as AgentActivityStatus, ApprovalOption, ApprovalRequest,
    HarnessEvent as NativeAgentEvent, OptionKind,
};
use serde_json::Value;
use std::collections::HashMap;

/// Clé de métadonnée d'un message utilisateur qui garde l'identifiant du tour d’Alfred.
pub(super) const CLIENT_ID_METADATA: &str = "alfredClientId";

/// Événement v2 tel qu'il arrive sur `/api/event`.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ServerEvent {
    pub kind: String,
    pub session_id: Option<String>,
    /// Numéro durable de l'événement dans sa session, absent pour les fragments (`*.delta`).
    pub seq: Option<i64>,
    pub data: Value,
}

impl ServerEvent {
    pub fn parse(raw: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(raw).ok()?;
        Some(Self {
            kind: value["type"].as_str()?.to_owned(),
            session_id: value["data"]["sessionID"].as_str().map(str::to_owned),
            seq: value["durable"]["seq"].as_i64(),
            data: value["data"].clone(),
        })
    }
}

/// Découpe un flux SSE en charges `data:` complètes.
#[derive(Default)]
pub(super) struct SseDecoder {
    buffer: String,
    data: String,
}

impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut payloads = Vec::new();
        while let Some(end) = self.buffer.find('\n') {
            let line = self.buffer[..end].trim_end_matches('\r').to_owned();
            self.buffer.drain(..=end);
            if line.is_empty() {
                if !self.data.is_empty() {
                    payloads.push(std::mem::take(&mut self.data));
                }
            } else if let Some(payload) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data
                    .push_str(payload.strip_prefix(' ').unwrap_or(payload));
            }
        }
        payloads
    }
}

/// Fin d'une exécution OpenCode, par l'événement direct ou le message `idle` relu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ExecutionEnd {
    Succeeded,
    Interrupted,
    Failed(String),
}

impl ExecutionEnd {
    pub fn from_event(kind: &str, data: &Value) -> Option<Self> {
        match kind {
            "session.execution.succeeded" => Some(Self::Succeeded),
            "session.execution.interrupted" => Some(Self::Interrupted),
            "session.execution.failed" => Some(Self::Failed(error_text(data))),
            _ => None,
        }
    }

    pub fn from_idle(message: &Value) -> Option<Self> {
        if message["type"] != "idle" {
            return None;
        }
        Some(match message["outcome"].as_str() {
            Some("failed") => Self::Failed(error_text(message)),
            Some("interrupted") => Self::Interrupted,
            _ => Self::Succeeded,
        })
    }
}

fn error_text(data: &Value) -> String {
    let error = &data["error"];
    error["message"]
        .as_str()
        .or(error["data"]["message"].as_str())
        .or(error.as_str())
        .or(data["message"].as_str())
        .filter(|message| !message.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "OpenCode n’a pas terminé la réponse.".to_owned())
}

fn text_item(message_id: &str, ordinal: &Value) -> String {
    format!("{message_id}:text:{}", ordinal.as_i64().unwrap_or(0))
}

fn reasoning_item(message_id: &str, ordinal: &Value) -> String {
    format!("{message_id}:reasoning:{}", ordinal.as_i64().unwrap_or(0))
}

/// Demande d'autorisation présentée à l'utilisateur.
pub(super) fn permission_request(data: &Value) -> Option<ApprovalRequest> {
    let id = data["id"].as_str()?.to_owned();
    let action = data["action"].as_str().unwrap_or("outil");
    let resources: Vec<&str> = data["resources"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let title = match action {
        "shell" | "bash" => "Exécuter une commande".to_owned(),
        "edit" | "write" | "patch" | "apply_patch" => "Modifier un fichier".to_owned(),
        "external_directory" => "Agir hors du dossier de l’agent".to_owned(),
        "webfetch" | "websearch" => "Accéder au web".to_owned(),
        other => format!("Utiliser l’outil {other}"),
    };
    Some(ApprovalRequest {
        id,
        title,
        detail: (!resources.is_empty()).then(|| resources.join("
")),
        options: vec![
            ApprovalOption::new("once", "Autoriser", OptionKind::Allow),
            ApprovalOption::new("always", "Toujours autoriser", OptionKind::AllowAlways),
            ApprovalOption::new("reject", "Refuser", OptionKind::Deny),
        ],
    })
}

#[derive(Default, Clone)]
struct ToolCall {
    name: String,
    input: Value,
}

/// État vivant d'une session : outils en cours, dont le nom n'est donné qu'au début.
#[derive(Default)]
pub(super) struct LiveMapper {
    tools: HashMap<String, ToolCall>,
    /// Réflexions déjà annoncées : la première fraction ouvre l’activité « Analyse ».
    reasoning: std::collections::HashSet<String>,
}

impl LiveMapper {
    pub fn map(&mut self, event: &ServerEvent) -> Vec<NativeAgentEvent> {
        let data = &event.data;
        let message_id = data["assistantMessageID"].as_str().unwrap_or("message");
        match event.kind.as_str() {
            "session.text.delta" => vec![NativeAgentEvent::Message {
                item_id: text_item(message_id, &data["ordinal"]),
                content: data["delta"].as_str().unwrap_or_default().to_owned(),
                replace: None,
            }],
            "session.text.ended" => vec![NativeAgentEvent::Message {
                item_id: text_item(message_id, &data["ordinal"]),
                content: data["text"].as_str().unwrap_or_default().to_owned(),
                replace: Some(true),
            }],
            "session.reasoning.delta" => {
                let item = reasoning_item(message_id, &data["ordinal"]);
                let mut events = Vec::new();
                if self.reasoning.insert(item.clone()) {
                    events.push(NativeAgentEvent::Activity(AgentActivity::new(
                        item.clone(),
                        AgentActivityKind::Analysis,
                        "Analyse",
                        AgentActivityStatus::Running,
                    )));
                }
                events.push(NativeAgentEvent::delta(item, data["delta"].as_str().unwrap_or_default()));
                events
            }
            "session.reasoning.ended" => vec![analysis(
                reasoning_item(message_id, &data["ordinal"]),
                data["text"].as_str().unwrap_or_default(),
            )],
            "session.tool.input.started" => {
                let Some(id) = data["id"].as_str() else {
                    return Vec::new();
                };
                let call = ToolCall {
                    name: data["name"].as_str().unwrap_or("outil").to_owned(),
                    input: Value::Null,
                };
                let event = tool_activity(id, &call.name, &call.input, ToolState::Running);
                self.tools.insert(id.to_owned(), call);
                vec![event]
            }
            "session.tool.called" => {
                let Some(id) = data["id"].as_str() else {
                    return Vec::new();
                };
                let call = self.tools.entry(id.to_owned()).or_default();
                call.input = data["input"].clone();
                vec![tool_activity(
                    id,
                    &call.name,
                    &call.input,
                    ToolState::Running,
                )]
            }
            "session.tool.success" | "session.tool.failed" => {
                let Some(id) = data["id"].as_str() else {
                    return Vec::new();
                };
                let call = self.tools.remove(id).unwrap_or_default();
                let state = if event.kind == "session.tool.success" {
                    ToolState::Completed {
                        content: &data["content"],
                        metadata: &data["metadata"],
                    }
                } else {
                    ToolState::Failed {
                        content: &data["content"],
                        error: error_text(data),
                    }
                };
                vec![tool_activity(id, &call.name, &call.input, state)]
            }
            _ => Vec::new(),
        }
    }
}

fn analysis(item_id: String, text: &str) -> NativeAgentEvent {
    NativeAgentEvent::Activity(AgentActivity {
        item_id,
        kind: AgentActivityKind::Analysis,
        title: "Analyse".into(),
        detail: None,
        actions: None,
        content: Some(text.to_owned()),
        images: None,
        files: None,
        status: AgentActivityStatus::Completed,
    })
}

enum ToolState<'a> {
    Running,
    Completed {
        content: &'a Value,
        metadata: &'a Value,
    },
    Failed {
        content: &'a Value,
        error: String,
    },
}

/// Texte, images et fichiers d'un contenu d'outil (`Tool.Content`).
fn tool_content(content: &Value) -> (Option<String>, Vec<String>, Vec<String>) {
    let mut text = Vec::new();
    let mut images = Vec::new();
    let mut files = Vec::new();
    for block in content.as_array().into_iter().flatten() {
        if let Some(value) = block["text"].as_str() {
            text.push(value.to_owned());
            continue;
        }
        let mime = block["mime"]
            .as_str()
            .or(block["mimeType"].as_str())
            .unwrap_or_default();
        let uri = block["uri"].as_str().or(block["url"].as_str());
        let path = uri
            .and_then(|uri| url::Url::parse(uri).ok())
            .filter(|uri| uri.scheme() == "file")
            .and_then(|uri| uri.to_file_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
            .or_else(|| block["path"].as_str().map(str::to_owned));
        let image = mime.starts_with("image/") || block["type"] == "image";
        match (path, block["data"].as_str()) {
            (Some(path), _) if image => images.push(path),
            (Some(path), _) => files.push(path),
            (None, Some(data)) if image && data.len() < MAX_IMAGE_DATA_URL => {
                images.push(format!("data:{mime};base64,{data}"));
            }
            _ => {}
        }
    }
    let text = (!text.is_empty()).then(|| text.join("\n"));
    (text, images, files)
}

fn input_text<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| input[*key].as_str().filter(|value| !value.is_empty()))
}

fn edit_actions(input: &Value, metadata: Option<&Value>) -> Vec<AgentActivityAction> {
    let from_metadata: Vec<AgentActivityAction> = metadata
        .and_then(|metadata| metadata["files"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|file| {
            let path = file["file"].as_str().or(file["path"].as_str())?;
            let mut action = AgentActivityAction::new(AgentActionType::Edit);
            action.path = Some(path.to_owned());
            action.added = file["additions"].as_u64().map(|n| n as u32);
            action.removed = file["deletions"].as_u64().map(|n| n as u32);
            Some(action)
        })
        .collect();
    if !from_metadata.is_empty() {
        return from_metadata;
    }
    input_text(input, &["path", "filePath", "file_path"])
        .map(|path| {
            let mut action = AgentActivityAction::new(AgentActionType::Edit);
            action.path = Some(path.to_owned());
            vec![action]
        })
        .unwrap_or_default()
}

/// Activité typée d'un appel d'outil OpenCode, au même niveau que Codex : commande, lecture,
/// recherche, modification de fichiers, recherche web, sous-agent ou outil générique.
fn tool_activity(id: &str, name: &str, input: &Value, state: ToolState) -> NativeAgentEvent {
    let (content, images, files, status, metadata) = match &state {
        ToolState::Running => (
            None,
            Vec::new(),
            Vec::new(),
            AgentActivityStatus::Running,
            None,
        ),
        ToolState::Completed { content, metadata } => {
            let (text, images, files) = tool_content(content);
            (
                text,
                images,
                files,
                AgentActivityStatus::Completed,
                Some(*metadata),
            )
        }
        ToolState::Failed { content, error } => {
            let (text, images, files) = tool_content(content);
            (
                Some(text.unwrap_or_else(|| error.clone())),
                images,
                files,
                AgentActivityStatus::Failed,
                None,
            )
        }
    };
    let path = input_text(input, &["path", "filePath", "file_path"]);
    let (kind, title, detail, actions, content) = match name {
        "shell" | "bash" => (
            AgentActivityKind::Command,
            "Commande".to_owned(),
            input_text(input, &["command", "cmd"]).map(str::to_owned),
            Some(Vec::new()),
            content,
        ),
        "read" | "list" => {
            let mut action = AgentActivityAction::new(if name == "list" {
                AgentActionType::ListFiles
            } else {
                AgentActionType::Read
            });
            action.path = path.map(str::to_owned);
            (
                AgentActivityKind::Command,
                "Lecture".to_owned(),
                path.map(str::to_owned),
                Some(vec![action]),
                content,
            )
        }
        "glob" | "grep" | "codesearch" => {
            let query = input_text(input, &["pattern", "query"]);
            let search_path = input_text(input, &["path"]);
            let mut action = AgentActivityAction::new(if name == "glob" {
                AgentActionType::ListFiles
            } else {
                AgentActionType::Search
            });
            action.query = query.map(str::to_owned);
            action.path = search_path.map(str::to_owned);
            let detail = [query, search_path]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            (
                AgentActivityKind::Command,
                "Recherche".to_owned(),
                (!detail.is_empty()).then_some(detail),
                Some(vec![action]),
                content,
            )
        }
        "edit" | "write" | "patch" | "apply_patch" | "multiedit" => {
            let actions = edit_actions(input, metadata);
            let detail = actions
                .iter()
                .filter_map(|action| action.path.clone())
                .collect::<Vec<_>>()
                .join("\n");
            (
                AgentActivityKind::File,
                "Modification de fichiers".to_owned(),
                (!detail.is_empty()).then_some(detail),
                Some(actions),
                None,
            )
        }
        "webfetch" | "websearch" => (
            AgentActivityKind::Search,
            "Recherche web".to_owned(),
            input_text(input, &["url", "query"]).map(str::to_owned),
            None,
            content,
        ),
        "task" | "subagent" => (
            AgentActivityKind::Agent,
            "Sous-agent".to_owned(),
            input_text(input, &["description", "prompt"]).map(str::to_owned),
            None,
            content,
        ),
        _ => (
            AgentActivityKind::Tool,
            format!("Outil · {name}"),
            input
                .as_object()
                .filter(|input| !input.is_empty())
                .and_then(|input| serde_json::to_string_pretty(input).ok()),
            None,
            content,
        ),
    };
    NativeAgentEvent::Activity(AgentActivity {
        item_id: id.to_owned(),
        kind,
        title,
        detail,
        actions,
        content,
        images: (!images.is_empty()).then_some(images),
        files: (!files.is_empty()).then_some(files),
        status,
    })
}

/// Événements d'un message assistant relu : textes complets, raisonnements et outils.
pub(super) fn assistant_events(message: &Value) -> Vec<NativeAgentEvent> {
    let message_id = message["id"].as_str().unwrap_or("message");
    let mut texts = 0_i64;
    let mut reasonings = 0_i64;
    let mut events = Vec::new();
    for part in message["content"].as_array().into_iter().flatten() {
        match part["type"].as_str() {
            Some("text") => {
                events.push(NativeAgentEvent::Message {
                    item_id: text_item(message_id, &Value::from(texts)),
                    content: part["text"].as_str().unwrap_or_default().to_owned(),
                    replace: Some(true),
                });
                texts += 1;
            }
            Some("reasoning") => {
                events.push(analysis(
                    reasoning_item(message_id, &Value::from(reasonings)),
                    part["text"].as_str().unwrap_or_default(),
                ));
                reasonings += 1;
            }
            Some("tool") => {
                let Some(id) = part["id"].as_str() else {
                    continue;
                };
                let name = part["name"].as_str().unwrap_or("outil");
                let tool = &part["state"];
                let state = match tool["status"].as_str() {
                    Some("completed") => ToolState::Completed {
                        content: &tool["content"],
                        metadata: &tool["metadata"],
                    },
                    Some("error") => ToolState::Failed {
                        content: &tool["content"],
                        error: error_text(tool),
                    },
                    _ => ToolState::Running,
                };
                events.push(tool_activity(id, name, &tool["input"], state));
            }
            _ => {}
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, data: Value) -> ServerEvent {
        ServerEvent {
            kind: kind.into(),
            session_id: Some("ses_1".into()),
            seq: None,
            data,
        }
    }

    #[test]
    fn the_event_stream_becomes_normalized_events() {
        let mut decoder = SseDecoder::default();
        let mut payloads = decoder.push(b"data: {\"type\":\"session.text.delta\",\"data\":{\"sessionID\":\"ses_1\"}}\r\n\r\ndata: {\"ty");
        payloads.extend(decoder.push(b"pe\":\"x\",\"durable\":{\"seq\":4},\"data\":{}}\n\n"));
        assert_eq!(payloads.len(), 2);
        let parsed = ServerEvent::parse(&payloads[0]).unwrap();
        assert_eq!(parsed.session_id.as_deref(), Some("ses_1"));
        assert_eq!(ServerEvent::parse(&payloads[1]).unwrap().seq, Some(4));

        let mut live = LiveMapper::default();
        let message = json!({ "assistantMessageID": "msg_a", "ordinal": 0 });
        let mut events = live.map(&event(
            "session.text.delta",
            json!({ "assistantMessageID": "msg_a", "ordinal": 0, "delta": "Bon" }),
        ));
        events.extend(live.map(&event(
            "session.text.ended",
            json!({ "assistantMessageID": "msg_a", "ordinal": 0, "text": "Bonjour" }),
        )));
        let tool = json!({ "assistantMessageID": "msg_a", "id": "call-1", "name": "edit" });
        events.extend(live.map(&event("session.tool.input.started", tool)));
        events.extend(live.map(&event(
            "session.tool.called",
            json!({ "id": "call-1", "input": { "path": "note.txt" } }),
        )));
        let done = live.map(&event(
            "session.tool.success",
            json!({ "id": "call-1", "content": [{ "type": "text", "text": "ok" }],
                    "metadata": { "files": [{ "file": "note.txt", "additions": 2, "deletions": 1 }] } }),
        ));
        assert!(message.is_object());
        assert_eq!(events[1], NativeAgentEvent::text("msg_a:text:0", "Bonjour", true));
        let NativeAgentEvent::Activity(activity) = &done[0] else {
            panic!("activité attendue")
        };
        assert_eq!(activity.kind, AgentActivityKind::File);
        assert_eq!(activity.status, AgentActivityStatus::Completed);
        assert_eq!(activity.actions.as_ref().unwrap()[0].added, Some(2));

        let permission = permission_request(
            &json!({ "id": "per_1", "action": "shell", "resources": ["echo salut"] }),
        )
        .unwrap();
        assert_eq!(permission.title, "Exécuter une commande");
        assert_eq!(permission.detail.as_deref(), Some("echo salut"));
        assert_eq!(
            ExecutionEnd::from_event("session.execution.interrupted", &json!({})),
            Some(ExecutionEnd::Interrupted)
        );
    }
}
