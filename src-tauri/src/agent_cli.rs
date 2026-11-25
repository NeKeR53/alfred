//! CLI `alfred` des agents. Les harnais (Claude Code, Codex, OpenCode) la trouvent dans leur PATH : c’est un petit
//! script qui relance l’exécutable d’Alfred avec `--alfred-cli`. Elle passe par le pont du SDK du cœur
//! (`ALFRED_SDK_URL`, méthode `agent.cli`) avec le jeton de la conversation (`ALFRED_SDK_TOKEN`), placé par Alfred
//! dans l’environnement du harnais. Le cœur applique les mêmes règles qu’aux anciens outils : périmètre d’une
//! conversation lancée par un module, outils de la coordinatrice, validations.
//!
//! La CLI remplace les outils de construction du serveur MCP : leur définition (une quarantaine de Ko) n’entre plus
//! dans le contexte d’une conversation neuve. `alfred help` est court ; `alfred help <commande>` donne le détail.

use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Argument qui fait de l’exécutable d’Alfred la CLI des agents.
pub const CLI_FLAG: &str = "--alfred-cli";

/// Méthode du pont du SDK qui reçoit les commandes de la CLI.
pub const BRIDGE_METHOD: &str = "agent.cli";

/// Une commande attend au plus ce temps : `wait_for_event` rend la main tout de suite, une capture prend quelques
/// secondes, une délégation aussi.
const CLIENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

// --- Côté harnais : la CLI elle-même -----------------------------------------------------------------------------

/// Point d’entrée de la CLI : rend le code de sortie du processus.
pub fn main(argv: Vec<String>) -> i32 {
    let mut argv = argv;
    // `--out` est propre à la CLI : où écrire une capture d’écran.
    let out = take_option(&mut argv, "--out");
    let (Ok(url), Ok(token)) = (std::env::var("ALFRED_SDK_URL"), std::env::var("ALFRED_SDK_TOKEN")) else {
        eprintln!("alfred : cette commande ne sert que dans une conversation d’Alfred (ALFRED_SDK_URL absent).");
        return 2;
    };
    let wants_stdin = argv.iter().any(|value| value == "-")
        || (argv.first().map(String::as_str) == Some("run") && argv.len() == 1);
    let stdin = if wants_stdin && !std::io::stdin().is_terminal() {
        let mut text = String::new();
        if std::io::stdin().read_to_string(&mut text).is_err() {
            eprintln!("alfred : entrée standard illisible.");
            return 2;
        }
        Some(text)
    } else {
        None
    };
    let cwd = std::env::current_dir().ok().map(|dir| dir.to_string_lossy().into_owned());
    let body = json!({ "argv": argv, "stdin": stdin, "cwd": cwd });
    let reply = match send(&url, &token, &body) {
        Ok(reply) => reply,
        Err(message) => {
            eprintln!("alfred : {message}");
            return 2;
        }
    };
    if let Some(error) = reply.get("error") {
        let message = error["message"].as_str().unwrap_or("Échec de la commande.");
        eprintln!("{message}");
        if let Some(detail) = error.get("detail").filter(|detail| !detail.is_null()) {
            eprintln!("{}", serde_json::to_string_pretty(detail).unwrap_or_default());
        }
        return 1;
    }
    let value = reply.get("ok").cloned().unwrap_or(Value::Null);
    match print_result(value, out.as_deref()) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("alfred : {message}");
            1
        }
    }
}

/// Retire `--name valeur` (ou `--name=valeur`) des arguments et rend la valeur.
fn take_option(argv: &mut Vec<String>, name: &str) -> Option<String> {
    let index = argv.iter().position(|value| value == name || value.starts_with(&format!("{name}=")))?;
    let token = argv.remove(index);
    if let Some((_, value)) = token.split_once('=') {
        return Some(value.to_string());
    }
    (index < argv.len()).then(|| argv.remove(index))
}

fn send(url: &str, token: &str, body: &Value) -> Result<Value, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("démarrage impossible : {error}"))?;
    runtime.block_on(async {
        // Jamais de proxy : le cœur est sur ce poste.
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(CLIENT_TIMEOUT)
            .build()
            .map_err(|error| format!("client HTTP indisponible : {error}"))?;
        let response = client
            .post(format!("{}/{BRIDGE_METHOD}", url.trim_end_matches('/')))
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                format!("Alfred ne répond pas ({error}). Alfred est-il ouvert ? Dans un bac à sable sans réseau, lancer `alfred` hors du bac à sable.")
            })?;
        let status = response.status();
        let text = response.text().await.map_err(|error| format!("réponse illisible : {error}"))?;
        serde_json::from_str::<Value>(&text).map_err(|_| format!("réponse inattendue ({status}) : {text}"))
    })
}

/// Affiche le résultat : un texte tel quel, le reste en JSON. Une image est écrite en PNG et la CLI rend son chemin.
fn print_result(mut value: Value, out: Option<&str>) -> Result<(), String> {
    if let Some(image) = value.get(IMAGE_KEY).cloned() {
        use base64::Engine;
        let data = image["data"].as_str().unwrap_or_default();
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "image illisible".to_string())?;
        // Alfred garde déjà la capture pour la conversation (`capture`) : c’est ce fichier qui est rendu.
        let kept = value["details"]["capture"].as_str().map(PathBuf::from).filter(|path| path.is_file());
        let path = match (out, kept) {
            (Some(out), _) => PathBuf::from(out),
            (None, Some(kept)) => kept,
            (None, None) => {
                let dir = std::env::temp_dir().join("alfred-captures");
                std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
                let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
                let name = value.get("page").and_then(Value::as_str).unwrap_or("page").replace('/', "-");
                dir.join(format!("{name}-{stamp}.png"))
            }
        };
        if !path.is_file() || out.is_some() {
            std::fs::write(&path, bytes).map_err(|error| format!("écriture de {} impossible : {error}", path.display()))?;
        }
        let mut shown = value.get("details").cloned().unwrap_or_else(|| json!({}));
        if let Some(object) = shown.as_object_mut() {
            object.insert("file".into(), json!(path.to_string_lossy()));
        } else {
            shown = json!({ "file": path.to_string_lossy(), "details": shown });
        }
        value = shown;
    }
    let text = match value {
        Value::String(text) => text,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    };
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{text}").map_err(|error| error.to_string())
}

// --- Côté cœur : les commandes -----------------------------------------------------------------------------------

/// Clé du résultat d’une capture : la CLI écrit l’image dans un fichier PNG.
pub const IMAGE_KEY: &str = "__image";

/// Commandes propres à la CLI, hors des outils : Code Mode et scripts gardés.
const OWN_COMMANDS: &[(&str, &str, &str)] = &[
    ("help", "alfred help [commande]", "Cette aide ; avec une commande, son détail."),
];

/// Commande reçue par le pont : `{ argv, stdin, cwd }` pour la conversation du jeton.
pub async fn handle(state: &Arc<AppState>, conversation: &str, body: &Value) -> AppResult<Value> {
    let argv: Vec<String> = body
        .get("argv")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let stdin = body.get("stdin").and_then(Value::as_str);
    let cwd = body.get("cwd").and_then(Value::as_str).map(PathBuf::from);
    let Some((command, rest)) = argv.split_first() else {
        return Ok(Value::String(short_help(state, conversation)));
    };
    let command = normalize(command);
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        return Ok(Value::String(match rest.first() {
            Some(name) => command_help(state, conversation, &normalize(name))?,
            None => short_help(state, conversation),
        }));
    }
    if rest.iter().any(|value| value == "--help" || value == "-h") {
        return Ok(Value::String(command_help(state, conversation, &command)?));
    }
    if let Some(result) = crate::code_mode::handle(state, conversation, &command, rest, stdin, cwd.as_deref()).await {
        return result;
    }
    let tools = crate::agent_tools::tools(state, conversation);
    let Some(tool) = tools.iter().find(|tool| tool["name"] == command.as_str()) else {
        return Err(AppError::new(format!(
            "Commande inconnue ou hors de cette conversation : « {command} ». `alfred help` les liste."
        )));
    };
    let args = parse_args(tool, rest, stdin, cwd.as_deref())?;
    crate::agent_tools::run_tool(state, conversation, &command, &args).await
}

/// `place-page` et `place_page` désignent la même commande.
fn normalize(command: &str) -> String {
    command.trim().replace('-', "_")
}

/// `--full-page` désigne la propriété `fullPage`.
fn camel(flag: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for character in flag.chars() {
        if character == '-' || character == '_' {
            upper = !out.is_empty();
        } else if upper {
            out.extend(character.to_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    out
}

/// `fullPage` s’écrit `--full-page`.
fn kebab(property: &str) -> String {
    let mut out = String::new();
    for character in property.chars() {
        if character.is_uppercase() {
            out.push('-');
            out.extend(character.to_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

fn properties(tool: &Value) -> Map<String, Value> {
    tool["inputSchema"]["properties"].as_object().cloned().unwrap_or_default()
}

fn required(tool: &Value) -> Vec<String> {
    tool["inputSchema"]["required"]
        .as_array()
        .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Ordre des arguments sans nom : les propriétés obligatoires, ou la seule propriété texte d’une commande qui n’en
/// a qu’une.
fn positional_order(tool: &Value) -> Vec<String> {
    let required = required(tool);
    if !required.is_empty() {
        return required;
    }
    let properties = properties(tool);
    if properties.len() == 1 {
        return properties.keys().cloned().collect();
    }
    Vec::new()
}

fn kind_of(schema: &Value) -> Option<&str> {
    schema.get("type").and_then(Value::as_str).or_else(|| {
        schema.get("enum").and_then(Value::as_array).filter(|values| values.iter().all(Value::is_string)).map(|_| "string")
    })
}

/// Valeur d’un argument d’après le type attendu : un texte reste un texte, le reste se lit en JSON (nombre, booléen,
/// objet, liste) et à défaut reste un texte. `-` est l’entrée standard.
fn typed_value(schema: &Value, raw: &str, stdin: Option<&str>) -> AppResult<Value> {
    let raw = if raw == "-" {
        stdin.ok_or_else(|| AppError::new("`-` lit l’entrée standard, qui est vide."))?
    } else {
        raw
    };
    Ok(match kind_of(schema) {
        Some("string") => Value::String(raw.to_string()),
        Some("boolean") => match raw {
            "true" | "oui" | "1" => Value::Bool(true),
            "false" | "non" | "0" => Value::Bool(false),
            other => return Err(AppError::new(format!("Booléen attendu (true ou false), reçu « {other} »."))),
        },
        _ => serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string())),
    })
}

/// Arguments d’une commande d’après le schéma de son outil : `--nom valeur`, `--nom=valeur`, `--drapeau`, des
/// valeurs sans nom dans l’ordre de `positional_order`, et `--json` (objet, `-` pour l’entrée standard, `@fichier`).
pub(crate) fn parse_args(tool: &Value, argv: &[String], stdin: Option<&str>, cwd: Option<&Path>) -> AppResult<Value> {
    let name = tool["name"].as_str().unwrap_or_default();
    let properties = properties(tool);
    let order = positional_order(tool);
    let mut args = Map::new();
    let mut flags = Map::new();
    let mut positional = Vec::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        index += 1;
        let Some(flag) = token.strip_prefix("--").filter(|flag| !flag.is_empty()) else {
            positional.push(token.clone());
            continue;
        };
        let (flag, inline) = match flag.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_string())),
            None => (flag, None),
        };
        if flag == "json" {
            let raw = inline.or_else(|| {
                let value = argv.get(index).cloned();
                index += 1;
                value
            });
            let raw = raw.ok_or_else(|| AppError::new("`--json` attend un objet JSON, `-` ou `@fichier`."))?;
            let text = if raw == "-" {
                stdin.ok_or_else(|| AppError::new("`--json -` lit l’entrée standard, qui est vide."))?.to_string()
            } else if let Some(file) = raw.strip_prefix('@') {
                let path = cwd.map(|cwd| cwd.join(file)).unwrap_or_else(|| PathBuf::from(file));
                std::fs::read_to_string(&path)
                    .map_err(|error| AppError::new(format!("Lecture de {} impossible : {error}", path.display())))?
            } else {
                raw
            };
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(object)) => args.extend(object),
                _ => return Err(AppError::new("`--json` attend un objet JSON.")),
            }
            continue;
        }
        let property = camel(flag);
        let Some(schema) = properties.get(&property) else {
            let known: Vec<String> = properties.keys().map(|key| format!("--{}", kebab(key))).collect();
            return Err(AppError::new(format!(
                "Option inconnue pour `{name}` : --{flag}. Options : {}. `alfred help {name}` les détaille.",
                if known.is_empty() { "aucune".to_string() } else { known.join(", ") }
            )));
        };
        let value = match inline {
            Some(value) => typed_value(schema, &value, stdin)?,
            None if kind_of(schema) == Some("boolean") => Value::Bool(true),
            None => {
                let raw = argv
                    .get(index)
                    .ok_or_else(|| AppError::new(format!("--{flag} attend une valeur.")))?
                    .clone();
                index += 1;
                typed_value(schema, &raw, stdin)?
            }
        };
        flags.insert(property, value);
    }
    if positional.len() > order.len() {
        return Err(AppError::new(format!(
            "Trop d’arguments sans nom pour `{name}` ({}). `alfred help {name}` donne l’usage.",
            positional.len()
        )));
    }
    for (property, raw) in order.iter().zip(positional.iter()) {
        let schema = properties.get(property).cloned().unwrap_or(Value::Null);
        args.insert(property.clone(), typed_value(&schema, raw, stdin)?);
    }
    args.extend(flags);
    Ok(Value::Object(args))
}

/// Première phrase d’une description, raccourcie.
fn summary(description: &str, limit: usize) -> String {
    let first = description.split(". ").next().unwrap_or(description).trim_end_matches('.');
    let mut text: String = first.chars().take(limit).collect();
    if first.chars().count() > limit {
        text.push('…');
    }
    text
}

fn short_help(state: &AppState, conversation: &str) -> String {
    let mut lines = vec![
        "alfred <commande> [valeurs] [--option valeur]   (alfred help <commande> : le détail ; --json '{…}' accepté)".to_string(),
        String::new(),
    ];
    for tool in crate::agent_tools::tools(state, conversation) {
        let name = tool["name"].as_str().unwrap_or_default();
        lines.push(format!("  {name:<18} {}", summary(tool["description"].as_str().unwrap_or_default(), 90)));
    }
    for (name, _, description) in OWN_COMMANDS.iter().chain(crate::code_mode::COMMANDS) {
        lines.push(format!("  {name:<18} {}", summary(description, 90)));
    }
    lines.join("\n")
}

fn command_help(state: &AppState, conversation: &str, command: &str) -> AppResult<String> {
    if let Some((_, usage, description)) = OWN_COMMANDS.iter().chain(crate::code_mode::COMMANDS).find(|(name, _, _)| *name == command) {
        return Ok(format!("{usage}\n\n{description}"));
    }
    let tools = crate::agent_tools::tools(state, conversation);
    let tool = tools
        .iter()
        .find(|tool| tool["name"] == command)
        .ok_or_else(|| AppError::new(format!("Commande inconnue : « {command} ». `alfred help` les liste.")))?;
    let properties = properties(tool);
    let order = positional_order(tool);
    let required = required(tool);
    let mut usage = format!("alfred {command}");
    for property in &order {
        if required.contains(property) {
            usage.push_str(&format!(" <{}>", kebab(property)));
        } else {
            usage.push_str(&format!(" [{}]", kebab(property)));
        }
    }
    let mut options = Vec::new();
    for (property, schema) in &properties {
        let kind = match kind_of(schema) {
            Some("string") if schema.get("enum").is_some() => {
                let values: Vec<String> = schema["enum"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                values.join("|")
            }
            Some(kind) => kind.to_string(),
            None => "json".to_string(),
        };
        let mut line = format!("  --{} ({kind}{})", kebab(property), if required.contains(property) { ", obligatoire" } else { "" });
        if let Some(description) = schema.get("description").and_then(Value::as_str) {
            line.push_str(&format!(" : {description}"));
        }
        // Un objet structuré : sa forme, pour l’écrire en JSON.
        if kind_of(schema).is_none() || matches!(kind_of(schema), Some("object" | "array")) {
            let mut shape = schema.clone();
            if let Some(object) = shape.as_object_mut() {
                object.remove("description");
            }
            line.push_str(&format!("\n      forme : {}", serde_json::to_string(&shape).unwrap_or_default()));
        }
        options.push(line);
    }
    let description = tool["description"].as_str().unwrap_or_default();
    Ok(format!(
        "{usage}\n\n{description}\n\n{}",
        if options.is_empty() { "Aucune option.".to_string() } else { format!("Options :\n{}", options.join("\n")) }
    ))
}

// --- Installation dans les harnais -------------------------------------------------------------------------------

/// Dossier qui porte le script `alfred`, ajouté en tête du PATH de chaque harnais.
pub fn bin_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("bin")
}

/// Écrit (ou réécrit) le script `alfred` qui relance l’exécutable d’Alfred en mode CLI.
pub fn install(state: &AppState) -> AppResult<PathBuf> {
    let dir = bin_dir(state);
    std::fs::create_dir_all(&dir)?;
    let exe = std::env::current_exe()?;
    if cfg!(windows) {
        let path = dir.join("alfred.cmd");
        let script = format!("@echo off\r\n\"{}\" {CLI_FLAG} %*\r\n", exe.display());
        write_if_changed(&path, &script)?;
    } else {
        let path = dir.join("alfred");
        let quoted = exe.to_string_lossy().replace('\'', "'\\''");
        let script = format!("#!/bin/sh\nexec '{quoted}' {CLI_FLAG} \"$@\"\n");
        write_if_changed(&path, &script)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(dir)
}

fn write_if_changed(path: &Path, content: &str) -> AppResult<()> {
    if std::fs::read_to_string(path).ok().as_deref() != Some(content) {
        std::fs::write(path, content)?;
    }
    Ok(())
}

/// Environnement d’un harnais : la CLI en tête du PATH, l’adresse du pont et le jeton de la conversation.
pub fn harness_env(state: &AppState, port: u16, token: &str) -> Vec<(&'static str, String)> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let path = match install(state) {
        Ok(dir) => format!("{}{separator}{}", dir.to_string_lossy(), crate::agents::search_path()),
        Err(error) => {
            log::error!("CLI alfred non installée : {}", error.message);
            crate::agents::search_path().to_string()
        }
    };
    vec![
        ("PATH", path),
        ("ALFRED_SDK_URL", format!("http://127.0.0.1:{port}/sdk")),
        ("ALFRED_SDK_TOKEN", token.to_string()),
    ]
}

/// Une commande shell qui ne fait que lancer `alfred` (un seul programme, sans enchaînement ni substitution) : les
/// harnais la laissent passer sans demander.
pub fn is_alfred_command(command: &str) -> bool {
    let command = command.trim();
    let command = command.strip_prefix("bash -lc ").or_else(|| command.strip_prefix("/bin/zsh -lc ")).unwrap_or(command);
    let command = command.trim_matches(|c| c == '\'' || c == '"').trim();
    let Some(rest) = command.strip_prefix("alfred") else { return false };
    if !(rest.is_empty() || rest.starts_with(' ')) {
        return false;
    }
    let safe = |head: &str| !["&&", "||", ";", "|", "`", "$(", ">", "<", "&", "\n"].iter().any(|danger| head.contains(danger));
    // Un document en ligne (`<<'EOF'`) donne du code à `alfred run` : il est permis s’il finit la commande.
    let Some((head, document)) = rest.split_once("<<") else { return safe(rest) };
    let Some((tag, body)) = document.split_once('\n') else { return false };
    let tag = tag.trim().trim_start_matches('-').trim_matches(|c| c == '\'' || c == '"');
    let quoted = document.trim_start().starts_with(['\'', '"']);
    // Sans guillemets, le shell remplacerait `$(…)` dans le document : seul un document cité est permis.
    quoted && !tag.is_empty() && body.trim_end().lines().last().map(str::trim) == Some(tag) && safe(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool() -> Value {
        json!({ "name": "page_screenshot", "inputSchema": { "type": "object", "required": ["page"], "properties": {
            "page": { "type": "string" }, "fullPage": { "type": "boolean" }, "limit": { "type": "integer" },
            "placement": { "oneOf": [] },
        } } })
    }

    #[test]
    fn arguments_follow_the_schema() {
        let argv = |values: &[&str]| values.iter().map(|value| value.to_string()).collect::<Vec<_>>();
        let parsed = parse_args(&tool(), &argv(&["notes/liste", "--full-page", "--limit", "5"]), None, None).unwrap();
        assert_eq!(parsed, json!({ "page": "notes/liste", "fullPage": true, "limit": 5 }));
        let parsed =
            parse_args(&tool(), &argv(&["--placement", r#"{"kind":"menu","label":"X"}"#, "--page=12"]), None, None).unwrap();
        assert_eq!(parsed, json!({ "page": "12", "placement": { "kind": "menu", "label": "X" } }));
        let parsed = parse_args(&tool(), &argv(&["--json", "-"]), Some(r#"{"page":"a/b"}"#), None).unwrap();
        assert_eq!(parsed["page"], "a/b");
        assert!(parse_args(&tool(), &argv(&["--inconnue", "1"]), None, None).unwrap_err().message.contains("--full-page"));
        assert!(parse_args(&tool(), &argv(&["a", "b"]), None, None).is_err());
    }

    /// De bout en bout par le pont : l’aide est courte, une commande a son détail, une page se place avec des
    /// valeurs sans nom, et un jeton inconnu est refusé.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_agent_builds_through_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = state.server.set(crate::state::ServerInfo { port });
        let app = crate::script_sdk::routes().with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let space = crate::space::Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        state.set_space(Some(space));
        state.agent_tokens.lock().unwrap().insert("jeton".into(), "conversation".into());
        let url = format!("http://127.0.0.1:{port}/sdk");
        let cli = |argv: &[&str], token: &str| {
            let body = json!({ "argv": argv, "stdin": null, "cwd": null });
            let (url, token) = (url.clone(), token.to_string());
            std::thread::spawn(move || send(&url, &token, &body).unwrap()).join().unwrap()
        };
        let help = cli(&[], "jeton")["ok"].as_str().unwrap().to_string();
        assert!(help.contains("place_page") && help.contains("db_query"), "{help}");
        assert!(help.len() < 6000, "aide courte : {} octets", help.len());
        let detail = cli(&["help", "page-screenshot"], "jeton")["ok"].as_str().unwrap().to_string();
        assert!(detail.starts_with("alfred page_screenshot <page>") && detail.contains("--full-page (boolean)"), "{detail}");
        let placed = cli(&["place-page", "Ventes", "--description", "Les ventes du mois."], "jeton");
        assert!(placed["ok"]["file"].as_str().unwrap().ends_with(".tsx"), "{placed}");
        let unknown = cli(&["voler"], "jeton");
        assert!(unknown["error"]["message"].as_str().unwrap().contains("alfred help"), "{unknown}");
        let refused = cli(&["check"], "autre");
        assert!(refused["error"]["message"].as_str().unwrap().contains("Jeton de conversation inconnu"), "{refused}");
    }

    #[test]
    fn only_a_plain_alfred_command_passes_without_asking() {
        assert!(is_alfred_command("alfred check"));
        assert!(is_alfred_command("alfred run - <<'EOF'\nreturn 1;\nEOF"));
        assert!(!is_alfred_command("alfred run - <<'EOF'\nreturn 1;\nEOF\nrm -rf x"));
        assert!(!is_alfred_command("alfred run - <<EOF\n$(rm x)\nEOF"));
        assert!(is_alfred_command("bash -lc 'alfred api jira'"));
        assert!(!is_alfred_command("alfred check && rm -rf /"));
        assert!(!is_alfred_command("alfred check; curl x"));
        assert!(!is_alfred_command("alfredo"));
        assert!(!is_alfred_command("echo $(alfred check)"));
    }
}
