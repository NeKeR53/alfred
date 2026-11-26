//! Délégation entre agents (S11) : une conversation **coordinatrice** répartit son travail entre d’autres agents.
//!
//! - Une conversation devient coordinatrice parce que l’utilisateur la marque dans la page Agent, ou parce qu’une
//!   page la lance avec `coordinator: true`. Elle reçoit les outils `delegate`, `task_status`, `read_report`,
//!   `relaunch_task`, `add_to_task`, `stop_task` et `archive_task` ; ses délégués ne les ont jamais. Elle n’agit que
//!   sur ses propres tâches.
//! - `delegate` reçoit de 1 à 50 tâches (objectif, dossier, mode, dépendances acycliques, harnais, modèle et effort).
//!   Le lot est validé en entier avant tout lancement ; un `requestId` déjà vu rend la même réponse.
//! - Un délégué reprend le harnais, le modèle et l’effort de la coordinatrice, sauf ce que sa tâche précise
//!   (`resolved`). Ce sont ceux de la session de la coordinatrice ; Alfred les garde à chacun de ses appels, pour les
//!   tâches qui partent après sa session.
//! - Chaque délégué finit par un contrat de retour (`status`, `summary`, `artifacts`, `questions`) ; son rapport
//!   complet est gardé et lu par pages. Une tâche ne part qu’une fois ses dépendances réussies ; un échec annule
//!   celles qui en dépendent.
//! - Les tâches sont gardées dans la base de l’espace : la coquille lance les conversations des tâches prêtes
//!   (`agents.tasks.claim`), puis rend leur contrat (`agents.tasks.report`) et relance la coordinatrice.
//! - Les tâches d’une coordinatrice partent dans l’interface qui tient sa session (ou celle d’un de ses délégués) :
//!   une autre interface ouverte sur le même Alfred (fenêtre cachée, navigateur par le pont de développement) les
//!   laisse. Sans cela, les délégués naissaient dans une interface que l’utilisateur ne regarde pas.
//! - Une tâche dont la session se ferme avant son rapport (rechargement de l’interface, CLI arrêté, Alfred quitté)
//!   passe « interrompue », avec la raison. L’interface la reprend dans la conversation du délégué, qui garde sa
//!   session de CLI ; après `MAX_RESUMES` reprises, elle passe en échec et la coordinatrice reçoit le rapport.
//! - La coordinatrice pilote chaque délégué. Elle le relance (`relaunch_task`) dans sa conversation, qui garde son
//!   contexte, ou dans une conversation neuve (`fresh`). Elle complète sa tâche (`add_to_task`) : la précision
//!   rejoint l’objectif et, s’il travaille, sa conversation. Elle l’arrête (`stop_task`) ou archive sa conversation
//!   (`archive_task`). Rust ne tient pas les conversations : l’outil inscrit l’action dans la tâche (`actions`), et
//!   `claim` la rend à l’interface qui tient le délégué, qui l’exécute. L’action survit ainsi à un rechargement.
//! - Le rapport d’une tâche qui ne travaille plus est ignoré : un délégué arrêté par la coordinatrice (ou avec elle)
//!   rend son tour annulé sans la relancer ; le résultat de l’outil lui suffit.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::session::Harness;
use crate::app_db::{self, AgentScope};
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::Space;
use crate::state::AppState;

const MAX_TASKS: usize = 50;
const SUMMARY_CHARS: usize = 600;
const REPORT_PAGE: usize = 4000;
const STATUSES: &[&str] = &["success", "partial", "failed", "needs_information", "cancelled"];
/// Reprises automatiques d’une tâche interrompue ; à l’interruption suivante, elle passe en échec.
const MAX_RESUMES: i64 = 2;
const CLOSED_REASON: &str =
    "Interrompue : la session du délégué s’est fermée avant son rapport (interface rechargée ou CLI arrêté).";
const STOPPED_REASON: &str = "Interrompue : Alfred s’est arrêté pendant la tâche.";
const STOPPED_BY_COORDINATOR: &str = "Arrêtée par la coordinatrice.";
/// Statuts d’une tâche qui travaille ou va travailler.
const WORKING: &[&str] = &["waiting", "ready", "running", "interrupted"];

/// Colonnes ajoutées après coup (héritage du harnais, reprises) : une table d’avant les reçoit.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("_alfred_agent_coordinators", "provider", "TEXT"),
    ("_alfred_agent_coordinators", "model", "TEXT"),
    ("_alfred_agent_coordinators", "effort", "TEXT"),
    ("_alfred_agent_tasks", "effort", "TEXT"),
    ("_alfred_agent_tasks", "resumes", "INTEGER NOT NULL DEFAULT 0"),
    // Actions de la coordinatrice que la coquille doit exécuter (`Action`, en JSON).
    ("_alfred_agent_tasks", "actions", "TEXT"),
    // Consigne envoyée au délégué relancé dans sa conversation.
    ("_alfred_agent_tasks", "instruction", "TEXT"),
    // Conversation du délégué archivée par la coordinatrice.
    ("_alfred_agent_tasks", "archived", "INTEGER NOT NULL DEFAULT 0"),
];

fn open(space: &Space) -> AppResult<Connection> {
    let db = crate::space_db::open(space)?;
    // `provider`, `model`, `effort` : le harnais de la coordinatrice (`remember_harness`), ce que la tâche précise.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_agent_coordinators (
           conversation TEXT PRIMARY KEY, cwd TEXT NOT NULL, max_mode TEXT NOT NULL, since INTEGER NOT NULL,
           provider TEXT, model TEXT, effort TEXT);
         CREATE TABLE IF NOT EXISTS _alfred_agent_tasks (
           id TEXT PRIMARY KEY, coordinator TEXT NOT NULL, request_id TEXT, key TEXT NOT NULL, goal TEXT NOT NULL,
           cwd TEXT NOT NULL, mode TEXT NOT NULL, depends TEXT NOT NULL, provider TEXT, model TEXT,
           status TEXT NOT NULL, conversation TEXT, summary TEXT, report TEXT, artifacts TEXT, questions TEXT,
           position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, effort TEXT);
         CREATE INDEX IF NOT EXISTS _alfred_agent_tasks_coordinator ON _alfred_agent_tasks (coordinator, position);",
    )?;
    for (table, column, kind) in ADDED_COLUMNS {
        let query = format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1");
        if !db.prepare(&query)?.exists([column])? {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};"))?;
        }
    }
    Ok(db)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Modes d’un délégué : ceux des agents de page.
fn valid_mode(mode: &str) -> bool {
    matches!(mode, "complet" | "espace-de-travail")
}

fn autonomy_of(mode: &str) -> &'static str {
    if mode == "complet" {
        "auto"
    } else {
        "workspace"
    }
}

/// Une conversation est-elle la tâche déléguée d’une autre ?
fn is_delegate(db: &Connection, conversation: &str) -> AppResult<bool> {
    Ok(db
        .query_row("SELECT 1 FROM _alfred_agent_tasks WHERE conversation = ?1", [conversation], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Marque (ou démarque) une conversation coordinatrice. `cwd` est son dossier de travail : les dossiers des tâches
/// en sont des sous-dossiers, sauf dossier accordé au module. `max_mode` borne le mode de ses délégués.
pub fn set_coordinator(state: &AppState, conversation: &str, on: bool, cwd: &str, max_mode: &str) -> AppResult<()> {
    let db = open(&state.space()?)?;
    if !on {
        db.execute("DELETE FROM _alfred_agent_coordinators WHERE conversation = ?1", [conversation])?;
        return Ok(());
    }
    if is_delegate(&db, conversation)? {
        return Err(AppError::new("Un agent délégué ne peut pas répartir à son tour le travail."));
    }
    if !valid_mode(max_mode) {
        return Err(AppError::new("Mode inconnu."));
    }
    if !Path::new(cwd).is_dir() {
        return Err(AppError::new("Le dossier de la coordinatrice est introuvable."));
    }
    db.execute(
        "INSERT INTO _alfred_agent_coordinators (conversation, cwd, max_mode, since) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (conversation) DO UPDATE SET cwd = excluded.cwd, max_mode = excluded.max_mode",
        params![conversation, cwd, max_mode, now_ms()],
    )?;
    Ok(())
}

/// La conversation reçoit-elle les outils de délégation ?
/// Une conversation peut déléguer : elle est coordinatrice, ou l’utilisateur l’a ouverte (ni page, ni délégué).
pub fn may_delegate(state: &AppState, conversation: &str) -> bool {
    if is_coordinator(state, conversation) {
        return true;
    }
    crate::agent_tools::scope_of(state, conversation).is_none()
        && state.try_space().and_then(|space| open(&space).ok()).is_some_and(|db| !is_delegate(&db, conversation).unwrap_or(true))
}

/// Toute conversation ouverte par l’utilisateur devient coordinatrice à son premier `delegate`, sans qu’il la marque :
/// son dossier de travail, et des délégués bornés à son autonomie (« Autonomie totale » : `complet`, sinon
/// `espace-de-travail`). Un délégué ne délègue jamais.
fn ensure_coordinator(state: &AppState, conversation: &str) -> AppResult<()> {
    if is_coordinator(state, conversation) {
        return Ok(());
    }
    if crate::agent_tools::scope_of(state, conversation).is_some() {
        return Err(AppError::new("Une conversation lancée par une page ne répartit le travail que si la page l’a lancée avec `coordinator: true`."));
    }
    let space = state.space()?;
    if is_delegate(&open(&space)?, conversation)? {
        return Err(AppError::new("Un agent délégué ne délègue jamais : fais la tâche toi-même, ou rends `needs_information`."));
    }
    let cwd = crate::agents::session::cwd_of(state, conversation).unwrap_or_else(|| space.root.to_string_lossy().to_string());
    let max_mode = if crate::consents::full(state, conversation) { "complet" } else { "espace-de-travail" };
    set_coordinator(state, conversation, true, &cwd, max_mode)?;
    state.emit("agent:coordinator", json!({ "conversation": conversation, "maxMode": max_mode }));
    Ok(())
}

pub fn is_coordinator(state: &AppState, conversation: &str) -> bool {
    state.try_space().and_then(|space| open(&space).ok()).is_some_and(|db| {
        db.query_row("SELECT 1 FROM _alfred_agent_coordinators WHERE conversation = ?1", [conversation], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    })
}

/// Garde le harnais de la coordinatrice : ses tâches le reprennent même quand sa session est fermée.
fn remember_harness(db: &Connection, coordinator: &str, harness: &Harness) -> AppResult<()> {
    db.execute(
        "UPDATE _alfred_agent_coordinators SET provider = ?2, model = ?3, effort = ?4 WHERE conversation = ?1",
        params![coordinator, harness.provider, harness.model, harness.effort],
    )?;
    Ok(())
}

/// Harnais de la coordinatrice : celui de sa session ouverte (gardé au passage), sinon le dernier gardé ; `None` tant
/// qu’aucun n’est connu.
fn coordinator_harness(state: &AppState, db: &Connection, coordinator: &str) -> Option<Harness> {
    if let Some(live) = super::session::harness_of(state, coordinator) {
        let _ = remember_harness(db, coordinator, &live);
        return Some(live);
    }
    db.query_row(
        "SELECT provider, model, effort FROM _alfred_agent_coordinators WHERE conversation = ?1 AND provider IS NOT NULL",
        [coordinator],
        |row| Ok(Harness { provider: row.get(0)?, model: row.get(1)?, effort: row.get(2)? }),
    )
    .optional()
    .ok()
    .flatten()
}

/// Harnais d’un délégué : ce que sa tâche précise l’emporte, le reste vient de la coordinatrice. Le modèle ne se
/// reprend que sur le même harnais, l’effort que pour le même modèle : un effort dépend du modèle (OpenCode refuse
/// celui que le modèle n’offre pas). Le booléen dit si le délégué garde le modèle de la coordinatrice : la coquille
/// prend alors modèle et effort tels quels, même absents (choix par défaut du CLI), sans les choix des réglages.
fn resolved(task: &Harness, coordinator: Option<&Harness>) -> (Harness, bool) {
    let Some(coordinator) = coordinator.filter(|coordinator| coordinator.provider.is_some()) else {
        return (task.clone(), false);
    };
    let provider = task.provider.clone().or_else(|| coordinator.provider.clone());
    let same_provider = provider == coordinator.provider;
    let model = if task.model.is_some() || !same_provider { task.model.clone() } else { coordinator.model.clone() };
    let same_model = same_provider && model == coordinator.model;
    let effort = if task.effort.is_some() || !same_model { task.effort.clone() } else { coordinator.effort.clone() };
    (Harness { provider, model, effort }, same_model)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskInput {
    key: String,
    goal: String,
    /// Sous-dossier du dossier de la coordinatrice.
    #[serde(default)]
    path: Option<String>,
    /// Dossier accordé au module de la coordinatrice (agent de page) : `{ id, path? }`.
    #[serde(default)]
    folder: Option<Value>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    depends_on: Vec<String>,
    /// Harnais, modèle et effort ; absents, ceux de la coordinatrice (`resolved`).
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
}

/// Ordre topologique des clés ; une dépendance inconnue ou un cycle refuse tout le lot.
fn topological(tasks: &[TaskInput]) -> AppResult<Vec<usize>> {
    let index: HashMap<&str, usize> = tasks.iter().enumerate().map(|(i, task)| (task.key.as_str(), i)).collect();
    let mut state = vec![0_u8; tasks.len()];
    let mut order = Vec::new();
    fn visit(i: usize, tasks: &[TaskInput], index: &HashMap<&str, usize>, state: &mut [u8], order: &mut Vec<usize>) -> AppResult<()> {
        match state[i] {
            2 => return Ok(()),
            1 => return Err(AppError::new(format!("Les dépendances forment une boucle autour de « {} ».", tasks[i].key))),
            _ => {}
        }
        state[i] = 1;
        for dependency in &tasks[i].depends_on {
            let &j = index.get(dependency.as_str()).ok_or_else(|| {
                AppError::new(format!("La tâche « {} » dépend de « {dependency} », absente du lot.", tasks[i].key))
            })?;
            visit(j, tasks, index, state, order)?;
        }
        state[i] = 2;
        order.push(i);
        Ok(())
    }
    for i in 0..tasks.len() {
        visit(i, tasks, &index, &mut state, &mut order)?;
    }
    Ok(order)
}

fn task_row(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let parse = |text: Option<String>| text.and_then(|text| serde_json::from_str::<Value>(&text).ok());
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "coordinator": row.get::<_, String>(1)?,
        "key": row.get::<_, String>(2)?,
        "goal": row.get::<_, String>(3)?,
        "cwd": row.get::<_, String>(4)?,
        "mode": row.get::<_, String>(5)?,
        "dependsOn": parse(Some(row.get::<_, String>(6)?)).unwrap_or(json!([])),
        "provider": row.get::<_, Option<String>>(7)?,
        "model": row.get::<_, Option<String>>(8)?,
        "status": row.get::<_, String>(9)?,
        "conversation": row.get::<_, Option<String>>(10)?,
        "summary": row.get::<_, Option<String>>(11)?,
        "artifacts": parse(row.get(12)?).unwrap_or(json!([])),
        "questions": parse(row.get(13)?).unwrap_or(json!([])),
        "effort": row.get::<_, Option<String>>(14)?,
        "archived": row.get::<_, Option<i64>>(15)?.unwrap_or(0) != 0,
    }))
}

const TASK_COLUMNS: &str = "id, coordinator, key, goal, cwd, mode, depends, provider, model, status, conversation, \
     summary, artifacts, questions, effort, archived";

fn tasks_of(db: &Connection, coordinator: &str) -> AppResult<Vec<Value>> {
    let mut statement = db.prepare(&format!(
        "SELECT {TASK_COLUMNS} FROM _alfred_agent_tasks WHERE coordinator = ?1 ORDER BY position"
    ))?;
    let rows = statement.query_map([coordinator], task_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Dossier d’une tâche : un sous-dossier de la coordinatrice, ou un dossier accordé au module qui l’a lancée.
fn task_dir(state: &AppState, scope: Option<&AgentScope>, root: &Path, task: &TaskInput) -> AppResult<PathBuf> {
    if let Some(folder) = &task.folder {
        let scope = scope.ok_or_else(|| {
            AppError::new("Un dossier accordé (`folder`) ne vaut que pour une coordinatrice lancée par une page ; utilise `path`.")
        })?;
        let id = folder["id"].as_str().ok_or_else(|| AppError::new("`folder` demande son `id`."))?;
        return crate::folders::resolve_dir(state, &scope.module, id, folder["path"].as_str());
    }
    // `resolve` attend une racine déjà résolue (liens symboliques, `/var` → `/private/var` sous macOS).
    let root = root.canonicalize().map_err(|_| AppError::new("Le dossier de la coordinatrice est introuvable."))?;
    let path = crate::folders::resolve(&root, task.path.as_deref().unwrap_or_default())?;
    if !path.is_dir() {
        return Err(AppError::new(format!("La tâche « {} » vise un dossier introuvable.", task.key)));
    }
    Ok(crate::folders::plain(&path))
}

/// `delegate` : valide tout le lot, puis l’enregistre ; les tâches sans dépendance sont prêtes à partir.
pub fn delegate(state: &AppState, coordinator: &str, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let db = open(&space)?;
    let (root, max_mode): (String, String) = db
        .query_row("SELECT cwd, max_mode FROM _alfred_agent_coordinators WHERE conversation = ?1", [coordinator], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?
        .ok_or_else(|| AppError::new("Cette conversation ne répartit pas le travail : l’utilisateur doit la désigner coordinatrice."))?;
    let request_id: Option<String> = opt_arg(args, "requestId")?;
    if let Some(request) = &request_id {
        let known: i64 = db.query_row(
            "SELECT count(*) FROM _alfred_agent_tasks WHERE coordinator = ?1 AND request_id = ?2",
            params![coordinator, request],
            |row| row.get(0),
        )?;
        if known > 0 {
            let tasks: Vec<Value> = tasks_of(&db, coordinator)?;
            return Ok(json!({ "repeated": true, "tasks": tasks }));
        }
    }
    let tasks: Vec<TaskInput> = arg(args, "tasks")?;
    if tasks.is_empty() || tasks.len() > MAX_TASKS {
        return Err(AppError::new("Un lot compte de 1 à 50 tâches."));
    }
    let mut keys = BTreeSet::new();
    for task in &tasks {
        if task.key.trim().is_empty() || task.key.len() > 60 || !keys.insert(task.key.as_str()) {
            return Err(AppError::new(format!("Clé de tâche vide, trop longue ou en double : « {} ».", task.key)));
        }
        if task.goal.trim().is_empty() || task.goal.len() > 20_000 {
            return Err(AppError::new(format!("L’objectif de « {} » est vide ou trop long.", task.key)));
        }
        let mode = task.mode.as_deref().unwrap_or("espace-de-travail");
        if !valid_mode(mode) {
            return Err(AppError::new(format!("Mode inconnu pour « {} » : « complet » ou « espace-de-travail ».", task.key)));
        }
        if mode == "complet" && max_mode != "complet" {
            return Err(AppError::new(format!("« {} » ne peut pas être en mode complet : la coordinatrice ne l’est pas.", task.key)));
        }
        if let Some(provider) = &task.provider {
            if !["claude", "codex", "opencode"].contains(&provider.as_str()) {
                return Err(AppError::new(format!("Harnais inconnu pour « {} ».", task.key)));
            }
        }
        if let Some(model) = &task.model {
            super::simple_value("modèle", model)?;
        }
        if let Some(effort) = &task.effort {
            super::simple_value("effort", effort)?;
        }
    }
    let order = topological(&tasks)?;
    let scope = state.app_db.lock().ok().and_then(|db| app_db::agent_scope(&db, coordinator).ok().flatten());
    let mut dirs = Vec::new();
    for task in &tasks {
        dirs.push(task_dir(state, scope.as_ref(), Path::new(&root), task)?);
    }
    let start: i64 = db.query_row(
        "SELECT coalesce(max(position), 0) FROM _alfred_agent_tasks WHERE coordinator = ?1",
        [coordinator],
        |row| row.get(0),
    )?;
    let now = now_ms();
    let mut ids: BTreeMap<String, String> = BTreeMap::new();
    for (offset, &i) in order.iter().enumerate() {
        let task = &tasks[i];
        let id = uuid::Uuid::new_v4().to_string();
        let status = if task.depends_on.is_empty() { "ready" } else { "waiting" };
        let depends: Vec<&String> = task.depends_on.iter().map(|key| &ids[key]).collect();
        db.execute(
            "INSERT INTO _alfred_agent_tasks (id, coordinator, request_id, key, goal, cwd, mode, depends, provider, model,
               status, position, created_at, updated_at, effort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14)",
            params![
                id,
                coordinator,
                request_id,
                task.key,
                task.goal,
                dirs[i].to_string_lossy(),
                task.mode.as_deref().unwrap_or("espace-de-travail"),
                serde_json::to_string(&depends)?,
                task.provider,
                task.model,
                status,
                start + 1 + offset as i64,
                now,
                task.effort,
            ],
        )?;
        ids.insert(task.key.clone(), id);
    }
    state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    Ok(json!({
        "tasks": tasks_of(&db, coordinator)?,
        "next": "Les tâches partent dès que leurs dépendances ont réussi. Termine ton tour : Alfred te relance avec le rapport de chaque tâche.",
    }))
}

/// Tâches parties pendant cette exécution d’Alfred : une tâche « en cours » qui n’en est pas vient d’une exécution
/// arrêtée, et plus aucune session ne la fait avancer.
fn claimed_here() -> &'static Mutex<HashSet<String>> {
    static CLAIMED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLAIMED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Interface qui ferme la session d’un délégué (rechargement : la nouvelle page ferme celles de l’ancienne). Si sa
/// tâche en est interrompue, elle reprend chez cette interface, que l’utilisateur regarde, et non dans une autre.
fn closers() -> &'static Mutex<HashMap<String, String>> {
    static CLOSERS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CLOSERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// L’interface `owner` va fermer la session de `conversation` (`session::close`).
pub fn closing(conversation: &str, owner: &str) {
    if let Ok(mut closers) = closers().lock() {
        closers.insert(conversation.to_owned(), owner.to_owned());
    }
}

/// Interfaces qui tiennent la session de la coordinatrice ou d’un de ses délégués en cours : ses tâches partent chez
/// elles. `live_owner` rend l’interface qui a ouvert la session d’une conversation.
fn holders(db: &Connection, coordinator: &str, live_owner: &dyn Fn(&str) -> Option<String>) -> AppResult<Vec<String>> {
    let mut statement = db.prepare(
        "SELECT conversation FROM _alfred_agent_tasks WHERE coordinator = ?1 AND status = 'running' AND conversation IS NOT NULL",
    )?;
    let delegates: Vec<String> = statement.query_map([coordinator], |row| row.get(0))?.collect::<Result<_, _>>()?;
    Ok(std::iter::once(coordinator.to_owned()).chain(delegates).filter_map(|conversation| live_owner(&conversation)).collect())
}

/// Action de la coordinatrice sur un délégué, gardée dans sa tâche jusqu’à ce qu’une interface l’exécute :
/// `message` (précision à déposer dans sa conversation), `stop` (arrêter son tour), `archive` (archiver sa
/// conversation).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Action {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

fn actions_of(db: &Connection, id: &str) -> AppResult<Vec<Action>> {
    let text: Option<String> =
        db.query_row("SELECT actions FROM _alfred_agent_tasks WHERE id = ?1", [id], |row| row.get(0)).optional()?.flatten();
    Ok(text.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default())
}

fn set_actions(db: &Connection, id: &str, actions: &[Action]) -> AppResult<()> {
    let text = if actions.is_empty() { None } else { Some(serde_json::to_string(actions)?) };
    db.execute("UPDATE _alfred_agent_tasks SET actions = ?2 WHERE id = ?1", params![id, text])?;
    Ok(())
}

fn push_action(db: &Connection, id: &str, action: Action) -> AppResult<()> {
    let mut actions = actions_of(db, id)?;
    actions.push(action);
    set_actions(db, id, &actions)
}

/// Tâches que l’interface `owner` doit faire avancer (`launch`) : les tâches prêtes (`start`, ou `continue` pour une
/// tâche relancée dans la conversation de son délégué), les tâches interrompues à reprendre dans la conversation de
/// leur délégué (`resume`), et celles qui ont épuisé leurs reprises, rendues en échec (`report`, avec le message à
/// déposer dans la coordinatrice). S’y ajoutent les actions de la coordinatrice (`message`, `stop`, `archive`).
/// `busy` : les tâches que cette interface fait déjà avancer ; `listening` : celles dont elle attend le tour, qui
/// peuvent recevoir une précision.
///
/// Le harnais, le modèle et l’effort sont résolus au départ (`resolved`) : une tâche relancée reprend ceux que la
/// coordinatrice a alors.
pub fn claim(state: &AppState, owner: Option<&str>, busy: &[String], listening: &[String]) -> AppResult<Vec<Value>> {
    claim_with(state, owner, busy, listening, &|conversation| super::session::owner_of(state, conversation))
}

fn claim_with(
    state: &AppState,
    owner: Option<&str>,
    busy: &[String],
    listening: &[String],
    live_owner: &dyn Fn(&str) -> Option<String>,
) -> AppResult<Vec<Value>> {
    let db = open(&state.space()?)?;
    let mut here = claimed_here().lock().map_err(|_| AppError::new("La délégation est indisponible."))?;
    // Une tâche « en cours » laissée par une exécution arrêtée d’Alfred : plus rien ne la fait avancer.
    let running: Vec<String> = {
        let mut statement = db.prepare("SELECT id FROM _alfred_agent_tasks WHERE status = 'running'")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in running.iter().filter(|id| !here.contains(*id) && !busy.contains(id)) {
        db.execute(
            "UPDATE _alfred_agent_tasks SET status = 'interrupted', summary = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, STOPPED_REASON, now_ms()],
        )?;
    }
    let mut allowed: HashMap<String, bool> = HashMap::new();
    // Une autre interface tient la coordinatrice ou un de ses délégués : ses tâches partent chez elle.
    let mut mine = |coordinator: &str| {
        *allowed.entry(coordinator.to_owned()).or_insert_with(|| {
            let holders = holders(&db, coordinator, live_owner).unwrap_or_default();
            holders.is_empty() || owner.is_some_and(|owner| holders.iter().any(|holder| holder == owner))
        })
    };
    let mut claimed = Vec::new();

    // Actions de la coordinatrice. Arrêt et archivage partent chez l’interface qui tient la session du délégué ;
    // une précision, chez celle qui attend son tour. Une précision arrivée après le rapport relance le délégué dans
    // sa conversation ; celle d’une tâche interrompue part avec sa reprise.
    let with_actions: Vec<(String, String, String, Option<String>)> = {
        let mut statement = db.prepare(
            "SELECT id, coordinator, status, conversation FROM _alfred_agent_tasks WHERE actions IS NOT NULL
             ORDER BY coordinator, position",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, coordinator, status, conversation) in with_actions {
        let Some(conversation) = conversation else {
            set_actions(&db, &id, &[])?;
            continue;
        };
        let held_here = busy.contains(&id)
            || match live_owner(&conversation) {
                Some(holder) => Some(holder.as_str()) == owner,
                None => mine(&coordinator),
            };
        let mut kept = Vec::new();
        let mut delivered = Vec::new();
        let mut late = Vec::new();
        for action in actions_of(&db, &id)? {
            match (action.kind.as_str(), action.text.clone()) {
                ("stop" | "archive", _) if held_here => claimed.push(json!({
                    "id": id, "coordinator": coordinator, "conversation": conversation, "launch": action.kind,
                })),
                ("message", Some(text)) if status == "running" && listening.contains(&id) => delivered.push(text),
                ("message", Some(text)) if STATUSES.contains(&status.as_str()) => late.push(text),
                ("message", Some(_)) if status == "running" || status == "interrupted" => kept.push(action),
                ("stop" | "archive", _) => kept.push(action),
                _ => {}
            }
        }
        if !delivered.is_empty() {
            claimed.push(json!({
                "id": id, "coordinator": coordinator, "conversation": conversation, "launch": "message",
                "message": delivered.join("\n\n"),
            }));
        }
        if !late.is_empty() {
            db.execute(
                "UPDATE _alfred_agent_tasks SET status = 'ready', resumes = 0, updated_at = ?3,
                   instruction = CASE WHEN instruction IS NULL THEN ?2 ELSE instruction || char(10) || char(10) || ?2 END
                 WHERE id = ?1",
                params![id, late.join("\n\n"), now_ms()],
            )?;
        }
        set_actions(&db, &id, &kept)?;
    }

    let mut statement = db.prepare(&format!(
        "SELECT {TASK_COLUMNS}, resumes, instruction FROM _alfred_agent_tasks WHERE status IN ('ready', 'interrupted')
         ORDER BY coordinator, position"
    ))?;
    let pending: Vec<(Value, i64, Option<String>)> = statement
        .query_map([], |row| Ok((task_row(row)?, row.get::<_, Option<i64>>(16)?.unwrap_or(0), row.get(17)?)))?
        .collect::<Result<_, _>>()?;
    let mut harnesses: HashMap<String, Option<Harness>> = HashMap::new();
    for (mut task, resumes, instruction) in pending {
        let id = task["id"].as_str().unwrap_or_default().to_owned();
        if busy.contains(&id) {
            continue;
        }
        let coordinator = task["coordinator"].as_str().unwrap_or_default().to_owned();
        if !mine(&coordinator) {
            continue;
        }
        let resume = task["status"] == "interrupted";
        // Prête avec une conversation : relancée dans la conversation de son délégué.
        let continued = !resume && !task["conversation"].is_null();
        // Interrompue par la fermeture qu’une interface a demandée : elle reprend chez celle-ci.
        if resume {
            let conversation = task["conversation"].as_str().unwrap_or_default();
            let closer = closers().lock().ok().and_then(|closers| closers.get(conversation).cloned());
            if closer.is_some_and(|closer| Some(closer.as_str()) != owner) {
                continue;
            }
            if let Ok(mut closers) = closers().lock() {
                closers.remove(conversation);
            }
        }
        if resume && (resumes >= MAX_RESUMES || task["conversation"].is_null()) {
            let reason = task["summary"].as_str().unwrap_or(CLOSED_REASON).to_owned();
            let summary =
                format!("{reason} Pas de nouvelle reprise automatique après {resumes} reprises : `relaunch_task` la relance.");
            let reported = report(state, &id, &json!({ "status": "failed", "summary": summary }), "")?;
            claimed.push(json!({ "id": id, "coordinator": coordinator, "launch": "report", "message": reported["message"] }));
            continue;
        }
        let known = harnesses.entry(coordinator.clone()).or_insert_with(|| coordinator_harness(state, &db, &coordinator));
        let given = |key: &str| task[key].as_str().map(str::to_owned);
        let asked = Harness { provider: given("provider"), model: given("model"), effort: given("effort") };
        let (harness, inherited) = resolved(&asked, known.as_ref());
        // Une reprise emporte les précisions que la coordinatrice a données pendant l’interruption.
        let extra: Vec<String> = if resume {
            let (texts, others): (Vec<Action>, Vec<Action>) =
                actions_of(&db, &id)?.into_iter().partition(|action| action.kind == "message");
            set_actions(&db, &id, &others)?;
            texts.into_iter().filter_map(|action| action.text).collect()
        } else {
            Vec::new()
        };
        db.execute(
            "UPDATE _alfred_agent_tasks SET status = 'running', resumes = resumes + ?3, instruction = NULL, updated_at = ?2
             WHERE id = ?1",
            params![id, now_ms(), i64::from(resume)],
        )?;
        here.insert(id);
        task["provider"] = json!(harness.provider);
        task["model"] = json!(harness.model);
        task["effort"] = json!(harness.effort);
        task["inherited"] = json!(inherited);
        task["status"] = json!("running");
        task["autonomy"] = json!(autonomy_of(task["mode"].as_str().unwrap_or_default()));
        task["launch"] = json!(if resume {
            "resume"
        } else if continued {
            "continue"
        } else {
            "start"
        });
        if continued {
            task["message"] = json!(instruction);
        } else if !extra.is_empty() {
            task["message"] = json!(extra.join("\n\n"));
        }
        claimed.push(task);
    }
    Ok(claimed)
}

/// La session d’un délégué s’est fermée : si sa tâche était en cours, elle n’aura pas de rapport. Elle passe
/// « interrompue », avec la raison, et l’interface qui tient la coordinatrice la reprend (`claim`).
pub fn session_closed(state: &AppState, conversation: &str) {
    let closer = closers().lock().ok().and_then(|mut closers| closers.remove(conversation));
    let Some(db) = state.try_space().and_then(|space| open(&space).ok()) else {
        return;
    };
    let coordinator: Option<String> = db
        .query_row(
            "SELECT coordinator FROM _alfred_agent_tasks WHERE conversation = ?1 AND status = 'running'",
            [conversation],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(coordinator) = coordinator else {
        return;
    };
    let changed = db
        .execute(
            "UPDATE _alfred_agent_tasks SET status = 'interrupted', summary = ?2, updated_at = ?3
             WHERE conversation = ?1 AND status = 'running'",
            params![conversation, CLOSED_REASON, now_ms()],
        )
        .unwrap_or(0);
    if changed > 0 {
        if let (Some(closer), Ok(mut closers)) = (closer, closers().lock()) {
            closers.insert(conversation.to_owned(), closer);
        }
        state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    }
}

/// La conversation du délégué est créée : elle hérite du périmètre de la coordinatrice (module, fonctions, entrées
/// imposées), si bien que la confidentialité d’un agent de page vaut pour toute la chaîne.
pub fn attach(state: &AppState, id: &str, conversation: &str) -> AppResult<()> {
    let db = open(&state.space()?)?;
    let coordinator: String = db
        .query_row("SELECT coordinator FROM _alfred_agent_tasks WHERE id = ?1", [id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| AppError::new("Cette tâche n’existe pas."))?;
    db.execute("UPDATE _alfred_agent_tasks SET conversation = ?2 WHERE id = ?1", params![id, conversation])?;
    let app = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    if let Some(scope) = app_db::agent_scope(&app, &coordinator)? {
        app_db::set_agent_scope(&app, conversation, &scope)?;
    }
    Ok(())
}

/// Contrat de retour d’un délégué, vérifié : statut connu, résumé borné, livrables relatifs et présents dans son
/// dossier.
fn checked_contract(cwd: &Path, report: &Value) -> (String, String, Vec<String>, Vec<String>) {
    let status = report["status"].as_str().filter(|status| STATUSES.contains(status)).unwrap_or("failed").to_owned();
    let summary: String = report["summary"]
        .as_str()
        .unwrap_or("Le délégué n’a pas rendu de résumé.")
        .chars()
        .take(SUMMARY_CHARS)
        .collect();
    let artifacts = report["artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|path| crate::folders::resolve(cwd, path).is_ok_and(|full| full.exists()))
        .map(str::to_owned)
        .take(100)
        .collect();
    let questions = report["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|question| question.chars().take(1000).collect())
        .take(20)
        .collect();
    (status, summary, artifacts, questions)
}

/// Un délégué a fini son tour : son contrat est gardé, ses dépendants partent ou sont annulés. Rend le message à
/// déposer dans la coordinatrice. Une tâche qui ne travaille plus (arrêtée par la coordinatrice, ou avec elle) garde
/// son statut : le rapport est ignoré (`ignored`) et la coordinatrice n’est pas relancée.
pub fn report(state: &AppState, id: &str, contract: &Value, full: &str) -> AppResult<Value> {
    let db = open(&state.space()?)?;
    let (coordinator, key, cwd, current): (String, String, String, String) = db
        .query_row("SELECT coordinator, key, cwd, status FROM _alfred_agent_tasks WHERE id = ?1", [id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .optional()?
        .ok_or_else(|| AppError::new("Cette tâche n’existe pas."))?;
    if current != "running" && current != "interrupted" {
        return Ok(json!({ "coordinator": coordinator, "ignored": true, "status": current }));
    }
    let root = Path::new(&cwd).canonicalize().unwrap_or_else(|_| PathBuf::from(&cwd));
    let (status, summary, artifacts, questions) = checked_contract(&root, contract);
    db.execute(
        "UPDATE _alfred_agent_tasks SET status = ?2, summary = ?3, report = ?4, artifacts = ?5, questions = ?6, updated_at = ?7
         WHERE id = ?1",
        params![id, status, summary, full, serde_json::to_string(&artifacts)?, serde_json::to_string(&questions)?, now_ms()],
    )?;
    settle_dependents(&db, &coordinator)?;
    state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    let mut message = format!("Rapport de la tâche déléguée « {key} » : {status}.\n\n{summary}");
    if !artifacts.is_empty() {
        message.push_str(&format!("\n\nLivrables (dans {cwd}) : {}", artifacts.join(", ")));
    }
    if !questions.is_empty() {
        message.push_str(&format!("\n\nQuestions :\n- {}", questions.join("\n- ")));
    }
    let remaining: i64 = db.query_row(
        "SELECT count(*) FROM _alfred_agent_tasks WHERE coordinator = ?1 AND status IN ('waiting', 'ready', 'running', 'interrupted')",
        [&coordinator],
        |row| row.get(0),
    )?;
    message.push_str(&format!(
        "\n\nTâches encore en cours ou en attente : {remaining}. `read_report` lit le rapport complet (identifiant {id})."
    ));
    Ok(json!({ "coordinator": coordinator, "message": message, "status": status }))
}

/// Les tâches en attente d’une coordinatrice : prêtes quand toutes leurs dépendances ont réussi, annulées dès que
/// l’une a fini sans succès. Rend les clés des tâches annulées.
fn settle_dependents(db: &Connection, coordinator: &str) -> AppResult<Vec<String>> {
    let mut cancelled = Vec::new();
    let waiting: Vec<(String, String, String)> = {
        let mut statement =
            db.prepare("SELECT id, depends, key FROM _alfred_agent_tasks WHERE coordinator = ?1 AND status = 'waiting'")?;
        let rows = statement.query_map([coordinator], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let status_of = |task: &str| -> AppResult<String> {
        Ok(db.query_row("SELECT status FROM _alfred_agent_tasks WHERE id = ?1", [task], |row| row.get(0))?)
    };
    let mut cascade = true;
    while cascade {
        cascade = false;
        for (task, depends, key) in &waiting {
            if status_of(task)? != "waiting" {
                continue;
            }
            let depends: Vec<String> = serde_json::from_str(depends).unwrap_or_default();
            let statuses: Vec<String> = depends.iter().map(|dependency| status_of(dependency)).collect::<AppResult<_>>()?;
            if statuses.iter().all(|status| status == "success") {
                db.execute("UPDATE _alfred_agent_tasks SET status = 'ready' WHERE id = ?1", [task])?;
            } else if statuses.iter().any(|status| STATUSES.contains(&status.as_str()) && status != "success") {
                db.execute(
                    "UPDATE _alfred_agent_tasks SET status = 'cancelled', summary = 'Annulée : une tâche dont elle dépend n’a pas réussi.' WHERE id = ?1",
                    [task],
                )?;
                cancelled.push(key.clone());
                cascade = true;
            }
        }
    }
    Ok(cancelled)
}

/// Rapport complet d’une tâche, par pages de 4 000 caractères.
pub fn read_report(state: &AppState, coordinator: &str, id: &str, page: usize) -> AppResult<Value> {
    let db = open(&state.space()?)?;
    let report: Option<String> = db
        .query_row(
            "SELECT report FROM _alfred_agent_tasks WHERE id = ?1 AND coordinator = ?2",
            params![id, coordinator],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::new("Cette tâche n’appartient pas à cette conversation."))?;
    let text: Vec<char> = report.unwrap_or_default().chars().collect();
    let pages = text.len().div_ceil(REPORT_PAGE).max(1);
    let start = page.min(pages - 1) * REPORT_PAGE;
    Ok(json!({
        "page": page.min(pages - 1),
        "pages": pages,
        "text": text[start..(start + REPORT_PAGE).min(text.len())].iter().collect::<String>(),
    }))
}

/// Statut, conversation et archivage d’une tâche de la coordinatrice ; une autre coordinatrice n’y touche pas.
fn owned_task(state: &AppState, db: &Connection, coordinator: &str, id: &str) -> AppResult<(String, Option<String>, bool)> {
    let (status, conversation, archived): (String, Option<String>, i64) = db
        .query_row(
            "SELECT status, conversation, archived FROM _alfred_agent_tasks WHERE id = ?1 AND coordinator = ?2",
            params![id, coordinator],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<i64>>(2)?.unwrap_or(0))),
        )
        .optional()?
        .ok_or_else(|| AppError::new("Cette tâche n’appartient pas à cette conversation."))?;
    let archived = archived != 0 || conversation.as_deref().is_some_and(|conversation| conversation_archived(state, conversation));
    Ok((status, conversation, archived))
}

/// La conversation a-t-elle été archivée (par l’utilisateur ou par la coordinatrice) ?
fn conversation_archived(state: &AppState, conversation: &str) -> bool {
    state.app_db.lock().ok().is_some_and(|db| {
        db.query_row("SELECT json_extract(data, '$.archived') FROM conversations WHERE id = ?1", [conversation], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .optional()
        .ok()
        .flatten()
        .flatten()
        .is_some_and(|archived| archived != 0)
    })
}

/// Précision de la coordinatrice, ajoutée à l’objectif gardé de la tâche.
fn precision(text: &str) -> String {
    format!("Précision de la coordinatrice : {text}")
}

fn checked_instruction(text: Option<&str>) -> AppResult<Option<&str>> {
    match text.map(str::trim) {
        Some("") | None => Ok(None),
        Some(text) if text.len() > 20_000 => Err(AppError::new("La consigne est trop longue.")),
        Some(text) => Ok(Some(text)),
    }
}

/// Relance une tâche qui ne travaille plus (finie, réussie ou non, arrêtée ou interrompue), avec une consigne
/// facultative, ajoutée à son objectif. Par défaut, le délégué reprend dans sa conversation : il garde son contexte et
/// sa session de CLI, et reçoit la consigne. `fresh` (ou une tâche jamais partie) la relance dans une conversation
/// neuve, avec l’objectif complet. Une conversation archivée ne se reprend pas : l’archivage est une décision de
/// l’utilisateur ou de la coordinatrice, qu’un agent ne défait pas en silence ; `fresh` reste possible.
/// Elle repart avec le harnais que la coordinatrice a au moment de la relance, sauf ce que la tâche précise (`claim`).
pub fn relaunch(state: &AppState, coordinator: &str, id: &str, extra: Option<&str>, fresh: bool) -> AppResult<Value> {
    let db = open(&state.space()?)?;
    let extra = checked_instruction(extra)?;
    let (status, conversation, archived) = owned_task(state, &db, coordinator, id)?;
    if WORKING.contains(&status.as_str()) && status != "interrupted" {
        return Err(AppError::new(
            "Cette tâche travaille encore (ou attend de partir) : complète-la avec `add_to_task`, ou arrête-la avec `stop_task`.",
        ));
    }
    let in_place = !fresh && conversation.is_some();
    if in_place && archived {
        return Err(AppError::new(
            "La conversation de ce délégué est archivée : relance la tâche avec `fresh: true`, dans une conversation neuve.",
        ));
    }
    let messages: Vec<Action> = actions_of(&db, id)?.into_iter().filter(|action| action.kind != "message").collect();
    set_actions(&db, id, &messages)?;
    db.execute(
        "UPDATE _alfred_agent_tasks SET status = 'ready', resumes = 0, updated_at = ?5,
           conversation = CASE WHEN ?4 THEN conversation ELSE NULL END,
           archived = CASE WHEN ?4 THEN archived ELSE 0 END,
           instruction = CASE WHEN ?4 THEN ?3 ELSE NULL END,
           goal = CASE WHEN ?3 IS NULL THEN goal ELSE goal || char(10) || char(10) || 'Précision de la coordinatrice : ' || ?3 END
         WHERE id = ?1 AND coordinator = ?2",
        params![id, coordinator, extra, in_place, now_ms()],
    )?;
    state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    Ok(json!({
        "relaunched": id,
        "conversation": if in_place { "same" } else { "new" },
        "next": "Termine ton tour : Alfred te relance avec le rapport de la tâche.",
    }))
}

/// Complète la tâche d’un délégué : la précision rejoint son objectif. S’il travaille, elle part aussi dans sa
/// conversation (glissée dans sa réponse si son agent le sait, sinon à la suite) ; la tâche reste en cours et rend un
/// seul rapport. Une tâche pas encore partie la reçoit avec son objectif. Une tâche finie se relance.
pub fn add_to_task(state: &AppState, coordinator: &str, id: &str, text: &str) -> AppResult<Value> {
    let db = open(&state.space()?)?;
    let text = checked_instruction(Some(text))?.ok_or_else(|| AppError::new("La précision est vide."))?;
    let (status, conversation, _) = owned_task(state, &db, coordinator, id)?;
    if !WORKING.contains(&status.as_str()) {
        return Err(AppError::new(
            "Cette tâche est finie : relance-la avec `relaunch_task` et ta consigne (`instruction`).",
        ));
    }
    db.execute(
        "UPDATE _alfred_agent_tasks SET goal = goal || char(10) || char(10) || ?3, updated_at = ?4
         WHERE id = ?1 AND coordinator = ?2",
        params![id, coordinator, precision(text), now_ms()],
    )?;
    let live = conversation.is_some() && (status == "running" || status == "interrupted");
    if live {
        push_action(&db, id, Action { kind: "message".into(), text: Some(precision(text)) })?;
        state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    }
    Ok(json!({
        "added": id,
        "delivered": if live { "conversation" } else { "goal" },
        "next": if live {
            "La précision part dans la conversation du délégué ; sa tâche reste en cours et rend un seul rapport."
        } else {
            "La précision rejoint l’objectif : le délégué la recevra à son départ."
        },
    }))
}

/// Arrête la tâche d’un délégué qui travaille ou attend de partir : elle passe « annulée » (« Arrêtée par la
/// coordinatrice »), ses dépendants sont annulés comme après un échec, et son tour est interrompu. Le rapport de ce
/// tour annulé est ignoré (`report`) : la coordinatrice n’est pas relancée. Rend `false` si la tâche ne travaillait
/// pas (`None`), sinon les clés des dépendants annulés.
fn stop_one(db: &Connection, coordinator: &str, id: &str) -> AppResult<Option<Vec<String>>> {
    let (status, conversation): (String, Option<String>) = db.query_row(
        "SELECT status, conversation FROM _alfred_agent_tasks WHERE id = ?1 AND coordinator = ?2",
        params![id, coordinator],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !WORKING.contains(&status.as_str()) {
        return Ok(None);
    }
    db.execute(
        "UPDATE _alfred_agent_tasks SET status = 'cancelled', summary = ?3, instruction = NULL, updated_at = ?4
         WHERE id = ?1 AND coordinator = ?2",
        params![id, coordinator, STOPPED_BY_COORDINATOR, now_ms()],
    )?;
    // Ses précisions en attente n’ont plus d’objet ; son tour en cours s’arrête.
    let mut actions: Vec<Action> = actions_of(db, id)?.into_iter().filter(|action| action.kind != "message").collect();
    if status == "running" && conversation.is_some() {
        actions.push(Action { kind: "stop".into(), text: None });
    }
    set_actions(db, id, &actions)?;
    Ok(Some(settle_dependents(db, coordinator)?))
}

pub fn stop_task(state: &AppState, coordinator: &str, id: &str) -> AppResult<Value> {
    let db = open(&state.space()?)?;
    owned_task(state, &db, coordinator, id)?;
    let cancelled = stop_one(&db, coordinator, id)?
        .ok_or_else(|| AppError::new("Cette tâche ne travaille pas : il n’y a rien à arrêter."))?;
    state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    Ok(json!({
        "stopped": id,
        "status": "cancelled",
        "cancelledDependents": cancelled,
        "next": "La tâche est arrêtée ; aucun rapport ne suivra. `relaunch_task` la relance.",
    }))
}

/// Archive la conversation d’un délégué, après l’avoir arrêté s’il travaillait. La tâche reste lisible dans
/// `task_status` (`archived`).
pub fn archive_task(state: &AppState, coordinator: &str, id: &str) -> AppResult<Value> {
    let db = open(&state.space()?)?;
    let (_, conversation, _) = owned_task(state, &db, coordinator, id)?;
    let stopped = stop_one(&db, coordinator, id)?;
    db.execute("UPDATE _alfred_agent_tasks SET archived = 1 WHERE id = ?1", [id])?;
    if conversation.is_some() {
        push_action(&db, id, Action { kind: "archive".into(), text: None })?;
    }
    state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    Ok(json!({
        "archived": id,
        "stopped": stopped.is_some(),
        "cancelledDependents": stopped.unwrap_or_default(),
        "next": "La conversation du délégué est archivée ; la tâche reste dans `task_status`. `relaunch_task` avec `fresh: true` la relance.",
    }))
}

/// Tâches de la coordinatrice pour `task_status`, avec l’archivage des conversations de leurs délégués.
fn status_of_tasks(state: &AppState, coordinator: &str) -> AppResult<Vec<Value>> {
    let mut tasks = tasks_of(&open(&state.space()?)?, coordinator)?;
    for task in &mut tasks {
        if task["archived"] != true && task["conversation"].as_str().is_some_and(|conversation| conversation_archived(state, conversation)) {
            task["archived"] = json!(true);
        }
    }
    Ok(tasks)
}

/// Une précision livrée trop tard (le tour du délégué venait de finir) revient dans la tâche : `claim` la livre à
/// la reprise, ou relance le délégué dans sa conversation si la tâche est finie.
pub fn defer(state: &AppState, id: &str, text: &str) -> AppResult<()> {
    let db = open(&state.space()?)?;
    let coordinator: String = db.query_row("SELECT coordinator FROM _alfred_agent_tasks WHERE id = ?1", [id], |row| row.get(0))?;
    push_action(&db, id, Action { kind: "message".into(), text: Some(text.to_owned()) })?;
    state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    Ok(())
}

/// La coordinatrice est arrêtée ou archivée : ses tâches non finies sont annulées. Rend les conversations des
/// délégués en cours, que la coquille arrête.
pub fn stop(state: &AppState, coordinator: &str) -> AppResult<Vec<String>> {
    let db = open(&state.space()?)?;
    let mut statement = db.prepare(
        "SELECT conversation FROM _alfred_agent_tasks WHERE coordinator = ?1 AND status = 'running' AND conversation IS NOT NULL",
    )?;
    let running: Vec<String> = statement.query_map([coordinator], |row| row.get(0))?.collect::<Result<_, _>>()?;
    db.execute(
        "UPDATE _alfred_agent_tasks SET status = 'cancelled', summary = coalesce(summary, 'Arrêtée avec la coordinatrice.')
         WHERE coordinator = ?1 AND status IN ('waiting', 'ready', 'running', 'interrupted')",
        [coordinator],
    )?;
    state.emit("agent:tasks", json!({ "coordinator": coordinator }));
    Ok(running)
}

/// Délégués d’une coordinatrice et coordinatrice d’un délégué, pour la liste des conversations.
pub fn links(state: &AppState) -> AppResult<Value> {
    let db = open(&state.space()?)?;
    let mut statement = db.prepare("SELECT conversation, coordinator, key, status FROM _alfred_agent_tasks WHERE conversation IS NOT NULL")?;
    let rows: Vec<Value> = statement
        .query_map([], |row| {
            Ok(json!({ "conversation": row.get::<_, String>(0)?, "coordinator": row.get::<_, String>(1)?,
                       "key": row.get::<_, String>(2)?, "status": row.get::<_, String>(3)? }))
        })?
        .collect::<Result<_, _>>()?;
    let mut statement = db.prepare("SELECT conversation FROM _alfred_agent_coordinators")?;
    let coordinators: Vec<String> = statement.query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?;
    Ok(json!({ "delegates": rows, "coordinators": coordinators }))
}

/// Outils de délégation, offerts aux seules coordinatrices.
pub fn tools() -> Vec<Value> {
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({ "name": name, "description": description,
                "inputSchema": { "type": "object", "properties": properties, "required": required } })
    };
    vec![
        tool(
            "delegate",
            "Confie de 1 à 50 tâches à d’autres agents. Chaque tâche : `key` unique, `goal` (objectif complet : le délégué ne voit pas cette conversation), `path` (sous-dossier de ton dossier) ou `folder` ({ id, path } d’un dossier accordé au module), `mode` (« espace-de-travail » par défaut, ou « complet »), `dependsOn` (clés du lot), `provider`, `model` et `effort` facultatifs (par défaut : ceux de ta conversation). Le lot est validé en entier ; une tâche part quand ses dépendances ont réussi. `requestId` rend la même réponse si tu répètes la demande. Termine ton tour ensuite : tu seras relancé avec chaque rapport. À utiliser pour plusieurs parties indépendantes (plusieurs modules) ; pas pour une seule tâche ni un petit travail.",
            json!({
                "requestId": { "type": "string" },
                "tasks": { "type": "array", "minItems": 1, "maxItems": 50, "items": { "type": "object",
                    "properties": {
                        "key": { "type": "string" }, "goal": { "type": "string" }, "path": { "type": "string" },
                        "folder": { "type": "object" }, "mode": { "enum": ["espace-de-travail", "complet"] },
                        "dependsOn": { "type": "array", "items": { "type": "string" } },
                        "provider": { "enum": ["claude", "codex", "opencode"] }, "model": { "type": "string" },
                        "effort": { "type": "string" }
                    }, "required": ["key", "goal"] } },
            }),
            &["tasks"],
        ),
        tool("task_status", "État des tâches que tu as déléguées : statut, résumé, livrables, questions.", json!({}), &[]),
        tool(
            "read_report",
            "Rapport complet d’une tâche déléguée, par pages de 4 000 caractères.",
            json!({ "id": { "type": "string" }, "page": { "type": "integer", "minimum": 0 } }),
            &["id"],
        ),
        tool(
            "relaunch_task",
            "Relance un délégué qui ne travaille plus (tâche finie, même réussie, arrêtée ou interrompue), avec une consigne facultative ajoutée à son objectif. Par défaut, il reprend dans sa conversation et garde son contexte ; `fresh: true` le relance dans une conversation neuve, avec l’objectif complet (obligatoire si sa conversation est archivée). Termine ton tour ensuite.",
            json!({ "id": { "type": "string" }, "instruction": { "type": "string" }, "fresh": { "type": "boolean" } }),
            &["id"],
        ),
        tool(
            "add_to_task",
            "Complète la tâche d’un délégué qui travaille ou n’est pas encore parti : la précision rejoint son objectif et, s’il travaille, sa conversation. Sa tâche reste en cours et rend un seul rapport. Pour une tâche finie, utilise `relaunch_task` avec `instruction`.",
            json!({ "id": { "type": "string" }, "instruction": { "type": "string" } }),
            &["id", "instruction"],
        ),
        tool(
            "stop_task",
            "Arrête un délégué qui travaille, ou une tâche pas encore partie : elle passe « cancelled », celles qui en dépendent sont annulées, et aucun rapport ne suit. `relaunch_task` la relance.",
            json!({ "id": { "type": "string" } }),
            &["id"],
        ),
        tool(
            "archive_task",
            "Archive la conversation d’un délégué, après l’avoir arrêté s’il travaillait. La tâche reste dans `task_status` (`archived`) ; seule une relance avec `fresh: true` la refait partir.",
            json!({ "id": { "type": "string" } }),
            &["id"],
        ),
    ]
}

/// Appel d’un outil de délégation par la coordinatrice `conversation`.
pub fn call(state: &AppState, conversation: &str, name: &str, args: &Value) -> Option<AppResult<Value>> {
    if !matches!(
        name,
        "delegate" | "task_status" | "read_report" | "relaunch_task" | "add_to_task" | "stop_task" | "archive_task"
    ) {
        return None;
    }
    if name == "delegate" {
        if let Err(error) = ensure_coordinator(state, conversation) {
            return Some(Err(error));
        }
    } else if !is_coordinator(state, conversation) {
        return Some(Err(AppError::new("Cette conversation n’a encore rien délégué.")));
    }
    // La coordinatrice est en plein tour : Alfred garde son harnais pour les tâches qui partiront après sa session.
    if let Some(live) = super::session::harness_of(state, conversation) {
        if let Ok(db) = state.space().and_then(|space| open(&space)) {
            let _ = remember_harness(&db, conversation, &live);
        }
    }
    Some(match name {
        "delegate" => delegate(state, conversation, args),
        "task_status" => status_of_tasks(state, conversation).map(Value::from),
        "read_report" => arg::<String>(args, "id").and_then(|id| {
            let page = opt_arg::<usize>(args, "page")?.unwrap_or(0);
            read_report(state, conversation, &id, page)
        }),
        "relaunch_task" => arg::<String>(args, "id").and_then(|id| {
            let extra: Option<String> = opt_arg(args, "instruction")?;
            let fresh = opt_arg::<bool>(args, "fresh")?.unwrap_or(false);
            relaunch(state, conversation, &id, extra.as_deref(), fresh)
        }),
        "add_to_task" => arg::<String>(args, "id")
            .and_then(|id| add_to_task(state, conversation, &id, &arg::<String>(args, "instruction")?)),
        "stop_task" => arg::<String>(args, "id").and_then(|id| stop_task(state, conversation, &id)),
        _ => arg::<String>(args, "id").and_then(|id| archive_task(state, conversation, &id)),
    })
}

/// Commandes de la coquille.
pub async fn handle(state: &std::sync::Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "agents.coordinator.set" => (|| {
            let conversation: String = arg(args, "conversation")?;
            let on: bool = arg(args, "on")?;
            let cwd: String = opt_arg(args, "cwd")?.unwrap_or_default();
            let max_mode: String = opt_arg(args, "maxMode")?.unwrap_or_else(|| "complet".into());
            set_coordinator(state, &conversation, on, &cwd, &max_mode).map(|_| Value::Null)
        })(),
        "agents.tasks.claim" => (|| {
            let owner: Option<String> = opt_arg(args, "owner")?;
            let busy: Vec<String> = opt_arg(args, "busy")?.unwrap_or_default();
            let listening: Vec<String> = opt_arg(args, "listening")?.unwrap_or_default();
            claim(state, owner.as_deref(), &busy, &listening).map(Value::from)
        })(),
        "agents.tasks.defer" => (|| {
            defer(state, &arg::<String>(args, "id")?, &arg::<String>(args, "text")?).map(|_| Value::Null)
        })(),
        "agents.tasks.attach" => (|| {
            attach(state, &arg::<String>(args, "id")?, &arg::<String>(args, "conversation")?).map(|_| Value::Null)
        })(),
        "agents.tasks.report" => (|| {
            let full: String = opt_arg(args, "text")?.unwrap_or_default();
            report(state, &arg::<String>(args, "id")?, &args["contract"], &full)
        })(),
        "agents.tasks.stop" => arg::<String>(args, "coordinator").and_then(|coordinator| stop(state, &coordinator)).map(Value::from),
        "agents.tasks.links" => links(state),
        "agents.tasks.list" => arg::<String>(args, "coordinator")
            .and_then(|coordinator| tasks_of(&open(&state.space()?)?, &coordinator))
            .map(Value::from),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn setup() -> (Arc<AppState>, tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        state.set_space(Some(space));
        let work = dir.path().join("travail");
        for sub in ["front", "back"] {
            std::fs::create_dir_all(work.join(sub)).unwrap();
        }
        (state, dir, work)
    }

    fn task(key: &str, path: &str, depends: &[&str]) -> Value {
        json!({ "key": key, "goal": format!("Faire {key}"), "path": path, "dependsOn": depends })
    }

    fn harness(provider: Option<&str>, model: Option<&str>, effort: Option<&str>) -> Harness {
        let owned = |value: Option<&str>| value.map(str::to_owned);
        Harness { provider: owned(provider), model: owned(model), effort: owned(effort) }
    }

    /// Harnais, modèle et effort d’une tâche réclamée, et si modèle et effort viennent de la coordinatrice.
    fn launched(task: &Value) -> (Option<&str>, Option<&str>, Option<&str>, bool) {
        (task["provider"].as_str(), task["model"].as_str(), task["effort"].as_str(), task["inherited"] == true)
    }

    /// Un délégué reprend le harnais, le modèle et l’effort de la coordinatrice ; ce que sa tâche précise l’emporte.
    /// Le modèle ne passe pas à un autre harnais, ni l’effort à un autre modèle.
    #[test]
    fn a_delegate_takes_from_its_coordinator_what_its_task_leaves_out() {
        let opus = harness(Some("claude"), Some("opus"), Some("high"));
        let cases = [
            // (tâche, harnais du délégué, modèle et effort repris tels quels)
            (Harness::default(), harness(Some("claude"), Some("opus"), Some("high")), true),
            (harness(None, None, Some("max")), harness(Some("claude"), Some("opus"), Some("max")), true),
            (harness(Some("claude"), Some("opus"), None), harness(Some("claude"), Some("opus"), Some("high")), true),
            (harness(None, Some("sonnet"), None), harness(Some("claude"), Some("sonnet"), None), false),
            (harness(None, Some("sonnet"), Some("low")), harness(Some("claude"), Some("sonnet"), Some("low")), false),
            (harness(Some("codex"), None, None), harness(Some("codex"), None, None), false),
            (harness(Some("codex"), None, Some("low")), harness(Some("codex"), None, Some("low")), false),
            (harness(Some("opencode"), Some("a/b"), Some("x")), harness(Some("opencode"), Some("a/b"), Some("x")), false),
        ];
        for (task, expected, inherited) in cases {
            assert_eq!(resolved(&task, Some(&opus)), (expected, inherited), "tâche {task:?}");
        }
        // Le modèle par défaut du CLI se reprend aussi, tel quel : pas celui des réglages.
        let default = harness(Some("codex"), None, Some("medium"));
        assert_eq!(resolved(&Harness::default(), Some(&default)), (default.clone(), true));
        // Harnais de la coordinatrice inconnu : la tâche telle quelle.
        let sonnet = harness(None, Some("sonnet"), None);
        assert_eq!(resolved(&sonnet, None), (sonnet.clone(), false));
        assert_eq!(resolved(&sonnet, Some(&Harness::default())), (sonnet, false));
    }

    /// Le harnais gardé pendant le tour de la coordinatrice part avec chaque tâche prête. Une tâche relancée prend
    /// celui que la coordinatrice a au moment de la relance ; ce que la tâche précise ne change pas.
    #[test]
    fn claimed_and_relaunched_tasks_carry_the_coordinator_harness() {
        let (state, _dir, work) = setup();
        // Coordinatrice marquée par l’utilisateur ou lancée par une page (`coordinator: true`).
        set_coordinator(&state, "coord", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        let db = open(&state.space().unwrap()).unwrap();
        remember_harness(&db, "coord", &harness(Some("claude"), Some("opus"), Some("high"))).unwrap();
        let batch = json!({ "tasks": [
            { "key": "notes", "goal": "Module notes" },
            { "key": "contacts", "goal": "Module contacts", "model": "sonnet" },
            { "key": "documents", "goal": "Base documentaire", "provider": "codex", "model": "gpt-5", "effort": "low" },
        ] });
        let delegated = delegate(&state, "coord", &batch).unwrap();
        assert_eq!(delegated["tasks"][2]["effort"], "low", "{delegated}");
        let bad = json!({ "tasks": [{ "key": "a", "goal": "x", "effort": "élevé; rm -rf /" }] });
        assert!(delegate(&state, "coord", &bad).is_err(), "un effort se vérifie comme un modèle");
        let ready = claim(&state, None, &[], &[]).unwrap();
        assert_eq!(
            ready.iter().map(launched).collect::<Vec<_>>(),
            [
                (Some("claude"), Some("opus"), Some("high"), true),
                (Some("claude"), Some("sonnet"), None, false),
                (Some("codex"), Some("gpt-5"), Some("low"), false),
            ]
        );
        for task in &ready {
            report(&state, task["id"].as_str().unwrap(), &json!({ "status": "failed", "summary": "Échec" }), "").unwrap();
        }
        // L’utilisateur passe la coordinatrice sur Sonnet · maximal, puis elle relance deux tâches.
        remember_harness(&db, "coord", &harness(Some("claude"), Some("sonnet"), Some("max"))).unwrap();
        relaunch(&state, "coord", ready[0]["id"].as_str().unwrap(), None, true).unwrap();
        relaunch(&state, "coord", ready[2]["id"].as_str().unwrap(), Some("Réessaie"), true).unwrap();
        assert_eq!(
            claim(&state, None, &[], &[]).unwrap().iter().map(launched).collect::<Vec<_>>(),
            [(Some("claude"), Some("sonnet"), Some("max"), true), (Some("codex"), Some("gpt-5"), Some("low"), false)]
        );
        // Marquer de nouveau la coordinatrice garde son harnais.
        set_coordinator(&state, "coord", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        assert_eq!(coordinator_harness(&state, &db, "coord"), Some(harness(Some("claude"), Some("sonnet"), Some("max"))));
    }

    /// Une base d’avant l’héritage du harnais reçoit ses colonnes ; ses tâches partent comme les autres.
    #[test]
    fn an_older_base_gets_the_harness_columns() {
        let (state, _dir, work) = setup();
        let space = state.space().unwrap();
        crate::space_db::open(&space)
            .unwrap()
            .execute_batch(
                "CREATE TABLE _alfred_agent_coordinators (
                   conversation TEXT PRIMARY KEY, cwd TEXT NOT NULL, max_mode TEXT NOT NULL, since INTEGER NOT NULL);
                 CREATE TABLE _alfred_agent_tasks (
                   id TEXT PRIMARY KEY, coordinator TEXT NOT NULL, request_id TEXT, key TEXT NOT NULL, goal TEXT NOT NULL,
                   cwd TEXT NOT NULL, mode TEXT NOT NULL, depends TEXT NOT NULL, provider TEXT, model TEXT,
                   status TEXT NOT NULL, conversation TEXT, summary TEXT, report TEXT, artifacts TEXT, questions TEXT,
                   position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
            )
            .unwrap();
        set_coordinator(&state, "coord", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        remember_harness(&open(&space).unwrap(), "coord", &harness(Some("claude"), Some("opus"), Some("high"))).unwrap();
        delegate(&state, "coord", &json!({ "tasks": [{ "key": "a", "goal": "x", "effort": "max" }] })).unwrap();
        assert_eq!(launched(&claim(&state, None, &[], &[]).unwrap()[0]), (Some("claude"), Some("opus"), Some("max"), true));
    }

    /// Une conversation ouverte par l’utilisateur délègue sans être marquée : elle devient coordinatrice à son premier
    /// `delegate`, bornée à son autonomie. Un délégué ou une conversation de page ne le peut pas.
    #[test]
    fn a_user_conversation_delegates_without_being_marked() {
        let (state, _dir, _work) = setup();
        assert!(may_delegate(&state, "utilisateur"));
        let two = json!({ "tasks": [{ "key": "notes", "goal": "Module notes" }, { "key": "contacts", "goal": "Module contacts" }] });
        let delegated = call(&state, "utilisateur", "delegate", &two).unwrap().unwrap();
        assert_eq!(delegated["tasks"].as_array().map(Vec::len), Some(2), "{delegated}");
        assert!(is_coordinator(&state, "utilisateur"));
        let ready = claim(&state, None, &[], &[]).unwrap();
        assert_eq!(ready.len(), 2, "deux modules indépendants partent ensemble");
        assert!(ready.iter().all(|task| task["autonomy"] == "workspace"), "hors Autonomie totale : espace de travail");
        // Le délégué ne délègue jamais, et n’a pas les commandes de délégation.
        attach(&state, ready[0]["id"].as_str().unwrap(), "delegue-notes").unwrap();
        assert!(!may_delegate(&state, "delegue-notes"));
        let refused = call(&state, "delegue-notes", "delegate", &two).unwrap().unwrap_err();
        assert!(refused.message.contains("ne délègue jamais"), "{}", refused.message);
        // Une conversation de page ne devient pas coordinatrice d’elle-même.
        let scope = AgentScope { module: "notes".into(), ..AgentScope::default() };
        crate::app_db::set_agent_scope(&state.app_db.lock().unwrap(), "page", &scope).unwrap();
        assert!(!may_delegate(&state, "page"));
        assert!(call(&state, "page", "delegate", &two).unwrap().is_err());
        // En « Autonomie totale », les délégués peuvent l’être aussi.
        crate::consents::TEST_AUTONOMY.lock().unwrap().push(("totale", crate::agents::session::Autonomy::Auto));
        let full = json!({ "tasks": [{ "key": "a", "goal": "x", "mode": "complet" }] });
        assert!(call(&state, "totale", "delegate", &full).unwrap().is_ok());
        crate::consents::TEST_AUTONOMY.lock().unwrap().retain(|(conversation, _)| *conversation != "totale");
    }

    #[test]
    fn three_dependent_tasks_on_two_folders() {
        let (state, _dir, work) = setup();
        let cwd = work.to_string_lossy().to_string();
        assert!(delegate(&state, "coord", &json!({ "tasks": [task("a", "front", &[])] })).is_err(), "pas coordinatrice");
        set_coordinator(&state, "coord", true, &cwd, "espace-de-travail").unwrap();

        // Tout le lot est refusé : boucle, dépendance absente, mode trop large, dossier hors de la coordinatrice.
        let cycle = json!({ "tasks": [task("a", "front", &["b"]), task("b", "back", &["a"])] });
        assert!(delegate(&state, "coord", &cycle).unwrap_err().message.contains("boucle"));
        assert!(delegate(&state, "coord", &json!({ "tasks": [task("a", "front", &["z"])] })).is_err());
        let full = json!({ "tasks": [{ "key": "a", "goal": "x", "mode": "complet" }] });
        assert!(delegate(&state, "coord", &full).is_err());
        assert!(delegate(&state, "coord", &json!({ "tasks": [task("a", "../..", &[])] })).is_err());
        assert!(claim(&state, None, &[], &[]).unwrap().is_empty(), "un lot refusé ne lance rien");

        let batch = json!({ "requestId": "r1", "tasks": [
            task("api", "back", &[]), task("ecran", "front", &["api"]), task("doc", "front", &["api", "ecran"]),
        ] });
        delegate(&state, "coord", &batch).unwrap();
        assert_eq!(delegate(&state, "coord", &batch).unwrap()["repeated"], true, "même requestId, même réponse");
        let ready = claim(&state, None, &[], &[]).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0]["key"], "api");
        assert_eq!(ready[0]["autonomy"], "workspace");
        assert!(ready[0]["cwd"].as_str().unwrap().ends_with("back"));
        attach(&state, ready[0]["id"].as_str().unwrap(), "delegue-api").unwrap();
        assert!(set_coordinator(&state, "delegue-api", true, &cwd, "complet").is_err(), "un délégué ne délègue pas");

        std::fs::write(work.join("back").join("api.md"), "ok").unwrap();
        let done = report(
            &state,
            ready[0]["id"].as_str().unwrap(),
            &json!({ "status": "success", "summary": "API prête", "artifacts": ["api.md", "absent.md", "../x"] }),
            "Rapport complet",
        )
        .unwrap();
        assert_eq!(done["coordinator"], "coord");
        assert!(done["message"].as_str().unwrap().contains("Livrables (dans") && !done["message"].as_str().unwrap().contains("absent.md"));
        let next = claim(&state, None, &[], &[]).unwrap();
        assert_eq!(next.iter().map(|task| task["key"].as_str().unwrap()).collect::<Vec<_>>(), ["ecran"]);
        // L’écran échoue : la documentation, qui en dépend, est annulée.
        report(&state, next[0]["id"].as_str().unwrap(), &json!({ "status": "failed", "summary": "Échec" }), "").unwrap();
        let tasks = tasks_of(&open(&state.space().unwrap()).unwrap(), "coord").unwrap();
        assert_eq!(tasks.iter().map(|task| task["status"].as_str().unwrap()).collect::<Vec<_>>(), ["success", "failed", "cancelled"]);
        assert!(claim(&state, None, &[], &[]).unwrap().is_empty());

        // Relance de l’écran avec une précision ; la page du rapport se lit.
        relaunch(&state, "coord", next[0]["id"].as_str().unwrap(), Some("Utilise la v2"), true).unwrap();
        let again = claim(&state, None, &[], &[]).unwrap();
        assert!(again[0]["goal"].as_str().unwrap().ends_with("Utilise la v2"));
        assert_eq!(read_report(&state, "coord", ready[0]["id"].as_str().unwrap(), 0).unwrap()["text"], "Rapport complet");
        assert!(read_report(&state, "autre", ready[0]["id"].as_str().unwrap(), 0).is_err());
        // Arrêter la coordinatrice annule le reste et rend les délégués en cours.
        attach(&state, again[0]["id"].as_str().unwrap(), "delegue-ecran").unwrap();
        assert_eq!(stop(&state, "coord").unwrap(), vec!["delegue-ecran".to_string()]);
    }

    fn status_of(state: &AppState, id: &str) -> (String, Option<String>) {
        open(&state.space().unwrap())
            .unwrap()
            .query_row("SELECT status, summary FROM _alfred_agent_tasks WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
    }

    /// Deux interfaces sur le même Alfred (fenêtre cachée et navigateur par le pont) : les tâches partent dans celle
    /// qui tient la session de la coordinatrice, puis dans celle qui tient un de ses délégués. Sans session vivante,
    /// la première venue les prend.
    #[test]
    fn tasks_go_to_the_interface_that_holds_the_coordinator() {
        let (state, _dir, work) = setup();
        set_coordinator(&state, "coord", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        delegate(&state, "coord", &json!({ "tasks": [task("api", "back", &[]), task("ecran", "front", &[])] })).unwrap();
        let browser = |conversation: &str| (conversation == "coord").then(|| "navigateur".to_string());
        assert!(claim_with(&state, Some("fenetre-cachee"), &[], &[], &browser).unwrap().is_empty());
        assert!(claim_with(&state, None, &[], &[], &browser).unwrap().is_empty(), "une interface sans nom non plus");
        let mine = claim_with(&state, Some("navigateur"), &[], &[], &browser).unwrap();
        assert_eq!(mine.iter().map(|task| task["launch"].as_str().unwrap()).collect::<Vec<_>>(), ["start", "start"]);

        // Session de la coordinatrice fermée : un délégué en cours suffit à garder ses tâches dans son interface.
        attach(&state, mine[0]["id"].as_str().unwrap(), "delegue-api").unwrap();
        report(&state, mine[1]["id"].as_str().unwrap(), &json!({ "status": "failed", "summary": "Échec" }), "").unwrap();
        relaunch(&state, "coord", mine[1]["id"].as_str().unwrap(), None, true).unwrap();
        let delegate_held = |conversation: &str| (conversation == "delegue-api").then(|| "navigateur".to_string());
        assert!(claim_with(&state, Some("fenetre-cachee"), &[], &[], &delegate_held).unwrap().is_empty());
        assert_eq!(claim_with(&state, Some("navigateur"), &[], &[], &delegate_held).unwrap().len(), 1);
    }

    /// La session d’un délégué se ferme avant son rapport : sa tâche passe « interrompue », avec la raison. Elle est
    /// reprise deux fois dans la conversation du délégué, puis rendue en échec à la coordinatrice, et se relance.
    #[test]
    fn a_closed_delegate_session_interrupts_its_task_which_resumes_then_fails() {
        let (state, _dir, work) = setup();
        set_coordinator(&state, "coord", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        delegate(&state, "coord", &json!({ "tasks": [task("api", "back", &[])] })).unwrap();
        let id = claim(&state, None, &[], &[]).unwrap()[0]["id"].as_str().unwrap().to_owned();
        attach(&state, &id, "delegue-api").unwrap();
        session_closed(&state, "autre-conversation");
        assert_eq!(status_of(&state, &id).0, "running", "une autre session ne touche pas la tâche");

        for round in 1..=MAX_RESUMES {
            session_closed(&state, "delegue-api");
            assert_eq!(status_of(&state, &id), ("interrupted".to_string(), Some(CLOSED_REASON.to_string())));
            assert!(claim(&state, None, &[id.clone()], &[]).unwrap().is_empty(), "l’interface qui la fait avancer la garde");
            let resumed = claim(&state, None, &[], &[]).unwrap();
            assert_eq!(resumed.len(), 1, "reprise {round}");
            assert_eq!((resumed[0]["launch"].as_str(), resumed[0]["conversation"].as_str()), (Some("resume"), Some("delegue-api")));
            assert_eq!(status_of(&state, &id).0, "running");
        }
        // Session fermée par l’interface rechargée : la tâche reprend chez elle, pas dans une autre ouverte à côté.
        closing("delegue-api", "navigateur");
        session_closed(&state, "delegue-api");
        assert!(claim(&state, Some("fenetre-cachee"), &[], &[]).unwrap().is_empty());
        let given_up = claim(&state, Some("navigateur"), &[], &[]).unwrap();
        assert_eq!(given_up[0]["launch"], "report");
        assert!(given_up[0]["message"].as_str().unwrap().contains("Interrompue"), "{}", given_up[0]);
        assert_eq!(status_of(&state, &id).0, "failed");
        relaunch(&state, "coord", &id, None, true).unwrap();
        assert_eq!(claim(&state, None, &[], &[]).unwrap()[0]["launch"], "start", "relancée, elle repart de zéro");
    }

    /// Une tâche restée « en cours » d’une exécution arrêtée d’Alfred est interrompue, puis reprise ; la coordinatrice
    /// relance aussi une tâche interrompue.
    #[test]
    fn a_task_left_running_by_a_stopped_alfred_resumes() {
        let (state, _dir, work) = setup();
        set_coordinator(&state, "coord", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        delegate(&state, "coord", &json!({ "tasks": [task("api", "back", &[]), task("ecran", "front", &[])] })).unwrap();
        let db = open(&state.space().unwrap()).unwrap();
        db.execute("UPDATE _alfred_agent_tasks SET status = 'running', conversation = 'delegue-' || key", []).unwrap();
        let resumed = claim(&state, None, &[], &[]).unwrap();
        assert_eq!(resumed.iter().map(|task| task["launch"].as_str().unwrap()).collect::<Vec<_>>(), ["resume", "resume"]);
        let api = resumed[0]["id"].as_str().unwrap();
        assert!(claim(&state, None, &[], &[]).unwrap().is_empty(), "reprise, elle n’est plus interrompue");
        session_closed(&state, "delegue-api");
        relaunch(&state, "coord", api, Some("Reprends de zéro"), true).unwrap();
        assert_eq!(claim(&state, None, &[], &[]).unwrap()[0]["launch"], "start");
        // Arrêter la coordinatrice annule aussi une tâche interrompue.
        session_closed(&state, "delegue-ecran");
        stop(&state, "coord").unwrap();
        assert_eq!(status_of(&state, resumed[1]["id"].as_str().unwrap()).0, "cancelled");
    }

    /// Tâches parties avec leur délégué (`<préfixe>-<clé>`), en cours. Chaque test a son préfixe : les fermetures de
    /// session (`closers`) sont communes aux tests, qui tournent en parallèle.
    fn running_task(state: &AppState, work: &Path, prefix: &str, keys: &[(&str, &[&str])]) -> Vec<String> {
        set_coordinator(state, "coord", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        let tasks: Vec<Value> = keys.iter().map(|(key, depends)| task(key, "back", depends)).collect();
        delegate(state, "coord", &json!({ "tasks": tasks })).unwrap();
        let ids: Vec<String> = tasks_of(&open(&state.space().unwrap()).unwrap(), "coord")
            .unwrap()
            .iter()
            .map(|task| task["id"].as_str().unwrap().to_owned())
            .collect();
        for task in claim(state, None, &[], &[]).unwrap() {
            let id = task["id"].as_str().unwrap();
            attach(state, id, &format!("{prefix}-{}", task["key"].as_str().unwrap())).unwrap();
        }
        ids
    }

    fn archive_conversation(state: &AppState, conversation: &str) {
        state
            .app_db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO conversations (id, space, updated_at, data) VALUES (?1, 'espace', '0', ?2)",
                params![conversation, json!({ "id": conversation, "archived": true }).to_string()],
            )
            .unwrap();
    }

    fn goal_of(state: &AppState, id: &str) -> String {
        open(&state.space().unwrap())
            .unwrap()
            .query_row("SELECT goal FROM _alfred_agent_tasks WHERE id = ?1", [id], |row| row.get(0))
            .unwrap()
    }

    /// Un délégué fini, même avec succès, se relance dans sa conversation : il garde son contexte et reçoit la
    /// consigne. `fresh` le relance dans une conversation neuve. Une tâche qui travaille ne se relance pas.
    #[test]
    fn a_delegate_is_relaunched_in_its_own_conversation() {
        let (state, _dir, work) = setup();
        let ids = running_task(&state, &work, "relance", &[("api", &[])]);
        let id = &ids[0];
        let refused = relaunch(&state, "coord", id, None, false).unwrap_err();
        assert!(refused.message.contains("add_to_task"), "{}", refused.message);
        report(&state, id, &json!({ "status": "success", "summary": "API prête" }), "").unwrap();

        let relaunched = relaunch(&state, "coord", id, Some("Ajoute les tests"), false).unwrap();
        assert_eq!(relaunched["conversation"], "same");
        let again = claim(&state, None, &[], &[]).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(
            (again[0]["launch"].as_str(), again[0]["conversation"].as_str(), again[0]["message"].as_str()),
            (Some("continue"), Some("relance-api"), Some("Ajoute les tests"))
        );
        assert!(goal_of(&state, id).ends_with("Précision de la coordinatrice : Ajoute les tests"));
        assert_eq!(status_of(&state, id).0, "running");

        // Sans consigne, elle repart aussi dans sa conversation ; `fresh` repart de zéro.
        report(&state, id, &json!({ "status": "partial", "summary": "À moitié" }), "").unwrap();
        relaunch(&state, "coord", id, None, false).unwrap();
        let plain = claim(&state, None, &[], &[]).unwrap();
        assert_eq!((plain[0]["launch"].as_str(), plain[0]["message"].as_str()), (Some("continue"), None));
        report(&state, id, &json!({ "status": "failed", "summary": "Échec" }), "").unwrap();
        assert_eq!(relaunch(&state, "coord", id, None, true).unwrap()["conversation"], "new");
        let fresh = claim(&state, None, &[], &[]).unwrap();
        assert_eq!((fresh[0]["launch"].as_str(), fresh[0]["conversation"].as_str()), (Some("start"), None));
    }

    /// Une précision rejoint l’objectif. Délégué au travail : elle part dans sa conversation, chez l’interface qui
    /// attend son tour ; arrivée après son rapport, elle le relance dans sa conversation ; pendant une interruption,
    /// elle part avec la reprise. Une tâche pas encore partie la reçoit avec son objectif.
    #[test]
    fn a_coordinator_adds_to_a_delegate_task() {
        let (state, _dir, work) = setup();
        let ids = running_task(&state, &work, "ajout", &[("api", &[]), ("ecran", &["api"])]);
        let (api, ecran) = (&ids[0], &ids[1]);

        // Tâche en attente : l’objectif seul.
        assert_eq!(add_to_task(&state, "coord", ecran, "Mode sombre").unwrap()["delivered"], "goal");
        assert!(goal_of(&state, ecran).ends_with("Précision de la coordinatrice : Mode sombre"));
        assert!(actions_of(&open(&state.space().unwrap()).unwrap(), ecran).unwrap().is_empty());

        // Délégué au travail : la précision attend l’interface qui attend son tour.
        assert_eq!(add_to_task(&state, "coord", api, "Utilise la v2").unwrap()["delivered"], "conversation");
        assert!(goal_of(&state, api).ends_with("Précision de la coordinatrice : Utilise la v2"));
        assert!(claim(&state, None, std::slice::from_ref(api), &[]).unwrap().is_empty(), "personne n’attend son tour ici");
        let message = claim(&state, None, std::slice::from_ref(api), std::slice::from_ref(api)).unwrap();
        assert_eq!(
            (message[0]["launch"].as_str(), message[0]["conversation"].as_str(), message[0]["message"].as_str()),
            (Some("message"), Some("ajout-api"), Some("Précision de la coordinatrice : Utilise la v2"))
        );
        assert!(claim(&state, None, std::slice::from_ref(api), std::slice::from_ref(api)).unwrap().is_empty(), "livrée une seule fois");
        assert_eq!(status_of(&state, api).0, "running", "la tâche reste en cours");

        // Livrée trop tard (le tour venait de finir) : rendue à la tâche, elle relance le délégué dans sa conversation.
        defer(&state, api, "Précision de la coordinatrice : Ajoute un index").unwrap();
        report(&state, api, &json!({ "status": "success", "summary": "API prête" }), "").unwrap();
        let late = claim(&state, None, &[], &[]).unwrap();
        let continued = late.iter().find(|task| task["id"] == api.as_str()).unwrap();
        assert_eq!(
            (continued["launch"].as_str(), continued["message"].as_str()),
            (Some("continue"), Some("Précision de la coordinatrice : Ajoute un index"))
        );

        // Pendant une interruption : la précision part avec la reprise.
        session_closed(&state, "ajout-api");
        add_to_task(&state, "coord", api, "Garde les noms").unwrap();
        let resumed = claim(&state, None, &[], &[]).unwrap();
        let resumed = resumed.iter().find(|task| task["id"] == api.as_str()).unwrap();
        assert_eq!(
            (resumed["launch"].as_str(), resumed["message"].as_str()),
            (Some("resume"), Some("Précision de la coordinatrice : Garde les noms"))
        );

        // Tâche finie : la relance avec consigne.
        report(&state, api, &json!({ "status": "success", "summary": "API prête" }), "").unwrap();
        let refused = add_to_task(&state, "coord", api, "Encore").unwrap_err();
        assert!(refused.message.contains("relaunch_task"), "{}", refused.message);
        assert!(add_to_task(&state, "coord", ecran, " ").is_err(), "une précision vide est refusée");
    }

    /// Arrêter un délégué : sa tâche passe « annulée » par la coordinatrice, ses dépendants sont annulés, et son tour
    /// est interrompu par l’interface qui tient sa session. Le rapport de ce tour annulé est ignoré : la coordinatrice
    /// n’est pas relancée. Une tâche arrêtée se relance.
    #[test]
    fn a_stopped_delegate_does_not_relaunch_its_coordinator() {
        let (state, _dir, work) = setup();
        let ids = running_task(&state, &work, "arret", &[("api", &[]), ("ecran", &["api"])]);
        let (api, ecran) = (&ids[0], &ids[1]);
        let stopped = stop_task(&state, "coord", api).unwrap();
        assert_eq!(stopped["cancelledDependents"], json!(["ecran"]));
        assert_eq!(status_of(&state, api), ("cancelled".to_string(), Some(STOPPED_BY_COORDINATOR.to_string())));
        assert_eq!(status_of(&state, ecran).0, "cancelled");

        // L’arrêt part chez l’interface qui tient la session du délégué.
        let held = |conversation: &str| (conversation == "arret-api").then(|| "navigateur".to_string());
        assert!(claim_with(&state, Some("fenetre-cachee"), &[], &[], &held).unwrap().is_empty());
        let stop = claim_with(&state, Some("navigateur"), &[], &[], &held).unwrap();
        assert_eq!((stop[0]["launch"].as_str(), stop[0]["conversation"].as_str()), (Some("stop"), Some("arret-api")));

        // Son tour annulé rend son contrat : ignoré, sans message pour la coordinatrice.
        let reported = report(&state, api, &json!({ "status": "cancelled", "summary": "Tour interrompu." }), "").unwrap();
        assert_eq!(reported["ignored"], true);
        assert!(reported.get("message").is_none());
        assert_eq!(status_of(&state, api), ("cancelled".to_string(), Some(STOPPED_BY_COORDINATOR.to_string())));

        assert!(stop_task(&state, "coord", api).unwrap_err().message.contains("rien à arrêter"));
        // Une tâche pas encore partie s’arrête aussi.
        relaunch(&state, "coord", ecran, None, false).unwrap();
        stop_task(&state, "coord", ecran).unwrap();
        assert_eq!(status_of(&state, ecran).0, "cancelled");
        // Relancée, elle repart dans la conversation de son délégué.
        relaunch(&state, "coord", api, None, false).unwrap();
        assert_eq!(claim(&state, None, &[], &[]).unwrap()[0]["launch"], "continue");
    }

    /// Archiver un délégué l’arrête d’abord ; sa tâche reste lisible, marquée archivée. Il ne se relance plus dans sa
    /// conversation, seulement dans une neuve. Une conversation archivée par l’utilisateur compte aussi.
    #[test]
    fn an_archived_delegate_stays_readable_and_relaunches_fresh() {
        let (state, _dir, work) = setup();
        let ids = running_task(&state, &work, "archive", &[("api", &[]), ("ecran", &[])]);
        let (api, ecran) = (&ids[0], &ids[1]);
        let archived = archive_task(&state, "coord", api).unwrap();
        assert_eq!(archived["stopped"], true);
        let launches = claim(&state, None, std::slice::from_ref(api), &[]).unwrap();
        assert_eq!(
            launches.iter().map(|task| task["launch"].as_str().unwrap()).collect::<Vec<_>>(),
            ["stop", "archive"],
            "arrêt d’abord, puis archivage"
        );
        let listed = status_of_tasks(&state, "coord").unwrap();
        assert_eq!((listed[0]["status"].as_str(), listed[0]["archived"].as_bool()), (Some("cancelled"), Some(true)));
        assert_eq!(listed[1]["archived"], false);
        assert!(relaunch(&state, "coord", api, None, false).unwrap_err().message.contains("fresh"));
        relaunch(&state, "coord", api, Some("Recommence"), true).unwrap();
        assert_eq!(claim(&state, None, &[], &[]).unwrap()[0]["launch"], "start");
        assert_eq!(status_of_tasks(&state, "coord").unwrap()[0]["archived"], false, "une conversation neuve");

        // Archivée par l’utilisateur dans la page Agent.
        report(&state, ecran, &json!({ "status": "success", "summary": "Écran prêt" }), "").unwrap();
        archive_conversation(&state, "archive-ecran");
        assert_eq!(status_of_tasks(&state, "coord").unwrap()[1]["archived"], true);
        assert!(relaunch(&state, "coord", ecran, None, false).is_err());
        // Finie, elle s’archive sans arrêt.
        assert_eq!(archive_task(&state, "coord", ecran).unwrap()["stopped"], false);
    }

    /// Seule la coordinatrice propriétaire agit sur ses tâches ; un délégué n’a jamais ces outils.
    #[test]
    fn only_the_owning_coordinator_drives_its_delegates() {
        let (state, _dir, work) = setup();
        let ids = running_task(&state, &work, "proprio", &[("api", &[])]);
        let id = json!({ "id": ids[0], "instruction": "x" });
        set_coordinator(&state, "autre", true, &work.to_string_lossy(), "espace-de-travail").unwrap();
        for name in ["relaunch_task", "add_to_task", "stop_task", "archive_task"] {
            let refused = call(&state, "autre", name, &id).unwrap().unwrap_err();
            assert!(refused.message.contains("n’appartient pas"), "{name} : {}", refused.message);
            let delegate = call(&state, "proprio-api", name, &id).unwrap().unwrap_err();
            assert!(delegate.message.contains("rien délégué"), "{name} : {}", delegate.message);
        }
        assert_eq!(status_of(&state, &ids[0]).0, "running", "rien n’a bougé");
        assert!(actions_of(&open(&state.space().unwrap()).unwrap(), &ids[0]).unwrap().is_empty());
        assert_eq!(call(&state, "coord", "stop_task", &id).unwrap().unwrap()["stopped"], ids[0].as_str());
    }
}
