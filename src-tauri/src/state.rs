use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use rusqlite::Connection;
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

use crate::error::{AppError, AppResult};
use crate::events::AppEvent;
use crate::space::Space;

/// Port fixe du serveur local en développement, pour que le navigateur de test retrouve le pont HTTP.
pub const DEV_PORT: u16 = 14731;
/// Port de l’application publiée : fixe, pour que l’adresse d’une automatisation ou d’un webhook reste la même
/// d’un lancement à l’autre. Pris par un autre programme, Alfred en prend un libre (l’adresse change alors).
pub const RELEASE_PORT: u16 = 14732;

pub struct ServerInfo {
    pub port: u16,
}

/// Réponse attendue de l’interface (exécution d’une fonction, carte de placement, accord de permission).
pub type Pending = oneshot::Sender<Result<Value, String>>;

pub struct AppState {
    /// Données d’Alfred hors de l’espace : réglages, accords, journal, index des conversations, marketplaces.
    pub data_dir: PathBuf,
    pub events: broadcast::Sender<AppEvent>,
    space: RwLock<Option<Space>>,
    pub app_db: Mutex<Connection>,
    pub server: OnceLock<ServerInfo>,
    pub pending: Mutex<HashMap<String, Pending>>,
    /// Demandes déjà prises en charge par une interface (`ui.claim`) : chacune ne s’exécute qu’une fois, même si
    /// plusieurs interfaces écoutent (fenêtre et navigateur de test en développement).
    claimed: Mutex<HashSet<String>>,
    /// Questions affichables encore en attente (accords) : une fenêtre ouverte après coup les montre aussi.
    asked: Mutex<Vec<(String, Value)>>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Jeton des outils d’Alfred remis à chaque processus d’agent → conversation qui l’a lancé.
    pub agent_tokens: Mutex<HashMap<String, String>>,
    /// Secret tiré à chaque lancement : il signe la clé qui ouvre le code d’un module à son seul cadre.
    pub frame_secret: [u8; 32],
}

/// Deux UUID v4, soit 244 bits tirés du générateur du système.
fn random_secret() -> [u8; 32] {
    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret
}

impl AppState {
    pub fn new(data_dir: &Path) -> AppResult<Arc<Self>> {
        std::fs::create_dir_all(data_dir)?;
        let app_db = Connection::open(data_dir.join("alfred.sqlite"))?;
        crate::app_db::migrate(&app_db)?;
        let (events, _) = broadcast::channel(1024);
        Ok(Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            events,
            space: RwLock::new(None),
            app_db: Mutex::new(app_db),
            server: OnceLock::new(),
            pending: Mutex::new(HashMap::new()),
            claimed: Mutex::new(HashSet::new()),
            asked: Mutex::new(Vec::new()),
            watcher: Mutex::new(None),
            agent_tokens: Mutex::new(HashMap::new()),
            frame_secret: random_secret(),
        }))
    }

    pub fn emit(&self, name: &str, payload: Value) {
        // Aucun abonné : l’événement est simplement perdu.
        let _ = self.events.send(AppEvent { name: name.to_string(), payload });
    }

    pub fn space(&self) -> AppResult<Space> {
        self.space
            .read()
            .ok()
            .and_then(|space| space.clone())
            .ok_or_else(|| AppError::new("Aucun espace de travail n’est ouvert."))
    }

    pub fn try_space(&self) -> Option<Space> {
        self.space.read().ok().and_then(|space| space.clone())
    }

    pub fn set_space(&self, space: Option<Space>) {
        // Un autre espace (ou aucun) : les noyaux Python des modules de l’ancien s’arrêtent.
        let previous = self.try_space().map(|current| current.root);
        if let Some(previous) = &previous {
            if space.as_ref().is_none_or(|space| &space.root != previous) {
                crate::python::kernel::kernels()
                    .stop_under(previous, "L’espace de travail a été fermé : le noyau Python s’est arrêté.");
                crate::states::close_space(&previous.to_string_lossy());
            }
        }
        // Les états gardés sur le disque reviennent dans le magasin : les pages s’affichent tout de suite.
        if let Some(space) = space.as_ref().filter(|space| previous.as_ref() != Some(&space.root)) {
            crate::states::open_space(space);
        }
        if let Ok(mut current) = self.space.write() {
            *current = space;
        }
    }

    pub fn server(&self) -> AppResult<&ServerInfo> {
        self.server.get().ok_or_else(|| AppError::new("Le serveur local d’Alfred n’a pas démarré."))
    }

    /// Demande quelque chose à l’interface et attend sa réponse (`ui.resolve`).
    pub async fn ask_ui(&self, name: &str, mut payload: Value, timeout: std::time::Duration) -> AppResult<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id.clone(), sender);
        }
        if let Some(object) = payload.as_object_mut() {
            object.insert("requestId".to_string(), Value::String(id.clone()));
        }
        // Demandes qu’une interface ouverte plus tard doit retrouver (`ui.waiting`) : un accord, un passage agentique.
        if name == "permission:ask" || name == "automation:agent" {
            if let Ok(mut asked) = self.asked.lock() {
                asked.push((name.to_string(), payload.clone()));
            }
        }
        self.emit(name, payload);
        let answer = tokio::time::timeout(timeout, receiver).await;
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
        if let Ok(mut asked) = self.asked.lock() {
            asked.retain(|(_, payload)| payload.get("requestId").and_then(Value::as_str) != Some(id.as_str()));
        }
        if let Ok(mut claimed) = self.claimed.lock() {
            claimed.remove(&id);
        }
        // Tranchée (ou abandonnée) : les interfaces qui l’affichent encore la retirent (accord, question d’agent).
        self.emit("ui:resolved", serde_json::json!({ "requestId": id }));
        match answer {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(AppError::new(message)),
            Ok(Err(_)) => Err(AppError::new("L’interface d’Alfred n’a pas répondu.")),
            Err(_) => Err(AppError::new("Délai dépassé : l’interface d’Alfred n’a pas répondu à temps.")),
        }
    }

    /// Réserve une demande en attente à l’interface qui la prend la première ; `false` pour les suivantes et pour
    /// une demande qui n’attend plus. Le backend diffuse ses demandes à toutes les interfaces connectées : sans
    /// cette réservation, une fonction s’exécutait une fois par interface, écritures comprises.
    pub fn claim_ui(&self, id: &str) -> bool {
        let waiting = self.pending.lock().is_ok_and(|pending| pending.contains_key(id));
        waiting && self.claimed.lock().is_ok_and(|mut claimed| claimed.insert(id.to_string()))
    }

    /// Questions `name` encore en attente, dans l’ordre où elles ont été posées.
    pub fn waiting_ui(&self, name: &str) -> Vec<Value> {
        self.asked
            .lock()
            .map(|asked| asked.iter().filter(|(asked, _)| asked == name).map(|(_, payload)| payload.clone()).collect())
            .unwrap_or_default()
    }

    pub fn resolve_ui(&self, id: &str, result: Result<Value, String>) -> AppResult<()> {
        let sender = self.pending.lock().ok().and_then(|mut pending| pending.remove(id));
        match sender {
            Some(sender) => {
                let _ = sender.send(result);
                Ok(())
            }
            None => Err(AppError::new("Cette demande n’attend plus de réponse.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une fenêtre ouverte pendant qu’une question attend la retrouve, et elle disparaît une fois tranchée.
    #[tokio::test]
    async fn a_waiting_question_is_shown_to_a_window_opened_later() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path()).unwrap();
        let mut events = state.events.subscribe();
        let asking = state.clone();
        let question = tokio::spawn(async move {
            asking
                .ask_ui("permission:ask", serde_json::json!({ "resource": "client:jira" }), std::time::Duration::from_secs(5))
                .await
        });
        let id = loop {
            let event = events.recv().await.unwrap();
            if event.name == "permission:ask" {
                break event.payload["requestId"].as_str().unwrap().to_string();
            }
        };
        let waiting = state.waiting_ui("permission:ask");
        assert_eq!((waiting.len(), waiting[0]["resource"].as_str()), (1, Some("client:jira")));
        assert!(state.waiting_ui("function:call").is_empty());
        state.resolve_ui(&id, Ok(serde_json::json!({ "granted": true }))).unwrap();
        question.await.unwrap().unwrap();
        assert!(state.waiting_ui("permission:ask").is_empty());
    }

    #[tokio::test]
    async fn a_request_is_claimed_by_a_single_interface() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let mut events = state.events.subscribe();
        let asking = state.clone();
        let answer = tokio::spawn(async move {
            asking.ask_ui("function:call", serde_json::json!({}), std::time::Duration::from_secs(5)).await
        });
        let event = events.recv().await.unwrap();
        let id = event.payload["requestId"].as_str().unwrap().to_string();

        assert!(state.claim_ui(&id), "la première interface obtient la demande");
        assert!(!state.claim_ui(&id), "les suivantes ne l’exécutent pas");
        assert!(!state.claim_ui("inconnue"), "une demande qui n’attend rien ne se réserve pas");

        state.resolve_ui(&id, Ok(Value::Bool(true))).unwrap();
        assert_eq!(answer.await.unwrap().unwrap(), Value::Bool(true));
        assert!(!state.claim_ui(&id), "une demande terminée ne se réserve plus");
        let resolved = events.recv().await.unwrap();
        assert_eq!((resolved.name.as_str(), resolved.payload["requestId"].as_str()), ("ui:resolved", Some(id.as_str())));
    }
}
