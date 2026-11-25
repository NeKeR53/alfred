//! Événements normalisés d’une session d’agent, identiques pour les trois harnais et au type `HarnessEvent` de
//! l’interface (`src/features/agent/harness/types.ts`). Ils ne portent jamais une ligne brute du protocole, un jeton,
//! un mot de passe ni la sortie d’erreur du CLI. Un champ absent n’est jamais envoyé à `null`.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Connecting,
    Ready,
    Responding,
    Idle,
    Closed,
}

/// `cancelled` (« Arrêté ») : l’activité restée ouverte quand le tour s’est terminé ou a été interrompu.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    Analysis,
    Command,
    File,
    Tool,
    Search,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionType {
    Read,
    Search,
    ListFiles,
    Edit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAction {
    #[serde(rename = "type")]
    pub action: ActionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

impl ActivityAction {
    pub fn new(action: ActionType) -> Self {
        Self { action, path: None, query: None, added: None, removed: None }
    }

    pub fn with_path(mut self, path: Option<&str>) -> Self {
        self.path = path.filter(|path| !path.is_empty()).map(str::to_owned);
        self
    }

    pub fn with_query(mut self, query: Option<&str>) -> Self {
        self.query = query.filter(|query| !query.is_empty()).map(str::to_owned);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub item_id: String,
    pub kind: ActivityKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ActivityAction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    pub status: ActivityStatus,
}

impl Activity {
    pub fn new(item_id: impl Into<String>, kind: ActivityKind, title: impl Into<String>, status: ActivityStatus) -> Self {
        Self {
            item_id: item_id.into(),
            kind,
            title: title.into(),
            detail: None,
            actions: None,
            content: None,
            images: None,
            files: None,
            status,
        }
    }

    pub fn detail(mut self, detail: Option<impl Into<String>>) -> Self {
        self.detail = detail.map(Into::into).filter(|detail: &String| !detail.is_empty());
        self
    }

    pub fn content(mut self, content: Option<impl Into<String>>) -> Self {
        self.content = content.map(Into::into);
        self
    }

    pub fn actions(mut self, actions: Vec<ActivityAction>) -> Self {
        self.actions = Some(actions);
        self
    }

    pub fn images(mut self, images: Vec<String>) -> Self {
        self.images = (!images.is_empty()).then_some(images);
        self
    }

    pub fn files(mut self, files: Vec<String>) -> Self {
        self.files = (!files.is_empty()).then_some(files);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OptionKind {
    Allow,
    AllowAlways,
    Deny,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApprovalOption {
    pub id: String,
    pub label: String,
    pub kind: OptionKind,
}

impl ApprovalOption {
    pub fn new(id: &str, label: &str, kind: OptionKind) -> Self {
        Self { id: id.into(), label: label.into(), kind }
    }
}

/// Carte d’accord : une commande, une écriture ou un outil qui sort de ce qui est permis à l’agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub options: Vec<ApprovalOption>,
}

/// État d’une étape du plan de l’agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
}

impl PlanStatus {
    /// État lu dans un harnais : `in_progress` (Claude Code, OpenCode) ou `inProgress` (Codex). Une étape annulée ou
    /// d’un état inconnu n’est pas gardée.
    pub fn parse(status: &str) -> Option<Self> {
        match status {
            "pending" => Some(Self::Pending),
            "in_progress" | "inProgress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlanStep {
    pub text: String,
    pub status: PlanStatus,
}

/// Plan d’une liste de tâches du harnais (`todos` de Claude Code et d’OpenCode) : `{ content, status }`.
pub fn plan_from_todos(input: &Value) -> Option<Vec<PlanStep>> {
    let todos = input["todos"].as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|todo| {
                let text = todo["content"].as_str()?.trim();
                let status = PlanStatus::parse(todo["status"].as_str()?)?;
                (!text.is_empty()).then(|| PlanStep { text: text.to_owned(), status })
            })
            .collect(),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    Command,
    Agent,
}

/// État d’une tâche de l’agent ; `stopped` : arrêtée par l’utilisateur, l’agent ou la fin du CLI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

impl TaskStatus {
    pub fn finished(self) -> bool {
        self != Self::Running
    }
}

/// Tâche de l’agent qui dure : commande lancée en arrière-plan, sous-agent, commande en cours.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub task_id: String,
    pub kind: TaskKind,
    pub title: String,
    /// Vrai si l’agent ne l’attend pas pour poursuivre (arrière-plan) ; faux pour une commande qui bloque la réponse.
    pub background: bool,
    pub status: TaskStatus,
    /// Début et fin, en millisecondes depuis l’époque Unix.
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// Vrai si Alfred sait arrêter cette tâche seule (`agents.stopTask`).
    pub stoppable: bool,
}

/// Heure courante en millisecondes depuis l’époque Unix.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

impl AgentTask {
    /// Fin de la tâche, datée maintenant si le harnais ne dit pas quand.
    pub fn finish(&mut self, status: TaskStatus, ended_at: Option<u64>) {
        self.status = status;
        self.ended_at = Some(ended_at.unwrap_or_else(now_ms));
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HarnessEvent {
    Status {
        status: SessionStatus,
    },
    Message {
        #[serde(rename = "itemId")]
        item_id: String,
        content: String,
        /// Texte complet de fin de message : il remplace les fragments reçus.
        #[serde(skip_serializing_if = "Option::is_none")]
        replace: Option<bool>,
    },
    Activity(Activity),
    ActivityDelta {
        #[serde(rename = "itemId")]
        item_id: String,
        content: String,
    },
    Approval {
        request: ApprovalRequest,
    },
    /// L’accord n’attend plus de réponse (tour annulé, réponse donnée ailleurs).
    ApprovalClosed {
        id: String,
    },
    /// Identifiant de la session dans le harnais, pour la reprendre plus tard.
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Error {
        message: String,
    },
    /// Plan de l’agent, en entier à chaque mise à jour : il remplace le précédent.
    Plan {
        steps: Vec<PlanStep>,
    },
    /// Tâche lancée par l’agent hors de sa réponse (commande de fond, sous-agent) ou commande longue : son état entier
    /// à chaque changement.
    Task(AgentTask),
    /// Résultat structuré d’un appel unique (réponse contrainte par un schéma).
    Structured {
        value: Value,
    },
}

impl HarnessEvent {
    pub fn status(status: SessionStatus) -> Self {
        Self::Status { status }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::Error { message: message.into() }
    }

    pub fn delta(item_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self::ActivityDelta { item_id: item_id.into(), content: content.into() }
    }

    pub fn text(item_id: impl Into<String>, content: impl Into<String>, replace: bool) -> Self {
        Self::Message { item_id: item_id.into(), content: content.into(), replace: replace.then_some(true) }
    }
}

/// Motif ajouté à une phrase d’erreur, sans doubler le point final du message du modèle.
pub fn with_reason(sentence: &str, reason: Option<&str>) -> String {
    match reason.map(|reason| reason.trim().trim_end_matches(['.', ' ', '\n'])).filter(|reason| !reason.is_empty()) {
        Some(reason) => format!("{sentence} : {reason}."),
        None => format!("{sentence}."),
    }
}

/// Dernière ligne non vide de la sortie d’erreur d’un CLI, expurgée : elle dit pourquoi il s’est arrêté.
pub fn last_line(stderr: &str) -> Option<String> {
    stderr.lines().rev().map(str::trim).find(|line| !line.is_empty()).map(redacted)
}

/// Motif court du CLI, sans jeton ni identifiant : en-têtes Bearer, clés, longues suites hexadécimales, courriels.
pub fn redacted(message: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut bearer = false;
    for word in message.split_whitespace() {
        let lower = word.to_ascii_lowercase();
        let secret = bearer
            || ["sk-", "sk_", "pk-", "pk_", "rk-", "rk_", "ghp_", "gho_", "xoxa-", "xoxb-", "xoxp-"]
                .iter()
                .any(|prefix| lower.starts_with(prefix) && word.len() > prefix.len() + 8)
            || (word.len() >= 24 && word.chars().all(|c| c.is_ascii_hexdigit()))
            || (word.contains('@') && word.split('@').nth(1).is_some_and(|domain| domain.contains('.')));
        bearer = lower == "bearer";
        words.push(if secret { "…".into() } else { word.to_owned() });
    }
    let text = words.join(" ");
    if text.chars().count() > 220 {
        format!("{}…", text.chars().take(219).collect::<String>())
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_have_the_shape_of_the_interface() {
        let activity = Activity::new("a1", ActivityKind::Command, "Commande", ActivityStatus::Running)
            .detail(Some("ls"))
            .actions(vec![ActivityAction::new(ActionType::ListFiles).with_path(Some("src"))]);
        assert_eq!(
            serde_json::to_value(HarnessEvent::Activity(activity)).unwrap(),
            json!({ "type": "activity", "itemId": "a1", "kind": "command", "title": "Commande", "detail": "ls",
                    "actions": [{ "type": "listFiles", "path": "src" }], "status": "running" })
        );
        assert_eq!(
            serde_json::to_value(HarnessEvent::text("m", "Bon", false)).unwrap(),
            json!({ "type": "message", "itemId": "m", "content": "Bon" })
        );
        assert_eq!(
            serde_json::to_value(HarnessEvent::ApprovalClosed { id: "x".into() }).unwrap(),
            json!({ "type": "approvalClosed", "id": "x" })
        );
        assert_eq!(
            serde_json::to_value(HarnessEvent::Session { session_id: "s".into() }).unwrap(),
            json!({ "type": "session", "sessionId": "s" })
        );
    }

    #[test]
    fn a_todo_list_becomes_a_plan() {
        let input = json!({ "todos": [
            { "content": "Lire le guide", "status": "completed", "activeForm": "Lecture du guide" },
            { "content": "Créer la page", "status": "in_progress" },
            { "content": "Vérifier", "status": "pending" },
            { "content": "Abandonné", "status": "cancelled" },
            { "content": "  ", "status": "pending" },
        ] });
        let steps = plan_from_todos(&input).unwrap();
        assert_eq!(
            serde_json::to_value(HarnessEvent::Plan { steps }).unwrap(),
            json!({ "type": "plan", "steps": [
                { "text": "Lire le guide", "status": "completed" },
                { "text": "Créer la page", "status": "inProgress" },
                { "text": "Vérifier", "status": "pending" },
            ] })
        );
        assert_eq!(plan_from_todos(&json!({})), None);
    }

    #[test]
    fn reasons_are_redacted_and_end_once() {
        assert_eq!(with_reason("Codex n’a pas pu terminer", Some("quota dépassé.")), "Codex n’a pas pu terminer : quota dépassé.");
        assert_eq!(with_reason("Arrêt", None), "Arrêt.");
        assert_eq!(redacted("Authorization: Bearer abc.def refusé pour moi@exemple.fr"), "Authorization: Bearer … refusé pour …");
        assert_eq!(last_line("ligne 1\n  dernière  \n\n").as_deref(), Some("dernière"));
    }
}
