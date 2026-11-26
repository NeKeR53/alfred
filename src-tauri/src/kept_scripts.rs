//! Scripts gardés de Code Mode. Chaque `alfred run` est gardé sept jours dans la base d’Alfred (code, entrée,
//! sortie, date, conversation) : `alfred runs` les liste, `alfred run --again <id>` en relance un. Un script réussi
//! peut devenir une vraie fonction TypeScript d’un module (`alfred run --save module/nom`) : son fichier, sa
//! déclaration (`effect: read`, ou `write` s’il a écrit ; `uses`, entrée et sortie déduites de l’exécution, premier test) et, s’il appelle un
//! autre module, `requires`. Elle reste « à valider » tant que l’utilisateur ne l’a pas acceptée dans la fiche du
//! module (Réglages → Modules) : l’accord porte sur une empreinte de sa déclaration et de son fichier, et toute
//! modification la remet à valider, comme une automatisation.

use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{arg, AppError, AppResult};
use crate::space::{FunctionDecl, ModuleManifest, Snapshot, Space};
use crate::state::AppState;

/// Durée de vie d’une exécution gardée.
const KEEP_DAYS: i64 = 7;
/// Module personnel des scripts qui touchent plusieurs modules.
pub const PERSONAL_MODULE: &str = "mes-scripts";

/// Exécution gardée.
#[derive(Debug, Clone)]
pub struct StoredRun {
    pub id: String,
    pub at: String,
    pub conversation: String,
    pub code: String,
    pub input: Value,
    pub ok: bool,
    pub output: Value,
    pub calls: Vec<String>,
    /// Durée de l’exécution, en millisecondes (absente des exécutions gardées avant qu’elle ne soit notée).
    pub ms: Option<u64>,
}

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    // Tables créées au premier usage, dans la base d’Alfred : hors de portée d’une écriture dans l’espace.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY, space TEXT NOT NULL, conversation TEXT NOT NULL, at TEXT NOT NULL,
            code TEXT NOT NULL, input TEXT NOT NULL, ok INTEGER NOT NULL, output TEXT NOT NULL, calls TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kept_functions (
            space TEXT NOT NULL, reference TEXT NOT NULL, conversation TEXT NOT NULL, created_at TEXT NOT NULL,
            accepted TEXT, PRIMARY KEY (space, reference));",
    )?;
    let has_ms: i64 = db.query_row("SELECT COUNT(*) FROM pragma_table_info('agent_runs') WHERE name = 'ms'", [], |row| row.get(0))?;
    if has_ms == 0 {
        db.execute("ALTER TABLE agent_runs ADD COLUMN ms INTEGER", [])?;
    }
    Ok(db)
}

fn space_key(space: &Space) -> String {
    space.root.to_string_lossy().to_string()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Garde une exécution et retire celles de plus de sept jours. Rend son identifiant.
pub fn record(state: &AppState, conversation: &str, code: &str, input: &Value, outcome: &AppResult<Value>, calls: &[String], ms: u64) -> AppResult<String> {
    let space = state.space()?;
    let id = format!("r{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let (ok, output) = match outcome {
        Ok(value) => (true, value.clone()),
        Err(error) => (false, json!({ "error": error.message, "detail": error.detail })),
    };
    let db = lock_db(state)?;
    let limit = (chrono::Utc::now() - chrono::Duration::days(KEEP_DAYS)).to_rfc3339();
    db.execute("DELETE FROM agent_runs WHERE at < ?1", params![limit])?;
    db.execute(
        "INSERT INTO agent_runs (id, space, conversation, at, code, input, ok, output, calls, ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            space_key(&space),
            conversation,
            now(),
            code,
            input.to_string(),
            ok,
            output.to_string(),
            serde_json::to_string(calls)?,
            ms as i64
        ],
    )?;
    Ok(id)
}

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<StoredRun> {
    let text = |index: usize| row.get::<_, String>(index);
    Ok(StoredRun {
        id: text(0)?,
        at: text(1)?,
        conversation: text(2)?,
        code: text(3)?,
        input: serde_json::from_str(&text(4)?).unwrap_or(Value::Null),
        ok: row.get(5)?,
        output: serde_json::from_str(&text(6)?).unwrap_or(Value::Null),
        calls: serde_json::from_str(&text(7)?).unwrap_or_default(),
        ms: row.get::<_, Option<i64>>(8)?.map(|ms| ms.max(0) as u64),
    })
}

const COLUMNS: &str = "id, at, conversation, code, input, ok, output, calls, ms";

/// Exécution gardée de l’espace ouvert.
pub fn load(state: &AppState, id: &str) -> AppResult<StoredRun> {
    let space = state.space()?;
    let db = lock_db(state)?;
    db.query_row(
        &format!("SELECT {COLUMNS} FROM agent_runs WHERE id = ?1 AND space = ?2"),
        params![id, space_key(&space)],
        from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::new(format!("Aucune exécution « {id} » (gardées {KEEP_DAYS} jours). `alfred runs` les liste.")))
}

/// `alfred runs` : les exécutions gardées de l’espace, la plus récente d’abord.
pub fn list(state: &AppState, limit: usize) -> AppResult<Value> {
    let space = state.space()?;
    let db = lock_db(state)?;
    let mut statement =
        db.prepare(&format!("SELECT {COLUMNS} FROM agent_runs WHERE space = ?1 ORDER BY at DESC LIMIT ?2"))?;
    let runs: Vec<StoredRun> =
        statement.query_map(params![space_key(&space), limit as i64], from_row)?.collect::<Result<_, _>>()?;
    if runs.is_empty() {
        return Ok(Value::String("Aucune exécution gardée dans cet espace.".to_string()));
    }
    let lines: Vec<String> = runs
        .iter()
        .map(|run| {
            let first = run.code.lines().map(str::trim).find(|line| !line.is_empty() && !line.starts_with("//")).unwrap_or("");
            let first: String = first.chars().take(70).collect();
            format!(
                "{}  {}  conversation {}  {}  {} appel(s)  {}",
                run.id,
                run.at.get(..16).unwrap_or(&run.at).replace('T', " "),
                run.conversation.chars().take(8).collect::<String>(),
                if run.ok { "réussie" } else { "échec  " },
                run.calls.len(),
                first
            )
        })
        .collect();
    Ok(Value::String(format!(
        "{}\n\n`alfred run --again <id> [--input …]` relance ; `--save module/nom` la garde comme fonction.",
        lines.join("\n")
    )))
}

// --- Sauvegarde ----------------------------------------------------------------------------------------------

/// Schéma JSON déduit d’une valeur d’exemple : pour une entrée, les champs présents sont obligatoires ; une sortie
/// n’en exige aucun (une autre exécution peut rendre un champ vide).
pub fn schema_of(value: &Value, depth: usize) -> Value {
    shape_of(value, depth, true)
}

fn shape_of(value: &Value, depth: usize, strict: bool) -> Value {
    match value {
        Value::Null => json!({}),
        Value::Bool(_) => json!({ "type": "boolean" }),
        Value::Number(number) if number.is_i64() || number.is_u64() => json!({ "type": "integer" }),
        Value::Number(_) => json!({ "type": "number" }),
        Value::String(_) => json!({ "type": "string" }),
        Value::Array(items) if depth > 0 => match items.first() {
            Some(first) => json!({ "type": "array", "items": shape_of(first, depth - 1, strict) }),
            None => json!({ "type": "array" }),
        },
        Value::Array(_) => json!({ "type": "array" }),
        Value::Object(object) if depth > 0 => {
            let properties: serde_json::Map<String, Value> =
                object.iter().map(|(key, value)| (key.clone(), shape_of(value, depth - 1, strict))).collect();
            if !strict {
                return json!({ "type": "object", "properties": properties });
            }
            let required: Vec<&String> = object.iter().filter(|(_, value)| !value.is_null()).map(|(key, _)| key).collect();
            json!({ "type": "object", "properties": properties, "required": required })
        }
        Value::Object(_) => json!({ "type": "object" }),
    }
}

/// Module où ranger un script sans module donné : celui qui reçoit plus de la moitié des appels, sinon
/// `mes-scripts`.
pub fn home_module(calls: &[String]) -> String {
    let modules: Vec<&str> = calls.iter().filter(|call| !call.starts_with("état ")).filter_map(|call| call.split_once('/').map(|(module, _)| module)).collect();
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for module in &modules {
        *counts.entry(module).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .filter(|(_, count)| *count * 2 > modules.len())
        .map(|(module, _)| module.to_string())
        .unwrap_or_else(|| PERSONAL_MODULE.to_string())
}

/// Paramètre d’un script gardé : même forme que les paramètres d’un état, avec sa valeur par défaut.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScriptParam {
    pub id: String,
    /// Ce que le paramètre choisit, en mots de l’utilisateur.
    pub description: String,
    /// Valeur prise quand l’appelant ne la donne pas : les anciens appels marchent toujours.
    pub default: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<Value>,
}

/// Options de `--save` (agent) ou de « Garder » (Réglages).
#[derive(Debug, Clone, Default)]
pub struct KeepOptions {
    pub description: Option<String>,
    pub params: Vec<ScriptParam>,
    /// `--new` : garder un script à part, même proche d’un script déjà gardé.
    pub new: bool,
}

/// Corps du script dans le fichier d’une fonction gardée : le code de l’agent, sans l’enveloppe.
const BODY_START: &str = "export default async function (input: any) {\n";
/// Ligne qui pose les valeurs par défaut des paramètres, en tête du corps.
const DEFAULTS_LINE: &str = "  input = { ...";

/// Fichier d’une fonction gardée : le code de l’agent, avec la même `api` qu’en Code Mode, branchée sur le SDK.
/// Les paramètres prennent leur valeur par défaut quand l’appelant ne la donne pas.
fn function_source(code: &str, functions: &[(String, String, String)], date: &str, writes: bool, params: &[ScriptParam]) -> String {
    let mut modules: std::collections::BTreeMap<&str, Vec<String>> = Default::default();
    for (module, id, reference) in functions {
        modules.entry(module).or_default().push(format!(
            "    {}: (input?: unknown) => functions.call({}, input ?? {{}}),",
            crate::code_mode::ident(id),
            serde_json::to_string(reference).unwrap_or_default()
        ));
    }
    let mut api = String::new();
    for (module, entries) in modules {
        api.push_str(&format!("  {}: {{\n{}\n  }},\n", crate::code_mode::ident(module), entries.join("\n")));
    }
    let defaults: serde_json::Map<String, Value> = params.iter().map(|param| (param.id.clone(), param.default.clone())).collect();
    let defaults = if defaults.is_empty() { String::new() } else { format!("{DEFAULTS_LINE}{}, ...(input ?? {{}}) }};\n", Value::Object(defaults)) };
    let body: String = code.lines().map(|line| if line.is_empty() { String::new() } else { format!("  {line}") }).collect::<Vec<_>>().join("\n");
    format!(
        "// Script gardé par l’agent depuis Code Mode (`alfred run`), le {date}. {}\n\
         // Il ne tourne qu’après l’accord de l’utilisateur (Réglages → Modules) ; toute modification le remet à valider.\n\
         import {{ functions, states }} from \"@alfred/sdk\";\n\n\
         // biome-ignore lint/suspicious/noExplicitAny: même API qu’en Code Mode.\n\
         const api: any = {{\n  call: (reference: string, input?: unknown) => functions.call(reference, input ?? {{}}),\n  \
         states: {{ get: (name: string, options = {{}}) => states.get(name, options) }},\n{api}}};\n\n\
         // biome-ignore lint/suspicious/noExplicitAny: entrée décrite dans module.json.\n\
         {BODY_START}{defaults}{body}\n}}\n",
        if writes { "Il écrit chez un service." } else { "Il ne fait que lire." }
    )
}

/// Code de l’agent tiré du fichier d’une fonction gardée (sans l’enveloppe ni la ligne des valeurs par défaut).
fn kept_body(file: &str) -> Option<String> {
    let start = file.find(BODY_START)? + BODY_START.len();
    let body = file[start..].trim_end().strip_suffix('}')?;
    Some(body.lines().filter(|line| !line.starts_with(DEFAULTS_LINE)).map(|line| line.strip_prefix("  ").unwrap_or(line)).collect::<Vec<_>>().join("\n"))
}

/// Mots du code, les valeurs littérales remplacées par un repère : deux scripts qui ne diffèrent que par un
/// identifiant, une date ou un seuil ont les mêmes mots.
fn code_words(code: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut chars = code.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' || c == '`' {
            let mut escaped = false;
            for next in chars.by_ref() {
                if escaped {
                    escaped = false;
                } else if next == '\\' {
                    escaped = true;
                } else if next == c {
                    break;
                }
            }
            words.push("<texte>".into());
        } else if c.is_ascii_digit() {
            while chars.peek().is_some_and(|next| next.is_ascii_alphanumeric() || *next == '.' || *next == '_') {
                chars.next();
            }
            words.push("<nombre>".into());
        } else if c.is_alphanumeric() || c == '_' || c == '$' {
            let mut word = c.to_string();
            while let Some(next) = chars.peek().copied().filter(|next| next.is_alphanumeric() || *next == '_' || *next == '$') {
                word.push(next);
                chars.next();
            }
            words.push(word);
        } else if !c.is_whitespace() {
            words.push(c.to_string());
        }
    }
    words
}

/// Ressemblance de deux codes : part des mots communs (multiensemble), de 0 à 1.
pub fn similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (code_words(a), code_words(b));
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut counts: std::collections::HashMap<&str, i64> = Default::default();
    for word in &a {
        *counts.entry(word).or_default() += 1;
    }
    let mut common = 0;
    for word in &b {
        if let Some(count) = counts.get_mut(word.as_str()).filter(|count| **count > 0) {
            *count -= 1;
            common += 1;
        }
    }
    (2 * common) as f64 / (a.len() + b.len()) as f64
}

/// Seuil au-delà duquel deux scripts aux mêmes appels sont un seul script à généraliser.
const CLOSE: f64 = 0.8;

/// Script gardé proche de `code` (mêmes fonctions appelées, code voisin), autre que `except`.
fn close_script(state: &AppState, space: &Space, called: &[String], code: &str, except: &str) -> Option<String> {
    let references: Vec<String> = {
        let db = lock_db(state).ok()?;
        let mut statement = db.prepare("SELECT reference FROM kept_functions WHERE space = ?1").ok()?;
        let rows = statement.query_map(params![space_key(space)], |row| row.get(0)).ok()?;
        rows.filter_map(Result::ok).collect()
    };
    let wanted: std::collections::BTreeSet<&String> = called.iter().collect();
    references.into_iter().filter(|reference| reference != except).find(|reference| {
        let Some((module, id)) = reference.split_once('/') else { return false };
        let Some(declared) = space.module(module).ok().and_then(|manifest| manifest.functions.into_iter().find(|declared| declared.id == id)) else {
            return false;
        };
        let same_calls = declared.uses.functions.iter().collect::<std::collections::BTreeSet<_>>() == wanted;
        same_calls
            && std::fs::read_to_string(space.function_file(module, id)).ok().and_then(|file| kept_body(&file)).is_some_and(|body| similarity(&body, code) >= CLOSE)
    })
}

/// Valeurs littérales passées aux fonctions dans le code : `{ cle: "valeur" }` ou `{ cle: 12 }` dans
/// `api.module.fonction(…)` ou `api.call(…)`. Chacune peut devenir un paramètre (Réglages, « Garder »).
pub fn literals(code: &str) -> Vec<Value> {
    let mut found = Vec::new();
    let bytes = code.as_bytes();
    let mut search = 0;
    while let Some(at) = code[search..].find("api.") {
        let call_start = search + at;
        search = call_start + 4;
        let Some(open) = code[call_start..].find('(').map(|offset| call_start + offset) else { break };
        // Seulement `api.x.y(` ou `api.call(` : pas d’espace ni de retour à la ligne avant la parenthèse.
        if code[call_start..open].contains(char::is_whitespace) {
            continue;
        }
        let callee = code[call_start + 4..open].to_string();
        let mut depth = 0usize;
        let mut close = None;
        let mut index = open;
        let mut quote: Option<u8> = None;
        while index < bytes.len() {
            let byte = bytes[index];
            if let Some(q) = quote {
                if byte == b'\\' {
                    index += 1;
                } else if byte == q {
                    quote = None;
                }
            } else if byte == b'"' || byte == b'\'' || byte == b'`' {
                quote = Some(byte);
            } else if byte == b'(' {
                depth += 1;
            } else if byte == b')' {
                depth -= 1;
                if depth == 0 {
                    close = Some(index);
                    break;
                }
            }
            index += 1;
        }
        let Some(close) = close else { break };
        let args = &code[open + 1..close];
        for (key, raw, offset) in key_literals(args) {
            let value = if raw.starts_with('\'') {
                Value::String(raw[1..raw.len() - 1].replace("\\'", "'"))
            } else {
                serde_json::from_str(raw).unwrap_or(Value::String(raw.to_string()))
            };
            let start = open + 1 + offset;
            found.push(json!({
                "key": key,
                "value": value,
                "function": callee.replace('.', "/"),
                "start": start,
                "end": start + raw.len(),
            }));
        }
        search = close;
    }
    found
}

/// Paires `cle: littéral` d’un texte (chaîne entre guillemets ou nombre) : (clé, littéral, position du littéral).
fn key_literals(text: &str) -> Vec<(&str, &str, usize)> {
    let bytes = text.as_bytes();
    let ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$';
    let mut found = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'"' || byte == b'\'' || byte == b'`' {
            // Une chaîne qui n’est pas après `cle:` : la sauter entière.
            index = string_end(bytes, index).unwrap_or(bytes.len());
            continue;
        }
        if !(ident(byte) && !byte.is_ascii_digit()) || (index > 0 && ident(bytes[index - 1])) {
            index += 1;
            continue;
        }
        let key_start = index;
        while index < bytes.len() && ident(bytes[index]) {
            index += 1;
        }
        let key = &text[key_start..index];
        let mut cursor = index;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b':') {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let literal_start = cursor;
        let literal_end = match bytes.get(cursor) {
            Some(b'"') | Some(b'\'') => string_end(bytes, cursor),
            Some(digit) if digit.is_ascii_digit() || *digit == b'-' => {
                let mut end = cursor + 1;
                while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
                    end += 1;
                }
                // Un nombre suivi d’un nom (`3px`, `-x`) n’est pas une valeur seule.
                (end > cursor + usize::from(bytes[cursor] == b'-') && !bytes.get(end).is_some_and(|next| ident(*next))).then_some(end)
            }
            _ => None,
        };
        if let Some(end) = literal_end {
            found.push((key, &text[literal_start..end], literal_start));
            index = end;
        }
    }
    found
}

/// Fin (exclue) de la chaîne qui commence à `start`.
fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let quote = bytes[start];
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index += 2;
            continue;
        }
        if bytes[index] == quote {
            return Some(index + 1);
        }
        index += 1;
    }
    None
}

/// Remplace des valeurs littérales du code par `input.<paramètre>` (Réglages, « Garder ») ; `at` : position
/// rendue par `literals`.
fn parametrize(code: &str, replacements: &[(usize, String)]) -> AppResult<String> {
    let spots: Vec<Value> = literals(code);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for (at, id) in replacements {
        let spot = spots
            .iter()
            .find(|spot| spot["start"].as_u64() == Some(*at as u64))
            .ok_or_else(|| AppError::new("Valeur introuvable dans le code : relire le détail de l’exécution."))?;
        edits.push((*at, spot["end"].as_u64().unwrap_or_default() as usize, format!("input.{id}")));
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0));
    let mut code = code.to_string();
    for (start, end, text) in edits {
        code.replace_range(start..end, &text);
    }
    Ok(code)
}

/// Vérifie les paramètres : identifiant, description, valeur par défaut, et le code s’en sert.
fn check_params(params: &[ScriptParam], code: &str) -> AppResult<()> {
    for param in params {
        if crate::code_mode::ident(&param.id) != param.id || param.id.is_empty() {
            return Err(AppError::new(format!("Paramètre « {} » : un identifiant JavaScript (lettres, chiffres, _).", param.id)));
        }
        if param.description.trim().is_empty() {
            return Err(AppError::new(format!("Paramètre « {} » sans description : dire ce qu’il choisit, en mots de l’utilisateur.", param.id)));
        }
        if param.default.is_null() {
            return Err(AppError::new(format!("Paramètre « {} » sans valeur par défaut (`default`).", param.id)));
        }
        if !code.contains(&format!("input.{}", param.id)) && !code.contains(&format!("input?.{}", param.id)) {
            return Err(AppError::new(format!("Le code ne lit pas `input.{}` : remplacer la valeur en dur par ce paramètre.", param.id)));
        }
    }
    Ok(())
}

/// Paramètres décrits d’une déclaration : les propriétés d’entrée qui ont une valeur par défaut.
fn declared_params(input: &Value) -> Vec<ScriptParam> {
    input["properties"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, schema)| schema.get("default").is_some())
        .map(|(id, schema)| ScriptParam {
            id: id.clone(),
            description: schema["description"].as_str().unwrap_or_default().to_string(),
            default: schema["default"].clone(),
            example: schema["examples"].get(0).cloned(),
        })
        .collect()
}

/// Schéma d’entrée : les paramètres (facultatifs, décrits, avec défaut et exemple), puis les champs de l’entrée de
/// l’exécution qui n’en sont pas (obligatoires).
fn input_schema(params: &[ScriptParam], run_input: &Value) -> Value {
    let mut schema = schema_of(run_input, 4);
    if schema.get("type").is_none() {
        schema = json!({ "type": "object" });
    }
    let mut properties = schema["properties"].as_object().cloned().unwrap_or_default();
    let mut required: Vec<Value> = schema["required"].as_array().cloned().unwrap_or_default();
    for param in params {
        let mut property = shape_of(param.example.as_ref().unwrap_or(&param.default), 3, false);
        property["description"] = json!(param.description);
        property["default"] = param.default.clone();
        if let Some(example) = &param.example {
            property["examples"] = json!([example]);
        }
        properties.insert(param.id.clone(), property);
        required.retain(|field| field.as_str() != Some(param.id.as_str()));
    }
    schema["type"] = json!("object");
    schema["properties"] = Value::Object(properties);
    if required.is_empty() {
        schema.as_object_mut().map(|object| object.remove("required"));
    } else {
        schema["required"] = Value::Array(required);
    }
    schema
}

/// Problème de `check` pour un script gardé : un paramètre sans description.
pub fn param_problem(state: &AppState, space: &Space, function: &crate::space::ResolvedFunction) -> Option<String> {
    status_of(state, space, &function.reference)?;
    let missing: Vec<&String> = function.input["properties"]
        .as_object()?
        .iter()
        .filter(|(_, schema)| schema["description"].as_str().is_none_or(|text| text.trim().is_empty()))
        .map(|(id, _)| id)
        .collect();
    (!missing.is_empty()).then(|| {
        format!(
            "Script gardé : paramètre(s) sans description ({}). Le regarder avec `alfred run --again <id> --save {} --params '[{{\"id\":…,\"description\":…,\"default\":…,\"example\":…}}]'`.",
            missing.iter().map(|id| id.as_str()).collect::<Vec<_>>().join(", "),
            function.reference
        )
    })
}

#[cfg(test)]
pub static TEST_OLD_TESTS: std::sync::Mutex<Option<bool>> = std::sync::Mutex::new(None);

/// Après une mise à jour, les anciens tests de lecture doivent passer : rend les échecs.
async fn old_tests_failures(state: &Arc<AppState>, reference: &str, tests: &[crate::space::FunctionTest]) -> AppResult<Vec<String>> {
    #[cfg(test)]
    if let Some(pass) = *TEST_OLD_TESTS.lock().unwrap() {
        return Ok(if pass { Vec::new() } else { tests.iter().map(|test| format!("{} : échec simulé", test.name)).collect() });
    }
    let mut failures = Vec::new();
    for test in tests {
        let outcome = crate::function_tests::run(state, reference, &test.name, false, None).await?;
        if outcome["status"] == json!("failed") {
            failures.push(format!("{} : {}", test.name, outcome["message"].as_str().unwrap_or_default()));
        }
    }
    Ok(failures)
}

/// Crée (au besoin) le module personnel des scripts.
fn personal_module(space: &Space) -> AppResult<ModuleManifest> {
    if let Ok(manifest) = space.module(PERSONAL_MODULE) {
        return Ok(manifest);
    }
    let manifest = ModuleManifest {
        id: PERSONAL_MODULE.into(),
        name: "Mes scripts".into(),
        description: "Scripts gardés par l’agent, qui lisent plusieurs modules.".into(),
        ..Default::default()
    };
    space.write_module(&manifest)?;
    Ok(manifest)
}

/// `alfred run --save module/nom` : la fonction est écrite, déclarée et mise « à valider ».
pub async fn save(state: &Arc<AppState>, conversation: &str, target: &str, options: KeepOptions, run: &StoredRun) -> AppResult<Value> {
    keep(state, conversation, target, options, run, false).await
}

/// Écrit et déclare la fonction tirée de `run`. Gardée par l’agent, elle attend l’accord ; gardée par
/// l’utilisateur (Réglages → Scripts de l’agent), elle est acceptée aussitôt : c’est lui qui la garde.
///
/// Un nom déjà gardé : la fonction est mise à jour (nouvelle version). Ses paramètres décrits restent, un nouveau
/// paramètre a une valeur par défaut, ses anciens tests restent et doivent passer, un test s’ajoute pour la
/// nouvelle entrée. Un autre nom, proche d’un script gardé (mêmes appels, code voisin) : refusé sans `--new`.
async fn keep(state: &Arc<AppState>, conversation: &str, target: &str, options: KeepOptions, run: &StoredRun, by_user: bool) -> AppResult<Value> {
    if !run.ok {
        return Err(AppError::new("Seule une exécution réussie se garde : corriger le code, le relancer, puis le garder."));
    }
    if !by_user && crate::agent_tools::scope_of(state, conversation).is_some() {
        return Err(AppError::new("Une conversation lancée par une page ne crée pas de fonction."));
    }
    let space = state.space()?;
    let (module, id) = match target.split_once('/') {
        Some((module, id)) => (module.to_string(), id.to_string()),
        None => (home_module(&run.calls), target.to_string()),
    };
    if !crate::space::valid_id(&module) || !crate::space::valid_id(&id) {
        return Err(AppError::new("Nom invalide : « module/nom », minuscules, chiffres et tirets."));
    }
    let manifest = if module == PERSONAL_MODULE { personal_module(&space)? } else { space.module(&module)? };
    if manifest.read_only() {
        return Err(AppError::new(format!(
            "Le module « {} » vient d’un marketplace : garder le script dans « {PERSONAL_MODULE}/{id} ».",
            manifest.name
        )));
    }
    let reference = format!("{module}/{id}");
    let previous = manifest.functions.iter().find(|declared| declared.id == id).cloned();
    if previous.is_some() && status_of(state, &space, &reference).is_none() {
        return Err(AppError::new(format!("« {reference} » existe déjà et n’est pas un script gardé : choisir un autre nom.")));
    }
    let called: Vec<String> = run.calls.iter().filter(|call| !call.starts_with("état ")).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    // Un script proche d’un autre déjà gardé : le généraliser plutôt que d’en garder un presque pareil.
    if previous.is_none() && !options.new {
        if let Some(close) = close_script(state, &space, &called, &run.code, &reference) {
            let message = if by_user {
                format!("Proche de « {close} » (mêmes appels, code voisin). Pour le mettre à jour, gardez celui-ci sous le même module et le même nom, avec un paramètre à la place de la valeur qui change. Sinon, gardez-le à part.")
            } else {
                format!("Proche de « {close} » (mêmes appels, code voisin) : généralise « {close} » avec un paramètre `input` (valeur en dur → paramètre avec défaut), puis garde-le sous le même nom (`--save {close} --params …`). `--new` pour garder quand même un script à part.")
            };
            return Err(AppError::with_detail(message, json!({ "close": close })));
        }
    }
    // Paramètres : ceux déjà décrits restent (le nouvel appel les redécrit s’il veut), puis ceux de cet appel.
    let mut params: Vec<ScriptParam> = previous.as_ref().map(|declared| declared_params(&declared.input)).unwrap_or_default();
    params.retain(|old| !options.params.iter().any(|new| new.id == old.id));
    params.retain(|old| run.code.contains(&format!("input.{}", old.id)) || run.code.contains(&format!("input?.{}", old.id)));
    params.extend(options.params.iter().cloned());
    check_params(&params, &run.code)?;
    let input = input_schema(&params, &run.input);
    // Nouvelle version : un champ obligatoire qui n’existait pas casserait les anciens appels.
    if let Some(previous) = &previous {
        let before = previous.input["properties"].as_object().cloned().unwrap_or_default();
        let new_required: Vec<&str> = input["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|field| !before.contains_key(*field))
            .collect();
        if !new_required.is_empty() {
            return Err(AppError::new(format!(
                "Nouveau champ d’entrée sans valeur par défaut ({}) : les anciens appels (pages, automatisations) échoueraient. Le déclarer en paramètre avec `--params` et un `default`.",
                new_required.join(", ")
            )));
        }
    }
    // Fonctions appelées pendant l’exécution, et celles des modules que le code nomme.
    let snapshot = space.snapshot()?;
    let named: Vec<&crate::space::ResolvedFunction> = snapshot
        .functions
        .iter()
        // Les fonctions appelées, les lectures des modules que le code nomme, et les écritures qu’il nomme.
        .filter(|function| {
            let module = format!("api.{}.", crate::code_mode::ident(&function.module));
            called.contains(&function.reference)
                || (function.effect == Some(crate::space::Effect::Read) && run.code.contains(&module))
                || run.code.contains(&format!("{module}{}(", crate::code_mode::ident(&function.id)))
        })
        .collect();
    let writes = named.iter().any(|function| function.effect != Some(crate::space::Effect::Read));
    let mapped: Vec<(String, String, String)> =
        named.iter().map(|function| (function.module.clone(), function.id.clone(), function.reference.clone())).collect();
    let result = run.output.get("result").cloned().unwrap_or(Value::Null);
    let description = options
        .description
        .clone()
        .filter(|text| !text.trim().is_empty())
        .or_else(|| previous.as_ref().map(|declared| declared.description.clone()).filter(|text| !text.is_empty()))
        .unwrap_or_else(|| format!("Script gardé par l’agent : {} {}.", if writes { "appelle" } else { "lit" }, if called.is_empty() { "des données".to_string() } else { called.join(", ") }));
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    // Les anciens tests restent ; un test s’ajoute pour l’entrée de cette exécution, s’il n’y en a pas déjà un.
    let old_tests: Vec<crate::space::FunctionTest> = previous.as_ref().map(|declared| declared.tests.clone()).unwrap_or_default();
    let mut tests: Vec<Value> = old_tests.iter().map(|test| serde_json::to_value(test).unwrap_or(Value::Null)).collect();
    if !old_tests.iter().any(|test| test.input == run.input) {
        let mut name = format!("Exécution du {date}");
        let mut index = 2;
        while old_tests.iter().any(|test| test.name == name) {
            name = format!("Exécution du {date} ({index})");
            index += 1;
        }
        tests.push(json!({ "name": name, "input": run.input, "expect": { "schema": true } }));
    }
    // Un test pour les nouveaux paramètres : leur exemple (sinon leur défaut) à la place de la valeur en dur.
    let before: Vec<String> = previous.as_ref().map(|declared| declared_params(&declared.input).into_iter().map(|param| param.id).collect()).unwrap_or_default();
    let fresh: Vec<&ScriptParam> = params.iter().filter(|param| !before.contains(&param.id)).collect();
    if !fresh.is_empty() {
        let mut input = if run.input.is_object() { run.input.clone() } else { json!({}) };
        for param in &fresh {
            input[param.id.as_str()] = param.example.clone().unwrap_or_else(|| param.default.clone());
        }
        let ids: Vec<&str> = fresh.iter().map(|param| param.id.as_str()).collect();
        let name = format!("Paramètre{} {} ({date})", if ids.len() > 1 { "s" } else { "" }, ids.join(", "));
        if !old_tests.iter().any(|test| test.name == name) {
            tests.push(json!({ "name": name, "input": input, "expect": { "schema": true } }));
        }
    }
    let file = space.function_file(&module, &id);
    let backup = (std::fs::read(&file).ok(), space.module(&module).ok());
    let declared = crate::functions::handle(
        state,
        "functions.declare",
        &json!({
            "module": module,
            "id": id,
            "description": description,
            "input": input,
            "output": shape_of(&result, 3, false),
            "effect": if writes { "write" } else { "read" },
            "uses": { "functions": called },
            "tests": tests,
        }),
    )
    .await
    .unwrap_or_else(|| Err(AppError::new("Déclaration impossible.")))?;
    let file = declared["file"].as_str().map(std::path::PathBuf::from).unwrap_or(file);
    std::fs::write(&file, function_source(&run.code, &mapped, &date, writes, &params))?;
    // Nouvelle version : les anciens tests de lecture doivent passer, sinon l’ancienne version revient.
    if previous.is_some() && !writes {
        let failures = old_tests_failures(state, &reference, &old_tests).await?;
        if !failures.is_empty() {
            if let (Some(bytes), Some(manifest)) = backup {
                std::fs::write(&file, bytes)?;
                space.write_module(&manifest)?;
            }
            state.emit("space:changed", Value::Null);
            return Err(AppError::with_detail(
                format!("La nouvelle version de « {reference} » casse ses anciens tests : l’ancienne version est gardée. Garder le comportement d’avant quand le nouveau paramètre prend sa valeur par défaut."),
                json!({ "failed": failures }),
            ));
        }
    }
    // Un autre module appelé : une dépendance déclarée, qui accorde ses fonctions.
    let mut manifest = space.module(&module)?;
    let mut added = Vec::new();
    for other in called.iter().filter_map(|reference| reference.split_once('/').map(|(owner, _)| owner.to_string())) {
        if other != module && !manifest.requires_module(&other) && !added.contains(&other) {
            manifest.requires.push(crate::space::Requirement { module: other.clone(), min_version: None });
            added.push(other);
        }
    }
    if !added.is_empty() {
        space.write_module(&manifest)?;
    }
    {
        let db = lock_db(state)?;
        db.execute(
            "INSERT INTO kept_functions (space, reference, conversation, created_at, accepted) VALUES (?1, ?2, ?3, ?4, NULL)
             ON CONFLICT (space, reference) DO UPDATE SET accepted = NULL, conversation = excluded.conversation",
            params![space_key(&space), reference, conversation, now()],
        )?;
    }
    if by_user {
        crate::git::commit_all(&space.root, &format!("Script gardé par l’utilisateur : {reference}"))?;
        accept(state, &space, &reference)?;
        return Ok(json!({ "function": reference, "file": file.to_string_lossy(), "status": "accepted", "requires": added, "updated": previous.is_some() }));
    }
    crate::git::commit_all(&space.root, &format!("Script gardé par l’agent : {reference} (à valider)"))?;
    let title = format!("Fonction « {reference} » à valider");
    crate::functions::journal(state, "agent", &reference, true, None, &title, Some(&json!({ "run": run.id })));
    state.emit(
        "agent:notice",
        json!({ "title": title, "description": "Elle ne tournera qu’après votre accord, dans Réglages → Scripts de l’agent." }),
    );
    state.emit("space:changed", Value::Null);
    Ok(json!({
        "function": reference,
        "file": file.to_string_lossy(),
        "status": "toValidate",
        "requires": added,
        "next": "Dis à l’utilisateur que la fonction l’attend dans Réglages → Scripts de l’agent (« Accepter ») : elle ne tourne qu’après son accord. Ensuite, une page ou une automatisation peut l’appeler, et elle apparaît dans `alfred api`.",
    }))
}

// --- Accord --------------------------------------------------------------------------------------------------

/// Empreinte de ce que l’utilisateur accepte : la déclaration et le fichier de la fonction.
fn fingerprint(space: &Space, reference: &str) -> String {
    let Some((module, id)) = reference.split_once('/') else { return "absent".into() };
    let declaration: Option<FunctionDecl> =
        space.module(module).ok().and_then(|manifest| manifest.functions.into_iter().find(|declared| declared.id == id));
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(&declaration).unwrap_or_default());
    match std::fs::read(space.function_file(module, id)) {
        Ok(bytes) => hasher.update(&bytes),
        Err(_) => hasher.update(b"absent"),
    }
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// État d’un script gardé : `toValidate` ou `accepted` ; `None` pour une fonction ordinaire.
pub fn status_of(state: &AppState, space: &Space, reference: &str) -> Option<&'static str> {
    let db = lock_db(state).ok()?;
    let accepted: Option<Option<String>> = db
        .query_row(
            "SELECT accepted FROM kept_functions WHERE space = ?1 AND reference = ?2",
            params![space_key(space), reference],
            |row| row.get(0),
        )
        .optional()
        .ok()?;
    drop(db);
    let accepted = accepted?;
    Some(if accepted.as_deref() == Some(fingerprint(space, reference).as_str()) { "accepted" } else { "toValidate" })
}

/// Un script gardé ne tourne qu’accepté dans son état actuel ; seule la vérification (`check`) le lance avant.
pub fn ensure_runnable(state: &AppState, reference: &str, caller: &str) -> AppResult<()> {
    let Ok(space) = state.space() else { return Ok(()) };
    if caller != crate::function_tests::CALLER && status_of(state, &space, reference) == Some("toValidate") {
        return Err(AppError::new(format!(
            "La fonction « {reference} » est un script gardé par l’agent : elle attend l’accord de l’utilisateur (Réglages → Scripts de l’agent)."
        )));
    }
    Ok(())
}

/// Vue de l’espace pour l’interface : l’état de chaque script gardé.
pub fn annotate(state: &AppState, space: &Space, snapshot: &mut Snapshot) {
    for function in &mut snapshot.functions {
        function.kept = status_of(state, space, &function.reference).map(str::to_string);
    }
}

/// L’utilisateur accepte le script dans son état actuel.
fn accept(state: &AppState, space: &Space, reference: &str) -> AppResult<()> {
    if status_of(state, space, reference).is_none() {
        return Err(AppError::new("Cette fonction n’est pas un script gardé."));
    }
    let print = fingerprint(space, reference);
    lock_db(state)?.execute(
        "UPDATE kept_functions SET accepted = ?1 WHERE space = ?2 AND reference = ?3",
        params![print, space_key(space), reference],
    )?;
    crate::functions::journal(
        state,
        "function",
        reference,
        true,
        None,
        "Script gardé accepté par l’utilisateur",
        None,
    );
    state.emit("space:changed", Value::Null);
    Ok(())
}

/// Une exécution, pour la liste des Réglages : sans le code ni la sortie, lus à l’ouverture du détail.
fn run_summary(run: &StoredRun) -> Value {
    json!({ "id": run.id, "at": run.at, "conversation": run.conversation, "ok": run.ok, "calls": run.calls, "ms": run.ms })
}

/// Modules où l’utilisateur peut garder un script : ceux qu’il peut modifier, et le module personnel.
fn writable_modules(space: &Space) -> AppResult<Vec<Value>> {
    let mut modules: Vec<Value> = space
        .module_ids()
        .into_iter()
        .filter_map(|id| space.module(&id).ok())
        .filter(|manifest| !manifest.read_only() && manifest.id != PERSONAL_MODULE)
        .map(|manifest| json!({ "id": manifest.id, "name": manifest.name }))
        .collect();
    modules.push(json!({ "id": PERSONAL_MODULE, "name": "Mes scripts" }));
    Ok(modules)
}

/// Scripts gardés de l’espace ouvert : référence, état, description, entrée de leur premier test.
fn kept_list(state: &AppState, space: &Space) -> AppResult<Vec<Value>> {
    let rows: Vec<(String, String, String)> = {
        let db = lock_db(state)?;
        let mut statement = db.prepare(
            "SELECT reference, conversation, created_at FROM kept_functions WHERE space = ?1 ORDER BY created_at DESC",
        )?;
        let rows = statement
            .query_map(params![space_key(space)], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        rows
    };
    let mut kept = Vec::new();
    for (reference, conversation, created_at) in rows {
        let Some((module, id)) = reference.split_once('/') else {
            continue;
        };
        // Une fonction retirée hors d’Alfred (fichier ou déclaration effacés) n’est plus listée.
        let Ok(manifest) = space.module(module) else {
            continue;
        };
        let Some(declared) = manifest.functions.iter().find(|declared| declared.id == id) else {
            continue;
        };
        kept.push(json!({
            "reference": reference,
            "module": module,
            "moduleName": manifest.name,
            "id": id,
            "description": declared.description,
            "effect": if declared.effect == Some(crate::space::Effect::Read) { "read" } else { "write" },
            "status": status_of(state, space, &reference).unwrap_or("toValidate"),
            "conversation": conversation,
            "createdAt": created_at,
            "input": declared.tests.first().map(|test| test.input.clone()).unwrap_or_else(|| json!({})),
        }));
    }
    Ok(kept)
}

/// Commandes de la coquille : `functions.acceptKept` (fiche du module) et `scripts.*` (Réglages → Scripts de
/// l’agent : exécutions gardées, détail, « Garder », scripts gardés, « Retirer »).
pub async fn handle(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Option<AppResult<Value>> {
    match command {
        "functions.acceptKept" => Some((|| {
            let reference: String = arg(args, "reference")?;
            accept(state, &state.space()?, &reference)?;
            Ok(json!({ "reference": reference, "status": "accepted" }))
        })()),
        "scripts.list" => Some((|| {
            let space = state.space()?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(500) as i64;
            let runs: Vec<StoredRun> = {
                let db = lock_db(state)?;
                let mut statement = db.prepare(&format!(
                    "SELECT {COLUMNS} FROM agent_runs WHERE space = ?1 ORDER BY at DESC LIMIT ?2"
                ))?;
                let runs = statement
                    .query_map(params![space_key(&space), limit], from_row)?
                    .collect::<Result<_, _>>()?;
                runs
            };
            Ok(json!({
                "runs": runs.iter().map(run_summary).collect::<Vec<_>>(),
                "kept": kept_list(state, &space)?,
                "keepDays": KEEP_DAYS,
            }))
        })()),
        "scripts.run" => Some((|| {
            let id: String = arg(args, "id")?;
            let run = load(state, &id)?;
            let mut value = run_summary(&run);
            value["literals"] = json!(literals(&run.code));
            value["code"] = json!(run.code);
            value["input"] = run.input.clone();
            value["output"] = run.output.clone();
            value["home"] = json!(home_module(&run.calls));
            value["modules"] = json!(writable_modules(&state.space()?)?);
            Ok(value)
        })()),
        "scripts.keep" => {
            let outcome = async {
                let id: String = arg(args, "id")?;
                let module: String = arg(args, "module")?;
                let name: String = arg(args, "name")?;
                let description: Option<String> = args
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let mut run = load(state, &id)?;
                // Valeurs en dur choisies comme paramètres : `input.<id>` dans le code, la valeur devient le défaut.
                let mut params = Vec::new();
                let mut replacements = Vec::new();
                for chosen in args.get("params").and_then(Value::as_array).into_iter().flatten() {
                    let param: ScriptParam = serde_json::from_value(chosen.clone())
                        .map_err(|_| AppError::new("Paramètre illisible."))?;
                    let at = chosen["at"].as_u64().ok_or_else(|| AppError::new("Paramètre sans position."))?;
                    replacements.push((at as usize, param.id.clone()));
                    params.push(ScriptParam { example: Some(param.default.clone()), ..param });
                }
                run.code = parametrize(&run.code, &replacements)?;
                let conversation = run.conversation.clone();
                let options = KeepOptions { description, params, new: args.get("new").and_then(Value::as_bool).unwrap_or(false) };
                keep(state, &conversation, &format!("{module}/{name}"), options, &run, true).await
            }
            .await;
            Some(outcome)
        }
        "scripts.remove" => {
            let outcome = async {
                let reference: String = arg(args, "reference")?;
                let space = state.space()?;
                if status_of(state, &space, &reference).is_none() {
                    return Err(AppError::new("Cette fonction n’est pas un script gardé."));
                }
                crate::functions::handle(
                    state,
                    "functions.remove",
                    &json!({ "reference": reference }),
                )
                .await
                .unwrap_or_else(|| Err(AppError::new("Suppression impossible.")))?;
                lock_db(state)?.execute(
                    "DELETE FROM kept_functions WHERE space = ?1 AND reference = ?2",
                    params![space_key(&space), reference],
                )?;
                state.emit("space:changed", Value::Null);
                Ok(Value::Null)
            }
            .await;
            Some(outcome)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une exécution réussie devient une fonction de lecture « à valider » : fichier, déclaration, dépendance et
    /// premier test ; elle ne tourne qu’acceptée, et une modification la remet à valider.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kept_script_waits_for_the_user() {
        use crate::space::{FunctionDecl, ModuleManifest};
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        for id in ["notes", "crm"] {
            let mut manifest = ModuleManifest { id: id.into(), name: id.into(), ..Default::default() };
            manifest.functions.push(FunctionDecl { id: "lister".into(), effect: Some(crate::space::Effect::Read), ..Default::default() });
            space.write_module(&manifest).unwrap();
        }
        state.set_space(Some(space.clone()));
        let code = "const a = await api.notes.lister({});\nconst b = await api.crm.lister({});\nreturn { total: a.length + b.length };";
        let calls = vec!["notes/lister".to_string(), "crm/lister".to_string()];
        let input = json!({ "jour": "lundi" });
        let id = record(&state, "conv", code, &input, &Ok(json!({ "result": { "total": 3 } })), &calls, 1200).unwrap();
        assert!(list(&state, 10).unwrap().as_str().unwrap().contains(&id));
        let run = load(&state, &id).unwrap();
        let saved = save(&state, "conv", "total", KeepOptions { description: Some("Total des notes et contacts.".into()), ..Default::default() }, &run).await.unwrap();
        assert_eq!(saved["function"], "mes-scripts/total", "deux modules à parts égales : le module personnel");
        assert_eq!(saved["requires"], json!(["crm", "notes"]));
        let manifest = space.module(PERSONAL_MODULE).unwrap();
        let declared = manifest.functions.iter().find(|function| function.id == "total").unwrap();
        assert_eq!(declared.effect, Some(crate::space::Effect::Read));
        assert_eq!(declared.uses.functions, vec!["crm/lister".to_string(), "notes/lister".to_string()]);
        assert_eq!(declared.tests[0].input, input);
        assert_eq!(declared.input["properties"]["jour"]["type"], "string");
        let file = std::fs::read_to_string(space.function_file(PERSONAL_MODULE, "total")).unwrap();
        assert!(file.contains("functions.call(\"notes/lister\"") && file.contains("return { total"), "{file}");
        assert!(declared.output.get("required").is_none(), "une sortie n’exige aucun champ");
        assert!(crate::transpile::transpile_in(&file, "total.ts", 1, &Default::default()).is_ok(), "le fichier compile");
        assert!(ensure_runnable(&state, "mes-scripts/total", "page").is_err());
        assert!(ensure_runnable(&state, "mes-scripts/total", crate::function_tests::CALLER).is_ok());
        handle(&state, "functions.acceptKept", &json!({ "reference": "mes-scripts/total" })).await.unwrap().unwrap();
        assert!(ensure_runnable(&state, "mes-scripts/total", "page").is_ok());
        std::fs::write(space.function_file(PERSONAL_MODULE, "total"), format!("{file}\n// changé")).unwrap();
        assert_eq!(status_of(&state, &space, "mes-scripts/total"), Some("toValidate"));
        // Un script qui écrit se garde aussi : une écriture, à valider.
        let mut notes = space.module("notes").unwrap();
        notes.functions.push(FunctionDecl { id: "archiver".into(), effect: Some(crate::space::Effect::Write), ..Default::default() });
        space.write_module(&notes).unwrap();
        let writing = "await api.notes.archiver({ id: 1 });\nreturn 1;";
        let id = record(&state, "conv", writing, &json!({}), &Ok(json!({ "result": 1 })), &["notes/archiver".to_string()], 5).unwrap();
        let saved = save(&state, "conv", "notes/archiver-tout", KeepOptions::default(), &load(&state, &id).unwrap()).await.unwrap();
        assert_eq!(saved["status"], "toValidate");
        let declared = space.module("notes").unwrap().functions.into_iter().find(|f| f.id == "archiver-tout").unwrap();
        assert_eq!(declared.effect, Some(crate::space::Effect::Write));
        let file = std::fs::read_to_string(space.function_file("notes", "archiver-tout")).unwrap();
        assert!(file.contains("Il écrit") && file.contains("functions.call(\"notes/archiver\""), "{file}");
        let failed = record(&state, "conv", code, &input, &Err(AppError::new("boum")), &[], 3).unwrap();
        assert!(save(&state, "conv", "x", KeepOptions::default(), &load(&state, &failed).unwrap()).await.is_err());
    }

    /// Réglages → Scripts de l’agent : la liste (durée comprise), le détail, « Garder » (acceptée aussitôt, puisque
    /// l’utilisateur la garde lui-même), puis « Retirer ».
    #[tokio::test(flavor = "multi_thread")]
    async fn the_user_keeps_and_removes_a_script() {
        use crate::space::{FunctionDecl, ModuleManifest};
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        let mut manifest = ModuleManifest {
            id: "notes".into(),
            name: "Notes".into(),
            ..Default::default()
        };
        manifest.functions.push(FunctionDecl {
            id: "lister".into(),
            effect: Some(crate::space::Effect::Read),
            ..Default::default()
        });
        space.write_module(&manifest).unwrap();
        state.set_space(Some(space.clone()));
        let code = "const a = await api.notes.lister({});\nreturn { total: a.length };";
        let input = json!({ "jour": "lundi" });
        let id = record(
            &state,
            "conv",
            code,
            &input,
            &Ok(json!({ "result": { "total": 2 } })),
            &["notes/lister".into()],
            840,
        )
        .unwrap();
        let failed = record(
            &state,
            "conv",
            code,
            &input,
            &Err(AppError::new("boum")),
            &[],
            12,
        )
        .unwrap();
        let call = |command: &'static str, args: Value| {
            let state = state.clone();
            async move { handle(&state, command, &args).await.unwrap() }
        };
        let listed = call("scripts.list", json!({})).await.unwrap();
        assert_eq!(listed["runs"].as_array().unwrap().len(), 2);
        assert_eq!(listed["runs"][1]["ms"], 840);
        assert_eq!(listed["runs"][1]["calls"], json!(["notes/lister"]));
        assert!(
            listed["runs"][1].get("code").is_none(),
            "le code se lit au détail"
        );
        let detail = call("scripts.run", json!({ "id": id })).await.unwrap();
        assert_eq!(detail["code"], code);
        assert_eq!(detail["output"]["result"]["total"], 2);
        assert_eq!(detail["home"], "notes");
        assert!(detail["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|module| module["id"] == "notes"));
        assert!(call(
            "scripts.keep",
            json!({ "id": failed, "module": "notes", "name": "x" })
        )
        .await
        .is_err());
        let kept = call(
            "scripts.keep",
            json!({ "id": id, "module": "notes", "name": "total", "description": "Total." }),
        )
        .await
        .unwrap();
        assert_eq!(
            kept["status"], "accepted",
            "gardée par l’utilisateur : acceptée aussitôt"
        );
        assert!(ensure_runnable(&state, "notes/total", "page").is_ok());
        let listed = call("scripts.list", json!({})).await.unwrap();
        let item = &listed["kept"][0];
        assert_eq!(
            (item["reference"].as_str(), item["status"].as_str()),
            (Some("notes/total"), Some("accepted"))
        );
        assert_eq!(item["input"], input);
        assert_eq!(item["description"], "Total.");
        assert!(
            call("scripts.remove", json!({ "reference": "notes/lister" }))
                .await
                .is_err(),
            "pas un script gardé"
        );
        call("scripts.remove", json!({ "reference": "notes/total" }))
            .await
            .unwrap();
        assert!(space
            .module("notes")
            .unwrap()
            .functions
            .iter()
            .all(|function| function.id != "total"));
        assert!(!space.function_file("notes", "total").exists());
        assert_eq!(
            call("scripts.list", json!({})).await.unwrap()["kept"],
            json!([])
        );
    }

    /// Un script presque pareil à un script gardé est refusé ; on généralise le premier avec un paramètre (défaut,
    /// description, exemple) : les anciens tests restent et doivent passer, un test s’ajoute pour le paramètre.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_close_script_is_generalized_instead_of_duplicated() {
        use crate::space::{FunctionDecl, ModuleManifest};
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        let mut manifest = ModuleManifest { id: "notes".into(), name: "Notes".into(), ..Default::default() };
        manifest.functions.push(FunctionDecl { id: "lister".into(), effect: Some(crate::space::Effect::Read), ..Default::default() });
        space.write_module(&manifest).unwrap();
        state.set_space(Some(space.clone()));
        let calls = vec!["notes/lister".to_string()];
        let ran = |code: &str, input: Value| {
            let id = record(&state, "conv", code, &input, &Ok(json!({ "result": 2 })), &calls, 10).unwrap();
            load(&state, &id).unwrap()
        };
        let data = "const t = await api.notes.lister({ equipe: \"Data\", limite: 5 });\nreturn t.length;";
        save(&state, "conv", "notes/par-equipe", KeepOptions::default(), &ran(data, json!({}))).await.unwrap();
        // Presque pareil (autre équipe, autre limite) : refusé, avec le nom du script à généraliser.
        let ventes = ran(&data.replace("Data", "Ventes").replace('5', "8"), json!({}));
        let error = save(&state, "conv", "notes/par-equipe-ventes", KeepOptions::default(), &ventes).await.unwrap_err();
        assert!(error.message.contains("Proche de « notes/par-equipe »"), "{}", error.message);
        assert_eq!(error.detail.unwrap()["close"], "notes/par-equipe");
        let forced = save(&state, "conv", "notes/a-part", KeepOptions { new: true, ..Default::default() }, &ventes).await;
        assert!(forced.is_ok(), "--new garde un script à part");
        // Un paramètre sans description, ou que le code ne lit pas, est refusé.
        let general = ran("const t = await api.notes.lister({ equipe: input.equipe, limite: 5 });\nreturn t.length;", json!({}));
        let param = |description: &str| ScriptParam { id: "equipe".into(), description: description.into(), default: json!("Data"), example: Some(json!("Ventes")) };
        let missing = save(&state, "conv", "notes/par-equipe", KeepOptions { params: vec![param("")], ..Default::default() }, &general).await;
        assert!(missing.unwrap_err().message.contains("sans description"));
        let unused = save(&state, "conv", "notes/par-equipe", KeepOptions { params: vec![param("Équipe")], ..Default::default() }, &ran(data, json!({}))).await;
        assert!(unused.unwrap_err().message.contains("input.equipe"));
        // Les anciens tests échouent : l’ancienne version reste.
        *TEST_OLD_TESTS.lock().unwrap() = Some(false);
        let broken = save(&state, "conv", "notes/par-equipe", KeepOptions { params: vec![param("Équipe suivie")], ..Default::default() }, &general).await;
        assert!(broken.unwrap_err().message.contains("casse ses anciens tests"));
        let declared = |id: &str| space.module("notes").unwrap().functions.into_iter().find(|f| f.id == id).unwrap();
        assert!(declared("par-equipe").input["properties"].get("equipe").is_none(), "ancienne version gardée");
        assert!(std::fs::read_to_string(space.function_file("notes", "par-equipe")).unwrap().contains("\"Data\""));
        // Ils passent : nouvelle version, paramètre décrit avec défaut, ancien test gardé, test du paramètre ajouté.
        *TEST_OLD_TESTS.lock().unwrap() = Some(true);
        save(&state, "conv", "notes/par-equipe", KeepOptions { params: vec![param("Équipe suivie")], ..Default::default() }, &general).await.unwrap();
        *TEST_OLD_TESTS.lock().unwrap() = None;
        let function = declared("par-equipe");
        assert_eq!(function.input["properties"]["equipe"]["default"], "Data");
        assert_eq!(function.input["properties"]["equipe"]["description"], "Équipe suivie");
        assert_eq!(function.input["properties"]["equipe"]["examples"], json!(["Ventes"]));
        assert!(function.input.get("required").is_none());
        assert_eq!(function.tests.len(), 2, "{:?}", function.tests);
        assert_eq!(function.tests[1].input, json!({ "equipe": "Ventes" }));
        let file = std::fs::read_to_string(space.function_file("notes", "par-equipe")).unwrap();
        assert!(file.contains("input = { ...{\"equipe\":\"Data\"}, ...(input ?? {}) };"), "{file}");
        assert!(crate::transpile::transpile_in(&file, "f.ts", 1, &Default::default()).is_ok());
        assert_eq!(kept_body(&file).unwrap(), "const t = await api.notes.lister({ equipe: input.equipe, limite: 5 });\nreturn t.length;");
        // Un nouveau champ obligatoire casserait les anciens appels.
        let limited = ran("const t = await api.notes.lister({ equipe: input.equipe, limite: input.limite });\nreturn t.length;", json!({ "limite": 3 }));
        let error = save(&state, "conv", "notes/par-equipe", KeepOptions::default(), &limited).await.unwrap_err();
        assert!(error.message.contains("Nouveau champ d’entrée sans valeur par défaut (limite)"), "{}", error.message);
        // `check` : un paramètre de script gardé sans description est un problème.
        let snapshot = space.snapshot().unwrap();
        let resolved = |reference: &str| snapshot.functions.iter().find(|f| f.reference == reference).unwrap().clone();
        assert!(param_problem(&state, &space, &resolved("notes/par-equipe")).is_none());
        let undocumented = ran("return input.jour;", json!({ "jour": "lundi" }));
        save(&state, "conv", "notes/jour", KeepOptions { new: true, ..Default::default() }, &undocumented).await.unwrap();
        let snapshot = space.snapshot().unwrap();
        let jour = snapshot.functions.iter().find(|f| f.reference == "notes/jour").unwrap();
        assert!(param_problem(&state, &space, jour).unwrap().contains("(jour)"));
    }

    /// Réglages, « Garder » : les valeurs en dur passées aux fonctions, et leur remplacement par `input.<id>`.
    #[tokio::test(flavor = "multi_thread")]
    async fn literal_values_become_parameters() {
        let code = "const a = await api.notes.lister({ equipe: \"Data\", limite: 5, x: y });\nconst b = await api.call(\"crm/clients\", { pays: 'FR' });\nconst c = { pas: \"ici\" };";
        let found = literals(code);
        let keys: Vec<&str> = found.iter().map(|spot| spot["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["equipe", "limite", "pays"]);
        assert_eq!(found[0]["function"], "notes/lister");
        assert_eq!(found[1]["value"], 5);
        assert_eq!(found[2]["value"], "FR");
        let at = |index: usize| found[index]["start"].as_u64().unwrap() as usize;
        let changed = parametrize(code, &[(at(0), "equipe".into()), (at(2), "pays".into())]).unwrap();
        assert!(changed.contains("{ equipe: input.equipe, limite: 5, x: y }") && changed.contains("{ pays: input.pays }"), "{changed}");
        assert!(parametrize(code, &[(3, "x".into())]).is_err());
        assert!(similarity(code, &code.replace("Data", "Ventes")) > 0.99);
        assert!(similarity(code, "return 1;") < 0.5);
    }

    #[test]
    fn a_script_lives_where_most_of_its_calls_go() {
        let calls = |values: &[&str]| values.iter().map(|value| value.to_string()).collect::<Vec<_>>();
        assert_eq!(home_module(&calls(&["notes/a", "notes/b", "crm/c"])), "notes");
        assert_eq!(home_module(&calls(&["notes/a", "crm/c"])), PERSONAL_MODULE);
        assert_eq!(home_module(&[]), PERSONAL_MODULE);
    }

    #[test]
    fn an_example_value_gives_its_schema() {
        let schema = schema_of(&json!({ "projet": "X", "limite": 3, "tags": ["a"] }), 4);
        assert_eq!(schema["properties"]["limite"]["type"], "integer");
        assert_eq!(schema["properties"]["tags"]["items"]["type"], "string");
        assert_eq!(schema["required"].as_array().unwrap().len(), 3);
    }
}
