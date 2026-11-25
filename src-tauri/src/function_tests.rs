//! Tests des fonctions : chaque fonction déclare des cas (une entrée d’exemple et ce que la sortie doit montrer).
//! Ceux d’une fonction de lecture se lancent d’office ; ceux d’une écriture attendent l’accord de l’utilisateur, sur
//! une cible qu’il choisit. Les résultats sont gardés dans la base d’Alfred avec l’empreinte de la fonction
//! (déclaration et fichier) : une fonction modifiée redevient « à vérifier ».

use std::sync::Arc;
use std::time::Instant;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::app_db;
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{Effect, Expect, FunctionDecl, FunctionTest, ModuleManifest, Space};
use crate::state::AppState;

/// Appelant inscrit au journal pour un test.
pub const CALLER: &str = "vérification";
/// Sortie gardée avec un résultat, pour la montrer à l’utilisateur : au-delà, elle est coupée.
const MAX_OUTPUT: usize = 4000;

fn space_key(space: &Space) -> String {
    space.root.to_string_lossy().to_string()
}

fn tests_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    db.execute(
        "CREATE TABLE IF NOT EXISTS function_tests (space TEXT NOT NULL, function TEXT NOT NULL, test TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, output TEXT NOT NULL, tested_at TEXT NOT NULL, PRIMARY KEY (space, function, test))",
        [],
    )?;
    Ok(db)
}

/// Empreinte de la fonction : sa déclaration et le contenu de son fichier.
pub fn fingerprint(space: &Space, module: &str, declared: &FunctionDecl) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(declared).unwrap_or_default());
    hasher.update([0]);
    hasher.update(std::fs::read(space.function_path(module, declared)).unwrap_or_default());
    format!("{:x}", hasher.finalize())
}

/// Clé d’un test dans sa fonction : son nom, ou sa position s’il n’en a pas.
fn test_key(test: &FunctionTest, index: usize) -> String {
    if test.name.trim().is_empty() {
        format!("#{}", index + 1)
    } else {
        test.name.trim().to_string()
    }
}

pub fn is_read(declared: &FunctionDecl) -> bool {
    declared.effect == Some(Effect::Read)
}

// ---------------------------------------------------------------------------------------------------------------
// Vérification d’une sortie
// ---------------------------------------------------------------------------------------------------------------

/// Valeur au chemin `a.0.b` ; `""` (ou `$`) désigne la valeur elle-même.
pub fn at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim().trim_start_matches('$').trim_start_matches('.');
    if path.is_empty() {
        return Some(value);
    }
    path.split('.').try_fold(value, |current, piece| match current {
        Value::Object(map) => map.get(piece),
        Value::Array(items) => piece.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    })
}

fn shown(path: &str) -> String {
    if path.trim().trim_start_matches('$').is_empty() {
        "la sortie".to_string()
    } else {
        format!("« {path} »")
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn type_matches(expected: &str, value: &Value) -> bool {
    let actual = type_name(value);
    expected == actual || (expected == "number" && actual == "integer")
}

/// Vérification simple d’un schéma JSON : `type`, `enum`, `const`, `required`, `properties`, `items`. Le reste est
/// ignoré. Chaque écart s’ajoute à `out` avec son chemin.
pub fn schema_errors(schema: &Value, value: &Value, path: &str, out: &mut Vec<String>) {
    let Some(schema) = schema.as_object() else { return };
    if out.len() >= 20 {
        return;
    }
    let place = if path.is_empty() { "la sortie".to_string() } else { format!("« {path} »") };
    let types: Vec<&str> = match schema.get("type") {
        Some(Value::String(kind)) => vec![kind.as_str()],
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    if !types.is_empty() && !types.iter().any(|kind| type_matches(kind, value)) {
        out.push(format!("{place} devrait être de type {}, elle est de type {}.", types.join(" ou "), type_name(value)));
        return;
    }
    if let Some(Value::Array(allowed)) = schema.get("enum") {
        if !allowed.contains(value) {
            out.push(format!("{place} vaut {value}, hors des valeurs permises."));
        }
    }
    if let Some(expected) = schema.get("const") {
        if expected != value {
            out.push(format!("{place} vaut {value} au lieu de {expected}."));
        }
    }
    let join = |key: &str| if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
    if let Value::Object(map) = value {
        for required in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !map.contains_key(required) {
                out.push(format!("« {} » est requis par le schéma de sortie et manque.", join(required)));
            }
        }
        if let Some(Value::Object(properties)) = schema.get("properties") {
            for (key, child) in properties {
                if let Some(inner) = map.get(key) {
                    schema_errors(child, inner, &join(key), out);
                }
            }
        }
    }
    if let (Value::Array(items), Some(item_schema)) = (value, schema.get("items")) {
        // Les premiers éléments suffisent à montrer un écart de forme.
        for (index, item) in items.iter().take(20).enumerate() {
            schema_errors(item_schema, item, &join(&index.to_string()), out);
        }
    }
}

/// Écarts entre la sortie et ce que le test attend.
pub fn evaluate(expect: &Expect, output_schema: &Value, output: &Value) -> Vec<String> {
    let mut failures = Vec::new();
    if expect.schema && output_schema.is_object() {
        schema_errors(output_schema, output, "", &mut failures);
    }
    for path in &expect.has {
        if at_path(output, path).is_none_or(Value::is_null) {
            failures.push(format!("{} est absent.", shown(path)));
        }
    }
    for path in &expect.non_empty {
        let empty = match at_path(output, path) {
            None | Some(Value::Null) => true,
            Some(Value::Array(items)) => items.is_empty(),
            Some(Value::String(text)) => text.trim().is_empty(),
            Some(Value::Object(map)) => map.is_empty(),
            Some(_) => false,
        };
        if empty {
            failures.push(format!("{} est vide.", shown(path)));
        }
    }
    for (path, expected) in &expect.equals {
        match at_path(output, path) {
            Some(actual) if actual == expected => {}
            Some(actual) => failures.push(format!("{} vaut {actual} au lieu de {expected}.", shown(path))),
            None => failures.push(format!("{} est absent (attendu : {expected}).", shown(path))),
        }
    }
    failures
}

/// Place la cible choisie par l’utilisateur au chemin `field` de l’entrée.
fn set_path(input: &mut Value, field: &str, target: Value) {
    let pieces: Vec<&str> = field.split('.').filter(|piece| !piece.is_empty()).collect();
    let mut current = input;
    for (index, piece) in pieces.iter().enumerate() {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let map = current.as_object_mut().expect("objet");
        if index == pieces.len() - 1 {
            map.insert((*piece).to_string(), target);
            return;
        }
        current = map.entry((*piece).to_string()).or_insert_with(|| Value::Object(Map::new()));
    }
}

fn clipped(output: &Value) -> String {
    let text = serde_json::to_string_pretty(output).unwrap_or_default();
    if text.len() <= MAX_OUTPUT {
        return text;
    }
    let mut end = MAX_OUTPUT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (sortie coupée)", &text[..end])
}

// ---------------------------------------------------------------------------------------------------------------
// Exécution et résultats
// ---------------------------------------------------------------------------------------------------------------

struct Located {
    space: Space,
    manifest: ModuleManifest,
    declared: FunctionDecl,
}

fn locate(state: &AppState, reference: &str) -> AppResult<Located> {
    let (module, function) = reference
        .split_once('/')
        .ok_or_else(|| AppError::new(format!("Fonction désignée par « module/fonction » attendue : « {reference} ».")))?;
    let space = state.space()?;
    let manifest = space.module(module)?;
    let declared = manifest
        .functions
        .iter()
        .find(|declared| declared.id == function)
        .cloned()
        .ok_or_else(|| AppError::new(format!("La fonction « {reference} » n’est pas déclarée dans son module.")))?;
    Ok(Located { space, manifest, declared })
}

/// Lance un test. Un test d’écriture n’est lancé qu’avec `approved` ; sinon il est « passé » (`skipped`) et rien
/// n’est gardé. `target` remplace la cible déclarée par le test.
pub async fn run(
    state: &Arc<AppState>,
    reference: &str,
    test: &str,
    approved: bool,
    target: Option<Value>,
) -> AppResult<Value> {
    let Located { space, manifest, declared } = locate(state, reference)?;
    let (index, case) = declared
        .tests
        .iter()
        .enumerate()
        .find(|(index, case)| test_key(case, *index) == test)
        .ok_or_else(|| AppError::new(format!("La fonction « {reference} » n’a pas de test « {test} ».")))?;
    let key = test_key(case, index);
    // Données d’exemple : le test ne joindrait pas le service et ne dirait rien de la fonction.
    if crate::examples::is_on(state, &manifest.id) {
        return Ok(json!({
            "function": reference, "test": key, "status": "skipped",
            "message": "Données d’exemple actives pour ce module : ses tests attendent que vous les quittiez.",
        }));
    }
    let read = is_read(&declared);
    if !read && !approved {
        return Ok(json!({
            "function": reference, "test": key, "status": "skipped",
            "message": "Test d’écriture : il ne se lance qu’avec votre accord, sur une cible de test.",
        }));
    }
    let mut input = if case.input.is_null() { json!({}) } else { case.input.clone() };
    if let Some(declared_target) = &case.target {
        match target.filter(|value| !value.is_null() && value.as_str().is_none_or(|text| !text.trim().is_empty())) {
            Some(value) => set_path(&mut input, &declared_target.field, value),
            None if !read => {
                return Ok(json!({
                    "function": reference, "test": key, "status": "skipped",
                    "message": format!("Indiquez la cible du test : {}.", declared_target.label),
                }));
            }
            None => {}
        }
    }
    let fingerprint = fingerprint(&space, &manifest.id, &declared);
    let started = Instant::now();
    let result = crate::functions::call(state, reference, input, CALLER).await;
    let duration = started.elapsed().as_millis() as u64;
    let (status, message, output) = match result {
        Ok(output) => {
            let failures = evaluate(&case.expect, &declared.output, &output);
            if failures.is_empty() {
                ("passed", "Sortie conforme.".to_string(), output)
            } else {
                ("failed", failures.join(" "), output)
            }
        }
        Err(error) => ("failed", format!("La fonction a échoué : {}", error.message), Value::Null),
    };
    let output_text = if output.is_null() { String::new() } else { clipped(&output) };
    let tested_at = app_db::now();
    {
        let db = tests_db(state)?;
        db.execute(
            "INSERT INTO function_tests (space, function, test, fingerprint, status, message, output, tested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (space, function, test) DO UPDATE SET fingerprint = excluded.fingerprint,
               status = excluded.status, message = excluded.message, output = excluded.output, tested_at = excluded.tested_at",
            params![space_key(&space), reference, key, fingerprint, status, message, output_text, tested_at],
        )?;
    }
    let outcome = json!({
        "function": reference, "test": key, "status": status, "message": message,
        "output": output_text, "durationMs": duration, "testedAt": tested_at,
    });
    state.emit("functions:tested", outcome.clone());
    Ok(outcome)
}

/// Dernier résultat du test, s’il vaut encore pour la fonction telle qu’elle est.
fn last(db: &rusqlite::Connection, space: &str, reference: &str, key: &str, fingerprint: &str) -> Option<Value> {
    let row: Option<(String, String, String, String, String)> = db
        .query_row(
            "SELECT fingerprint, status, message, output, tested_at FROM function_tests WHERE space = ?1 AND function = ?2 AND test = ?3",
            params![space, reference, key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .ok()
        .flatten();
    row.filter(|(stored, ..)| stored == fingerprint)
        .map(|(_, status, message, output, at)| json!({ "status": status, "message": message, "output": output, "testedAt": at }))
}

/// État des tests de chaque fonction (du module `only`, ou de tout l’espace).
///
/// Par fonction : `state` vaut `none` (aucun test), `toVerify` (un test jamais lancé dans l’état actuel de la
/// fonction), `failed`, `partial` (lectures réussies, écritures pas encore lancées) ou `passed`.
pub fn status(state: &AppState, only: Option<&str>) -> AppResult<Value> {
    let space = state.space()?;
    let key = space_key(&space);
    let db = tests_db(state)?;
    let mut functions = Vec::new();
    for id in space.module_ids() {
        if only.is_some_and(|only| only != id) {
            continue;
        }
        let Ok(manifest) = space.module(&id) else { continue };
        for declared in &manifest.functions {
            let reference = format!("{}/{}", manifest.id, declared.id);
            let fingerprint = fingerprint(&space, &manifest.id, declared);
            let read = is_read(declared);
            let tests: Vec<Value> = declared
                .tests
                .iter()
                .enumerate()
                .map(|(index, case)| {
                    let name = test_key(case, index);
                    json!({
                        "name": name,
                        "target": case.target,
                        "result": last(&db, &key, &reference, &name, &fingerprint),
                    })
                })
                .collect();
            let result_of = |test: &Value| test["result"]["status"].as_str().map(str::to_string);
            let failed = tests.iter().filter(|test| result_of(test).as_deref() == Some("failed")).count();
            let passed = tests.iter().filter(|test| result_of(test).as_deref() == Some("passed")).count();
            let pending = tests.len() - failed - passed;
            let state = if tests.is_empty() {
                "none"
            } else if failed > 0 {
                "failed"
            } else if pending == 0 {
                "passed"
            } else if read || passed == 0 {
                "toVerify"
            } else {
                "partial"
            };
            functions.push(json!({
                "function": reference,
                "effect": declared.effect,
                "state": state,
                "passed": passed,
                "failed": failed,
                "pending": pending,
                "tests": tests,
            }));
        }
    }
    Ok(json!({ "functions": functions }))
}

/// Pour `check` : lance les tests de lecture qui ne sont pas réussis dans l’état actuel de leur fonction, et
/// renvoie ceux qui échouent. Les fonctions absentes ou qui ne compilent pas sont laissées à leurs propres erreurs.
pub async fn check(state: &Arc<AppState>, snapshot: &crate::space::Snapshot, only: Option<&str>) -> AppResult<Value> {
    let current = status(state, only)?;
    let mut failures = Vec::new();
    let mut ran = 0;
    let mut fresh = 0;
    let mut writes = 0;
    for function in current["functions"].as_array().into_iter().flatten() {
        let reference = function["function"].as_str().unwrap_or_default();
        let runnable = snapshot
            .functions
            .iter()
            .any(|resolved| resolved.reference == reference && !resolved.missing && resolved.errors.is_empty());
        if function["effect"] != json!("read") {
            writes += function["tests"].as_array().map_or(0, Vec::len);
            continue;
        }
        for test in function["tests"].as_array().into_iter().flatten() {
            if test["result"]["status"] == json!("passed") {
                fresh += 1;
                continue;
            }
            if !runnable {
                continue;
            }
            let name = test["name"].as_str().unwrap_or_default();
            ran += 1;
            let outcome = run(state, reference, name, false, None).await?;
            if outcome["status"] == json!("failed") {
                failures.push(json!({
                    "function": reference, "test": name, "message": outcome["message"], "output": outcome["output"],
                }));
            }
        }
    }
    Ok(json!({ "failed": failures, "ran": ran, "alreadyPassed": fresh, "writeTestsNotRun": writes }))
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "functions.tests" => opt_arg::<String>(args, "module").and_then(|only| status(state, only.as_deref())),
        "functions.runTest" => {
            let parsed: AppResult<(String, String, bool)> = (|| {
                Ok((arg(args, "function")?, arg(args, "test")?, opt_arg::<bool>(args, "approved")?.unwrap_or(false)))
            })();
            match parsed {
                Ok((reference, test, approved)) => {
                    run(state, &reference, &test, approved, args.get("target").cloned()).await
                }
                Err(error) => Err(error),
            }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::testing::{invoke, test_state};
    use crate::space::TestTarget;

    #[test]
    fn evaluate_reports_each_gap() {
        let schema = json!({
            "type": "object",
            "required": ["issues", "total"],
            "properties": { "issues": { "type": "array", "items": { "type": "object", "required": ["key"] } } },
        });
        let expect = Expect {
            has: vec!["issues.0.key".into()],
            non_empty: vec!["issues".into()],
            equals: [("issues.0.status".to_string(), json!("Open"))].into(),
            ..Expect::default()
        };
        let good = json!({ "issues": [{ "key": "A-1", "status": "Open" }], "total": 1 });
        assert!(evaluate(&expect, &schema, &good).is_empty());
        let bad = json!({ "issues": [] });
        let failures = evaluate(&expect, &schema, &bad);
        assert!(failures.iter().any(|f| f.contains("« total » est requis")), "{failures:?}");
        assert!(failures.iter().any(|f| f.contains("« issues » est vide")), "{failures:?}");
        assert!(failures.iter().any(|f| f.contains("« issues.0.key » est absent")), "{failures:?}");
        let wrong = json!({ "issues": [{ "status": "Done" }], "total": "1" });
        let failures = evaluate(&Expect::default(), &schema, &wrong);
        assert!(failures.iter().any(|f| f.contains("« issues.0.key » est requis")), "{failures:?}");
        let failures = evaluate(&expect, &schema, &wrong);
        assert!(failures.iter().any(|f| f.contains("vaut \"Done\" au lieu de \"Open\"")), "{failures:?}");
    }

    #[test]
    fn number_accepts_integers_and_root_path() {
        let mut out = Vec::new();
        schema_errors(&json!({ "type": "number" }), &json!(3), "", &mut out);
        assert!(out.is_empty());
        assert_eq!(at_path(&json!([1]), ""), Some(&json!([1])));
        let mut input = json!({ "body": "x" });
        set_path(&mut input, "issue.key", json!("T-1"));
        assert_eq!(input, json!({ "body": "x", "issue": { "key": "T-1" } }));
    }

    fn write_function(state: &Arc<AppState>, declared: FunctionDecl, script: &str) {
        let space = state.space().unwrap();
        let mut manifest = space.module("jira").unwrap_or_else(|_| ModuleManifest {
            id: "jira".into(),
            name: "Jira".into(),
            ..Default::default()
        });
        manifest.functions.retain(|existing| existing.id != declared.id);
        manifest.functions.push(declared.clone());
        space.write_module(&manifest).unwrap();
        let file = space.function_path("jira", &declared);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, script).unwrap();
    }

    fn read_function(output: &str) -> (FunctionDecl, String) {
        let declared = FunctionDecl {
            id: "lister".into(),
            effect: Some(Effect::Read),
            runtime: crate::space::Runtime::Bash,
            output: json!({ "type": "object", "required": ["issues"] }),
            tests: vec![FunctionTest {
                name: "Liste des tickets".into(),
                input: json!({ "limit": 1 }),
                expect: Expect { non_empty: vec!["issues".into()], ..Expect::default() },
                ..Default::default()
            }],
            ..Default::default()
        };
        (declared, format!("#!/bin/bash\ncat > /dev/null\necho '{output}'\n"))
    }

    #[tokio::test]
    async fn results_follow_the_function_fingerprint() {
        if crate::scripts::availability(crate::space::Runtime::Bash).is_some() {
            return;
        }
        let (state, _dir) = test_state();
        let (declared, script) = read_function(r#"{"issues":[]}"#);
        write_function(&state, declared.clone(), &script);
        let status_of = |state: &Arc<AppState>| status(state, Some("jira")).unwrap()["functions"][0].clone();
        assert_eq!(status_of(&state)["state"], "toVerify");

        let outcome = invoke(&state, "functions.runTest", json!({ "function": "jira/lister", "test": "Liste des tickets" }))
            .await
            .unwrap();
        assert_eq!(outcome["status"], "failed", "{outcome}");
        assert!(outcome["message"].as_str().unwrap().contains("« issues » est vide"));
        assert_eq!(status_of(&state)["state"], "failed");

        // Corriger la fonction efface le résultat : elle redevient « à vérifier », et `check` la relance.
        let (declared, script) = read_function(r#"{"issues":[{"key":"A-1"}]}"#);
        write_function(&state, declared, &script);
        assert_eq!(status_of(&state)["state"], "toVerify");
        let snapshot = state.space().unwrap().snapshot().unwrap();
        let checked = check(&state, &snapshot, Some("jira")).await.unwrap();
        assert_eq!(checked["ran"], 1, "{checked}");
        assert_eq!(checked["failed"], json!([]));
        assert_eq!(status_of(&state)["state"], "passed");
        let again = check(&state, &snapshot, Some("jira")).await.unwrap();
        assert_eq!((again["ran"].clone(), again["alreadyPassed"].clone()), (json!(0), json!(1)));
    }

    #[tokio::test]
    async fn write_tests_need_approval_and_a_target() {
        if crate::scripts::availability(crate::space::Runtime::Bash).is_some() {
            return;
        }
        let (state, _dir) = test_state();
        let declared = FunctionDecl {
            id: "commenter".into(),
            effect: Some(Effect::Write),
            runtime: crate::space::Runtime::Bash,
            tests: vec![FunctionTest {
                name: "Commente le ticket de test".into(),
                input: json!({ "body": "Test" }),
                target: Some(TestTarget { field: "issue".into(), label: "Ticket de test".into(), hint: String::new() }),
                expect: Expect { equals: [("issue".to_string(), json!("T-9"))].into(), ..Expect::default() },
            }],
            ..Default::default()
        };
        // Le script renvoie son entrée : le test voit la cible choisie.
        write_function(&state, declared, "#!/bin/bash\ncat\n");
        let args = |extra: Value| {
            let mut args = json!({ "function": "jira/commenter", "test": "Commente le ticket de test" });
            args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            args
        };
        let skipped = invoke(&state, "functions.runTest", args(json!({}))).await.unwrap();
        assert_eq!(skipped["status"], "skipped");
        let no_target = invoke(&state, "functions.runTest", args(json!({ "approved": true }))).await.unwrap();
        assert_eq!(no_target["status"], "skipped");
        assert!(no_target["message"].as_str().unwrap().contains("Ticket de test"));
        let snapshot = state.space().unwrap().snapshot().unwrap();
        let checked = check(&state, &snapshot, None).await.unwrap();
        assert_eq!((checked["ran"].clone(), checked["writeTestsNotRun"].clone()), (json!(0), json!(1)));
        let ran =
            invoke(&state, "functions.runTest", args(json!({ "approved": true, "target": "T-9" }))).await.unwrap();
        assert_eq!(ran["status"], "passed", "{ran}");
    }
}
