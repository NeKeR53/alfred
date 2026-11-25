//! Ce que la coquille et `check` savent des lectures d’un service. Le magasin des états (`states.rs`) est la seule
//! source de vérité des données : une fonction de lecture l’alimente par sa sortie, une page s’y abonne
//! (`useAlfredState`). Ici :
//!
//! - [`client_changed`] : une fonction a écrit chez un service (vu par `clients::frame_request`) ; les coquilles
//!   relisent les états affichés du module (`clients:changed`).
//! - Les contrôles de `check` qui font respecter la règle : une page s’abonne à un état, elle n’appelle pas une
//!   fonction pour afficher une donnée ; toute lecture d’un service alimente un état nommé ; un script passe par le
//!   client d’Alfred.

use serde_json::{json, Value};

use crate::state::AppState;

/// Événement d’une écriture chez un service, reçu par les coquilles.
pub const CLIENT_CHANGED: &str = "clients:changed";

/// Une fonction a écrit chez un service (méthode autre que `GET` ou `HEAD`) : les coquilles relisent les états
/// affichés du module (une lecture par état). Rien n’est émis pour une fonction déclarée `effect: "read"`
/// (une recherche en `POST`) : sinon la relecture qu’elle déclenche la relancerait sans fin. Le nom de la fonction
/// n’est connu que pour un script ; pour une fonction TypeScript (`module/*`), la coquille ignore l’événement tant
/// qu’une fonction de ce module tourne chez elle, et invalide elle-même à la fin d’une écriture.
pub fn client_changed(
    state: &AppState,
    space: &crate::space::Space,
    subject: &crate::permissions::Subject,
    client: &str,
    instance: &str,
) {
    let function = subject.reference.split_once('/').map(|(_, id)| id).filter(|id| *id != "*");
    if let Some(id) = function {
        let read = space.module(&subject.module).is_ok_and(|manifest| {
            manifest.functions.iter().any(|f| f.id == id && f.effect == Some(crate::space::Effect::Read))
        });
        if read {
            return;
        }
    }
    let mut payload = json!({ "module": subject.module, "client": client, "instance": instance });
    if let Some(id) = function {
        payload["function"] = json!(format!("{}/{id}", subject.module));
    }
    state.emit(CLIENT_CHANGED, payload);
}

// --- Contrôles de `check` : aucune lecture d’un service ne contourne le magasin partagé ---------------------------

/// Références des fonctions qu’un fichier de page appelle par `functions.call("…")`, avec une chaîne littérale.
fn called_functions(source: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = source.as_bytes();
    let mut from = 0;
    while let Some(at) = source[from..].find("functions.call") {
        let mut index = from + at + "functions.call".len();
        from = index;
        let skip_spaces = |index: &mut usize| {
            while *index < bytes.len() && bytes[*index].is_ascii_whitespace() {
                *index += 1;
            }
        };
        skip_spaces(&mut index);
        // Paramètre de type : `<{ tickets: Array<Ticket> }>`, chevrons imbriqués compris.
        if bytes.get(index) == Some(&b'<') {
            let mut depth = 0usize;
            while index < bytes.len() {
                match bytes[index] {
                    b'<' => depth += 1,
                    b'>' => {
                        depth -= 1;
                        if depth == 0 {
                            index += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                index += 1;
            }
            skip_spaces(&mut index);
        }
        if bytes.get(index) != Some(&b'(') {
            continue;
        }
        index += 1;
        skip_spaces(&mut index);
        let Some(&quote) = bytes.get(index).filter(|quote| matches!(**quote, b'"' | b'\'' | b'`')) else { continue };
        let start = index + 1;
        if let Some(length) = source[start..].find(quote as char) {
            let name = &source[start..start + length];
            if !name.is_empty() && !name.contains('$') {
                found.push(name.to_string());
            }
        }
    }
    found
}

/// Remarques sur une page (ou un panneau) qui lit une fonction de lecture par `functions.call` au lieu de s’abonner à
/// un état (`useAlfredState`) : la donnée ne suivrait pas les changements. `check` les refuse comme une erreur.
pub fn page_read_problems(source: &str, module: &str, functions: &[crate::space::ResolvedFunction]) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    for name in called_functions(source) {
        let reference = if name.contains('/') { name.clone() } else { format!("{module}/{name}") };
        let read = functions
            .iter()
            .any(|function| function.reference == reference && function.effect == Some(crate::space::Effect::Read));
        let problem = format!(
            "La page lit « {reference} » par `functions.call` : une page s’abonne à un état, elle n’appelle pas une \
             fonction pour afficher une donnée. Écris `useAlfredState(\"<module>/<état>\")` sur l’état que cette \
             lecture alimente (SDK.md, section 3, « États partagés ») : la page reçoit la valeur courante, puis chaque \
             changement. `functions.call` reste pour les écritures et les actions."
        );
        if read && !problems.contains(&problem) {
            problems.push(problem);
        }
    }
    problems
}

/// Outils de réseau qu’un script n’utilise pas : il joint le service par `alfred.client` (ou `ALFRED_SDK_URL`).
const SCRIPT_NETWORK: [&str; 12] = [
    "curl ",
    "wget ",
    "Invoke-WebRequest",
    "Invoke-RestMethod",
    "iwr ",
    "irm ",
    "import requests",
    "import httpx",
    "import urllib",
    "from urllib",
    "from requests",
    "import aiohttp",
];

/// Remarque sur une fonction qui joint un service : `effect` absent (ses lectures ne seraient pas partagées), ou
/// script qui appelle le réseau lui-même au lieu du client d’Alfred.
pub fn function_problem(space: &crate::space::Space, function: &crate::space::ResolvedFunction) -> Option<String> {
    let reaches_service = !function.uses.clients.is_empty()
        || space.module(&function.module).is_ok_and(|manifest| !manifest.clients.is_empty());
    if !reaches_service {
        return None;
    }
    if function.effect.is_none() {
        return Some(
            "La fonction joint un service sans déclarer `effect` : déclare `effect: \"read\"` pour une lecture (elle \
             alimente alors un état nommé, `state` ou `entity`), `\"write\"` pour une écriture (elle fait relire les \
             états affichés du module). Redéclare-la avec `declare_function`."
                .to_string(),
        );
    }
    let manifest = space.module(&function.module).ok()?;
    // Seule une lecture qui joint un service (`uses.clients`) alimente un état : un calcul sans service n’en a pas.
    if function.effect == Some(crate::space::Effect::Read)
        && !function.uses.clients.is_empty()
        && function.state.is_none()
        && function.entity.is_none()
    {
        return Some(
            "Toute lecture d’un service alimente un état nommé : déclare l’état (`states` du module.json) ou le type \
             d’entité (`entities`) que la fonction alimente, puis redéclare-la avec `state` (une liste, une valeur) ou \
             `entity` (un objet lu seul, avec `param`, le champ de l’entrée qui porte son identifiant). Les pages s’y \
             abonnent avec `useAlfredState` (SDK.md, section 3)."
                .to_string(),
        );
    }
    if let Some(state) = &function.state {
        if !manifest.states.iter().any(|declared| &declared.id == state) {
            return Some(format!("La fonction alimente « {state} », absent de `states` du module.json : déclare-le."));
        }
    }
    if let Some(entity) = &function.entity {
        if !manifest.entities.iter().any(|declared| &declared.id == entity) {
            return Some(format!("La fonction met à jour « {entity} », absent de `entities` du module.json : déclare-le."));
        }
    }
    if function.runtime == crate::scripts::Runtime::Ts {
        return None;
    }
    let source = std::fs::read_to_string(space.function_file(&function.module, &function.id)).ok()?;
    let tool = SCRIPT_NETWORK.iter().find(|tool| source.contains(*tool))?;
    Some(format!(
        "Le script appelle le réseau lui-même (« {} ») : un service se joint par le client d’Alfred \
         (`alfred.client(\"…\")` en Python, le pont `ALFRED_SDK_URL` en bash ou PowerShell, SDK.md section 2). Ainsi \
         sa lecture passe par le magasin partagé et l’authentification reste chez Alfred.",
        tool.trim()
    ))
}

/// Remarques sur les états et entités d’un module : un état qu’aucune lecture n’alimente, une liste d’un type
/// d’entité non déclaré, un identifiant d’entité vide.
pub fn state_problems(space: &crate::space::Space, module: &str) -> Vec<Value> {
    let Ok(manifest) = space.module(module) else { return Vec::new() };
    let mut problems = Vec::new();
    for state in &manifest.states {
        let read = |id: &str| {
            manifest.functions.iter().find(|function| function.id == id && function.effect == Some(crate::space::Effect::Read))
        };
        let fed = manifest.functions.iter().any(|function| {
            function.state.as_deref() == Some(state.id.as_str()) && function.effect == Some(crate::space::Effect::Read)
        });
        match &state.refresh {
            // Un état à rafraîchissement a sa fonction : une lecture du module, appelée avec les paramètres.
            Some(refresh) => {
                if refresh.function.is_empty() || read(&refresh.function).is_none() {
                    problems.push(json!({ "module": module, "state": state.id, "problem": format!("`refresh.function` vaut « {} » : il faut une fonction de lecture du module (`effect: \"read\"`) qui rafraîchit l’état.", refresh.function) }));
                }
                if refresh.every < 10 {
                    problems.push(json!({ "module": module, "state": state.id, "problem": "`refresh.every` vaut 10 secondes au moins : choisis la période la plus longue qui suffit (30 à 300 s pour un service)." }));
                }
                if refresh.mode == crate::space::RefreshMode::Always && !state.params.is_empty() {
                    problems.push(json!({ "module": module, "state": state.id, "problem": "`mode: \"always\"` vaut pour un état sans paramètres : un état à paramètres se rafraîchit tant qu’il a un abonné." }));
                }
            }
            None if !fed => {
                problems.push(json!({ "module": module, "state": state.id, "problem": "Aucune fonction de lecture n’alimente cet état (`state` sur une fonction `effect: \"read\"`, ou `refresh.function`) : il resterait vide." }));
            }
            None => {}
        }
        // Un paramètre se décrit : c’est ce que lit un module consommateur pour savoir quoi passer.
        for param in &state.params {
            if param.description().trim().is_empty() {
                problems.push(json!({ "module": module, "state": state.id, "problem": format!("Décris le paramètre « {} » : {{ \"id\": \"{}\", \"description\": \"…\", \"example\": … }}. Un module qui s’abonne lit cette description dans `space_overview`.", param.id(), param.id()) }));
            }
        }
        if let Some(entity) = &state.entity {
            if !manifest.entities.iter().any(|declared| &declared.id == entity) {
                problems.push(json!({ "module": module, "state": state.id, "problem": format!("L’état liste des « {entity} », type absent de `entities`.") }));
            }
        }
    }
    for entity in &manifest.entities {
        if entity.version == 0 {
            problems.push(json!({ "module": module, "entity": entity.id, "problem": "Donne une `version` au contrat de l’entité (1 pour commencer) : d’autres modules s’y fient." }));
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_that_reads_a_connector_by_functions_call_is_refused() {
        let source = r#"
            const a = useAsync(() => functions.call<{ tickets: Array<{ cle: string }> }>("jira/lister-tickets", { jql }), []);
            const b = useAsync(() => functions.call('etat', {}), []);
            const ok = () => functions.call("jira/commenter-ticket", { cle });
            const dynamic = functions.call(`${nom}`, {});
            const hook = useAlfredState("jira/mes-tickets");
        "#;
        assert_eq!(
            called_functions(source),
            vec!["jira/lister-tickets", "etat", "jira/commenter-ticket"],
            "une référence calculée est ignorée"
        );
        let declared = |reference: &str, effect| crate::space::ResolvedFunction {
            reference: reference.to_string(),
            module: reference.split('/').next().unwrap().to_string(),
            id: reference.split('/').nth(1).unwrap().to_string(),
            description: String::new(),
            input: Value::Null,
            output: Value::Null,
            tool: false,
            missing: false,
            errors: Vec::new(),
            uses: Default::default(),
            runtime: Default::default(),
            effect,
            state: None,
            entity: None,
            param: None,
            tests: Vec::new(),
            examples: 0,
        };
        let functions = [
            declared("jira/lister-tickets", Some(crate::space::Effect::Read)),
            declared("jira/commenter-ticket", Some(crate::space::Effect::Write)),
            declared("ci/etat", Some(crate::space::Effect::Read)),
        ];
        let problems = page_read_problems(source, "ci", &functions);
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems[0].contains("« jira/lister-tickets »") && problems[0].contains("useAlfredState"));
        assert!(problems[1].contains("« ci/etat »"));
    }
}
