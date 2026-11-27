//! Configuration des modules : ce qu’il reste à renseigner pour qu’un module fonctionne, étape par étape.
//!
//! Le parcours se déduit de ce que le module déclare (`clients` de son `module.json`, et ceux des modules qu’il
//! requiert) et de l’état réel des services de l’espace. Rien n’est mémorisé à part le résultat des tests : le
//! parcours reprend toujours à la première étape incomplète.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{opt_arg, AppResult};
use crate::space::ModuleManifest;
use crate::state::AppState;

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "modules.setup" => {
            let (state, args) = (state.clone(), args.clone());
            // Lecture du trousseau : hors des fils asynchrones.
            Some(
                crate::vault::blocking(move || {
                    let only = opt_arg::<String>(&args, "module")?;
                    status(&state, only.as_deref())
                })
                .await,
            )
        }
        _ => None,
    }
}

/// État de configuration de chaque module (ou du seul `only`) : `{ modules: [{ module, name, ready, steps }] }`.
pub fn status(state: &Arc<AppState>, only: Option<&str>) -> AppResult<Value> {
    let space = state.space()?;
    let overview = crate::clients::overview(state)?;
    let modules: Vec<ModuleManifest> = space.module_ids().iter().filter_map(|id| space.module(id).ok()).collect();
    let items: Vec<Value> = modules
        .iter()
        .filter(|module| only.is_none_or(|only| only == module.id))
        .map(|module| module_status(&modules, module, &overview))
        .collect();
    Ok(json!({ "modules": items }))
}

/// Besoins de `module` puis ceux de ses dépendances, en profondeur, chacun une seule fois.
fn needs_of<'a>(
    modules: &'a [ModuleManifest],
    module: &'a ModuleManifest,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<(&'a ModuleManifest, &'a crate::space::ClientNeed)>,
) {
    if !seen.insert(module.id.clone()) {
        return;
    }
    for need in &module.clients {
        out.push((module, need));
    }
    for requirement in &module.requires {
        if let Some(required) = modules.iter().find(|candidate| candidate.id == requirement.module) {
            needs_of(modules, required, seen, out);
        }
    }
}

fn module_status(modules: &[ModuleManifest], module: &ModuleManifest, overview: &Value) -> Value {
    let mut needs = Vec::new();
    needs_of(modules, module, &mut BTreeSet::new(), &mut needs);
    let steps: Vec<Value> = needs.iter().map(|(owner, need)| step(owner, need, overview)).collect();
    let ready = steps.iter().all(|step| step["optional"] == json!(true) || step["state"] == json!("ready"));
    json!({
        "module": module.id,
        "name": if module.name.is_empty() { &module.id } else { &module.name },
        "description": module.description,
        "welcome": module.setup.as_ref().map(|setup| setup.welcome.clone()).unwrap_or_default(),
        "installed": module.imported(),
        "ready": ready,
        "steps": steps,
    })
}

/// Une étape : un service dont le module a besoin, et où il en est.
///
/// - `missing` : aucun service ne répond au besoin ;
/// - `incomplete` : le service existe, mais aucun de ses comptes n’est prêt (secret, approbation, connexion…) ;
/// - `untested` : un compte est prêt mais n’a pas encore été testé dans son état actuel ;
/// - `failed` : les comptes prêts ont tous échoué à leur dernier test ;
/// - `ready` : au moins un compte est prêt et son dernier test a réussi.
fn step(owner: &ModuleManifest, need: &crate::space::ClientNeed, overview: &Value) -> Value {
    let key = format!("{}/{}", owner.id, need.id);
    let resolved = overview["needs"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["key"].as_str() == Some(&key))
        .and_then(|item| item["client"].as_str().map(str::to_string));
    let client = resolved
        .as_deref()
        .and_then(|id| overview["clients"].as_array().into_iter().flatten().find(|client| client["id"].as_str() == Some(id)));
    let state = match client {
        None => "missing",
        Some(client) => {
            let ready: Vec<&Value> = client["instances"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|instance| instance["status"] == json!("ready"))
                .collect();
            if ready.is_empty() {
                "incomplete"
            } else if ready.iter().any(|instance| instance["lastTest"]["ok"] == json!(true)) {
                "ready"
            } else if ready.iter().all(|instance| instance["lastTest"]["ok"] == json!(false)) {
                "failed"
            } else {
                "untested"
            }
        }
    };
    json!({
        "key": key,
        "module": owner.id,
        "moduleName": if owner.name.is_empty() { &owner.id } else { &owner.name },
        "need": need.id,
        "label": if need.label.is_empty() { &need.id } else { &need.label },
        "help": need.help,
        "optional": need.optional,
        "hasTemplate": need.client.is_some(),
        "client": resolved,
        "state": state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::testing::*;
    use crate::space::{ClientNeed, Requirement, SetupDecl};

    fn write_module(state: &Arc<AppState>, manifest: ModuleManifest) {
        state.space().unwrap().write_module(&manifest).unwrap();
    }

    fn need(id: &str, label: &str) -> ClientNeed {
        ClientNeed { id: id.into(), label: label.into(), ..ClientNeed::default() }
    }

    fn module_of(value: &Value, id: &str) -> Value {
        value["modules"].as_array().unwrap().iter().find(|module| module["module"] == json!(id)).unwrap().clone()
    }

    #[tokio::test]
    async fn steps_follow_needs_then_dependencies_and_readiness_needs_a_passing_test() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        write_module(
            &state,
            ModuleManifest {
                id: "annuaire".into(),
                name: "Annuaire".into(),
                clients: vec![need("crm", "CRM")],
                ..ModuleManifest::default()
            },
        );
        write_module(
            &state,
            ModuleManifest {
                id: "suivi".into(),
                name: "Suivi".into(),
                requires: vec![Requirement { module: "annuaire".into(), min_version: None }],
                clients: vec![
                    need("jira", "Jira"),
                    ClientNeed { optional: true, help: "Facultatif.".into(), ..need("slack", "Slack") },
                ],
                setup: Some(SetupDecl { welcome: "Bienvenue.".into() }),
                ..ModuleManifest::default()
            },
        );

        let first = module_of(&status(&state, None).unwrap(), "suivi");
        assert_eq!(first["welcome"], json!("Bienvenue."));
        assert_eq!(first["ready"], json!(false));
        let keys: Vec<&str> = first["steps"].as_array().unwrap().iter().map(|step| step["key"].as_str().unwrap()).collect();
        assert_eq!(keys, ["suivi/jira", "suivi/slack", "annuaire/crm"], "ordre du manifeste, puis dépendances");
        assert!(first["steps"].as_array().unwrap().iter().all(|step| step["state"] == json!("missing")));

        // Deux services sans authentification, créés par l’utilisateur : prêts, mais pas encore testés.
        for id in ["jira", "crm"] {
            invoke(&state, "clients.save", json!({ "client": { "id": id, "label": id, "baseUrl": format!("{}/api", remote.origin), "testPath": "/texte", "auth": { "type": "none" } }, "create": true }))
                .await
                .unwrap();
        }
        let untested = module_of(&status(&state, Some("suivi")).unwrap(), "suivi");
        assert_eq!(untested["steps"][0]["state"], json!("untested"));
        assert_eq!(untested["ready"], json!(false), "un compte jamais testé ne rend pas le module prêt");

        invoke(&state, "clients.test", json!({ "id": "jira" })).await.unwrap();
        let half = module_of(&status(&state, None).unwrap(), "suivi");
        assert_eq!(half["steps"][0]["state"], json!("ready"));
        assert_eq!(half["steps"][2]["state"], json!("untested"));
        assert_eq!(half["ready"], json!(false), "la dépendance compte aussi");

        invoke(&state, "clients.test", json!({ "id": "crm" })).await.unwrap();
        let done = module_of(&status(&state, None).unwrap(), "suivi");
        assert_eq!(done["ready"], json!(true), "le service facultatif peut rester à configurer: {done}");
        assert_eq!(module_of(&status(&state, None).unwrap(), "annuaire")["ready"], json!(true));

        // Modifier l’adresse efface la réussite du test.
        invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "jira", "label": "jira", "baseUrl": format!("{}/api/echo", remote.origin), "testPath": "/texte", "auth": { "type": "none" } } }),
        )
        .await
        .unwrap();
        let changed = module_of(&status(&state, None).unwrap(), "suivi");
        assert_eq!(changed["steps"][0]["state"], json!("untested"));
        assert_eq!(changed["ready"], json!(false));
    }

    #[tokio::test]
    async fn a_failed_test_is_reported_and_a_module_without_needs_is_ready() {
        let (state, _dir) = test_state();
        write_module(&state, ModuleManifest { id: "notes".into(), name: "Notes".into(), ..ModuleManifest::default() });
        write_module(
            &state,
            ModuleManifest { id: "suivi".into(), name: "Suivi".into(), clients: vec![need("jira", "Jira")], ..ModuleManifest::default() },
        );
        // Adresse où rien n’écoute : le test échoue.
        invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "jira", "label": "Jira", "baseUrl": "http://127.0.0.1:9", "auth": { "type": "none" } }, "create": true }),
        )
        .await
        .unwrap();
        let tested = invoke(&state, "clients.test", json!({ "id": "jira" })).await.unwrap();
        assert_eq!(tested["ok"], json!(false));
        let all = status(&state, None).unwrap();
        assert_eq!(module_of(&all, "suivi")["steps"][0]["state"], json!("failed"));
        assert_eq!(module_of(&all, "notes")["ready"], json!(true));
        assert_eq!(module_of(&all, "notes")["steps"], json!([]));
    }
}
