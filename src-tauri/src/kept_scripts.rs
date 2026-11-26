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

/// Fichier d’une fonction gardée : le code de l’agent, avec la même `api` qu’en Code Mode, branchée sur le SDK.
fn function_source(code: &str, functions: &[(String, String, String)], date: &str, writes: bool) -> String {
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
    let body: String = code.lines().map(|line| if line.is_empty() { String::new() } else { format!("  {line}") }).collect::<Vec<_>>().join("\n");
    format!(
        "// Script gardé par l’agent depuis Code Mode (`alfred run`), le {date}. {}\n\
         // Il ne tourne qu’après l’accord de l’utilisateur (Réglages → Modules) ; toute modification le remet à valider.\n\
         import {{ functions, states }} from \"@alfred/sdk\";\n\n\
         // biome-ignore lint/suspicious/noExplicitAny: même API qu’en Code Mode.\n\
         const api: any = {{\n  call: (reference: string, input?: unknown) => functions.call(reference, input ?? {{}}),\n  \
         states: {{ get: (name: string, options = {{}}) => states.get(name, options) }},\n{api}}};\n\n\
         // biome-ignore lint/suspicious/noExplicitAny: entrée décrite dans module.json.\n\
         export default async function (input: any) {{\n{body}\n}}\n",
        if writes { "Il écrit chez un service." } else { "Il ne fait que lire." }
    )
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
pub async fn save(state: &Arc<AppState>, conversation: &str, target: &str, description: Option<String>, run: &StoredRun) -> AppResult<Value> {
    keep(state, conversation, target, description, run, false).await
}

/// Écrit et déclare la fonction tirée de `run`. Gardée par l’agent, elle attend l’accord ; gardée par
/// l’utilisateur (Réglages → Scripts de l’agent), elle est acceptée aussitôt : c’est lui qui la garde.
async fn keep(state: &Arc<AppState>, conversation: &str, target: &str, description: Option<String>, run: &StoredRun, by_user: bool) -> AppResult<Value> {
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
    let previous = manifest.functions.iter().find(|declared| declared.id == id);
    if previous.is_some() && status_of(state, &space, &reference).is_none() {
        return Err(AppError::new(format!("« {reference} » existe déjà et n’est pas un script gardé : choisir un autre nom.")));
    }
    // Fonctions appelées pendant l’exécution, et celles des modules que le code nomme.
    let snapshot = space.snapshot()?;
    let called: Vec<String> = run.calls.iter().filter(|call| !call.starts_with("état ")).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
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
    let description = description
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| format!("Script gardé par l’agent : {} {}.", if writes { "appelle" } else { "lit" }, if called.is_empty() { "des données".to_string() } else { called.join(", ") }));
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let test = json!({
        "name": format!("Exécution du {date}"),
        "input": run.input,
        "expect": { "schema": true },
    });
    let declared = crate::functions::handle(
        state,
        "functions.declare",
        &json!({
            "module": module,
            "id": id,
            "description": description,
            "input": schema_of(&run.input, 4),
            "output": shape_of(&result, 3, false),
            "effect": if writes { "write" } else { "read" },
            "uses": { "functions": called },
            "tests": [test],
        }),
    )
    .await
    .unwrap_or_else(|| Err(AppError::new("Déclaration impossible.")))?;
    let file = declared["file"].as_str().map(std::path::PathBuf::from).ok_or_else(|| AppError::new("Fichier de la fonction introuvable."))?;
    std::fs::write(&file, function_source(&run.code, &mapped, &date, writes))?;
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
        return Ok(json!({ "function": reference, "file": file.to_string_lossy(), "status": "accepted", "requires": added }));
    }
    crate::git::commit_all(&space.root, &format!("Script gardé par l’agent : {reference} (à valider)"))?;
    let title = format!("Fonction « {reference} » à valider");
    crate::functions::journal(state, "agent", &reference, true, None, &title, Some(&json!({ "run": run.id })));
    state.emit(
        "agent:notice",
        json!({ "title": title, "description": "Elle ne tournera qu’après votre accord, dans Réglages → Modules." }),
    );
    state.emit("space:changed", Value::Null);
    Ok(json!({
        "function": reference,
        "file": file.to_string_lossy(),
        "status": "toValidate",
        "requires": added,
        "next": "Dis à l’utilisateur que la fonction l’attend dans Réglages → Modules (fiche du module, « Accepter ») : elle ne tourne qu’après son accord. Ensuite, une page ou une automatisation peut l’appeler, et elle apparaît dans `alfred api`.",
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
            "La fonction « {reference} » est un script gardé par l’agent : elle attend l’accord de l’utilisateur (Réglages → Modules, fiche du module)."
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
                let run = load(state, &id)?;
                let conversation = run.conversation.clone();
                keep(
                    state,
                    &conversation,
                    &format!("{module}/{name}"),
                    description,
                    &run,
                    true,
                )
                .await
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
        let saved = save(&state, "conv", "total", Some("Total des notes et contacts.".into()), &run).await.unwrap();
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
        let saved = save(&state, "conv", "notes/archiver-tout", None, &load(&state, &id).unwrap()).await.unwrap();
        assert_eq!(saved["status"], "toValidate");
        let declared = space.module("notes").unwrap().functions.into_iter().find(|f| f.id == "archiver-tout").unwrap();
        assert_eq!(declared.effect, Some(crate::space::Effect::Write));
        let file = std::fs::read_to_string(space.function_file("notes", "archiver-tout")).unwrap();
        assert!(file.contains("Il écrit") && file.contains("functions.call(\"notes/archiver\""), "{file}");
        let failed = record(&state, "conv", code, &input, &Err(AppError::new("boum")), &[], 3).unwrap();
        assert!(save(&state, "conv", "x", None, &load(&state, &failed).unwrap()).await.is_err());
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
