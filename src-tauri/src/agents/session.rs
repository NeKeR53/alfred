//! Sessions d’agent pilotées depuis Rust. L’interface n’a que des commandes fermées :
//!
//! - `agents.start` (harnais, dossier, modèle, autonomie, consignes, reprise) ouvre une session et rend sa poignée ;
//! - `agents.send`, `agents.steer`, `agents.answer`, `agents.cancel`, `agents.stopTask`, `agents.close` agissent sur cette poignée ;
//! - les événements normalisés (`HarnessEvent`) arrivent par le `Channel` de la session.
//!
//! L’interface ne choisit ni le programme, ni ses arguments, ni son environnement ; elle n’écrit jamais sur l’entrée
//! d’un CLI et ne reçoit ni ligne du protocole, ni jeton, ni mot de passe, ni sortie d’erreur brute.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};

use super::event::HarnessEvent;
use super::{claude, codex, opencode, Output, Provider};
use crate::error::{arg, AppError, AppResult};
use crate::state::AppState;

pub const MAX_SESSIONS: usize = 32;
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_INSTRUCTIONS_BYTES: usize = 200_000;
const MAX_FILES: usize = 64;

/// Texte remis au CLI pour un message qui n’a que des pièces jointes, faute de quoi Claude Code et Codex ignoraient un
/// texte vide.
pub const ATTACHMENTS_ONLY_TEXT: &str = "Analyse les fichiers joints.";

/// Liberté d’action de l’agent.
///
/// - `ask` : libre dans ses dossiers, une carte d’accord pour le reste (page Agent, par défaut) ;
/// - `strict` : une carte d’accord à chaque écriture et chaque commande ;
/// - `auto` : le mode **complet** — l’agent fait ce qu’il veut, sans aucune demande ;
/// - `workspace` : le mode **espace de travail** — l’agent n’agit que dans son dossier de travail, sans demande ;
///   tout ce qui en sortirait est refusé, jamais proposé.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Autonomy {
    #[default]
    Ask,
    Strict,
    Auto,
    Workspace,
}

/// Harnais, modèle et effort d’un agent. Ce qui manque revient au choix par défaut : pour une session, le modèle et
/// l’effort par défaut du CLI.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Harness {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Modèle proposé par un harnais : `id` est celui que garde la conversation.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFile {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub mime_type: Option<String>,
}

impl InputFile {
    pub fn is_image(&self) -> bool {
        self.mime_type.as_deref().is_some_and(|mime| mime.starts_with("image/"))
            || super::content::is_image(&self.path)
    }
}

/// Options de lancement, validées avant tout lancement.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StartOptions {
    pub cwd: String,
    /// Dossier de l’espace : l’agent y écrit librement même s’il travaille ailleurs (sauf en `workspace`).
    pub space_dir: Option<String>,
    /// Conversation à laquelle rattacher les outils d’Alfred ; absente pour un appel unique.
    pub conversation: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Consignes d’Alfred, hors du fil des messages.
    pub instructions: Option<String>,
    pub resume_session_id: Option<String>,
    pub autonomy: Autonomy,
    pub title: Option<String>,
    /// Appel unique : aucun outil, aucune demande d’accord, rien de gardé dans l’historique du CLI.
    pub one_shot: bool,
    /// Schéma JSON de la réponse d’un appel unique.
    pub output_schema: Option<Value>,
    /// Interface qui ouvre la session (un identifiant par chargement de la page) : les tâches déléguées partent chez
    /// celle qui tient la coordinatrice (`delegation::claim`).
    pub owner: Option<String>,
}

impl StartOptions {
    fn validate(&mut self) -> AppResult<()> {
        if !Path::new(&self.cwd).is_dir() {
            return Err(AppError::new(format!("Le dossier de travail de l’agent est introuvable : {}", self.cwd)));
        }
        if let Some(space) = &self.space_dir {
            if !Path::new(space).is_dir() {
                self.space_dir = None;
            }
        }
        if self.instructions.as_ref().is_some_and(|text| text.len() > MAX_INSTRUCTIONS_BYTES) {
            return Err(AppError::new("Les consignes de l’agent sont trop longues."));
        }
        if self.instructions.as_ref().is_some_and(|text| text.trim().is_empty()) {
            self.instructions = None;
        }
        for (name, value) in [("modèle", &self.model), ("effort", &self.effort)] {
            if let Some(value) = value {
                super::simple_value(name, value)?;
            }
        }
        if let Some(owner) = &self.owner {
            super::simple_value("interface", owner)?;
        }
        if self.model.as_deref() == Some("default") {
            self.model = None;
        }
        if self.one_shot {
            self.conversation = None;
            self.resume_session_id = None;
        }
        Ok(())
    }

    /// Dossiers où l’agent écrit librement : son dossier, et celui de l’espace sauf en mode espace de travail.
    pub fn roots(&self) -> Vec<String> {
        let mut roots = vec![self.cwd.clone()];
        if self.autonomy != Autonomy::Workspace {
            if let Some(space) = self.space_dir.as_ref().filter(|space| **space != self.cwd) {
                roots.push(space.clone());
            }
        }
        roots
    }
}

/// Destination des événements d’une session, avec sa poignée.
#[derive(Clone)]
pub struct Sink {
    state: Arc<AppState>,
    output: Output,
    handle: String,
}

impl Sink {
    pub fn emit(&self, event: HarnessEvent) {
        let Ok(mut payload) = serde_json::to_value(&event) else {
            return;
        };
        if let Some(object) = payload.as_object_mut() {
            object.insert("session".into(), Value::String(self.handle.clone()));
        }
        match &self.output {
            Output::Events => self.state.emit("agent:event", payload),
            Output::Channel(channel) => {
                let _ = channel.send(payload);
            }
        }
    }
}

/// Ce que chaque pilote reçoit pour démarrer.
pub struct Launch {
    pub state: Arc<AppState>,
    pub options: StartOptions,
    pub program: PathBuf,
    pub sink: Sink,
    /// Jeton des outils d’Alfred de cette session, placé dans l’environnement du CLI, jamais dans ses arguments.
    pub token: Option<String>,
    pub port: u16,
    /// Poignée de la session : nom de son fichier de consignes, clé du registre.
    pub handle: String,
}

impl Launch {
    /// Prévient le registre que le processus s’est arrêté de lui-même.
    pub fn on_exit(&self) -> impl FnOnce() + Send + 'static {
        let (state, handle) = (self.state.clone(), self.handle.clone());
        move || forget(&state, &handle)
    }
}

pub enum Driver {
    Claude(Arc<claude::Claude>),
    Codex(Arc<codex::Codex>),
    Opencode(Arc<opencode::OpenCode>),
}

struct Entry {
    driver: Driver,
    token: Option<String>,
    /// Pour les cartes qu’Alfred ajoute lui-même au tour en cours (accord d’une écriture de Code Mode).
    sink: Sink,
    /// Autonomie donnée au harnais : les accords d’Alfred la suivent (`consents.rs`).
    autonomy: Autonomy,
    /// Dossier de travail de la conversation : celui d’une coordinatrice implicite (`delegation.rs`).
    cwd: String,
    /// Harnais, modèle et effort reçus par le CLI : ses délégués les reprennent (`delegation.rs`).
    harness: Harness,
    /// Interface qui a ouvert la session (`StartOptions::owner`).
    owner: Option<String>,
}

/// Session ouverte pour `conversation`, retrouvée par le jeton de ses outils.
fn entry_of(state: &AppState, conversation: &str) -> Option<Arc<Entry>> {
    let tokens = state.agent_tokens.lock().ok()?;
    let all = sessions().lock().ok()?;
    all.values()
        .find(|entry| entry.token.as_ref().and_then(|token| tokens.get(token)).map(String::as_str) == Some(conversation))
        .cloned()
}

/// Dossier de travail de la session ouverte pour `conversation`.
pub fn cwd_of(state: &AppState, conversation: &str) -> Option<String> {
    entry_of(state, conversation).map(|entry| entry.cwd.clone())
}

/// Autonomie de la session ouverte pour `conversation` ; `None` sans session.
pub fn autonomy_of(state: &AppState, conversation: &str) -> Option<Autonomy> {
    entry_of(state, conversation).map(|entry| entry.autonomy)
}

/// Harnais, modèle et effort de la session ouverte pour `conversation` : ceux que son CLI a reçus. `None` sans
/// session.
pub fn harness_of(state: &AppState, conversation: &str) -> Option<Harness> {
    entry_of(state, conversation).map(|entry| entry.harness.clone())
}

/// Interface qui tient la session ouverte pour `conversation` ; `None` sans session ou sans interface connue.
pub fn owner_of(state: &AppState, conversation: &str) -> Option<String> {
    entry_of(state, conversation).and_then(|entry| entry.owner.clone())
}

/// Cartes d’accord posées par Alfred (et non par le harnais), en attente de la réponse de l’utilisateur.
fn own_approvals() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Préfixe des cartes posées par Alfred.
const OWN_APPROVAL: &str = "alfred-";

/// Pose une carte d’accord dans le tour en cours de la conversation et attend le choix de l’utilisateur (l’identifiant
/// de l’option), au plus `wait`. `None` : aucune session ouverte pour cette conversation, ou pas de réponse à temps.
pub async fn ask_in_conversation(
    state: &AppState,
    conversation: &str,
    title: &str,
    detail: &str,
    options: Vec<super::event::ApprovalOption>,
    wait: std::time::Duration,
) -> Option<String> {
    let sink = entry_of(state, conversation)?.sink.clone();
    let id = format!("{OWN_APPROVAL}{}", uuid::Uuid::new_v4().simple());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    own_approvals().lock().ok()?.insert(id.clone(), sender);
    sink.emit(HarnessEvent::Approval {
        request: super::event::ApprovalRequest { id: id.clone(), title: title.into(), detail: Some(detail.into()), options },
    });
    let answer = tokio::time::timeout(wait, receiver).await.ok().and_then(Result::ok);
    if let Ok(mut pending) = own_approvals().lock() {
        pending.remove(&id);
    }
    sink.emit(HarnessEvent::ApprovalClosed { id });
    answer
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Entry>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Entry>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gone() -> AppError {
    AppError::new("La session de l’agent n’est plus disponible.")
}

fn entry(handle: &str) -> AppResult<Arc<Entry>> {
    sessions().lock().map_err(|_| gone())?.get(handle).cloned().ok_or_else(gone)
}

/// Texte remis au CLI : vide avec des pièces jointes, il devient la demande d’analyse.
pub fn message_text(text: &str, files: &[InputFile]) -> String {
    let text = text.trim();
    if text.is_empty() && !files.is_empty() {
        ATTACHMENTS_ONLY_TEXT.into()
    } else {
        text.into()
    }
}

/// Fichiers joints cités par leur chemin, pour un harnais qui les lit lui-même.
pub fn attached_list(files: &[&InputFile]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = files.iter().map(|file| format!("- {}", file.path)).collect();
    format!("\n\nFichiers joints :\n{}", lines.join("\n"))
}

pub fn prompt_file(state: &AppState, handle: &str) -> PathBuf {
    state.data_dir.join("consignes").join(format!("{handle}.md"))
}

pub fn write_prompt(state: &AppState, handle: &str, prompt: &str) -> AppResult<PathBuf> {
    let path = prompt_file(state, handle);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, prompt)?;
    Ok(path)
}

fn forget(state: &AppState, handle: &str) {
    let _ = std::fs::remove_file(prompt_file(state, handle));
    let removed = sessions().lock().ok().and_then(|mut sessions| sessions.remove(handle));
    let conversation = removed
        .and_then(|entry| entry.token.clone())
        .and_then(|token| state.agent_tokens.lock().ok().and_then(|mut tokens| tokens.remove(&token)));
    // La session d’un délégué fermée avant son rapport : sa tâche passe « interrompue » et sera reprise.
    if let Some(conversation) = conversation {
        super::delegation::session_closed(state, &conversation);
    }
}

/// Ouvre une session et rend sa poignée.
pub async fn start(state: &Arc<AppState>, args: &Value, output: Output) -> AppResult<Value> {
    let provider: Provider = arg(args, "provider")?;
    let mut options: StartOptions = serde_json::from_value(args.clone())
        .map_err(|error| AppError::new(format!("Options d’agent invalides : {error}")))?;
    options.validate()?;
    if sessions().lock().map_err(|_| gone())?.len() >= MAX_SESSIONS {
        return Err(AppError::new("Trop d’agents sont déjà lancés. Fermer une conversation avant d’en ouvrir une autre."));
    }
    let program = super::resolve_program(provider.program()).ok_or_else(|| super::missing(provider))?;
    let port = state.server()?.port;
    let token = options.conversation.as_ref().map(|conversation| {
        let token = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut tokens) = state.agent_tokens.lock() {
            tokens.insert(token.clone(), conversation.clone());
        }
        token
    });
    let handle = uuid::Uuid::new_v4().to_string();
    let sink = Sink { state: state.clone(), output, handle: handle.clone() };
    let own_sink = sink.clone();
    let autonomy = options.autonomy;
    let cwd = options.cwd.clone();
    let owner = options.owner.clone();
    let harness =
        Harness { provider: Some(provider.id().into()), model: options.model.clone(), effort: options.effort.clone() };
    let launch = Launch { state: state.clone(), options, program, sink, token: token.clone(), port, handle: handle.clone() };
    let opened = match provider {
        Provider::Claude => claude::Claude::start(launch).map(Driver::Claude),
        Provider::Codex => codex::Codex::start(launch).await.map(Driver::Codex),
        Provider::Opencode => opencode::OpenCode::start(launch).await.map(Driver::Opencode),
    };
    let driver = match opened {
        Ok(driver) => driver,
        Err(error) => {
            let _ = std::fs::remove_file(prompt_file(state, &handle));
            if let (Some(token), Ok(mut tokens)) = (&token, state.agent_tokens.lock()) {
                tokens.remove(token);
            }
            return Err(error);
        }
    };
    let session_id = match &driver {
        Driver::Claude(_) => None,
        Driver::Codex(codex) => codex.session_id(),
        Driver::Opencode(opencode) => Some(opencode.session_id()),
    };
    sessions()
        .lock()
        .map_err(|_| gone())?
        .insert(handle.clone(), Arc::new(Entry { driver, token, sink: own_sink, autonomy, cwd, harness, owner }));
    Ok(json!({ "handle": handle, "sessionId": session_id }))
}

fn files_of(args: &Value) -> AppResult<Vec<InputFile>> {
    let files: Vec<InputFile> = crate::error::opt_arg(args, "files")?.unwrap_or_default();
    if files.len() > MAX_FILES {
        return Err(AppError::new("Trop de fichiers joints."));
    }
    Ok(files)
}

fn text_of(args: &Value) -> AppResult<String> {
    let text: String = crate::error::opt_arg(args, "text")?.unwrap_or_default();
    if text.len() > MAX_TEXT_BYTES {
        return Err(AppError::new("Le message envoyé à l’agent est trop volumineux."));
    }
    Ok(text)
}

async fn send(args: &Value, steer: bool) -> AppResult<Value> {
    let handle: String = arg(args, "handle")?;
    let text = text_of(args)?;
    let files = files_of(args)?;
    let client_id: Option<String> = crate::error::opt_arg(args, "clientId")?;
    let entry = entry(&handle)?;
    match (&entry.driver, steer) {
        (Driver::Claude(claude), false) => claude.send(&text, &files),
        (Driver::Codex(codex), false) => codex.send(&text, &files, client_id.as_deref()).await,
        (Driver::Codex(codex), true) => codex.steer(&text, &files, client_id.as_deref()).await,
        // Claude Code prend le message entre deux étapes et poursuit sa tâche (voir `Claude::steer`).
        (Driver::Claude(claude), true) => claude.steer(&text, &files),
        (Driver::Opencode(opencode), false) => opencode.send(&text, &files, client_id.as_deref()).await,
        // OpenCode fusionnerait le message avec l’exécution en cours.
        (_, true) => Err(AppError::new("Cet agent ne peut pas orienter la réponse en cours.")),
    }?;
    Ok(Value::Null)
}

async fn answer(args: &Value) -> AppResult<Value> {
    let handle: String = arg(args, "handle")?;
    let approval: String = arg(args, "approvalId")?;
    let option: String = arg(args, "optionId")?;
    if approval.starts_with(OWN_APPROVAL) {
        let sender = own_approvals().lock().map_err(|_| gone())?.remove(&approval);
        if let Some(sender) = sender {
            let _ = sender.send(option);
        }
        return Ok(Value::Null);
    }
    match &entry(&handle)?.driver {
        Driver::Claude(claude) => claude.answer(&approval, &option),
        Driver::Codex(codex) => codex.answer(&approval, &option),
        Driver::Opencode(opencode) => opencode.answer(&approval, &option).await,
    }?;
    Ok(Value::Null)
}

async fn cancel(args: &Value) -> AppResult<Value> {
    let handle: String = arg(args, "handle")?;
    match &entry(&handle)?.driver {
        Driver::Claude(claude) => claude.cancel(),
        Driver::Codex(codex) => codex.cancel().await,
        Driver::Opencode(opencode) => opencode.cancel().await,
    }?;
    Ok(Value::Null)
}

/// Arrête une seule tâche de l’agent (commande de fond, sous-agent). Seul Claude Code le permet (`stop_task`) ; Codex
/// n’offre aucun arrêt par tâche à un client de `codex app-server`, OpenCode n’annonce pas de tâches.
async fn stop_task(args: &Value) -> AppResult<Value> {
    let handle: String = arg(args, "handle")?;
    let task: String = arg(args, "taskId")?;
    super::simple_value("tâche", &task)?;
    match &entry(&handle)?.driver {
        Driver::Claude(claude) => claude.stop_task(&task).await,
        _ => Err(AppError::new("Cet agent ne sait pas arrêter une tâche seule. Interrompez sa réponse.")),
    }?;
    Ok(Value::Null)
}

/// Ferme la session et arrête son CLI ; une poignée inconnue est déjà fermée. `owner` : l’interface qui la ferme ;
/// si c’est la session d’un délégué au travail, sa tâche reprendra chez elle (`delegation::closing`).
async fn close(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let handle: String = arg(args, "handle")?;
    let owner: Option<String> = crate::error::opt_arg(args, "owner")?;
    let Ok(entry) = entry(&handle) else {
        return Ok(Value::Null);
    };
    let conversation = entry.token.as_ref().and_then(|token| state.agent_tokens.lock().ok()?.get(token).cloned());
    if let (Some(conversation), Some(owner)) = (conversation, owner) {
        super::delegation::closing(&conversation, &owner);
    }
    match &entry.driver {
        Driver::Claude(claude) => {
            let claude = claude.clone();
            tokio::task::spawn_blocking(move || claude.close()).await.map_err(|_| gone())?;
        }
        Driver::Codex(codex) => {
            let codex = codex.clone();
            tokio::task::spawn_blocking(move || codex.close()).await.map_err(|_| gone())?;
        }
        Driver::Opencode(opencode) => opencode.close().await,
    }
    forget(state, &handle);
    Ok(Value::Null)
}

/// Arrête toutes les sessions à la fermeture d’Alfred : aucun processus ne doit lui survivre.
pub fn shutdown() {
    let running: Vec<Arc<Entry>> =
        sessions().lock().map(|sessions| sessions.values().cloned().collect()).unwrap_or_default();
    for entry in running {
        match &entry.driver {
            Driver::Claude(claude) => claude.close(),
            Driver::Codex(codex) => codex.close(),
            Driver::Opencode(opencode) => opencode.stop_now(),
        }
    }
}

/// Catalogue des modèles d’un harnais.
async fn models(args: &Value) -> AppResult<Value> {
    let provider: Provider = arg(args, "provider")?;
    let cwd: String = arg(args, "cwd")?;
    super::checked_dir(&cwd)?;
    let program = super::resolve_program(provider.program()).ok_or_else(|| super::missing(provider))?;
    let models = match provider {
        Provider::Claude => claude::models(),
        Provider::Codex => codex::models(&program, &cwd).await?,
        Provider::Opencode => opencode::models(&program, &cwd).await?,
    };
    Ok(serde_json::to_value(models)?)
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "agents.start" => start(state, args, Output::Events).await,
        "agents.send" => send(args, false).await,
        "agents.steer" => send(args, true).await,
        "agents.answer" => answer(args).await,
        "agents.cancel" => cancel(args).await,
        "agents.stopTask" => stop_task(args).await,
        "agents.close" => close(state, args).await,
        "agents.models" => models(args).await,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_are_checked_before_any_launch() {
        let mut options = StartOptions { cwd: "/dossier/absent".into(), ..StartOptions::default() };
        assert!(options.validate().is_err());
        let dir = std::env::temp_dir();
        let mut options = StartOptions {
            cwd: dir.to_string_lossy().into(),
            model: Some("opus; rm -rf /".into()),
            ..StartOptions::default()
        };
        assert!(options.validate().is_err());
        let mut one_shot = StartOptions {
            cwd: dir.to_string_lossy().into(),
            one_shot: true,
            conversation: Some("c".into()),
            model: Some("default".into()),
            ..StartOptions::default()
        };
        one_shot.validate().unwrap();
        assert!(one_shot.conversation.is_none(), "un appel unique n’a pas d’outils");
        assert!(one_shot.model.is_none(), "« default » est le modèle du compte");
    }

    #[test]
    fn the_workspace_mode_keeps_only_its_folder() {
        let options = StartOptions {
            cwd: "/projet".into(),
            space_dir: Some("/espace".into()),
            autonomy: Autonomy::Workspace,
            ..StartOptions::default()
        };
        assert_eq!(options.roots(), vec!["/projet".to_string()]);
        let ask = StartOptions { autonomy: Autonomy::Ask, ..options };
        assert_eq!(ask.roots(), vec!["/projet".to_string(), "/espace".into()]);
        assert_eq!(message_text("  ", &[InputFile { path: "/a.png".into(), name: "a".into(), mime_type: None }]), ATTACHMENTS_ONLY_TEXT);
    }
}
