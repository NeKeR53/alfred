//! Fonctions de l’espace : des modules partagés, déclarés dans le manifeste de leur module, que les pages, les
//! agents, les webhooks et la planification appellent de la même façon. Elles s’exécutent dans un cadre invisible de
//! la coquille, avec le même pont que les pages : Rust transmet l’appel et attend le résultat.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::app_db::{self, JournalEntry};
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::{self, Subject};
use crate::scripts::{self, Runtime, ScriptCall};
use crate::space::{valid_id, FunctionDecl, ModuleManifest, Uses};
use crate::state::AppState;

fn db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))
}

fn space_key(state: &AppState) -> AppResult<String> {
    Ok(state.space()?.root.to_string_lossy().to_string())
}

fn split(reference: &str) -> AppResult<(&str, &str)> {
    reference
        .split_once('/')
        .filter(|(module, function)| valid_id(module) && valid_id(function))
        .ok_or_else(|| AppError::new(format!("Fonction désignée par « module/fonction » attendue : « {reference} ».")))
}

/// Appelle une fonction depuis Rust (agent, webhook, planification) : l’interface l’exécute et renvoie sa sortie.
pub async fn call(state: &Arc<AppState>, reference: &str, input: Value, caller: &str) -> AppResult<Value> {
    let (module, function) = split(reference)?;
    let space = state.space()?;
    let manifest = space.module(module)?;
    let Some(declared) = manifest.functions.iter().find(|declared| declared.id == function) else {
        return Err(AppError::new(format!("La fonction « {reference} » n’est pas déclarée dans son module.")));
    };
    if declared.runtime.is_script() {
        return call_script(state, &space, &manifest, declared, input, caller).await;
    }
    state
        .ask_ui(
            "function:call",
            json!({ "function": reference, "input": input, "caller": caller }),
            Duration::from_secs(180),
        )
        .await
}

fn declaration_for(manifest: &ModuleManifest, id: &str) -> AppResult<FunctionDecl> {
    manifest.functions.iter().find(|declared| declared.id == id).cloned().ok_or_else(|| AppError::new("Fonction inconnue."))
}

/// Lance une fonction écrite en script, sans passer par l’interface, et note l’appel au journal.
async fn call_script(
    state: &Arc<AppState>,
    space: &crate::space::Space,
    manifest: &ModuleManifest,
    declared: &FunctionDecl,
    input: Value,
    caller: &str,
) -> AppResult<Value> {
    let reference = format!("{}/{}", manifest.id, declared.id);
    let started = std::time::Instant::now();
    let result = scripts::run(ScriptCall {
        runtime: declared.runtime,
        file: space.function_path(&manifest.id, declared),
        dir: space.module_dir(&manifest.id),
        env: vec![
            ("ALFRED_MODULE".to_string(), manifest.id.clone()),
            ("ALFRED_FUNCTION".to_string(), declared.id.clone()),
            ("ALFRED_CALLER".to_string(), caller.to_string()),
            ("ALFRED_SPACE".to_string(), space.root.to_string_lossy().to_string()),
        ],
        input,
        timeout: scripts::TIMEOUT,
    })
    .await;
    let duration = Some(started.elapsed().as_millis() as u64);
    match &result {
        Ok(_) => journal(state, "function", &reference, true, duration, &format!("Appelée par {caller}"), Some(&json!({ "caller": caller }))),
        Err(error) => journal(
            state,
            "function",
            &reference,
            false,
            duration,
            &format!("Échec (appelée par {caller}) : {}", error.message),
            Some(&json!({ "caller": caller, "error": error.message, "diagnostics": error.detail })),
        ),
    }
    result
}

/// Écrit une ligne au journal d’exécution de l’espace ouvert.
pub fn journal(
    state: &AppState,
    kind: &str,
    subject: &str,
    ok: bool,
    duration_ms: Option<u64>,
    summary: &str,
    detail: Option<&Value>,
) {
    let Ok(space) = space_key(state) else { return };
    if let Ok(db) = db(state) {
        let _ = app_db::record_journal(
            &db,
            &JournalEntry {
                space: &space,
                kind,
                subject,
                status: if ok { "ok" } else { "error" },
                duration_ms,
                summary,
                detail,
            },
        );
    }
    state.emit("journal:changed", Value::Null);
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "functions.declare" => (|| {
            let space = state.space()?;
            let module: String = arg(args, "module")?;
            let id: String = arg(args, "id")?;
            if !valid_id(&id) {
                return Err(AppError::new(
                    "Identifiant de fonction invalide : minuscules, chiffres et tirets uniquement.",
                ));
            }
            let mut manifest = space.module(&module)?;
            if manifest.read_only() {
                return Err(AppError::new(format!(
                    "Le module « {} » est importé d’un marketplace : le détacher pour lui ajouter une fonction.",
                    manifest.name
                )));
            }
            let declaration = FunctionDecl {
                id: id.clone(),
                description: opt_arg::<String>(args, "description")?.unwrap_or_default(),
                input: args.get("input").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                output: args.get("output").cloned().unwrap_or(Value::Null),
                tool: opt_arg::<bool>(args, "tool")?.unwrap_or(false),
                uses: opt_arg::<Uses>(args, "uses")?.unwrap_or_default(),
                runtime: opt_arg::<Runtime>(args, "runtime")
                    .map_err(|_| AppError::new("Langage inconnu : `runtime` vaut ts, bash, pwsh ou python."))?
                    .unwrap_or_default(),
                effect: opt_arg::<crate::space::Effect>(args, "effect")
                    .map_err(|_| AppError::new("Effet inconnu : `effect` vaut read ou write."))?,
                tests: opt_arg::<Vec<crate::space::FunctionTest>>(args, "tests")
                    .map_err(|error| AppError::new(format!("Tests illisibles : {}", error.message)))?
                    .unwrap_or_default(),
            };
            let mut declaration = declaration;
            match manifest.functions.iter_mut().find(|declared| declared.id == id) {
                Some(existing) => {
                    // Une redéclaration qui ne parle pas de l’effet ou des tests les garde.
                    if args.get("effect").is_none() {
                        declaration.effect = existing.effect;
                    }
                    if args.get("tests").is_none() {
                        declaration.tests = std::mem::take(&mut existing.tests);
                    }
                    *existing = declaration
                }
                None => manifest.functions.push(declaration),
            }
            space.write_module(&manifest)?;
            let file = space.function_path(&module, &declaration_for(&manifest, &id)?);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            state.emit("space:changed", Value::Null);
            Ok(json!({ "reference": format!("{module}/{id}"), "file": file.to_string_lossy() }))
        })(),
        "functions.remove" => (|| {
            let space = state.space()?;
            let reference: String = arg(args, "reference")?;
            let (module, function) = split(&reference)?;
            let mut manifest = space.module(module)?;
            if manifest.read_only() {
                return Err(AppError::new("Ce module est en lecture seule."));
            }
            let file = space.function_file(module, function);
            manifest.functions.retain(|declared| declared.id != function);
            space.write_module(&manifest)?;
            let _ = std::fs::remove_file(file);
            crate::permissions::forget_function(state, &reference)?;
            crate::git::commit_all(&space.root, &format!("Suppression de la fonction {reference}"))?;
            state.emit("space:changed", Value::Null);
            Ok(Value::Null)
        })(),
        "functions.setTool" => (|| {
            let space = state.space()?;
            let reference: String = arg(args, "reference")?;
            let tool: bool = arg(args, "tool")?;
            let (module, function) = split(&reference)?;
            let mut manifest = space.module(module)?;
            if manifest.read_only() {
                return Err(AppError::new("Ce module est en lecture seule : la fonction garde son réglage d’origine."));
            }
            let declared = manifest
                .functions
                .iter_mut()
                .find(|declared| declared.id == function)
                .ok_or_else(|| AppError::new("Fonction inconnue."))?;
            declared.tool = tool;
            space.write_module(&manifest)?;
            crate::git::commit_all(&space.root, &format!("Fonction {reference} : outil d’agent {}", if tool { "activé" } else { "désactivé" }))?;
            state.emit("space:changed", Value::Null);
            Ok(Value::Null)
        })(),
        "functions.call" => {
            let reference: Result<String, _> = arg(args, "function");
            match reference {
                Ok(reference) => {
                    let caller = opt_arg::<String>(args, "caller").ok().flatten();
                    let caller = caller.as_deref().unwrap_or("interface");
                    call(state, &reference, args.get("input").cloned().unwrap_or(json!({})), caller).await
                }
                Err(error) => Err(error),
            }
        }
        // Une page ou une fonction d’un autre module demande à appeler cette fonction : l’utilisateur l’accorde.
        "frame.functions.authorize" => {
            let parsed: AppResult<(Subject, String)> =
                (|| Ok((arg(args, "subject")?, arg::<String>(args, "function")?)))();
            match parsed {
                Ok((subject, function)) => {
                    let owner = split(&function).map(|(module, _)| module.to_string());
                    let same_module = owner.as_deref().is_ok_and(|module| module == subject.module);
                    // Les fonctions d’une dépendance déclarée dans `requires` sont accordées d’office.
                    let dependency = owner.as_deref().is_ok_and(|owner| {
                        state.space().and_then(|space| space.module(&subject.module)).is_ok_and(|m| m.requires_module(owner))
                    });
                    if same_module || dependency {
                        Ok(Value::Null)
                    } else {
                        permissions::ensure(
                            state,
                            &subject,
                            &format!("function:{function}"),
                            &format!("la fonction {function}"),
                        )
                        .await
                        .map(|_| Value::Null)
                    }
                }
                Err(error) => Err(error),
            }
        }
        "journal.record" => (|| {
            let kind: String = arg(args, "kind")?;
            let subject: String = arg(args, "subject")?;
            let ok: bool = arg(args, "ok")?;
            let summary: String = arg(args, "summary")?;
            let duration: Option<u64> = opt_arg(args, "durationMs")?;
            journal(state, &kind, &subject, ok, duration, &summary, args.get("detail").filter(|v| !v.is_null()));
            Ok(Value::Null)
        })(),
        "journal.list" => (|| {
            let kind: Option<String> = opt_arg(args, "kind")?;
            let limit: Option<u32> = opt_arg(args, "limit")?;
            let space = space_key(state)?;
            let db = db(state)?;
            Ok(Value::Array(app_db::read_journal(&db, &space, kind.as_deref(), limit.unwrap_or(200).min(1000))?))
        })(),
        "grants.list" => (|| {
            let space = space_key(state)?;
            let db = db(state)?;
            Ok(Value::Array(app_db::list_grants(&db, &space)?))
        })(),
        "grants.revoke" => (|| {
            let subject: String = arg(args, "subject")?;
            let resource: String = arg(args, "resource")?;
            let space = space_key(state)?;
            let db = db(state)?;
            app_db::revoke(&db, &space, &subject, &resource)?;
            Ok(Value::Null)
        })(),
        _ => return None,
    })
}
