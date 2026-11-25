//! Code Mode des agents : au lieu d’un outil par fonction, l’agent lit les types TypeScript des fonctions de lecture
//! (`alfred api`, générés depuis `module.json`) et écrit un petit programme qui les enchaîne (`alfred run`). Le code
//! est transpilé (`transpile.rs`) et tourne dans un cadre invisible, isolé comme une fonction TypeScript : ni réseau
//! ni disque. Il ne parle qu’au cœur, par deux requêtes : appeler une fonction (`agentCode.call`) et lire un état
//! partagé (`agentCode.state`). Chaque appel passe par `functions::call_in` avec l’appelant « agent-code », qui
//! l’inscrit au Journal.
//!
//! Lectures libres, écritures avec accord. Une fonction qui n’est pas `effect: read` demande l’accord de
//! l’utilisateur : une carte dans le tour en cours de la conversation (fonction, description, entrée), « Autoriser »
//! (cette fois), « Autoriser pour cette conversation » (cette fonction, cette conversation, jamais au-delà) ou
//! « Refuser ». Sans réponse en 90 s, ou sans conversation ouverte, rien n’est écrit. Le temps d’attente ne compte
//! pas dans la durée de l’exécution. Une conversation lancée par une page n’écrit que par les fonctions que la page
//! lui offre (accordées par l’utilisateur), sans carte ; elle ne demande rien de plus.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::app_db::AgentScope;
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{Effect, ResolvedFunction};
use crate::state::AppState;

/// Durée maximale d’une exécution.
pub const MAX_DURATION: Duration = Duration::from_secs(60);
/// Attente maximale d’une exécution, accords compris : au-delà, le cadre s’arrête de lui-même.
const MAX_WAIT: Duration = Duration::from_secs(15 * 60);
/// Nombre maximal d’appels (fonctions et états) par exécution.
pub const MAX_CALLS: usize = 50;
/// Taille maximale de la sortie rendue à l’agent (valeur rendue et console), en caractères.
pub const MAX_OUTPUT: usize = 20_000;
/// Lignes de console gardées au plus.
const MAX_LOG_LINES: usize = 300;

/// Commandes de Code Mode : nom, usage, description.
pub const COMMANDS: &[(&str, &str, &str)] = &[
    (
        "api",
        "alfred api [module | module/fonction]",
        "Types TypeScript des fonctions et des états partagés, pour `alfred run`. Sans valeur : une ligne par fonction. Avec un module : ses déclarations. Avec une fonction : son détail (entrée, sortie, description).",
    ),
    (
        "run",
        "alfred run <fichier.ts | -> [--input '{…}'] [--examples] [--again <id>] [--save module/nom] [--description …]",
        "Code Mode. Exécute du TypeScript qui enchaîne des lectures : `await api.module.fonction(entrée)`, `await api.call(\"module/fonction\", entrée)`, `await api.states.get(\"module/etat\", { params })`. Le code est le corps d’une fonction asynchrone : `await`, `return` et `console.log` permis, `input` vaut `--input`, pas d’import. Il tourne sans réseau ni disque. Rend `result` (la valeur rendue), `logs` et `calls`. Une lecture part tout de suite ; une écriture (fonction qui n’est pas `effect: read`) attend l’accord de l’utilisateur, par une carte dans la conversation (90 s au plus, sinon rien n’est écrit) ; il peut l’accorder pour toute la conversation. Limites : 60 s, 50 appels, 20 000 caractères de sortie. `--examples` : les fonctions de connecteur rendent leurs données d’exemple, sans joindre le service. Écrire le code dans un fichier, ou `alfred run - <<'EOF'` … `EOF` (une commande `alfred` seule passe sans demande d’accord). Chaque exécution est gardée 7 jours (`alfred runs`) : `--again <id>` la relance (avec son entrée, ou `--input`). `--save module/nom` garde une exécution réussie comme vraie fonction du module (une écriture si elle a écrit) (`--save nom` : dans le module le plus appelé, sinon `mes-scripts`) ; elle reste « à valider » jusqu’à l’accord de l’utilisateur.",
    ),
    ("runs", "alfred runs [--limit n]", "Exécutions de Code Mode gardées 7 jours : id, date, réussite, nombre d’appels, début du code."),
];

/// Exécution en cours : ce que ses requêtes peuvent faire, et ce qu’elles ont fait.
struct Run {
    conversation: String,
    scope: Option<AgentScope>,
    js: String,
    /// Échéance : repoussée du temps passé à attendre un accord.
    deadline: Mutex<Instant>,
    calls: Mutex<Vec<String>>,
    /// Les fonctions rendent leurs données d’exemple, sans joindre aucun service.
    examples: bool,
}

fn runs() -> &'static Mutex<HashMap<String, Arc<Run>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<Run>>>> = OnceLock::new();
    RUNS.get_or_init(Default::default)
}

/// Retire l’exécution de la table quand elle se termine, quelle qu’en soit l’issue.
struct Registered(String);

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut all) = runs().lock() {
            all.remove(&self.0);
        }
    }
}

/// Clé qui ouvre le code d’une exécution à son cadre : signée par le secret du lancement, inconnue des pages.
pub fn frame_key(state: &AppState) -> String {
    let mac = crate::webhooks::hmac_sha256(&state.frame_secret, b"cadre:code-agent");
    mac[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Code transpilé d’une exécution en cours, servi au cadre par `pages.rs`.
pub fn script(run: &str) -> Option<String> {
    runs().lock().ok()?.get(run).map(|run| run.js.clone())
}

pub async fn handle(
    state: &Arc<AppState>,
    conversation: &str,
    command: &str,
    argv: &[String],
    stdin: Option<&str>,
    cwd: Option<&Path>,
) -> Option<AppResult<Value>> {
    match command {
        "api" => Some(api(state, conversation, argv)),
        "run" => Some(run_command(state, conversation, argv, stdin, cwd).await),
        "runs" => Some(options(argv, &["limit"]).and_then(|(_, named)| {
            let limit = named.get("limit").and_then(Value::as_str).and_then(|raw| raw.parse().ok()).unwrap_or(20usize);
            crate::kept_scripts::list(state, limit.clamp(1, 200))
        })),
        _ => None,
    }
}

/// Options d’une commande de Code Mode : `--nom valeur` et valeurs sans nom.
fn options(argv: &[String], known: &[&str]) -> AppResult<(Vec<String>, Map<String, Value>)> {
    options_with(argv, known, &[])
}

/// Comme `options`, avec des drapeaux sans valeur (`--examples`).
fn options_with(argv: &[String], known: &[&str], switches: &[&str]) -> AppResult<(Vec<String>, Map<String, Value>)> {
    let mut positional = Vec::new();
    let mut named = Map::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        index += 1;
        let Some(flag) = token.strip_prefix("--") else {
            positional.push(token.clone());
            continue;
        };
        if switches.contains(&flag) {
            named.insert(flag.to_string(), Value::Bool(true));
            continue;
        }
        let (flag, value) = match flag.split_once('=') {
            Some((flag, value)) => (flag.to_string(), value.to_string()),
            None => {
                let value = argv.get(index).cloned().ok_or_else(|| AppError::new(format!("--{flag} attend une valeur.")))?;
                index += 1;
                (flag.to_string(), value)
            }
        };
        if !known.contains(&flag.as_str()) {
            let list: Vec<String> = known.iter().chain(switches).map(|known| format!("--{known}")).collect();
            return Err(AppError::new(format!("Option inconnue : --{flag}. Options : {}.", list.join(", "))));
        }
        named.insert(flag, Value::String(value));
    }
    Ok((positional, named))
}

// --- Types ---------------------------------------------------------------------------------------------------

/// `list-tickets` s’écrit `listTickets` dans `api`.
pub fn ident(id: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for character in id.chars() {
        if character == '-' || character == '_' {
            upper = !out.is_empty();
        } else if upper {
            out.extend(character.to_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    if out.chars().next().is_some_and(|first| first.is_ascii_digit()) {
        return format!("_{out}");
    }
    out
}

fn property_name(name: &str) -> String {
    let plain = !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !name.chars().next().is_some_and(|c| c.is_ascii_digit());
    if plain { name.to_string() } else { serde_json::to_string(name).unwrap_or_default() }
}

fn doc(description: Option<&str>) -> String {
    match description.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => format!("/** {} */ ", text.replace("*/", "*\\/").replace('\n', " ")),
        None => String::new(),
    }
}

/// Type TypeScript d’un schéma JSON. `docs` : garder les descriptions des propriétés.
pub fn ts_type(schema: &Value, docs: bool) -> String {
    if let Some(value) = schema.get("const") {
        return serde_json::to_string(value).unwrap_or_default();
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values.iter().map(|value| serde_json::to_string(value).unwrap_or_default()).collect::<Vec<_>>().join(" | ");
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(variants) = schema.get(key).and_then(Value::as_array) {
            if !variants.is_empty() {
                return variants.iter().map(|variant| ts_type(variant, docs)).collect::<Vec<_>>().join(" | ");
            }
        }
    }
    let kinds: Vec<&str> = match schema.get("type") {
        Some(Value::String(kind)) => vec![kind.as_str()],
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
        _ if schema.get("properties").is_some() => vec!["object"],
        _ => Vec::new(),
    };
    if kinds.is_empty() {
        return "unknown".to_string();
    }
    kinds
        .iter()
        .map(|kind| match *kind {
            "string" => "string".to_string(),
            "integer" | "number" => "number".to_string(),
            "boolean" => "boolean".to_string(),
            "null" => "null".to_string(),
            "array" => {
                let item = schema.get("items").map(|items| ts_type(items, docs)).unwrap_or_else(|| "unknown".to_string());
                if item.contains(' ') { format!("({item})[]") } else { format!("{item}[]") }
            }
            "object" => {
                let Some(properties) = schema.get("properties").and_then(Value::as_object).filter(|properties| !properties.is_empty())
                else {
                    return "Record<string, unknown>".to_string();
                };
                let required: Vec<&str> =
                    schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
                let fields: Vec<String> = properties
                    .iter()
                    .map(|(name, property)| {
                        let optional = if required.contains(&name.as_str()) { "" } else { "?" };
                        let described = if docs { doc(property.get("description").and_then(Value::as_str)) } else { String::new() };
                        format!("{described}{}{optional}: {}", property_name(name), ts_type(property, docs))
                    })
                    .collect();
                format!("{{ {} }}", fields.join("; "))
            }
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Fonctions qu’une conversation peut appeler en Code Mode : les lectures qu’elle atteint, et pour une conversation
/// lancée par une page, les fonctions que la page lui offre (écritures comprises, accordées par l’utilisateur).
fn callable<'a>(functions: &'a [ResolvedFunction], scope: Option<&AgentScope>) -> Vec<&'a ResolvedFunction> {
    // Une conversation ouverte par l’utilisateur voit aussi les écritures : chacune demande son accord.
    functions.iter().filter(|function| !function.missing && (scope.is_none() || allowed(function, scope))).collect()
}

fn allowed(function: &ResolvedFunction, scope: Option<&AgentScope>) -> bool {
    if !crate::agent_tools::reaches(scope, &function.reference) {
        return false;
    }
    function.effect == Some(Effect::Read) || scope.is_some_and(|scope| scope.functions.contains(&function.reference))
}

fn signature(function: &ResolvedFunction, scope: Option<&AgentScope>, docs: bool) -> String {
    let schema = crate::agent_tools::without_fixed_fields(scope, &function.reference, function.input.clone());
    let input = ts_type(&schema, docs);
    let input = if input == "Record<string, unknown>" || input == "unknown" { "input?: Record<string, unknown>".to_string() } else { format!("input: {input}") };
    format!("{}({input}): Promise<{}>", ident(&function.id), ts_type(&function.output, docs))
}

fn api(state: &Arc<AppState>, conversation: &str, argv: &[String]) -> AppResult<Value> {
    let (positional, _) = options(argv, &[])?;
    let space = state.space()?;
    let snapshot = space.snapshot()?;
    let scope = crate::agent_tools::scope_of(state, conversation);
    let functions = callable(&snapshot.functions, scope.as_ref());
    let shared = crate::states::agent_overview(&space);
    let states: Vec<&Value> = shared["states"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|declared| {
            let provider = declared["provider"].as_str().unwrap_or_default();
            scope.as_ref().is_none_or(|scope| scope.module == provider)
        })
        .collect();
    let write_note = |function: &ResolvedFunction| match (function.effect == Some(Effect::Read), scope.is_some()) {
        (true, _) => "",
        (false, true) => " (écriture offerte par la page)",
        (false, false) => " (écriture : l’utilisateur l’accorde par une carte)",
    };
    match positional.first() {
        None => {
            let mut lines = vec![
                "Code Mode. Enchaîne toutes les lectures dans un seul `alfred run` :".to_string(),
                "  alfred run - <<'EOF'".to_string(),
                "  const a = await api.module.fonction({ … });".to_string(),
                "  const b = await api.module.autre({ champ: a[0].champ });".to_string(),
                "  return b;".to_string(),
                "  EOF".to_string(),
                "Types détaillés d’un module : `alfred api <module>`. Options de run : `alfred help run`.".to_string(),
                String::new(),
            ];
            for function in &functions {
                let mut line = format!(
                    "api.{}.{}  {}{}",
                    ident(&function.module),
                    signature(function, scope.as_ref(), false),
                    function.description.split(". ").next().unwrap_or_default().trim_end_matches('.'),
                    write_note(function)
                );
                if line.chars().count() > 220 {
                    line = line.chars().take(219).collect::<String>() + "…";
                }
                lines.push(line);
            }
            if functions.is_empty() {
                lines.push("Aucune fonction dans cet espace.".to_string());
            }
            for declared in &states {
                lines.push(format!(
                    "api.states.get({}{})  {}",
                    serde_json::to_string(&declared["state"]).unwrap_or_default(),
                    if declared["params"].as_array().is_some_and(|params| !params.is_empty()) { ", { params }" } else { "" },
                    declared["description"].as_str().unwrap_or_default()
                ));
            }
            Ok(Value::String(lines.join("\n")))
        }
        Some(target) => {
            let (module, function) = match target.split_once('/') {
                Some((module, function)) => (module.to_string(), Some(function.to_string())),
                None => (target.clone(), None),
            };
            let chosen: Vec<&&ResolvedFunction> = functions
                .iter()
                .filter(|candidate| candidate.module == module || ident(&candidate.module) == module)
                .filter(|candidate| function.as_ref().is_none_or(|wanted| &candidate.id == wanted || &ident(&candidate.id) == wanted))
                .collect();
            if chosen.is_empty() {
                return Err(AppError::new(format!(
                    "Aucune fonction pour « {target} ». `alfred api` les liste."
                )));
            }
            let module_ident = ident(&chosen[0].module);
            let mut lines = vec![format!("declare const api: {{\n  {module_ident}: {{")];
            for candidate in &chosen {
                lines.push(format!(
                    "    {}{};{}",
                    doc(Some(&candidate.description)),
                    signature(candidate, scope.as_ref(), true),
                    write_note(candidate)
                ));
            }
            lines.push("  };".to_string());
            let own_states: Vec<&&Value> = states.iter().filter(|declared| declared["provider"] == chosen[0].module.as_str()).collect();
            if !own_states.is_empty() {
                lines.push("  states: {".to_string());
                for declared in own_states {
                    let params: Vec<String> = declared["params"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|param| format!("{}{}?: unknown", doc(param["description"].as_str()), property_name(param["id"].as_str().unwrap_or_default())))
                        .collect();
                    lines.push(format!(
                        "    {}get(name: {}, options?: {{ params?: {{ {} }}; key?: string }}): Promise<{{ value: unknown; empty: boolean; updatedAt?: number }}>;",
                        doc(declared["description"].as_str()),
                        serde_json::to_string(&declared["state"]).unwrap_or_default(),
                        params.join("; ")
                    ));
                }
                lines.push("  };".to_string());
            }
            lines.push("};".to_string());
            if function.is_some() {
                // Le détail d’une fonction : un exemple d’appel tiré de son premier test.
                if let Some(test) = chosen[0].tests.first() {
                    lines.push(format!(
                        "// Exemple ({}) : await api.{}.{}({})",
                        test.name,
                        module_ident,
                        ident(&chosen[0].id),
                        serde_json::to_string(&test.input).unwrap_or_default()
                    ));
                }
            }
            Ok(Value::String(lines.join("\n")))
        }
    }
}

// --- Exécution -----------------------------------------------------------------------------------------------

/// Source à exécuter : un fichier (relatif au dossier de l’agent) ou l’entrée standard.
fn source(positional: &[String], stdin: Option<&str>, cwd: Option<&Path>) -> AppResult<String> {
    match positional.first().map(String::as_str) {
        None | Some("-") => stdin
            .map(str::to_string)
            .filter(|code| !code.trim().is_empty())
            .ok_or_else(|| AppError::new("Donne le code : `alfred run fichier.ts`, ou `alfred run -` avec le code sur l’entrée standard.")),
        Some(file) => {
            let path = cwd.map(|cwd| cwd.join(file)).unwrap_or_else(|| Path::new(file).to_path_buf());
            std::fs::read_to_string(&path).map_err(|error| AppError::new(format!("Lecture de {} impossible : {error}", path.display())))
        }
    }
}

/// Le code de l’agent devient le corps d’une fonction asynchrone `(api, input)`.
pub fn wrap(code: &str) -> AppResult<String> {
    if code.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("import ") || line.starts_with("import{") || line.starts_with("export ")
    }) {
        return Err(AppError::new(
            "Pas d’import ni d’export en Code Mode : le code est le corps d’une fonction. Appelle les fonctions par `api.module.fonction(entrée)`.",
        ));
    }
    let source = format!("export default async function (api, input) {{\n{code}\n}}\n");
    crate::transpile::transpile_in(&source, "alfred-run.ts", 0, &std::collections::BTreeMap::new()).map_err(|diagnostics| {
        // Les lignes comptent depuis le code de l’agent, sans la ligne ajoutée.
        let shifted: Vec<Value> = diagnostics
            .iter()
            .map(|diagnostic| json!({ "message": diagnostic.message, "line": diagnostic.line.map(|line| line.saturating_sub(1)), "column": diagnostic.column }))
            .collect();
        AppError::with_detail("Le code ne se compile pas.", json!(shifted))
    })
}

async fn run_command(
    state: &Arc<AppState>,
    conversation: &str,
    argv: &[String],
    stdin: Option<&str>,
    cwd: Option<&Path>,
) -> AppResult<Value> {
    let (positional, named) = options_with(argv, &["input", "again", "save", "description"], &["examples"])?;
    let text = |name: &str| named.get(name).and_then(Value::as_str).map(str::to_string);
    let input = match text("input") {
        Some(raw) => Some(serde_json::from_str(&raw).map_err(|_| AppError::new("`--input` attend du JSON."))?),
        None => None,
    };
    let (code, input) = match text("again") {
        Some(id) => {
            if positional.iter().any(|value| value != "-") {
                return Err(AppError::new("`--again` relance une exécution gardée : sans fichier."));
            }
            let stored = crate::kept_scripts::load(state, &id)?;
            (stored.code, input.unwrap_or(stored.input))
        }
        None => (source(&positional, stdin, cwd)?, input.unwrap_or_else(|| json!({}))),
    };
    let examples = named.contains_key("examples");
    let (outcome, calls) = execute(state, conversation, &code, input.clone(), examples).await;
    // Un code qui ne compile pas n’a pas tourné : il n’est pas gardé.
    let compiled = !matches!(&outcome, Err(error) if error.message == "Le code ne se compile pas.");
    let id = if compiled { Some(crate::kept_scripts::record(state, conversation, &code, &input, &outcome, &calls)?) } else { None };
    let mut shown = outcome?;
    shown["run"] = json!(id);
    if let (Some(target), Some(id)) = (text("save"), &id) {
        let stored = crate::kept_scripts::load(state, id)?;
        shown["saved"] = crate::kept_scripts::save(state, conversation, &target, text("description"), &stored).await?;
    }
    Ok(shown)
}

/// Exécute `code` pour la conversation : `{ result, logs, calls, ms }`, et les appels faits.
pub async fn execute(state: &Arc<AppState>, conversation: &str, code: &str, input: Value, examples: bool) -> (AppResult<Value>, Vec<String>) {
    match execute_inner(state, conversation, code, input, examples).await {
        Ok((outcome, calls)) => (outcome, calls),
        Err(error) => (Err(error), Vec::new()),
    }
}

async fn execute_inner(state: &Arc<AppState>, conversation: &str, code: &str, input: Value, examples: bool) -> AppResult<(AppResult<Value>, Vec<String>)> {
    let js = wrap(code)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let run = Arc::new(Run {
        conversation: conversation.to_string(),
        scope: crate::agent_tools::scope_of(state, conversation),
        js,
        deadline: Mutex::new(Instant::now() + MAX_DURATION),
        calls: Mutex::new(Vec::new()),
        examples,
    });
    runs().lock().map_err(|_| AppError::new("Code Mode indisponible."))?.insert(id.clone(), run.clone());
    let _registered = Registered(id.clone());
    let started = Instant::now();
    // Le cadre attend sans limite propre : le cœur l’arrête à l’échéance, repoussée pendant l’attente d’un accord.
    let ask = state.ask_ui(
        "agent:code",
        json!({ "run": id, "key": frame_key(state), "input": input, "timeoutMs": MAX_WAIT.as_millis() as u64 }),
        MAX_WAIT,
    );
    tokio::pin!(ask);
    let answer = loop {
        tokio::select! {
            answer = &mut ask => break answer,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                if Instant::now() > run.deadline_at() {
                    state.emit("agent:codeCancel", json!({ "run": id }));
                    break Err(AppError::new(format!("Durée maximale dépassée ({} s).", MAX_DURATION.as_secs())));
                }
            }
        }
    };
    let ms = started.elapsed().as_millis() as u64;
    let calls = run.calls.lock().map(|calls| calls.clone()).unwrap_or_default();
    let outcome = answer.and_then(|answer| shape(answer, &calls, ms));
    let summary = match &outcome {
        Ok(_) => format!("Code Mode : {} appel(s) en {ms} ms", calls.len()),
        Err(error) => format!("Code Mode, échec : {}", error.message),
    };
    crate::functions::journal(
        state,
        "agent",
        "alfred run",
        outcome.is_ok(),
        Some(ms),
        &summary,
        Some(&json!({ "conversation": conversation, "calls": calls })),
    );
    Ok((outcome, calls))
}

/// Réponse du cadre `{ output, logs, error }` : la sortie rendue à l’agent, bornée.
fn shape(answer: Value, calls: &[String], ms: u64) -> AppResult<Value> {
    let mut logs: Vec<String> = answer["logs"]
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_LOG_LINES)
        .map(|line| match line["level"].as_str() {
            Some("log") | None => line["text"].as_str().unwrap_or_default().to_string(),
            Some(level) => format!("[{level}] {}", line["text"].as_str().unwrap_or_default()),
        })
        .collect();
    if answer["logs"].as_array().is_some_and(|all| all.len() > MAX_LOG_LINES) {
        logs.push(format!("… console coupée à {MAX_LOG_LINES} lignes."));
    }
    if let Some(error) = answer.get("error").filter(|error| !error.is_null()) {
        let message = error["message"].as_str().unwrap_or("Le code a échoué.").to_string();
        return Err(AppError::with_detail(format!("Le code a échoué : {message}"), json!({ "logs": logs, "calls": calls, "stack": error["stack"] })));
    }
    let result = answer.get("output").cloned().unwrap_or(Value::Null);
    let mut shown = json!({ "result": result, "logs": logs, "calls": calls.len(), "ms": ms });
    let size = serde_json::to_string(&shown).map(|text| text.chars().count()).unwrap_or_default();
    if size > MAX_OUTPUT {
        let text = serde_json::to_string(&result).unwrap_or_default();
        let kept: String = text.chars().take(MAX_OUTPUT / 2).collect();
        shown["result"] = Value::String(kept);
        shown["truncated"] = json!(format!(
            "Sortie de {size} caractères coupée (limite {MAX_OUTPUT}) : rends moins (slice, champs choisis, totaux)."
        ));
        let mut length = 0;
        let logs: Vec<String> = logs.into_iter().take_while(|line| { length += line.len(); length < MAX_OUTPUT / 4 }).collect();
        shown["logs"] = json!(logs);
    }
    Ok(shown)
}

/// Fonction visée par `api.module.fonction` (noms d’API ou identifiants) ou par `api.call("module/fonction")`.
fn resolve<'a>(functions: &'a [ResolvedFunction], args: &Value) -> AppResult<&'a ResolvedFunction> {
    let (module, name) = match args.get("function").and_then(Value::as_str) {
        Some(reference) => reference
            .split_once('/')
            .map(|(module, name)| (module.to_string(), name.to_string()))
            .ok_or_else(|| AppError::new(format!("Fonction invalide : « {reference} » (« module/fonction » attendu).")))?,
        None => (arg::<String>(args, "module")?, arg::<String>(args, "name")?),
    };
    functions
        .iter()
        .find(|function| {
            (function.module == module || ident(&function.module) == module) && (function.id == name || ident(&function.id) == name)
        })
        .ok_or_else(|| AppError::new(format!("La fonction « {module}/{name} » n’existe pas. `alfred api` liste celles que tu peux appeler.")))
}

fn active(args: &Value) -> AppResult<Arc<Run>> {
    let id: String = arg(args, "run")?;
    let run = runs()
        .lock()
        .ok()
        .and_then(|all| all.get(&id).cloned())
        .ok_or_else(|| AppError::new("Cette exécution est terminée."))?;
    if Instant::now() > run.deadline_at() {
        return Err(AppError::new(format!("Durée maximale dépassée ({} s).", MAX_DURATION.as_secs())));
    }
    Ok(run)
}

fn count(run: &Run, what: String) -> AppResult<()> {
    let mut calls = run.calls.lock().map_err(|_| AppError::new("Code Mode indisponible."))?;
    if calls.len() >= MAX_CALLS {
        return Err(AppError::new(format!("Trop d’appels : {MAX_CALLS} au plus par exécution.")));
    }
    calls.push(what);
    Ok(())
}

/// Requêtes du cadre d’une exécution, relayées par la coquille.
pub async fn handle_command(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "agentCode.call" => Some(call_function(state, args).await),
        "agentCode.state" => Some(read_state(state, args).await),
        _ => None,
    }
}

async fn call_function(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let run = active(args)?;
    let snapshot = state.space()?.snapshot()?;
    let function = resolve(&snapshot.functions, args)?;
    if !crate::agent_tools::reaches(run.scope.as_ref(), &function.reference) {
        return Err(AppError::new(format!(
            "« {} » est hors du module de cette conversation.",
            function.reference
        )));
    }
    let write = !allowed(function, run.scope.as_ref());
    if write && run.scope.is_some() {
        return Err(AppError::new(format!(
            "« {} » est une écriture que la page n’offre pas à cette conversation : elle n’est pas lancée.",
            function.reference
        )));
    }
    count(&run, function.reference.clone())?;
    let input = args.get("input").cloned().filter(|input| !input.is_null()).unwrap_or_else(|| json!({}));
    let input = crate::agent_tools::with_fixed_input(run.scope.as_ref(), &function.reference, input);
    if write {
        approve_write(state, &run, function, &input).await?;
    }
    let reference = function.reference.clone();
    let remaining = run.deadline_at().saturating_duration_since(Instant::now());
    tokio::time::timeout(remaining, crate::functions::call_in(state, &reference, input, "agent-code", run.examples))
        .await
        .map_err(|_| AppError::new(format!("Durée maximale dépassée ({} s).", MAX_DURATION.as_secs())))?
}

impl Run {
    fn deadline_at(&self) -> Instant {
        self.deadline.lock().map(|deadline| *deadline).unwrap_or_else(|_| Instant::now())
    }
}

/// Attente maximale d’une réponse à une carte d’accord.
pub const APPROVAL_WAIT: Duration = Duration::from_secs(90);

fn grants_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    db.execute(
        "CREATE TABLE IF NOT EXISTS code_grants (conversation TEXT NOT NULL, reference TEXT NOT NULL, granted_at TEXT NOT NULL,
         PRIMARY KEY (conversation, reference))",
        [],
    )?;
    Ok(db)
}

fn granted(state: &AppState, conversation: &str, reference: &str) -> bool {
    grants_db(state)
        .and_then(|db| {
            Ok(db.query_row(
                "SELECT 1 FROM code_grants WHERE conversation = ?1 AND reference = ?2",
                rusqlite::params![conversation, reference],
                |_| Ok(()),
            ).is_ok())
        })
        .unwrap_or(false)
}

/// Réponses données à la place de l’utilisateur dans les tests, par conversation : identifiant d’option ; absente,
/// pas de réponse.
#[cfg(test)]
pub static TEST_ANSWERS: Mutex<Vec<(&'static str, &'static str)>> = Mutex::new(Vec::new());

async fn ask_user(state: &AppState, conversation: &str, function: &ResolvedFunction, input: &Value) -> Option<String> {
    #[cfg(test)]
    {
        let _ = (state, function, input);
        return TEST_ANSWERS
            .lock()
            .ok()
            .and_then(|answers| answers.iter().find(|(asked, _)| *asked == conversation).map(|(_, answer)| answer.to_string()));
    }
    #[cfg(not(test))]
    {
        use crate::agents::event::{ApprovalOption, OptionKind};
        let mut shown = serde_json::to_string_pretty(input).unwrap_or_default();
        if shown.chars().count() > 1500 {
            shown = shown.chars().take(1500).collect::<String>() + "\n…";
        }
        let description = if function.description.is_empty() { String::new() } else { format!("{}\n", function.description) };
        crate::agents::session::ask_in_conversation(
            state,
            conversation,
            &format!("Écrire avec {}", function.reference),
            &format!("{description}Entrée :\n{shown}"),
            vec![
                ApprovalOption::new("once", "Autoriser", OptionKind::Allow),
                ApprovalOption::new("conversation", "Autoriser pour cette conversation", OptionKind::AllowAlways),
                ApprovalOption::new("deny", "Refuser", OptionKind::Deny),
            ],
            APPROVAL_WAIT,
        )
        .await
    }
}

/// Une écriture dans une conversation ouverte par l’utilisateur : accordée pour la conversation, ou demandée par une
/// carte. Le temps d’attente repousse l’échéance de l’exécution.
async fn approve_write(state: &AppState, run: &Run, function: &ResolvedFunction, input: &Value) -> AppResult<()> {
    if granted(state, &run.conversation, &function.reference) {
        return Ok(());
    }
    let started = Instant::now();
    // Pendant l’attente, l’échéance recule d’autant : la carte a tout son temps, le calcul garde ses 60 s.
    let before = run.deadline_at();
    if let Ok(mut deadline) = run.deadline.lock() {
        *deadline = before + APPROVAL_WAIT + Duration::from_secs(5);
    }
    let answer = ask_user(state, &run.conversation, function, input).await;
    if let Ok(mut deadline) = run.deadline.lock() {
        *deadline = before + started.elapsed();
    }
    match answer.as_deref() {
        Some("once") => Ok(()),
        Some("conversation") => {
            grants_db(state)?.execute(
                "INSERT OR IGNORE INTO code_grants (conversation, reference, granted_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![run.conversation, function.reference, chrono::Utc::now().to_rfc3339()],
            )?;
            Ok(())
        }
        Some(_) => Err(AppError::new(format!(
            "L’utilisateur a refusé l’écriture « {} » : rien n’a été écrit.",
            function.reference
        ))),
        None => Err(AppError::new(format!(
            "Pas de réponse à la demande d’accord pour « {} » : rien n’a été écrit. Le dire à l’utilisateur.",
            function.reference
        ))),
    }
}

async fn read_state(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let run = active(args)?;
    let name: String = arg(args, "name")?;
    let (provider, _) = name.split_once('/').ok_or_else(|| AppError::new("État attendu : « module/etat »."))?;
    if run.scope.as_ref().is_some_and(|scope| scope.module != provider) {
        return Err(AppError::new(format!("L’état « {name} » est hors du module de cette conversation.")));
    }
    count(&run, format!("état {name}"))?;
    let subject = crate::permissions::Subject {
        kind: "function".into(),
        module: provider.to_string(),
        reference: format!("{provider}/agent-code"),
        ..Default::default()
    };
    let mut request = json!({ "subject": subject, "name": name });
    for field in ["params", "key", "instance"] {
        if let Some(value) = opt_arg::<Value>(args, field)? {
            request[field] = value;
        }
    }
    let _ = &run.conversation;
    crate::states::handle(state, "frame.states.get", &request)
        .await
        .unwrap_or_else(|| Err(AppError::new("Lecture d’état indisponible.")))
}

/// Appel d’une fonction comme depuis le code d’un agent (`api.call`), pour les tests du cœur sans interface.
#[cfg(test)]
pub async fn call_as_agent(state: &Arc<AppState>, conversation: &str, reference: &str, input: Value) -> AppResult<Value> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let run = Arc::new(Run {
        conversation: conversation.to_string(),
        scope: crate::agent_tools::scope_of(state, conversation),
        js: String::new(),
        deadline: Mutex::new(Instant::now() + MAX_DURATION),
        calls: Mutex::new(Vec::new()),
        examples: false,
    });
    runs().lock().unwrap().insert(id.clone(), run);
    let _registered = Registered(id.clone());
    call_function(state, &json!({ "run": id, "function": reference, "input": input })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une écriture attend l’accord : sans réponse ou refusée, rien n’est écrit ; « une fois » vaut pour cet appel,
    /// « pour cette conversation » pour les suivants ; une conversation de page n’écrit que ce que la page offre.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_write_waits_for_the_user() {
        use crate::space::{FunctionDecl, ModuleManifest, Space};
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        let mut manifest = ModuleManifest { id: "notes".into(), name: "Notes".into(), ..Default::default() };
        manifest.functions.push(FunctionDecl {
            id: "archiver".into(),
            runtime: crate::scripts::Runtime::Bash,
            effect: Some(Effect::Write),
            ..Default::default()
        });
        space.write_module(&manifest).unwrap();
        let marker = dir.path().join("ecrit");
        std::fs::create_dir_all(space.module_dir("notes").join("functions")).unwrap();
        std::fs::write(
            space.module_dir("notes").join("functions/archiver.sh"),
            format!("cat >/dev/null\necho x >> '{}'\nprintf '{{\"ok\":true}}'\n", marker.display()),
        )
        .unwrap();
        state.set_space(Some(space));
        let written = || std::fs::read_to_string(&marker).map(|text| text.lines().count()).unwrap_or(0);
        let call = |conversation: &'static str| {
            let state = state.clone();
            async move { call_as_agent(&state, conversation, "notes/archiver", json!({ "id": 1 })).await }
        };
        let answer = |value: Option<&'static str>| {
            let mut answers = TEST_ANSWERS.lock().unwrap();
            answers.retain(|(conversation, _)| !["c1", "c2", "page"].contains(conversation));
            if let Some(value) = value {
                answers.extend([("c1", value), ("page", value)]);
            }
        };

        answer(None);
        assert!(call("c1").await.unwrap_err().message.contains("Pas de réponse"));
        answer(Some("deny"));
        assert!(call("c1").await.unwrap_err().message.contains("refusé"));
        assert_eq!(written(), 0, "rien n’est écrit sans accord");
        answer(Some("once"));
        assert_eq!(call("c1").await.unwrap(), json!({ "ok": true }));
        answer(None);
        assert!(call("c1").await.is_err(), "« Autoriser » ne vaut que pour cet appel");
        answer(Some("conversation"));
        call("c1").await.unwrap();
        answer(None);
        call("c1").await.unwrap();
        assert_eq!(written(), 3);
        assert!(call("c2").await.is_err(), "l’accord ne vaut que pour sa conversation");

        let page = AgentScope { module: "notes".into(), ..AgentScope::default() };
        crate::app_db::set_agent_scope(&state.app_db.lock().unwrap(), "page", &page).unwrap();
        answer(Some("once"));
        assert!(call("page").await.unwrap_err().message.contains("n’offre pas"), "une page ne demande rien de plus");
        assert_eq!(written(), 3);
        answer(None);
    }

    #[test]
    fn schemas_become_typescript() {
        let schema = json!({ "type": "object", "required": ["project"], "properties": {
            "project": { "type": "string", "description": "Clé du projet." },
            "status": { "enum": ["open", "done"] },
            "limit": { "type": "integer" },
            "tags": { "type": "array", "items": { "type": "string" } },
            "nom-complet": { "type": ["string", "null"] },
        } });
        assert_eq!(
            ts_type(&schema, false),
            r#"{ limit?: number; "nom-complet"?: string | null; project: string; status?: "open" | "done"; tags?: string[] }"#
        );
        assert!(ts_type(&schema, true).contains("/** Clé du projet. */ project: string"));
        assert_eq!(ts_type(&json!({}), false), "unknown");
        assert_eq!(ident("list-tickets"), "listTickets");
        assert_eq!(ident("mes-scripts"), "mesScripts");
    }

    #[test]
    fn the_code_is_the_body_of_an_async_function() {
        let js = wrap("const n: number = await api.notes.compter({});\nconsole.log(n);\nreturn n * 2;").unwrap();
        assert!(js.contains("export default async function(api, input)") || js.contains("export default async function (api, input)"), "{js}");
        assert!(!js.contains(": number"));
        assert!(wrap("import x from 'y';\nreturn 1;").unwrap_err().message.contains("Pas d’import"));
        let broken = wrap("return (;").unwrap_err();
        assert_eq!(broken.message, "Le code ne se compile pas.");
    }
}
