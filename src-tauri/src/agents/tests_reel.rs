//! Scénarios réels avec les CLI installés sur le poste, ignorés par défaut :
//! `cargo test --lib agents::tests_reel -- --ignored --nocapture --test-threads 1`.
//! Ils n’utilisent que les comptes déjà configurés des CLI et n’écrivent aucun jeton.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::session;
use super::Output;
use crate::state::{AppState, ServerInfo};

struct Run {
    state: Arc<AppState>,
    events: tokio::sync::broadcast::Receiver<crate::events::AppEvent>,
    handle: String,
    _data: tempfile::TempDir,
}

async fn start(provider: &str, cwd: &str, extra: Value) -> Run {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(data.path()).unwrap();
    let _ = state.server.set(ServerInfo { port: 9 });
    let events = state.events.subscribe();
    let mut args = json!({ "provider": provider, "cwd": cwd });
    for (key, value) in extra.as_object().unwrap() {
        args[key] = value.clone();
    }
    let opened = session::start(&state, &args, Output::Events).await.unwrap_or_else(|error| panic!("{provider} : {error}"));
    Run { state, events, handle: opened["handle"].as_str().unwrap().to_owned(), _data: data }
}

impl Run {
    /// Événements de la session jusqu’à `until` (compris), ou panique après le délai.
    async fn until(&mut self, until: impl Fn(&Value) -> bool) -> Vec<Value> {
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        loop {
            let event = tokio::time::timeout_at(deadline, self.events.recv()).await.expect("délai dépassé").unwrap();
            if event.name != "agent:event" || event.payload["session"] != self.handle.as_str() {
                continue;
            }
            println!("  {}", event.payload.to_string().chars().take(300).collect::<String>());
            let done = until(&event.payload);
            seen.push(event.payload);
            if done {
                return seen;
            }
        }
    }

    async fn send(&self, text: &str) {
        session::handle(&self.state, "agents.send", &json!({ "handle": self.handle, "text": text })).await.unwrap().unwrap();
    }

    async fn close(&self) {
        session::handle(&self.state, "agents.close", &json!({ "handle": self.handle })).await.unwrap().unwrap();
    }
}

fn idle(event: &Value) -> bool {
    event["type"] == "status" && (event["status"] == "idle" || event["status"] == "closed")
}

fn answer(events: &[Value]) -> String {
    let mut text = String::new();
    for event in events.iter().filter(|event| event["type"] == "message") {
        if event["replace"] == true {
            text = event["content"].as_str().unwrap_or_default().to_owned();
        } else {
            text.push_str(event["content"].as_str().unwrap_or_default());
        }
    }
    text
}

fn model(provider: &str) -> Value {
    match provider {
        "claude" => json!({ "model": "haiku" }),
        _ => json!({}),
    }
}

/// Une demande, puis une deuxième dans le même processus ; le harnais rend son identifiant de session.
async fn conversation(provider: &str) {
    let dir = tempfile::tempdir().unwrap();
    let mut extra = model(provider);
    extra["autonomy"] = json!("auto");
    let mut run = start(provider, dir.path().to_str().unwrap(), extra).await;
    run.send("Réponds uniquement par le mot : pong").await;
    let events = run.until(idle).await;
    assert!(answer(&events).to_lowercase().contains("pong"), "{provider} : {events:?}");
    assert!(events.iter().any(|event| event["type"] == "session") || provider == "opencode");
    run.send("Réponds uniquement par le mot : ping").await;
    let events = run.until(idle).await;
    assert!(answer(&events).to_lowercase().contains("ping"), "{provider} : {events:?}");
    run.close().await;
}

/// Mode espace de travail : l’agent écrit dans son dossier sans demande, et rien hors de lui.
async fn workspace(provider: &str) {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("dehors.txt");
    let mut extra = model(provider);
    extra["autonomy"] = json!("workspace");
    let mut run = start(provider, dir.path().to_str().unwrap(), extra).await;
    run.send(&format!(
        "Crée le fichier dedans.txt dans ton dossier de travail avec le contenu « ok ». Ensuite, essaie une seule fois \
         de créer le fichier {} avec le contenu « non » ; si c’est refusé, n’insiste pas. Réponds « fini ».",
        target.display()
    ))
    .await;
    let events = run.until(idle).await;
    assert!(!events.iter().any(|event| event["type"] == "approval"), "{provider} : aucune demande en mode espace de travail");
    assert!(dir.path().join("dedans.txt").exists(), "{provider} : le fichier du dossier de travail manque");
    assert!(!target.exists(), "{provider} : l’agent a écrit hors de son dossier");
    run.close().await;
}

macro_rules! reel {
    ($name:ident, $provider:literal, $scenario:ident) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore = "lance le vrai CLI installé sur le poste et appelle son modèle"]
        async fn $name() {
            $scenario($provider).await;
        }
    };
}

reel!(claude_conversation, "claude", conversation);
reel!(codex_conversation, "codex", conversation);
reel!(opencode_conversation, "opencode", conversation);
reel!(claude_espace_de_travail, "claude", workspace);
reel!(codex_espace_de_travail, "codex", workspace);
reel!(opencode_espace_de_travail, "opencode", workspace);
