//! Réponses des fonctions diffusées à toutes les coquilles d’Alfred (fenêtre principale, fenêtres de page) par
//! l’événement `functions:result`. Chaque coquille garde un magasin partagé des lectures (`src/shell/sharedQueries.ts`) :
//! une lecture (`effect: "read"`) y est publiée aux pages abonnées sans nouvelle requête ; une écriture y rend
//! caduques les lectures du même module et des modules qui en dépendent.
//!
//! Point d’entrée pour le cœur : une fonction que le cœur exécute lui-même (automatisation, webhook, planification
//! d’un script) appelle [`publish`] avec sa réponse, pour que les pages qui montrent cette lecture se mettent à jour.
//! La coquille vérifie l’effet déclaré de la fonction : le cœur n’a pas à le savoir.

use serde_json::{json, Map, Value};

use crate::error::{arg, AppResult};
use crate::state::AppState;

/// Nom de l’événement reçu par les coquilles.
pub const EVENT: &str = "functions:result";
/// Une réponse plus grosse n’est pas diffusée : les autres fenêtres la reliront elles-mêmes au besoin.
const MAX_OUTPUT: usize = 1024 * 1024;

/// Réponse d’une fonction, telle que la reçoivent les coquilles.
pub struct FunctionResult<'a> {
    /// `module/fonction`.
    pub function: &'a str,
    pub input: &'a Value,
    /// Comptes passés à la fonction, par besoin de son module (`{ "jira": "acme" }`) ; vide : comptes par défaut.
    pub accounts: Option<&'a Map<String, Value>>,
    pub examples: bool,
    /// Sortie d’une lecture réussie ; `None` pour une écriture (ou un échec) : les lectures touchées se relisent.
    pub output: Option<&'a Value>,
    /// Coquille d’où vient la réponse (elle l’ignore) ; `None` pour le cœur.
    pub origin: Option<&'a str>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

/// Contenu de l’événement, ou `None` si la sortie est trop grosse pour être diffusée.
fn payload(result: &FunctionResult, at: u64) -> Option<Value> {
    let mut payload = json!({
        "function": result.function,
        "input": result.input,
        "accounts": result.accounts.cloned().unwrap_or_default(),
        "examples": result.examples,
        "at": at,
    });
    if let Some(origin) = result.origin {
        payload["origin"] = json!(origin);
    }
    if let Some(output) = result.output {
        if serde_json::to_string(output).map(|text| text.len()).unwrap_or(usize::MAX) > MAX_OUTPUT {
            return None;
        }
        payload["output"] = output.clone();
    }
    Some(payload)
}

/// Diffuse la réponse d’une fonction à toutes les coquilles.
pub fn publish(state: &AppState, result: &FunctionResult) {
    if let Some(payload) = payload(result, now_ms()) {
        state.emit(EVENT, payload);
    }
}

/// Événement d’une écriture chez un service, reçu par les coquilles.
pub const CLIENT_CHANGED: &str = "clients:changed";

/// Une fonction a écrit chez un service (méthode autre que `GET` ou `HEAD`) : les coquilles rendent caduques les
/// lectures du module et des modules qui en dépendent. Rien n’est émis pour une fonction déclarée `effect: "read"`
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

/// Remarques sur une page (ou un panneau) qui lit une fonction de lecture par `functions.call` au lieu de `useQuery` :
/// la donnée ne suivrait pas les nouvelles réponses ni les écritures. `check` les refuse comme une erreur.
pub fn page_read_problems(source: &str, module: &str, functions: &[crate::space::ResolvedFunction]) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    for name in called_functions(source) {
        let reference = if name.contains('/') { name.clone() } else { format!("{module}/{name}") };
        let read = functions
            .iter()
            .any(|function| function.reference == reference && function.effect == Some(crate::space::Effect::Read));
        let problem = format!(
            "La page lit « {reference} » par `functions.call` : une lecture d’un connecteur passe par le magasin \
             partagé. Écris `useQuery(\"{name}\", entrée)` (SDK.md, section 3, « useQuery ») : la page reçoit la \
             dernière réponse, suit chaque nouvelle réponse et se relit après une écriture. `functions.call` reste \
             pour les écritures."
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
            "La fonction joint un service sans déclarer `effect` : déclare `effect: \"read\"` pour une lecture (sa \
             réponse est alors partagée entre les pages par le magasin, `useQuery`), `\"write\"` pour une écriture \
             (elle fait relire les lectures du module). Redéclare-la avec `declare_function`."
                .to_string(),
        );
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

pub async fn handle(state: &AppState, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        // Une coquille a obtenu une réponse : les autres fenêtres la reçoivent. Jamais demandé par un cadre.
        "functions.shareResult" => Some((|| {
            let function: String = arg(args, "function")?;
            let origin: Option<String> = args.get("origin").and_then(Value::as_str).map(str::to_string);
            let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
            let accounts = args.get("accounts").and_then(Value::as_object);
            let examples = args.get("examples").and_then(Value::as_bool).unwrap_or(false);
            let result = FunctionResult {
                function: &function,
                input: &input,
                accounts,
                examples,
                output: args.get("output"),
                origin: origin.as_deref(),
            };
            let at = args.get("at").and_then(Value::as_u64).unwrap_or_else(now_ms);
            if let Some(payload) = payload(&result, at) {
                state.emit(EVENT, payload);
            }
            Ok(Value::Null)
        })()),
        _ => None,
    }
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
            const hook = useQuery("jira/lister-tickets", { jql });
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
        assert!(problems[0].contains("« jira/lister-tickets »") && problems[0].contains("useQuery"));
        assert!(problems[1].contains("« ci/etat »"));
    }

    #[tokio::test]
    async fn a_result_reaches_every_shell_with_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let mut events = state.events.subscribe();

        let input = json!({ "projet": "ALF" });
        let output = json!({ "tickets": [{ "cle": "ALF-1" }] });
        let accounts = json!({ "jira": "acme" });
        publish(
            &state,
            &FunctionResult {
                function: "jira/lister-tickets",
                input: &input,
                accounts: accounts.as_object(),
                examples: false,
                output: Some(&output),
                origin: None,
            },
        );
        let event = events.recv().await.unwrap();
        assert_eq!(event.name, EVENT);
        assert_eq!(event.payload["function"], "jira/lister-tickets");
        assert_eq!(event.payload["accounts"], accounts);
        assert_eq!(event.payload["output"], output);
        assert!(event.payload.get("origin").is_none(), "venue du cœur");

        // Une écriture part sans sortie ; la coquille d’origine est nommée.
        let shared = handle(
            &state,
            "functions.shareResult",
            &json!({ "function": "jira/commenter", "input": { "ticket": "ALF-1" }, "origin": "shell-1", "at": 5 }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(shared, Value::Null);
        let event = events.recv().await.unwrap();
        assert_eq!(event.payload["origin"], "shell-1");
        assert_eq!(event.payload["at"], 5);
        assert!(event.payload.get("output").is_none());

        // Une sortie trop grosse n’est pas diffusée.
        let big = json!("x".repeat(MAX_OUTPUT + 1));
        let result = FunctionResult {
            function: "jira/lister-tickets",
            input: &input,
            accounts: None,
            examples: false,
            output: Some(&big),
            origin: None,
        };
        assert!(payload(&result, 1).is_none());
    }
}
