//! Accords d’accès. Une page ou une fonction déclare ce dont elle a besoin, mais seul l’utilisateur accorde :
//! la première utilisation d’une ressource sensible pose la question, et la réponse est mémorisée hors de l’espace,
//! là où l’agent ne peut pas l’écrire.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::app_db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Demandeur d’un accès, tel que la coquille l’identifie : `{ kind, module, reference }`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct Subject {
    /// `page`, `panel`, `function`.
    pub kind: String,
    pub module: String,
    /// `module/page` ou `module/fonction`.
    pub reference: String,
}

impl Subject {
    /// Clé de mémorisation : un panneau partage les accords de sa page, une fonction a les siens.
    pub fn key(&self) -> String {
        let kind = if self.kind == "function" { "function" } else { "page" };
        format!("{kind}:{}", self.reference)
    }
}

/// Vérifie que `subject` a accès à `resource` (par exemple `client:jira`) ; sinon pose la question à l’utilisateur
/// et attend sa réponse. `label` décrit la ressource dans la question (« le client Jira »).
pub async fn ensure(state: &Arc<AppState>, subject: &Subject, resource: &str, label: &str) -> AppResult<()> {
    let space = state.space()?.root.to_string_lossy().to_string();
    let key = subject.key();
    {
        let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
        if app_db::is_granted(&db, &space, &key, resource)? {
            return Ok(());
        }
    }
    let answer = state
        .ask_ui(
            "permission:ask",
            json!({ "subject": subject, "resource": resource, "label": label }),
            Duration::from_secs(300),
        )
        .await?;
    if answer.get("granted").and_then(Value::as_bool) != Some(true) {
        return Err(AppError::new(format!("Accès refusé : {} n’a pas le droit d’utiliser {label}.", subject.reference)));
    }
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    app_db::grant(&db, &space, &key, resource)
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
}
