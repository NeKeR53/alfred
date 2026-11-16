//! Réglages que l’agent fait lui-même, pour que l’utilisateur n’ait rien à finir à la main : enregistrer un secret
//! dans le coffre, valider un client, accorder à une page ou aux fonctions d’un module l’accès à un client, lancer
//! une connexion OAuth. Ces outils ne sont offerts qu’aux conversations ouvertes par l’utilisateur, jamais à celles
//! qu’une page lance. Chaque action est inscrite au journal et signalée par une notification ; aucune ne renvoie
//! jamais la valeur d’un secret.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::state::AppState;
use crate::{app_db, clients, functions, vault};

/// Durée maximale d’une commande qui produit un secret.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// Inscrit l’action au journal et la signale à l’utilisateur.
fn notice(state: &AppState, subject: &str, title: &str, description: &str) {
    functions::journal(state, "agent", subject, true, None, title, None);
    state.emit("agent:notice", json!({ "title": title, "description": description }));
}

/// Exécute `command` dans le dossier de l’espace et renvoie sa sortie standard, sans espaces autour. La sortie ne
/// quitte jamais Rust : elle va au trousseau, pas à l’agent.
async fn command_output(state: &AppState, command: &str) -> AppResult<String> {
    let space = state.space()?;
    let mut process = if cfg!(windows) {
        let mut process = tokio::process::Command::new("cmd");
        process.args(["/C", command]);
        process
    } else {
        let mut process = tokio::process::Command::new("/bin/sh");
        process.args(["-c", command]);
        process
    };
    process
        .current_dir(&space.root)
        .env("PATH", crate::agents::search_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, process.output())
        .await
        .map_err(|_| AppError::new("La commande n’a pas répondu en 60 secondes."))?
        .map_err(|error| AppError::new(format!("La commande n’a pas pu être lancée : {error}.")))?;
    if !output.status.success() {
        // Seule la première ligne d’erreur, raccourcie : assez pour comprendre, trop peu pour faire sortir un secret.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first: String = stderr.lines().next().unwrap_or_default().chars().take(200).collect();
        return Err(AppError::new(format!(
            "La commande a échoué (code {}){}",
            output.status.code().map_or_else(|| "inconnu".to_string(), |code| code.to_string()),
            if first.is_empty() { ".".to_string() } else { format!(" : {first}") }
        )));
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| AppError::new("La commande n’a pas produit de texte."))?
        .trim()
        .to_string();
    if value.is_empty() {
        return Err(AppError::new("La commande n’a rien écrit sur sa sortie standard."));
    }
    Ok(value)
}

/// `vault_store` : crée ou met à jour une entrée du coffre. Chaque champ secret vient soit d’une valeur donnée
/// (`secrets`), soit de la sortie d’une commande (`fromCommand`), qu’Alfred exécute sans jamais la renvoyer.
pub async fn store_secret(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let mut secrets = match args.get("secrets") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(fields)) => fields.clone(),
        Some(_) => return Err(AppError::new("Argument « secrets » invalide : un objet est attendu.")),
    };
    if let Some(commands) = args.get("fromCommand").filter(|value| !value.is_null()) {
        let commands = commands
            .as_object()
            .ok_or_else(|| AppError::new("Argument « fromCommand » invalide : un objet est attendu."))?;
        for (field, command) in commands {
            let command = command
                .as_str()
                .filter(|command| !command.trim().is_empty())
                .ok_or_else(|| AppError::new(format!("Commande vide pour le champ « {field} ».")))?;
            let value = command_output(state, command)
                .await
                .map_err(|error| AppError::new(format!("Champ « {field} » : {}", error.message)))?;
            secrets.insert(field.clone(), Value::String(value));
        }
    }
    let mut forwarded = json!({
        "label": args.get("label").cloned().unwrap_or(Value::Null),
        "kind": args.get("kind").cloned().unwrap_or(Value::Null),
        "meta": args.get("meta").cloned().unwrap_or(Value::Null),
        "secrets": Value::Object(secrets),
    });
    if let Some(id) = args.get("id").filter(|id| !id.is_null()) {
        forwarded["id"] = id.clone();
    }
    let saved = vault::handle(state, "vault.save", &forwarded)
        .await
        .unwrap_or_else(|| Err(AppError::new("Coffre indisponible.")))?;
    let label = saved["label"].as_str().unwrap_or_default();
    notice(
        state,
        &format!("vault:{}", saved["id"].as_str().unwrap_or_default()),
        &format!("J’ai rangé « {label} » dans le coffre"),
        "Vous la retrouverez dans Réglages → Mots de passe et clés.",
    );
    Ok(json!({
        "entry": saved["id"],
        "label": saved["label"],
        "kind": saved["kind"],
        "hasSecret": saved["hasSecret"],
        "next": "Relier l’entrée au client : `declare_client` avec `auth.secret` = `entry`, puis `validate_client`.",
    }))
}

/// `validate_client` : approuve le client tel que son fichier le décrit aujourd’hui.
pub async fn validate_client(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let id: String = arg(args, "client")?;
    let mut validated = clients::validate_by_agent(state, &id)?;
    // Un client prêt est testé tout de suite : un module n’est dit prêt qu’après un test réussi de son compte, et
    // l’utilisateur n’a rien à faire de plus.
    let tests = if validated["status"] == json!("ready") { clients::test_instances(state, &id).await? } else { Vec::new() };
    let failed = tests.iter().any(|test| test["ok"] != json!(true));
    if !tests.is_empty() {
        validated["tests"] = json!(tests);
    }
    let label = validated["label"].as_str().unwrap_or(&id).to_string();
    // Adresses réellement appelées : celle de chaque instance.
    let addresses: Vec<&str> = validated["instances"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|instance| instance["effectiveUrl"].as_str())
        .collect();
    let base_url = addresses.join(", ");
    notice(
        state,
        &format!("client:{id}"),
        &format!("J’ai validé le service « {label} »"),
        &format!("Ses requêtes partent vers {base_url}. Vous le retrouverez dans Réglages → Modules."),
    );
    Ok(json!({
        "client": id,
        "status": validated["status"],
        "problem": validated["problem"],
        "tests": validated["tests"],
        "next": match validated["status"].as_str() {
            _ if failed => {
                "Client validé, mais son test échoue (voir `tests`) : corriger l’adresse, le `testPath` ou le secret, puis `validate_client` à nouveau."
            }
            Some("missingSecret") => "Le secret manque : `vault_store`, puis `declare_client` avec `auth.secret`, puis `validate_client` à nouveau.",
            Some("toConnect") => "Client OAuth 2 pas encore connecté : `connect_client` ouvre la page de connexion du service.",
            _ => "Client prêt. Accorder l’accès aux pages et fonctions qui l’utilisent avec `grant_access`.",
        },
    }))
}

/// `grant_access` : accorde à une page (« module/page ») ou aux fonctions d’un module (« module/* ») l’accès à un
/// client ou à la fonction d’un autre module, comme si l’utilisateur avait répondu oui à la question.
pub fn grant_access(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let to: String = arg(args, "to")?;
    let client: Option<String> = opt_arg(args, "client")?;
    let function: Option<String> = opt_arg(args, "function")?;
    let agent = opt_arg::<bool>(args, "agent")?.unwrap_or(false);
    let host: Option<String> = opt_arg::<String>(args, "host")?.map(|host| host.trim().to_ascii_lowercase());
    let event: Option<String> = opt_arg(args, "event")?;
    let command: Option<String> = opt_arg(args, "command")?;
    let space = state.space()?;
    let snapshot = space.snapshot()?;
    let Some((module, name)) = to.split_once('/') else {
        return Err(AppError::new(format!("Demandeur invalide : « {to} ». Attendu « module/page » ou « module/* ».")));
    };
    let subject = if name == "*" {
        if !snapshot.modules.iter().any(|known| known.id == module) {
            return Err(AppError::new(format!("Le module « {module} » n’existe pas dans l’espace de travail.")));
        }
        format!("function:{to}")
    } else {
        if crate::mcp::find_page(&snapshot, &to).is_none() {
            return Err(AppError::new(format!("La page « {to} » n’existe pas dans l’espace de travail.")));
        }
        format!("page:{to}")
    };
    let given = usize::from(client.is_some())
        + usize::from(function.is_some())
        + usize::from(agent)
        + usize::from(host.is_some())
        + usize::from(event.is_some())
        + usize::from(command.is_some());
    if given != 1 {
        return Err(AppError::new(
            "Donner une seule ressource : `client`, `function`, `agent`, `host`, `event` ou `command`.",
        ));
    }
    let (resource, label) = match (client, function) {
        _ if agent => ("agent".to_string(), "un agent".to_string()),
        _ if command.is_some() => {
            let program = command.unwrap_or_default();
            let path = crate::commands::resolve(&program)?;
            (format!("command:{program}"), format!("le lancement du programme « {program} » ({})", path.display()))
        }
        _ if event.is_some() => {
            let event = event.unwrap_or_default();
            if name != "*" {
                return Err(AppError::new("Un événement s’accorde aux fonctions d’un module : `to` vaut « module/* »."));
            }
            let declared = event.split_once('/').is_some_and(|(publisher, id)| {
                space.module(publisher).is_ok_and(|manifest| manifest.events.publishes.iter().any(|published| published.id == id))
            });
            if !declared {
                return Err(AppError::new(format!("L’événement « {event} » n’est déclaré par aucun module (« module/événement »).")));
            }
            (format!("event:{event}"), format!("l’événement {event}"))
        }
        _ if host.is_some() => {
            let host = host.unwrap_or_default();
            if host.is_empty() || host.contains(['/', ':', '@', ' ']) {
                return Err(AppError::new(format!(
                    "Hôte invalide : « {host} ». Attendu un nom d’hôte seul (ex. mail.google.com)."
                )));
            }
            (format!("external:{host}"), format!("l’ouverture de liens vers {host}"))
        }
        (Some(client), None) => {
            let loaded = clients::load(&space, &client)?
                .ok_or_else(|| AppError::new(format!("Le client « {client} » n’existe pas dans cet espace de travail.")))?;
            (format!("client:{client}"), format!("le client « {} »", loaded.label))
        }
        (None, Some(function)) => {
            if !snapshot.functions.iter().any(|known| known.reference == function) {
                return Err(AppError::new(format!("La fonction « {function} » n’existe pas dans l’espace de travail.")));
            }
            (format!("function:{function}"), format!("la fonction {function}"))
        }
        _ => {
            return Err(AppError::new(
                "Donner une seule ressource : `client`, `function`, `agent`, `host`, `event` ou `command`.",
            ))
        }
    };
    {
        let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
        app_db::grant(&db, &space.root.to_string_lossy(), &subject, &resource)?;
    }
    notice(
        state,
        &subject,
        &format!("J’ai accordé à {to} l’accès à {label}"),
        "La page ne vous posera plus la question.",
    );
    Ok(json!({ "granted": { "to": to, "resource": resource } }))
}

/// `connect_client` : ouvre la page de connexion OAuth 2 du service dans le navigateur. Se connecter reste le geste
/// de l’utilisateur, sur le site du service.
pub async fn connect_client(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let id: String = arg(args, "client")?;
    let instance: Option<String> = opt_arg(args, "instance")?;
    let space = state.space()?;
    let client = clients::load(&space, &id)?
        .ok_or_else(|| AppError::new(format!("Le client « {id} » n’existe pas dans cet espace de travail.")))?
        .effective(instance.as_deref())?;
    let url = crate::oauth::begin(state, &client).await?;
    if !cfg!(test) {
        tauri_plugin_opener::open_url(&url, None::<&str>)
            .map_err(|error| AppError::new(format!("Le navigateur n’a pas pu être ouvert : {error}.")))?;
    }
    notice(
        state,
        &format!("client:{id}"),
        &format!("J’ai ouvert la connexion à « {} » dans votre navigateur", client.label),
        "Il ne vous reste qu’à vous connecter sur la page du service.",
    );
    Ok(json!({
        "client": id,
        "opened": true,
        "next": "Dire à l’utilisateur de se connecter dans la page qui vient de s’ouvrir ; le client passe « Prêt » ensuite.",
    }))
}
