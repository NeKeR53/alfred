//! Accords qu’Alfred demande à l’utilisateur pour ce que fait l’agent, selon l’autonomie de la conversation (celle
//! donnée au harnais) :
//!
//! | Accord | « Autonomie totale » | « Libre dans ses dossiers » | « Accord à chaque action » |
//! |---|---|---|---|
//! | Écriture en Code Mode (`alfred run`) | sans carte | carte | carte |
//! | Script gardé par l’agent (`--save`) | accepté d’office | à valider | à valider |
//! | `validate_client`, `grant_access`, `vault_store` | sans carte | sans carte (avis) | carte |
//! | Automatisation créée ou modifiée par l’agent | à valider | à valider | à valider |
//!
//! Une automatisation reste toujours à valider : elle agit plus tard, seule et à chaque déclenchement, hors de la
//! conversation où le mode a été choisi. En « Accord à chaque action », la CLI `alfred` passe sans les cartes du
//! harnais (elle est autorisée d’office) : Alfred pose donc lui-même la question pour un secret rangé, un service
//! validé (ses requêtes partent avec le secret vers l’hôte déclaré) ou un accès accordé. Le Journal note chaque
//! accord et sa raison.

use serde_json::{json, Value};

use crate::agents::session::Autonomy;
use crate::state::AppState;

/// Autonomie de la conversation, d’après sa session ouverte ; `None` sans session.
pub fn autonomy(state: &AppState, conversation: &str) -> Option<Autonomy> {
    #[cfg(test)]
    if let Some((_, autonomy)) = TEST_AUTONOMY.lock().ok()?.iter().find(|(asked, _)| *asked == conversation) {
        return Some(*autonomy);
    }
    crate::agents::session::autonomy_of(state, conversation)
}

/// « Autonomie totale » : le harnais agit sans demander ; Alfred non plus.
pub fn full(state: &AppState, conversation: &str) -> bool {
    autonomy(state, conversation) == Some(Autonomy::Auto)
}

/// « Accord à chaque action » : Alfred demande aussi pour ses commandes sensibles.
pub fn strict(state: &AppState, conversation: &str) -> bool {
    autonomy(state, conversation) == Some(Autonomy::Strict)
}

/// Autonomie imposée dans les tests, par conversation.
#[cfg(test)]
pub static TEST_AUTONOMY: std::sync::Mutex<Vec<(&'static str, Autonomy)>> = std::sync::Mutex::new(Vec::new());

/// Note au Journal un accord et sa raison (« accord du mode Autonomie totale », « accord de l’utilisateur »).
pub fn record(state: &AppState, conversation: &str, subject: &str, reason: &str) {
    crate::functions::journal(state, "agent", subject, true, None, reason, Some(&json!({ "conversation": conversation })));
}

/// Raison notée quand l’autonomie totale tient lieu d’accord.
pub const FULL_REASON: &str = "accord du mode « Autonomie totale »";

/// Commandes de la CLI qui demandent l’accord en « Accord à chaque action ».
pub const STRICT_COMMANDS: [&str; 3] = ["validate_client", "grant_access", "vault_store"];

/// Carte « Autoriser / Refuser » pour une commande sensible, en « Accord à chaque action ». Rend une erreur à
/// transmettre à l’agent si l’utilisateur refuse ou ne répond pas.
pub async fn ask_command(state: &AppState, conversation: &str, command: &str, args: &Value) -> crate::error::AppResult<()> {
    let title = match command {
        "validate_client" => format!("Valider le service « {} »", args["client"].as_str().unwrap_or("?")),
        "grant_access" => format!("Accorder un accès à « {} »", args["to"].as_str().unwrap_or("?")),
        _ => format!("Ranger « {} » dans le coffre", args["label"].as_str().unwrap_or("?")),
    };
    // Le contenu d’un secret ne s’affiche jamais.
    let mut shown = args.clone();
    if let Some(object) = shown.as_object_mut() {
        for hidden in ["value", "secret", "secrets", "fields", "password", "token"] {
            if object.contains_key(hidden) {
                object.insert(hidden.into(), json!("•••"));
            }
        }
    }
    let detail = format!("L’agent demande : alfred {command}\n{}", serde_json::to_string_pretty(&shown).unwrap_or_default());
    match ask(state, conversation, &title, &detail).await.as_deref() {
        Some("once") => {
            record(state, conversation, command, "accord de l’utilisateur (« Accord à chaque action »)");
            Ok(())
        }
        Some(_) => Err(crate::error::AppError::new(format!("L’utilisateur a refusé `alfred {command}` : rien n’a été fait."))),
        None => Err(crate::error::AppError::new(format!(
            "Pas de réponse à la demande d’accord pour `alfred {command}` : rien n’a été fait. Le dire à l’utilisateur."
        ))),
    }
}

/// Délai d’une carte d’accord.
const WAIT: std::time::Duration = std::time::Duration::from_secs(90);

async fn ask(state: &AppState, conversation: &str, title: &str, detail: &str) -> Option<String> {
    #[cfg(test)]
    {
        let _ = (state, title, detail);
        return crate::code_mode::TEST_ANSWERS
            .lock()
            .ok()
            .and_then(|answers| answers.iter().find(|(asked, _)| *asked == conversation).map(|(_, answer)| answer.to_string()));
    }
    #[cfg(not(test))]
    {
        use crate::agents::event::{ApprovalOption, OptionKind};
        crate::agents::session::ask_in_conversation(
            state,
            conversation,
            title,
            detail,
            vec![ApprovalOption::new("once", "Autoriser", OptionKind::Allow), ApprovalOption::new("deny", "Refuser", OptionKind::Deny)],
            WAIT,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::Space;
    use std::sync::Arc;

    /// En « Accord à chaque action », `grant_access`, `validate_client` et `vault_store` attendent l’accord de
    /// l’utilisateur ; dans les autres modes, rien ne change.
    #[tokio::test(flavor = "multi_thread")]
    async fn strict_mode_asks_for_sensitive_commands() {
        let dir = tempfile::tempdir().unwrap();
        let state: Arc<AppState> = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        state.set_space(Some(space));
        TEST_AUTONOMY.lock().unwrap().push(("strict", Autonomy::Strict));
        let answer = |value: Option<&'static str>| {
            let mut answers = crate::code_mode::TEST_ANSWERS.lock().unwrap();
            answers.retain(|(conversation, _)| *conversation != "strict");
            if let Some(value) = value {
                answers.push(("strict", value));
            }
        };
        let grant = || {
            let state = state.clone();
            async move { crate::agent_tools::run_tool(&state, "strict", "grant_access", &json!({ "to": "absent/*", "host": "exemple.org" })).await }
        };
        answer(None);
        assert!(grant().await.unwrap_err().message.contains("Pas de réponse à la demande d’accord"));
        answer(Some("deny"));
        assert!(grant().await.unwrap_err().message.contains("a refusé"));
        answer(Some("once"));
        let after = grant().await.unwrap_err().message;
        assert!(after.contains("n’existe pas"), "accordé : la commande s’exécute ({after})");
        answer(None);
        // Hors du mode strict, aucune carte : la commande s’exécute.
        let free = crate::agent_tools::run_tool(&state, "libre", "grant_access", &json!({ "to": "absent/*", "host": "exemple.org" })).await;
        assert!(free.unwrap_err().message.contains("n’existe pas"));
        TEST_AUTONOMY.lock().unwrap().retain(|(conversation, _)| *conversation != "strict");
    }
}
