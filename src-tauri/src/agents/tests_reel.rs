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

/// Un message envoyé pendant le travail (`agents.steer`) est pris entre deux étapes : l’agent y répond et finit sa
/// tâche, dans le même tour, sans être arrêté.
async fn steering(provider: &str) {
    let dir = tempfile::tempdir().unwrap();
    let mut extra = model(provider);
    extra["autonomy"] = json!("auto");
    let mut run = start(provider, dir.path().to_str().unwrap(), extra).await;
    run.send(
        "Lance successivement ces deux commandes shell, une par une : `sleep 5; echo UN`, puis `sleep 5; echo DEUX`. \
         Après la dernière, réponds « tâche finie ».",
    )
    .await;
    // Dès que la première commande est lancée, la question arrive.
    run.until(|event| event["type"] == "activity").await;
    session::handle(
        &run.state,
        "agents.steer",
        &json!({ "handle": run.handle, "text": "Question en passant : combien font 7 fois 8 ? Réponds, puis continue." }),
    )
    .await
    .unwrap()
    .unwrap();
    let events = run.until(idle).await;
    let text = answer(&events);
    assert!(text.contains("56"), "{provider} : la question n’a pas reçu de réponse : {text}");
    assert!(text.to_lowercase().contains("finie"), "{provider} : la tâche n’a pas été finie : {text}");
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
reel!(claude_message_pendant_le_travail, "claude", steering);
reel!(codex_conversation, "codex", conversation);
reel!(opencode_conversation, "opencode", conversation);
reel!(claude_espace_de_travail, "claude", workspace);
reel!(codex_espace_de_travail, "codex", workspace);
reel!(opencode_espace_de_travail, "opencode", workspace);

/// Essai du guide de placement : dans un espace de test neuf (jamais celui de l’utilisateur), l’agent reçoit une
/// demande de module avec les consignes d’Alfred, propose (plan, maquette, question), puis construit après « oui ».
/// L’espace reste sur le disque pour la relecture ; son chemin est imprimé.
/// `cargo test --lib agents::tests_reel::claude_suivi_de_factures -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "lance le vrai Claude Code et son modèle, plusieurs minutes"]
async fn claude_suivi_de_factures() {
    let keep = tempfile::Builder::new().prefix("alfred-essai-factures-").tempdir().unwrap().keep();
    let data = keep.join("alfred");
    let state = AppState::new(&data).unwrap();
    let space = crate::space::Space::open_or_create(&keep.join("espace"), Some("Essai")).unwrap();
    crate::docs::materialize(&space).unwrap();
    let root = space.root.clone();
    state.set_space(Some(space));
    crate::server::start(state.clone()).await.unwrap();
    println!("espace d’essai : {}", root.display());

    let root_text = root.to_string_lossy().to_string();
    let instructions = [
        "Tu es Alfred, le majordome de l’utilisateur : tu mets en place pour lui pages, panneaux et fonctions dans son espace de travail.".to_string(),
        "Parle-lui comme un majordome posé et serviable : à la première personne, en le vouvoyant, sans jargon technique, sans parler de toi comme d’une application ou d’un agent. Propose de mettre en place ce dont il a besoin plutôt que d’expliquer l’outil. Tes réponses sont lues à voix haute : des phrases courtes et naturelles à l’oral.".to_string(),
        format!("Son espace de travail est le dossier {root_text} : pages, panneaux, fonctions et clients y sont rangés par module."),
        format!("Avant de créer ou de modifier quoi que ce soit dans l’espace de travail, lis {root_text}/AGENTS.md et suis-le."),
        "Les outils « alfred » servent à placer une page, vérifier qu’elle compile, lire ses erreurs et interroger la base.".to_string(),
        "Réponds en français.".to_string(),
        "Réponds en Markdown, sans JSON. Quand une décision de l’utilisateur est indispensable pour continuer, termine ta réponse par un unique bloc de code de langage alfred-question contenant {\"question\":\"question précise\",\"options\":[\"choix court\",\"autre choix\"]} avec zéro à quatre options, puis arrête ton tour. N’utilise ce bloc que pour une vraie question bloquante.".to_string(),
    ]
    .join("\n\n");
    let events = state.events.subscribe();
    let args = json!({ "provider": "claude", "cwd": root_text, "autonomy": "auto", "conversation": "essai-factures", "instructions": instructions });
    let opened = session::start(&state, &args, Output::Events).await.unwrap();
    let mut run = Run { state: state.clone(), events, handle: opened["handle"].as_str().unwrap().to_owned(), _data: tempfile::tempdir().unwrap() };

    let long = |run: &mut Run| {
        let mut events = std::mem::replace(&mut run.events, run.state.events.subscribe());
        let handle = run.handle.clone();
        async move {
            let mut seen = Vec::new();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(1500);
            loop {
                let event = tokio::time::timeout_at(deadline, events.recv()).await.expect("délai dépassé").unwrap();
                if event.name != "agent:event" || event.payload["session"] != handle.as_str() {
                    continue;
                }
                if event.payload["type"] == "activity" {
                    println!("  · {}", event.payload["activity"]["title"].as_str().unwrap_or_default());
                }
                let done = idle(&event.payload);
                seen.push(event.payload);
                if done {
                    return (seen, events);
                }
            }
        }
    };

    run.send("Je voudrais suivre mes factures clients : le numéro, le client, le montant, la date d’échéance, et si elle est payée ou non. J’aimerais aussi voir d’un coup d’œil celles qui sont en retard.").await;
    let (first, events) = long(&mut run).await;
    run.events = events;
    let proposal = answer(&first);
    println!("\n=== Réponse 1 ===\n{proposal}\n");

    if proposal.contains("alfred-question") {
        run.send("Oui, construis").await;
        let (second, events) = long(&mut run).await;
        run.events = events;
        println!("\n=== Réponse 2 ===\n{}\n", answer(&second));
    }
    run.close().await;
    println!("espace d’essai : {}", root.display());
}
