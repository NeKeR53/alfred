//! Données d’exemple : une page dont les services ne sont pas configurés (ou qu’on veut voir sans toucher aux vrais
//! comptes) s’affiche quand même. Le mode se règle module par module, dans la base d’Alfred (hors de l’espace,
//! jamais commité). Les fonctions de connecteur (`uses.clients`) rendent alors l’exemple déclaré dans `module.json`
//! dont l’entrée correspond le mieux à l’appel ; les autres fonctions s’exécutent normalement, mais leurs appels à
//! d’autres fonctions passent eux aussi par les exemples, et aucune requête ne part vers un service
//! (`frame.clients.request` refuse). Les écritures dans la base du module restent possibles.

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};

use crate::app_db;
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{FunctionDecl, FunctionExample, Space};
use crate::state::AppState;

fn key(space: &Space) -> String {
    format!("examples:{}", space.root.to_string_lossy())
}

fn stored(state: &AppState, space: &Space) -> Vec<String> {
    let Ok(db) = state.app_db.lock() else { return Vec::new() };
    app_db::get_setting(&db, &key(space))
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default()
}

/// Modules de l’espace ouvert affichés avec leurs données d’exemple (ceux qui existent encore).
pub fn modules(state: &AppState) -> Vec<String> {
    let Some(space) = state.try_space() else { return Vec::new() };
    stored(state, &space).into_iter().filter(|module| space.module(module).is_ok()).collect()
}

/// Le module est réglé en mode « données d’exemple ».
pub fn is_on(state: &AppState, module: &str) -> bool {
    state.try_space().is_some_and(|space| stored(state, &space).iter().any(|item| item == module))
}

/// Active ou quitte le mode pour un module.
pub fn set(state: &AppState, module: &str, on: bool) -> AppResult<Vec<String>> {
    let space = state.space()?;
    space.module(module)?;
    let mut list = stored(state, &space);
    list.retain(|item| item != module);
    if on {
        list.push(module.to_string());
    }
    list.sort();
    {
        let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
        let value = if list.is_empty() { Value::Null } else { json!(list) };
        app_db::set_setting(&db, &key(&space), &value)?;
    }
    state.emit("examples:changed", json!({ "module": module, "on": on }));
    Ok(list)
}

/// Erreur rendue à une fonction qui tente de joindre un service en mode exemple.
pub fn blocked(client: &str) -> AppError {
    AppError::new(format!(
        "Données d’exemple : aucune requête ne part vers le service « {client} ». Une fonction de connecteur déclare \
         ce service dans `uses.clients` et rend alors ses `examples` à la place."
    ))
}

/// Exemple qui répond à `input` : celui dont l’entrée est identique, sinon celui qui partage le plus de champs
/// fournis par l’appel (même valeur), sinon le premier.
pub fn pick<'a>(examples: &'a [FunctionExample], input: &Value) -> Option<&'a FunctionExample> {
    let score = |example: &FunctionExample| -> usize {
        if example.input == *input {
            return usize::MAX;
        }
        input.as_object().map_or(0, |fields| {
            fields.iter().filter(|(name, value)| example.input.get(name.as_str()) == Some(*value)).count()
        })
    };
    let mut best: Option<(&FunctionExample, usize)> = None;
    for example in examples {
        let points = score(example);
        if best.is_none_or(|(_, top)| points > top) {
            best = Some((example, points));
        }
    }
    best.map(|(example, _)| example)
}

/// Sortie d’exemple de `declared` pour `input`, ou l’erreur qui dit qu’il n’y en a pas.
pub fn answer(reference: &str, declared: &FunctionDecl, input: &Value) -> AppResult<(String, Value)> {
    let input = if input.is_null() { json!({}) } else { input.clone() };
    match pick(&declared.examples, &input) {
        Some(example) => Ok((example.name.clone(), example.output.clone())),
        None => Err(AppError::new(format!(
            "Cette fonction n’a pas encore de données d’exemple (« {reference} ») : ajoutez-lui des `examples` dans sa \
             déclaration (declare_function)."
        ))),
    }
}

/// Répond à l’appel d’une fonction de connecteur en mode exemple, et le note au journal.
pub fn respond(state: &AppState, reference: &str, declared: &FunctionDecl, input: &Value, caller: &str) -> AppResult<Value> {
    let started = Instant::now();
    let result = answer(reference, declared, input);
    let duration = Some(started.elapsed().as_millis() as u64);
    match &result {
        Ok((name, _)) => crate::functions::journal(
            state,
            "function",
            reference,
            true,
            duration,
            &format!("Données d’exemple « {name} » (appelée par {caller})"),
            Some(&json!({ "caller": caller, "example": name })),
        ),
        Err(error) => crate::functions::journal(
            state,
            "function",
            reference,
            false,
            duration,
            &format!("Échec (appelée par {caller}) : {}", error.message),
            Some(&json!({ "caller": caller, "error": error.message, "examples": true })),
        ),
    }
    result.map(|(_, output)| output)
}

/// Pour `check` : chaque sortie d’exemple respecte le schéma `output`, et chaque fonction de connecteur a des
/// exemples.
pub fn problems(space: &Space, keep: &dyn Fn(&str) -> bool) -> Vec<Value> {
    let mut found = Vec::new();
    for id in space.module_ids() {
        let Ok(manifest) = space.module(&id) else { continue };
        if !keep(&manifest.id) || manifest.read_only() {
            continue;
        }
        for declared in &manifest.functions {
            let reference = format!("{}/{}", manifest.id, declared.id);
            if declared.is_connector() && declared.examples.is_empty() {
                found.push(json!({
                    "function": reference,
                    "problem": "Fonction de connecteur sans données d’exemple : redéclarer avec deux ou trois `examples` réalistes, au format exact du service et cohérents avec les autres fonctions du connecteur (mêmes identifiants), pour que ses pages s’affichent sans compte.",
                }));
            }
            for (index, example) in declared.examples.iter().enumerate() {
                let name = if example.name.trim().is_empty() { format!("#{}", index + 1) } else { example.name.clone() };
                let mut errors = Vec::new();
                crate::function_tests::schema_errors(&declared.output, &example.output, "", &mut errors);
                if !errors.is_empty() {
                    found.push(json!({
                        "function": reference,
                        "example": name,
                        "problem": format!("L’exemple « {name} » ne respecte pas le schéma `output` : {}", errors.join(" ")),
                    }));
                }
            }
        }
    }
    found
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "examples.list" => Ok(json!(modules(state))),
        "examples.set" => (|| {
            let module: String = arg(args, "module")?;
            let on: bool = arg(args, "on")?;
            Ok(json!(set(state, &module, on)?))
        })(),
        // La coquille demande l’exemple d’une fonction de connecteur TypeScript appelée en mode exemple.
        "functions.example" => (|| {
            let reference: String = arg(args, "function")?;
            let caller = opt_arg::<String>(args, "caller")?.unwrap_or_else(|| "interface".to_string());
            let (module, function) = reference
                .split_once('/')
                .ok_or_else(|| AppError::new(format!("Fonction désignée par « module/fonction » attendue : « {reference} ».")))?;
            let manifest = state.space()?.module(module)?;
            let declared = manifest
                .functions
                .iter()
                .find(|declared| declared.id == function)
                .ok_or_else(|| AppError::new(format!("La fonction « {reference} » n’est pas déclarée dans son module.")))?;
            respond(state, &reference, declared, args.get("input").unwrap_or(&Value::Null), &caller)
        })(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::testing::{function_subject, grant, invoke, remote, request, test_state};
    use crate::space::{ModuleManifest, Uses};

    fn example(name: &str, input: Value, output: Value) -> FunctionExample {
        FunctionExample { name: name.into(), input, output }
    }

    fn connector() -> FunctionDecl {
        FunctionDecl {
            id: "lister".into(),
            uses: Uses { clients: vec!["jira".into()], ..Uses::default() },
            output: json!({ "type": "object", "required": ["issues"], "properties": { "issues": { "type": "array" } } }),
            examples: vec![
                example("Trois tickets ouverts", json!({ "status": "open" }), json!({ "issues": [1, 2, 3] })),
                example("Un ticket fermé", json!({ "status": "closed", "project": "ALF" }), json!({ "issues": [4] })),
                example("Projet ALF ouvert", json!({ "status": "open", "project": "ALF" }), json!({ "issues": [5] })),
            ],
            ..FunctionDecl::default()
        }
    }

    #[test]
    fn the_closest_example_answers() {
        let declared = connector();
        let pick = |input: Value| answer("jira/lister", &declared, &input).unwrap().0;
        // Entrée identique.
        assert_eq!(pick(json!({ "status": "open", "project": "ALF" })), "Projet ALF ouvert");
        // Le plus de champs fournis en commun.
        assert_eq!(pick(json!({ "status": "closed" })), "Un ticket fermé");
        assert_eq!(pick(json!({ "status": "open", "limit": 10 })), "Trois tickets ouverts");
        // À égalité, le premier ; sans rien de commun, le premier aussi.
        assert_eq!(pick(json!({ "project": "ALF" })), "Un ticket fermé");
        assert_eq!(pick(json!({ "query": "x" })), "Trois tickets ouverts");
        assert_eq!(pick(Value::Null), "Trois tickets ouverts");
    }

    #[test]
    fn a_function_without_examples_says_so() {
        let declared = FunctionDecl { id: "lister".into(), ..connector() };
        let declared = FunctionDecl { examples: Vec::new(), ..declared };
        let error = answer("jira/lister", &declared, &json!({})).unwrap_err();
        assert!(error.message.starts_with("Cette fonction n’a pas encore de données d’exemple"), "{}", error.message);
    }

    #[test]
    fn check_reports_examples_off_schema_and_connectors_without_examples() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        let mut bad = connector();
        bad.examples.push(example("Sans liste", json!({}), json!({ "total": 3 })));
        let missing = FunctionDecl { id: "detail".into(), examples: Vec::new(), ..connector() };
        let local = FunctionDecl { id: "compter".into(), ..FunctionDecl::default() };
        let manifest = ModuleManifest {
            id: "jira".into(),
            name: "Jira".into(),
            functions: vec![bad, missing, local],
            ..ModuleManifest::default()
        };
        space.write_module(&manifest).unwrap();
        let found = problems(&space, &|_| true);
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.iter().any(|item| item["function"] == json!("jira/lister")
            && item["problem"].as_str().unwrap().contains("« issues » est requis")));
        assert!(found.iter().any(|item| item["function"] == json!("jira/detail")
            && item["problem"].as_str().unwrap().contains("sans données d’exemple")));
        assert!(problems(&space, &|module| module == "autre").is_empty());
    }

    /// En mode exemple, rien ne part vers le service : ni par l’indicateur que fixe la coquille, ni pour un module
    /// réglé en mode exemple. Hors du mode, la même requête passe.
    #[tokio::test]
    async fn no_request_reaches_a_service_in_example_mode() {
        let (state, _dir) = test_state();
        let remote = remote().await;
        let client = json!({ "id": "public", "label": "Public", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "none" } });
        let saved = invoke(&state, "clients.save", json!({ "client": client })).await.unwrap();
        assert_eq!(saved["status"], json!("ready"));
        let space = state.space().unwrap();
        space
            .write_module(&ModuleManifest { id: "crm".into(), name: "CRM".into(), ..ModuleManifest::default() })
            .unwrap();
        let function = function_subject("crm");
        grant(&state, &function, "public");

        let mut flagged = function.clone();
        flagged.examples = true;
        let error = request(&state, &flagged, "public", json!({ "path": "/echo" })).await.unwrap_err();
        assert!(error.message.contains("aucune requête ne part"), "{}", error.message);

        invoke(&state, "examples.set", json!({ "module": "crm", "on": true })).await.unwrap();
        assert_eq!(invoke(&state, "examples.list", json!({})).await.unwrap(), json!(["crm"]));
        assert!(request(&state, &function, "public", json!({ "path": "/echo" })).await.is_err());
        assert!(remote.state.seen.lock().unwrap().is_empty(), "le service n’a pas été appelé");

        invoke(&state, "examples.set", json!({ "module": "crm", "on": false })).await.unwrap();
        assert!(request(&state, &function, "public", json!({ "path": "/echo" })).await.is_ok());
    }

    /// Une fonction de connecteur en script rend son exemple sans être lancée (le script ferait échouer l’appel),
    /// une fonction `write` aussi ; sans exemple, l’appel est refusé.
    #[tokio::test]
    async fn a_connector_answers_with_its_example_without_running() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        let mut lister = connector();
        lister.runtime = crate::scripts::Runtime::Bash;
        let creer = FunctionDecl {
            id: "creer".into(),
            runtime: crate::scripts::Runtime::Bash,
            effect: Some(crate::space::Effect::Write),
            examples: vec![example("Ticket créé", json!({}), json!({ "key": "ALF-9" }))],
            ..connector()
        };
        let vide = FunctionDecl { id: "vide".into(), runtime: crate::scripts::Runtime::Bash, examples: Vec::new(), ..connector() };
        let manifest = ModuleManifest {
            id: "jira".into(),
            name: "Jira".into(),
            functions: vec![lister, creer, vide],
            ..ModuleManifest::default()
        };
        space.write_module(&manifest).unwrap();
        let functions = space.module_dir("jira").join("functions");
        std::fs::create_dir_all(&functions).unwrap();
        for id in ["lister", "creer", "vide"] {
            std::fs::write(functions.join(format!("{id}.sh")), "#!/bin/bash\necho 'appel réel' >&2\nexit 3\n").unwrap();
        }
        set(&state, "jira", true).unwrap();
        let output = crate::functions::call(&state, "jira/lister", json!({ "status": "closed" }), "test").await.unwrap();
        assert_eq!(output, json!({ "issues": [4] }));
        let output = crate::functions::call(&state, "jira/creer", json!({ "summary": "x" }), "test").await.unwrap();
        assert_eq!(output, json!({ "key": "ALF-9" }));
        let error = crate::functions::call(&state, "jira/vide", json!({}), "test").await.unwrap_err();
        assert!(error.message.contains("pas encore de données d’exemple"), "{}", error.message);
        // L’indicateur propagé par un appelant en mode exemple suffit, même si le module ne l’est pas.
        set(&state, "jira", false).unwrap();
        let output =
            crate::functions::call_in(&state, "jira/lister", json!({ "status": "open" }), "test", true).await.unwrap();
        assert_eq!(output, json!({ "issues": [1, 2, 3] }));
    }
}
