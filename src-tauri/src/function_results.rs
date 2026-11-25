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
