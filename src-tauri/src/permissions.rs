//! Accords d’accès. Une page ou une fonction déclare ce dont elle a besoin, mais seul l’utilisateur accorde :
//! la première utilisation d’une ressource sensible pose la question, et la réponse est mémorisée hors de l’espace,
//! là où l’agent ne peut pas l’écrire.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::app_db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Demandeur d’un accès, tel que la coquille l’identifie : `{ kind, module, reference }`.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct Subject {
    /// `page`, `panel`, `function`.
    pub kind: String,
    pub module: String,
    /// `module/page` ou `module/fonction`.
    pub reference: String,
    /// Instance d’un client que montre la page (section par instance). Les accords ne dépendent pas d’elle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// Comptes de la page qui a appelé la fonction, par besoin (`jira` → `acme`) : `client("jira")` vise d’office le
    /// sien. Les accords ne dépendent pas d’eux.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub accounts: std::collections::BTreeMap<String, String>,
    /// Le demandeur montre des données d’exemple (page ou fonction appelée depuis une page en mode exemple) : la
    /// coquille le fixe, jamais le cadre. Aucune requête ne part alors vers un service.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub examples: bool,
}

impl Subject {
    /// Clé de mémorisation : un panneau partage les accords de sa page, une fonction a les siens.
    pub fn key(&self) -> String {
        let kind = if self.kind == "function" { "function" } else { "page" };
        format!("{kind}:{}", self.reference)
    }
}

/// Question d’accès pour un même demandeur et une même ressource. Deux cadres qui demandent le même accès en même
/// temps (la page dans la fenêtre principale et dans sa fenêtre à part, deux copies par instance) n’ouvrent qu’une
/// question : le second attend son tour et reprend la réponse donnée entre-temps.
#[derive(Default)]
struct Question {
    /// Nombre de réponses données, lu sans attendre son tour.
    answered: AtomicU64,
    granted: AtomicBool,
    turn: tokio::sync::Mutex<()>,
}

type Questions = Mutex<HashMap<String, Arc<Question>>>;

fn questions() -> &'static Questions {
    static QUESTIONS: OnceLock<Questions> = OnceLock::new();
    QUESTIONS.get_or_init(Questions::default)
}

fn is_granted(state: &AppState, space: &str, key: &str, resource: &str) -> AppResult<bool> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::is_granted(&db, space, key, resource)
}

fn refused(subject: &Subject, label: &str) -> AppError {
    AppError::new(format!("Accès refusé : {} n’a pas le droit d’utiliser {label}.", subject.reference))
}

/// Vérifie que `subject` a accès à `resource` (par exemple `client:jira`) ; sinon pose la question à l’utilisateur
/// et attend sa réponse. `label` décrit la ressource dans la question (« le client Jira »).
pub async fn ensure(state: &Arc<AppState>, subject: &Subject, resource: &str, label: &str) -> AppResult<()> {
    let space = state.space()?.root.to_string_lossy().to_string();
    let key = subject.key();
    if is_granted(state, &space, &key, resource)? {
        return Ok(());
    }
    let question = {
        let mut all = questions().lock().map_err(|_| AppError::new("Les accords sont indisponibles."))?;
        all.entry(format!("{space}\n{key}\n{resource}")).or_default().clone()
    };
    let seen = question.answered.load(Ordering::SeqCst);
    let _turn = question.turn.lock().await;
    // Une question posée pendant l’attente vient d’être tranchée : sa réponse vaut aussi pour cette demande.
    if question.answered.load(Ordering::SeqCst) != seen {
        return if question.granted.load(Ordering::SeqCst) { Ok(()) } else { Err(refused(subject, label)) };
    }
    if is_granted(state, &space, &key, resource)? {
        return Ok(());
    }
    let answer = state
        .ask_ui(
            "permission:ask",
            json!({ "subject": subject, "resource": resource, "label": label }),
            Duration::from_secs(300),
        )
        .await;
    let granted = matches!(&answer, Ok(value) if value.get("granted").and_then(Value::as_bool) == Some(true));
    if granted {
        let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
        app_db::grant(&db, &space, &key, resource)?;
    }
    question.granted.store(granted, Ordering::SeqCst);
    question.answered.fetch_add(1, Ordering::SeqCst);
    match answer {
        Err(error) => Err(error),
        Ok(_) if granted => Ok(()),
        Ok(_) => Err(refused(subject, label)),
    }
}

/// Oublie les accords d’une page supprimée (son panneau partage sa clé) : une page recréée sous le même nom
/// redemandera.
pub fn forget_page(state: &AppState, reference: &str) -> AppResult<()> {
    let space = state.space()?.root.to_string_lossy().to_string();
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::revoke_subject(&db, &space, &format!("page:{reference}"))
}

/// Oublie les accords d’un module désinstallé : un module installé ensuite sous le même identifiant n’en hérite pas.
pub fn forget_module(state: &AppState, module: &str) -> AppResult<()> {
    let space = state.space()?.root.to_string_lossy().to_string();
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::revoke_module(&db, &space, module)
}

/// Oublie les accords donnés sur une fonction supprimée : une fonction recréée sous ce nom redemandera.
pub fn forget_function(state: &AppState, reference: &str) -> AppResult<()> {
    let space = state.space()?.root.to_string_lossy().to_string();
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::revoke_resource(&db, &space, &format!("function:{reference}"))
}

/// Longueur maximale d’une adresse ouverte pour une page : au-delà, elle sert à faire sortir des données.
const MAX_EXTERNAL_URL: usize = 2048;

/// `frame.shell.openExternal` : une page veut ouvrir une adresse dans le navigateur du système. C’est une sortie
/// vers le réseau ; l’utilisateur accorde chaque hôte, une fois, à la page qui le demande.
async fn authorize_external(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject: Subject = crate::error::arg(args, "subject")?;
    let text: String = crate::error::arg(args, "url")?;
    if text.len() > MAX_EXTERNAL_URL {
        return Err(AppError::new(format!("Adresse trop longue : {MAX_EXTERNAL_URL} caractères au plus.")));
    }
    let url = url::Url::parse(&text).map_err(|_| AppError::new("Adresse invalide."))?;
    let host = url.host_str().filter(|_| matches!(url.scheme(), "http" | "https"));
    let Some(host) = host else {
        return Err(AppError::new("Seules les adresses http(s) peuvent être ouvertes."));
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::new("Une adresse ouverte par une page ne contient pas d’identifiants."));
    }
    let host = host.to_ascii_lowercase();
    ensure(state, &subject, &format!("external:{host}"), &format!("l’ouverture de liens vers {host}")).await?;
    Ok(json!({ "url": url.to_string() }))
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "frame.shell.openExternal" => Some(authorize_external(state, args).await),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grants(state: &AppState) -> Vec<String> {
        let space = state.space().unwrap().root.to_string_lossy().to_string();
        let db = state.app_db.lock().unwrap();
        app_db::list_grants(&db, &space)
            .unwrap()
            .iter()
            .map(|grant| format!("{} {}", grant["subject"].as_str().unwrap(), grant["resource"].as_str().unwrap()))
            .collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn deleting_a_page_or_uninstalling_a_module_forgets_its_grants() {
        let (state, _dir) = crate::clients::testing::test_state();
        let space = state.space().unwrap();
        for label in ["Notes", "Banque"] {
            space
                .place_page("Liste", None, "", &crate::space::PlaceTarget::Menu { label: label.into(), icon: None, color: None }, None)
                .unwrap();
        }
        let root = space.root.to_string_lossy().to_string();
        {
            let db = state.app_db.lock().unwrap();
            for (subject, resource) in [
                ("page:notes/liste", "client:jira"),
                ("page:notes/autre", "client:jira"),
                ("function:notes/*", "function:banque/exporter"),
                ("page:notes-ajouts/liste", "client:jira"),
                ("page:banque/liste", "client:jira"),
            ] {
                app_db::grant(&db, &root, subject, resource).unwrap();
            }
        }
        crate::dispatch::dispatch(state.clone(), "space.deletePage", json!({ "reference": "banque/liste" })).await.unwrap();
        assert!(!grants(&state).contains(&"page:banque/liste client:jira".to_string()));
        forget_module(&state, "notes").unwrap();
        assert_eq!(grants(&state), vec!["page:notes-ajouts/liste client:jira".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_opens_a_link_only_to_a_host_the_user_granted() {
        let (state, _dir) = crate::clients::testing::test_state();
        let asked = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let mut events = state.events.subscribe();
            let (state, asked) = (state.clone(), asked.clone());
            tokio::spawn(async move {
                while let Ok(event) = events.recv().await {
                    if event.name != "permission:ask" {
                        continue;
                    }
                    let resource = event.payload["resource"].as_str().unwrap().to_string();
                    let granted = resource == "external:docs.example.com";
                    asked.lock().unwrap().push(resource);
                    let id = event.payload["requestId"].as_str().unwrap().to_string();
                    let _ = state.resolve_ui(&id, Ok(json!({ "granted": granted })));
                }
            });
        }
        let subject = json!({ "kind": "page", "module": "notes", "reference": "notes/liste" });
        let open = |url: String| {
            let (state, subject) = (state.clone(), subject.clone());
            async move { handle(&state, "frame.shell.openExternal", &json!({ "subject": subject, "url": url })).await.unwrap() }
        };

        assert!(open("https://docs.example.com/guide".into()).await.is_ok());
        assert!(open("https://DOCS.example.com/autre".into()).await.is_ok(), "accord mémorisé pour l’hôte");
        assert!(open("https://attaquant.example/?d=secrets".into()).await.is_err());
        assert!(open(format!("https://docs.example.com/?d={}", "x".repeat(3000))).await.is_err());
        assert!(open("javascript:alert(1)".into()).await.is_err());
        assert!(open("https://moi:motdepasse@docs.example.com/".into()).await.is_err());
        assert_eq!(*asked.lock().unwrap(), vec!["external:docs.example.com", "external:attaquant.example"]);
    }

    /// La même page ouverte deux fois (fenêtre principale et fenêtre à part) demande le même accès en même temps :
    /// une seule question, et sa réponse vaut pour les deux demandes, accord comme refus.
    #[tokio::test(flavor = "multi_thread")]
    async fn simultaneous_requests_for_the_same_access_share_one_question() {
        let (state, _dir) = crate::clients::testing::test_state();
        let asked = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let mut events = state.events.subscribe();
            let (state, asked) = (state.clone(), asked.clone());
            tokio::spawn(async move {
                while let Ok(event) = events.recv().await {
                    if event.name != "permission:ask" {
                        continue;
                    }
                    let resource = event.payload["resource"].as_str().unwrap().to_string();
                    asked.lock().unwrap().push(resource.clone());
                    let id = event.payload["requestId"].as_str().unwrap().to_string();
                    // L’utilisateur prend son temps : l’autre demande arrive pendant que la question est affichée.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let _ = state.resolve_ui(&id, Ok(json!({ "granted": resource == "client:jira" })));
                }
            });
        }
        let subject = Subject {
            kind: "page".into(),
            module: "jira".into(),
            reference: "jira/tickets".into(),
            instance: Some("acme".into()),
            ..Default::default()
        };
        let ask = |resource: &'static str| {
            let (state, subject) = (state.clone(), subject.clone());
            tokio::spawn(async move { ensure(&state, &subject, resource, "le client").await })
        };
        let (first, second) = (ask("client:jira"), ask("client:jira"));
        assert!(first.await.unwrap().is_ok() && second.await.unwrap().is_ok());
        let (first, second) = (ask("client:mail"), ask("client:mail"));
        assert!(first.await.unwrap().is_err() && second.await.unwrap().is_err());
        assert_eq!(*asked.lock().unwrap(), vec!["client:jira", "client:mail"]);
        // Après un refus, une nouvelle demande pose de nouveau la question.
        assert!(ask("client:mail").await.unwrap().is_err());
        assert_eq!(asked.lock().unwrap().len(), 3);
    }
}
