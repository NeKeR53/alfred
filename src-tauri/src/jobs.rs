//! Tâches de fond : un travail long (import de milliers de lignes, relevé complet d’un service) découpé en étapes.
//! Une tâche est une fonction du module qu’Alfred rappelle étape par étape, chacune sous la limite de 120 secondes
//! d’une fonction, en lui rendant l’état qu’elle a laissé. L’état est gardé dans la base de l’espace : une tâche
//! interrompue (Alfred fermé, espace changé) reprend à l’étape où elle s’était arrêtée, et l’utilisateur peut
//! l’annuler entre deux étapes. Il suit la progression dans la fiche du module (Réglages → Modules).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, Space};
use crate::state::AppState;

/// Tâches qui avancent en même temps, une seule par module.
const PARALLEL: usize = 3;
/// Essais d’une même étape avant que la tâche passe en échec.
const ATTEMPTS: i64 = 3;
/// Garde-fou contre une fonction qui ne dit jamais `done`.
const MAX_STEPS: i64 = 100_000;
/// Tâches terminées gardées par module.
const KEEP_FINISHED: i64 = 200;

fn open(space: &Space) -> AppResult<Connection> {
    let db = crate::space_db::open(space)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_jobs (
           id TEXT PRIMARY KEY, module TEXT NOT NULL, function TEXT NOT NULL, title TEXT NOT NULL,
           input TEXT NOT NULL, state TEXT, step INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL, progress REAL, message TEXT, result TEXT, error TEXT,
           attempts INTEGER NOT NULL DEFAULT 0, cancel INTEGER NOT NULL DEFAULT 0,
           started_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
         CREATE INDEX IF NOT EXISTS _alfred_jobs_status ON _alfred_jobs (status, created_at);",
    )?;
    Ok(db)
}

fn parse(text: Option<String>) -> Value {
    text.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null)
}

const COLUMNS: &str =
    "id, module, function, title, input, state, step, status, progress, message, result, error, attempts, cancel, started_by, created_at, updated_at, finished_at";

fn row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "module": row.get::<_, String>(1)?,
        "function": row.get::<_, String>(2)?,
        "title": row.get::<_, String>(3)?,
        "input": parse(row.get(4)?),
        "step": row.get::<_, i64>(6)?,
        "status": row.get::<_, String>(7)?,
        "progress": row.get::<_, Option<f64>>(8)?,
        "message": row.get::<_, Option<String>>(9)?,
        "result": parse(row.get(10)?),
        "error": row.get::<_, Option<String>>(11)?,
        "attempts": row.get::<_, i64>(12)?,
        "cancelRequested": row.get::<_, i64>(13)? != 0,
        "startedBy": row.get::<_, String>(14)?,
        "createdAt": row.get::<_, String>(15)?,
        "updatedAt": row.get::<_, String>(16)?,
        "finishedAt": row.get::<_, Option<String>>(17)?,
    }))
}

pub fn get(space: &Space, id: &str) -> AppResult<Value> {
    let db = open(space)?;
    db.query_row(&format!("SELECT {COLUMNS} FROM _alfred_jobs WHERE id = ?1"), [id], row_to_json)
        .optional()?
        .ok_or_else(|| AppError::new("Cette tâche de fond n’existe pas."))
}

/// Tâches de l’espace (ou d’un module), les plus récentes d’abord.
pub fn list(space: &Space, module: Option<&str>, status: Option<&str>, limit: usize) -> AppResult<Vec<Value>> {
    let db = open(space)?;
    let mut statement = db.prepare(&format!(
        "SELECT {COLUMNS} FROM _alfred_jobs WHERE (?1 IS NULL OR module = ?1) AND (?2 IS NULL OR status = ?2)
         ORDER BY created_at DESC, rowid DESC LIMIT ?3"
    ))?;
    let rows = statement.query_map(params![module, status, limit as i64], row_to_json)?.filter_map(Result::ok).collect();
    Ok(rows)
}

/// Crée une tâche ; elle démarre dès qu’un emplacement se libère.
pub fn create(space: &Space, module: &str, function: &str, input: Value, title: Option<&str>, started_by: &str) -> AppResult<Value> {
    let function = function.strip_prefix(&format!("{module}/")).unwrap_or(function);
    if !valid_id(function) {
        return Err(AppError::new("Une tâche de fond lance une fonction du module : « fonction », sans autre module."));
    }
    let manifest = space.module(module)?;
    let Some(declared) = manifest.functions.iter().find(|declared| declared.id == function) else {
        return Err(AppError::new(format!("La fonction « {function} » n’est pas déclarée dans le module « {module} ».")));
    };
    let title = title.map(str::trim).filter(|title| !title.is_empty()).map(str::to_string).unwrap_or_else(|| {
        if declared.description.is_empty() { function.to_string() } else { declared.description.clone() }
    });
    let id = uuid::Uuid::new_v4().simple().to_string();
    let now = crate::app_db::now();
    let db = open(space)?;
    db.execute(
        "INSERT INTO _alfred_jobs (id, module, function, title, input, status, started_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?7)",
        params![id, module, function, title, input.to_string(), started_by, now],
    )?;
    // Les plus anciennes tâches terminées du module s’effacent.
    db.execute(
        "DELETE FROM _alfred_jobs WHERE module = ?1 AND status IN ('done', 'failed', 'cancelled') AND id NOT IN (
           SELECT id FROM _alfred_jobs WHERE module = ?1 AND status IN ('done', 'failed', 'cancelled')
           ORDER BY created_at DESC LIMIT ?2)",
        params![module, KEEP_FINISHED],
    )?;
    get(space, &id)
}

fn owned(space: &Space, id: &str, module: Option<&str>) -> AppResult<Value> {
    let job = get(space, id)?;
    if module.is_some_and(|module| job["module"] != module) {
        return Err(AppError::new("Cette tâche de fond n’existe pas."));
    }
    Ok(job)
}

/// Annule une tâche : tout de suite si elle attend, après l’étape en cours sinon.
pub fn cancel(space: &Space, id: &str, module: Option<&str>) -> AppResult<Value> {
    owned(space, id, module)?;
    let db = open(space)?;
    let now = crate::app_db::now();
    db.execute(
        "UPDATE _alfred_jobs SET status = 'cancelled', message = 'Annulée', finished_at = ?2, updated_at = ?2
         WHERE id = ?1 AND status = 'queued'",
        params![id, now],
    )?;
    db.execute("UPDATE _alfred_jobs SET cancel = 1, updated_at = ?2 WHERE id = ?1 AND status = 'running'", params![id, now])?;
    get(space, id)
}

/// Relance une tâche en échec ou annulée, à l’étape où elle s’était arrêtée.
pub fn resume(space: &Space, id: &str, module: Option<&str>) -> AppResult<Value> {
    let job = owned(space, id, module)?;
    if !matches!(job["status"].as_str(), Some("failed" | "cancelled")) {
        return Err(AppError::new("Seule une tâche en échec ou annulée se reprend."));
    }
    open(space)?.execute(
        "UPDATE _alfred_jobs SET status = 'queued', attempts = 0, cancel = 0, error = NULL, finished_at = NULL, updated_at = ?2
         WHERE id = ?1",
        params![id, crate::app_db::now()],
    )?;
    get(space, id)
}

pub fn remove(space: &Space, id: &str) -> AppResult<()> {
    let job = get(space, id)?;
    if matches!(job["status"].as_str(), Some("queued" | "running")) {
        return Err(AppError::new("Annulez la tâche avant de la retirer."));
    }
    open(space)?.execute("DELETE FROM _alfred_jobs WHERE id = ?1", [id])?;
    Ok(())
}

/// Ce que l’étape a rendu.
#[derive(Debug, PartialEq)]
struct Outcome {
    done: bool,
    state: Value,
    progress: Option<f64>,
    message: Option<String>,
    result: Value,
}

/// Une étape rend `{ state, progress, message, done, result }`. Elle continue si elle rend `done: false`, ou un
/// `state` sans `done: true` ; tout le reste termine la tâche (une fonction ordinaire est une tâche d’une étape).
fn outcome(output: Value) -> Outcome {
    let object = output.as_object();
    let field = |name: &str| object.and_then(|object| object.get(name)).cloned();
    let done_flag = field("done").and_then(|done| done.as_bool());
    let has_state = object.is_some_and(|object| object.contains_key("state"));
    let done = match done_flag {
        Some(done) => done,
        None => !has_state,
    };
    let result = if done {
        match field("result") {
            Some(result) => result,
            None if done_flag.is_some() || has_state => Value::Null,
            None => output.clone(),
        }
    } else {
        Value::Null
    };
    Outcome {
        done,
        state: field("state").unwrap_or(Value::Null),
        progress: field("progress").and_then(|progress| progress.as_f64()).map(|progress| progress.clamp(0.0, 1.0)),
        message: field("message").and_then(|message| message.as_str().map(|text| text.chars().take(300).collect())),
        result,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------------------------------------------

struct Runner {
    wake: tokio::sync::Notify,
    /// Tâches en cours dans ce processus, et leurs modules.
    running: Mutex<HashSet<(String, String)>>,
}

fn runner() -> &'static Runner {
    static RUNNER: OnceLock<Runner> = OnceLock::new();
    RUNNER.get_or_init(|| Runner { wake: tokio::sync::Notify::new(), running: Mutex::new(HashSet::new()) })
}

/// Réveille l’exécution : une tâche vient d’être créée ou reprise.
pub fn kick() {
    runner().wake.notify_one();
}

/// Démarre la boucle qui fait avancer les tâches de l’espace ouvert.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            let _ = tokio::time::timeout(Duration::from_secs(5), runner().wake.notified()).await;
            if let Some(space) = state.try_space() {
                if let Err(error) = dispatch_ready(&state, &space) {
                    log::error!("tâches de fond : {}", error.message);
                }
            }
        }
    });
}

fn dispatch_ready(state: &Arc<AppState>, space: &Space) -> AppResult<()> {
    let db = open(space)?;
    let (running_ids, busy_modules): (HashSet<String>, HashSet<String>) = {
        let running = runner().running.lock().map_err(|_| AppError::new("Tâches indisponibles."))?;
        (running.iter().map(|(id, _)| id.clone()).collect(), running.iter().map(|(_, module)| module.clone()).collect())
    };
    // Une tâche « en cours » qu’aucune exécution ne porte a été interrompue (Alfred fermé) : elle repart.
    let mut statement = db.prepare("SELECT id FROM _alfred_jobs WHERE status = 'running'")?;
    let stale: Vec<String> = statement.query_map([], |row| row.get(0))?.filter_map(Result::ok).collect();
    for id in stale.iter().filter(|id| !running_ids.contains(*id)) {
        db.execute("UPDATE _alfred_jobs SET status = 'queued' WHERE id = ?1", [id])?;
    }
    let mut statement =
        db.prepare("SELECT id, module FROM _alfred_jobs WHERE status = 'queued' ORDER BY created_at, rowid")?;
    let queued: Vec<(String, String)> =
        statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.filter_map(Result::ok).collect();
    let mut busy = busy_modules;
    let mut slots = PARALLEL.saturating_sub(running_ids.len());
    for (id, module) in queued {
        if slots == 0 {
            break;
        }
        if busy.contains(&module) {
            continue;
        }
        busy.insert(module.clone());
        slots -= 1;
        if let Ok(mut running) = runner().running.lock() {
            running.insert((id.clone(), module.clone()));
        }
        db.execute("UPDATE _alfred_jobs SET status = 'running', updated_at = ?2 WHERE id = ?1", params![id, crate::app_db::now()])?;
        let state = state.clone();
        let space = space.clone();
        tokio::spawn(async move {
            run_job(&state, &space, &id).await;
            if let Ok(mut running) = runner().running.lock() {
                running.retain(|(running_id, _)| running_id != &id);
            }
            state.emit("jobs:changed", json!({ "id": id }));
            kick();
        });
    }
    if !stale.is_empty() {
        state.emit("jobs:changed", Value::Null);
    }
    Ok(())
}

fn finish(space: &Space, id: &str, status: &str, message: Option<&str>, result: &Value, error: Option<&str>) -> AppResult<()> {
    let now = crate::app_db::now();
    open(space)?.execute(
        "UPDATE _alfred_jobs SET status = ?2, message = COALESCE(?3, message), result = ?4, error = ?5,
           progress = CASE WHEN ?2 = 'done' THEN 1.0 ELSE progress END, finished_at = ?6, updated_at = ?6, cancel = 0
         WHERE id = ?1",
        params![id, status, message, result.to_string(), error, now],
    )?;
    Ok(())
}

/// Fait avancer une tâche jusqu’à sa fin, son annulation, son échec ou un changement d’espace.
async fn run_job(state: &Arc<AppState>, space: &Space, id: &str) {
    if let Err(error) = run_steps(state, space, id).await {
        log::error!("tâche de fond {id} : {}", error.message);
        let _ = finish(space, id, "failed", None, &Value::Null, Some(&error.message));
    }
}

async fn run_steps(state: &Arc<AppState>, space: &Space, id: &str) -> AppResult<()> {
    loop {
        // L’utilisateur a changé d’espace : la tâche attend sa réouverture.
        if state.try_space().is_none_or(|current| current.root != space.root) {
            open(space)?.execute("UPDATE _alfred_jobs SET status = 'queued' WHERE id = ?1 AND status = 'running'", [id])?;
            return Ok(());
        }
        let job = get(space, id)?;
        let module = job["module"].as_str().unwrap_or_default().to_string();
        let reference = format!("{module}/{}", job["function"].as_str().unwrap_or_default());
        let title = job["title"].as_str().unwrap_or_default().to_string();
        if job["cancelRequested"] == true {
            finish(space, id, "cancelled", Some("Annulée"), &Value::Null, None)?;
            crate::functions::journal(state, "job", &reference, true, None, &format!("« {title} » annulée"), None);
            return Ok(());
        }
        let step = job["step"].as_i64().unwrap_or_default();
        if step >= MAX_STEPS {
            return Err(AppError::new(format!("La tâche a dépassé {MAX_STEPS} étapes sans se terminer.")));
        }
        let saved_state = parse(open(space)?.query_row("SELECT state FROM _alfred_jobs WHERE id = ?1", [id], |row| row.get(0))?);
        let input = json!({ "input": job["input"], "state": saved_state, "step": step, "job": { "id": id, "title": title } });
        let started = std::time::Instant::now();
        match crate::functions::call(state, &reference, input, "tâche de fond").await {
            Ok(output) => {
                let outcome = outcome(output);
                let db = open(space)?;
                db.execute(
                    "UPDATE _alfred_jobs SET state = ?2, step = step + 1, attempts = 0, progress = COALESCE(?3, progress),
                       message = COALESCE(?4, message), updated_at = ?5 WHERE id = ?1",
                    params![id, outcome.state.to_string(), outcome.progress, outcome.message, crate::app_db::now()],
                )?;
                state.emit("jobs:changed", json!({ "id": id }));
                if outcome.done {
                    finish(space, id, "done", None, &outcome.result, None)?;
                    crate::functions::journal(
                        state,
                        "job",
                        &reference,
                        true,
                        Some(started.elapsed().as_millis() as u64),
                        &format!("« {title} » terminée en {} étape{}", step + 1, if step == 0 { "" } else { "s" }),
                        Some(&json!({ "job": id })),
                    );
                    state.emit("jobs:finished", json!({ "id": id, "status": "done", "title": title, "module": module }));
                    return Ok(());
                }
            }
            Err(error) => {
                let attempts = job["attempts"].as_i64().unwrap_or_default() + 1;
                let db = open(space)?;
                db.execute(
                    "UPDATE _alfred_jobs SET attempts = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, attempts, error.message, crate::app_db::now()],
                )?;
                if attempts >= ATTEMPTS {
                    finish(space, id, "failed", None, &Value::Null, Some(&error.message))?;
                    crate::functions::journal(
                        state,
                        "job",
                        &reference,
                        false,
                        None,
                        &format!("« {title} » en échec à l’étape {} : {}", step + 1, error.message),
                        Some(&json!({ "job": id, "error": error.message })),
                    );
                    state.emit("jobs:finished", json!({ "id": id, "status": "failed", "title": title, "module": module, "error": error.message }));
                    return Ok(());
                }
                state.emit("jobs:changed", json!({ "id": id }));
                tokio::time::sleep(Duration::from_secs(2 * attempts as u64)).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("frame.jobs.") && !command.starts_with("jobs.") {
        return None;
    }
    let result = (|| -> AppResult<Value> {
        let space = state.space()?;
        let id = || arg::<String>(args, "id");
        // Depuis une page ou une fonction : les seules tâches de son module. Depuis les Réglages : toutes.
        let subject: Option<Subject> = if command.starts_with("frame.") { Some(arg(args, "subject")?) } else { None };
        let module = subject.as_ref().map(|subject| subject.module.as_str());
        let value = match command.trim_start_matches("frame.") {
            "jobs.start" => {
                let subject = subject.as_ref().ok_or_else(|| AppError::new("Commande réservée aux modules."))?;
                let function: String = arg(args, "function")?;
                let title: Option<String> = opt_arg(args, "title")?;
                let job = create(
                    &space,
                    &subject.module,
                    &function,
                    args.get("input").cloned().unwrap_or_else(|| json!({})),
                    title.as_deref(),
                    &subject.reference,
                )?;
                kick();
                job
            }
            "jobs.get" => owned(&space, &id()?, module)?,
            "jobs.list" => {
                let status: Option<String> = opt_arg(args, "status")?;
                let limit: Option<usize> = opt_arg(args, "limit")?;
                Value::Array(list(&space, module, status.as_deref(), limit.unwrap_or(100).min(500))?)
            }
            "jobs.cancel" => cancel(&space, &id()?, module)?,
            "jobs.resume" => {
                let job = resume(&space, &id()?, module)?;
                kick();
                job
            }
            "jobs.remove" if subject.is_none() => {
                remove(&space, &id()?)?;
                Value::Null
            }
            _ => return Err(AppError::new(format!("Commande inconnue : {command}"))),
        };
        Ok(value)
    })();
    if result.is_ok() && !command.ends_with(".get") && !command.ends_with(".list") {
        state.emit("jobs:changed", Value::Null);
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_says_whether_the_job_goes_on() {
        let next = outcome(json!({ "state": { "page": 2 }, "progress": 0.4, "message": "Page 2" }));
        assert!(!next.done);
        assert_eq!(next.state, json!({ "page": 2 }));
        assert_eq!(next.progress, Some(0.4));
        let done = outcome(json!({ "done": true, "result": { "importees": 12 } }));
        assert!(done.done);
        assert_eq!(done.result, json!({ "importees": 12 }));
        // Une fonction ordinaire est une tâche d’une étape, dont la sortie est le résultat.
        let plain = outcome(json!({ "total": 3 }));
        assert!(plain.done);
        assert_eq!(plain.result, json!({ "total": 3 }));
        assert!(!outcome(json!({ "done": false })).done);
        assert_eq!(outcome(json!({ "progress": 7 })).progress, Some(1.0));
    }

    #[test]
    fn jobs_are_scoped_to_their_module() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let mut manifest = crate::space::ModuleManifest { id: "import".into(), name: "Import".into(), ..Default::default() };
        manifest.functions.push(crate::space::FunctionDecl { id: "lire".into(), description: "Import du fichier".into(), ..Default::default() });
        space.write_module(&manifest).unwrap();
        assert!(create(&space, "import", "autre", json!({}), None, "import/page").is_err());
        assert!(create(&space, "import", "crm/lire", json!({}), None, "import/page").is_err());
        let job = create(&space, "import", "import/lire", json!({ "n": 1 }), None, "import/page").unwrap();
        assert_eq!(job["title"], "Import du fichier");
        assert_eq!(job["status"], "queued");
        let id = job["id"].as_str().unwrap();

        assert!(owned(&space, id, Some("crm")).is_err(), "un autre module ne la voit pas");
        assert_eq!(list(&space, Some("crm"), None, 10).unwrap().len(), 0);
        assert!(remove(&space, id).is_err(), "pas pendant qu’elle attend");
        assert!(resume(&space, id, None).is_err());
        assert_eq!(cancel(&space, id, Some("import")).unwrap()["status"], "cancelled");
        assert_eq!(resume(&space, id, Some("import")).unwrap()["status"], "queued");
    }

    /// De bout en bout, avec une fonction en script : trois étapes, l’état passé de l’une à l’autre, la progression
    /// et le résultat gardés ; une étape qui échoue trois fois met la tâche en échec, et elle se reprend.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_job_runs_step_by_step_until_done() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        let mut manifest = crate::space::ModuleManifest { id: "import".into(), name: "Import".into(), ..Default::default() };
        for id in ["compter", "casser"] {
            manifest.functions.push(crate::space::FunctionDecl {
                id: id.into(),
                runtime: crate::scripts::Runtime::Bash,
                ..Default::default()
            });
        }
        space.write_module(&manifest).unwrap();
        let functions = space.module_dir("import").join("functions");
        std::fs::create_dir_all(&functions).unwrap();
        std::fs::write(
            functions.join("compter.sh"),
            r#"input=$(cat)
step=$(printf '%s' "$input" | sed -n 's/.*"step":\([0-9]*\).*/\1/p')
if [ "$step" -ge 2 ]; then echo '{"done":true,"result":{"etapes":3}}'; else echo "{\"state\":{\"n\":$step},\"progress\":0.5,\"message\":\"Étape $step\"}"; fi
"#,
        )
        .unwrap();
        std::fs::write(functions.join("casser.sh"), "echo 'service indisponible' >&2; exit 1\n").unwrap();
        state.set_space(Some(space.clone()));

        let job = create(&space, "import", "compter", json!({}), Some("Comptage"), "import/page").unwrap();
        let id = job["id"].as_str().unwrap().to_string();
        let broken = create(&space, "import", "casser", json!({}), None, "import/page").unwrap();
        let broken_id = broken["id"].as_str().unwrap().to_string();
        start(state.clone());
        kick();
        let wait = |id: String| {
            let space = space.clone();
            async move {
                for _ in 0..200 {
                    let job = get(&space, &id).unwrap();
                    if matches!(job["status"].as_str(), Some("done" | "failed" | "cancelled")) {
                        return job;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                panic!("tâche jamais terminée : {}", get(&space, &id).unwrap());
            }
        };
        let done = wait(id.clone()).await;
        assert_eq!(done["status"], "done", "{done}");
        assert_eq!(done["step"], 3);
        assert_eq!(done["result"], json!({ "etapes": 3 }));
        assert_eq!(done["progress"], 1.0);
        assert_eq!(done["message"], "Étape 1");

        let failed = wait(broken_id.clone()).await;
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["attempts"], 3);
        assert!(failed["error"].as_str().unwrap().contains("service indisponible"), "{failed}");
        assert_eq!(resume(&space, &broken_id, None).unwrap()["status"], "queued");
    }
}
