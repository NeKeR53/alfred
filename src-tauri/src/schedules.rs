//! Planification des fonctions : un module déclare qu’une de ses fonctions part toutes les N minutes, toutes les N
//! secondes (relevé rapproché, au moins 5) ou chaque jour à une heure locale. Une fonction à intervalle peut rendre
//! `{ nextInSeconds }` : son prochain passage est avancé ou repoussé d’autant, une fois. Tout repose sur l’horloge d’Alfred ouvert : rien ne tourne quand il est fermé, et une heure
//! fixe manquée part au premier réveil qui suit, le jour même.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{valid_id, ModuleManifest, ScheduleDecl, Space};
use crate::state::AppState;

/// Intervalle de réveil de la boucle : une planification part au plus 30 secondes après son heure.
const WAKE_EVERY: Duration = Duration::from_secs(30);
/// Réveil rapproché, tant qu’une planification à la seconde ou un prochain passage demandé existe.
const WAKE_FAST: Duration = Duration::from_secs(1);
/// Plus petit intervalle à la seconde.
pub const MIN_SECONDS: u32 = 5;
/// Bornes de `nextInSeconds` rendu par une fonction : de 5 secondes à un jour.
const NEXT_RANGE: (u64, u64) = (5, 86_400);

// ---------------------------------------------------------------------------------------------------------------
// Calcul pur : est-elle due, et quand partira-t-elle ?
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Toutes les N secondes : `everyMinutes` × 60, ou `everySeconds` (au moins 5).
    Every(u32),
    /// Chaque jour à cette heure locale.
    At(NaiveTime),
}

impl Trigger {
    pub fn of(declaration: &ScheduleDecl) -> AppResult<Self> {
        match (declaration.every_minutes, declaration.every_seconds, declaration.at.as_deref()) {
            (Some(minutes), None, None) if minutes >= 1 => Ok(Self::Every(minutes.saturating_mul(60))),
            (Some(_), None, None) => Err(AppError::new("L’intervalle doit être d’au moins une minute.")),
            (None, Some(seconds), None) if seconds >= MIN_SECONDS => Ok(Self::Every(seconds)),
            (None, Some(_), None) => {
                Err(AppError::new(format!("L’intervalle doit être d’au moins {MIN_SECONDS} secondes.")))
            }
            (None, None, Some(at)) => parse_at(at).map(Self::At),
            _ => Err(AppError::new(
                "Une planification a un seul déclencheur : un intervalle (everyMinutes ou everySeconds) ou une heure (at), pas les deux.",
            )),
        }
    }
}

/// Heure « HH:MM » sur 24 heures.
fn parse_at(at: &str) -> AppResult<NaiveTime> {
    let valid = at.len() == 5 && at.as_bytes()[2] == b':';
    valid.then(|| NaiveTime::parse_from_str(at, "%H:%M").ok()).flatten().ok_or_else(|| {
        AppError::new(format!("Heure invalide : « {at} ». Format attendu « HH:MM », par exemple 08:30."))
    })
}

/// La planification doit-elle partir maintenant ? `last_run` et `now` sont en heure locale.
///
/// Pour une heure fixe, seule compte une exécution postérieure à l’heure prévue du jour : une exécution manuelle
/// faite plus tôt dans la journée n’empêche pas le passage prévu.
pub fn is_due(trigger: Trigger, last_run: Option<NaiveDateTime>, now: NaiveDateTime) -> bool {
    match trigger {
        Trigger::Every(seconds) => {
            last_run.is_none_or(|last| now - last >= chrono::Duration::seconds(i64::from(seconds.max(1))))
        }
        Trigger::At(at) => {
            let today = now.date().and_time(at);
            now >= today && last_run.is_none_or(|last| last < today)
        }
    }
}

/// Prochain départ prévu, en heure locale ; `now` quand elle est déjà due.
pub fn next_run(trigger: Trigger, last_run: Option<NaiveDateTime>, now: NaiveDateTime) -> NaiveDateTime {
    if is_due(trigger, last_run, now) {
        return now;
    }
    match trigger {
        Trigger::Every(seconds) => {
            let last = last_run.unwrap_or(now);
            (last + chrono::Duration::seconds(i64::from(seconds.max(1)))).max(now)
        }
        Trigger::At(at) => {
            let today = now.date().and_time(at);
            if now < today {
                today
            } else {
                today + chrono::Duration::days(1)
            }
        }
    }
}

/// Prochain passage demandé par la fonction (`{ nextInSeconds }`), borné de 5 secondes à un jour.
pub fn requested_next(output: &Value) -> Option<u64> {
    let seconds = output.get("nextInSeconds")?.as_f64()?;
    (seconds.is_finite() && seconds > 0.0).then(|| (seconds.round() as u64).clamp(NEXT_RANGE.0, NEXT_RANGE.1))
}

/// Due compte tenu d’un prochain passage demandé : il remplace l’intervalle, une fois. Une heure fixe l’ignore.
pub fn is_due_with(
    trigger: Trigger,
    last_run: Option<NaiveDateTime>,
    now: NaiveDateTime,
    requested: Option<NaiveDateTime>,
) -> bool {
    match (trigger, requested) {
        (Trigger::Every(_), Some(at)) => now >= at,
        _ => is_due(trigger, last_run, now),
    }
}

/// Prochains passages demandés par les fonctions, par planification ; perdus à la fermeture d’Alfred.
fn requested() -> &'static Mutex<std::collections::HashMap<String, NaiveDateTime>> {
    static REQUESTED: OnceLock<Mutex<std::collections::HashMap<String, NaiveDateTime>>> = OnceLock::new();
    REQUESTED.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn requested_at(space: &str, schedule: &str) -> Option<NaiveDateTime> {
    requested().lock().ok()?.get(&format!("{space}\u{0}{schedule}")).copied()
}

fn set_requested(space: &str, schedule: &str, at: Option<NaiveDateTime>) {
    if let Ok(mut map) = requested().lock() {
        let key = format!("{space}\u{0}{schedule}");
        match at {
            Some(at) => map.insert(key, at),
            None => map.remove(&key),
        };
    }
}

fn to_local(iso: &str) -> Option<NaiveDateTime> {
    DateTime::parse_from_rfc3339(iso).ok().map(|date| date.with_timezone(&Local).naive_local())
}

fn to_iso(local: NaiveDateTime) -> Option<String> {
    Local
        .from_local_datetime(&local)
        .earliest()
        .map(|date| date.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// État, rangé dans la base d’Alfred : pause et dernière exécution sont propres au poste, pas à l’espace.
// ---------------------------------------------------------------------------------------------------------------

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    db.execute(
        "CREATE TABLE IF NOT EXISTS schedule_state (space TEXT, schedule TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, last_status TEXT, last_error TEXT, PRIMARY KEY (space, schedule))",
        [],
    )?;
    Ok(db)
}

#[derive(Debug, Clone)]
struct RunState {
    enabled: bool,
    last_run_at: Option<String>,
    last_status: Option<String>,
    last_error: Option<String>,
}

fn read_state(db: &Connection, space: &str, schedule: &str) -> AppResult<RunState> {
    Ok(db
        .query_row(
            "SELECT enabled, last_run_at, last_status, last_error FROM schedule_state WHERE space = ?1 AND schedule = ?2",
            params![space, schedule],
            |row| {
                Ok(RunState {
                    enabled: row.get::<_, i64>(0)? != 0,
                    last_run_at: row.get(1)?,
                    last_status: row.get(2)?,
                    last_error: row.get(3)?,
                })
            },
        )
        .optional()?
        .unwrap_or(RunState { enabled: true, last_run_at: None, last_status: None, last_error: None }))
}

fn record(state: &AppState, space: &str, schedule: &str, status: &str, error: Option<&str>, started: bool) {
    let Ok(db) = lock_db(state) else { return };
    let result = if started {
        db.execute(
            "INSERT INTO schedule_state (space, schedule, last_run_at, last_status, last_error) VALUES (?1, ?2, ?3, ?4, NULL)
             ON CONFLICT (space, schedule) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status, last_error = NULL",
            params![space, schedule, crate::app_db::now(), status],
        )
    } else {
        db.execute(
            "UPDATE schedule_state SET last_status = ?3, last_error = ?4 WHERE space = ?1 AND schedule = ?2",
            params![space, schedule, status, error],
        )
    };
    if let Err(error) = result {
        log::warn!("état de la planification {schedule} non enregistré : {error}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------------------------------------------

/// Planifications en cours d’exécution, par espace : une même planification ne tourne jamais deux fois à la fois.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Place réservée dans `running` ; libérée quand l’exécution se termine, même sur une erreur.
struct Slot(String);

impl Slot {
    fn take(space: &str, schedule: &str) -> Option<Self> {
        let key = format!("{space}\u{0}{schedule}");
        // Le verrou est relâché avant de construire la place : un `Slot` refusé ne doit jamais être créé, car sa
        // libération retirerait la place de l’exécution en cours (et reprendrait ce verrou).
        let inserted = running().lock().ok()?.insert(key.clone());
        inserted.then(|| Self(key))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut running) = running().lock() {
            running.remove(&self.0);
        }
    }
}

fn is_running(space: &str, schedule: &str) -> bool {
    running().lock().is_ok_and(|running| running.contains(&format!("{space}\u{0}{schedule}")))
}

/// Exécute la fonction de la planification ; la place `slot` est déjà prise.
async fn run(
    state: &Arc<AppState>,
    space: String,
    module: String,
    declaration: ScheduleDecl,
    manual: bool,
    slot: Slot,
) -> AppResult<Value> {
    let schedule = format!("{module}/{}", declaration.id);
    let reference = format!("{module}/{}", declaration.function);
    record(state, &space, &schedule, "running", None, true);
    state.emit("schedules:changed", Value::Null);
    let input = if declaration.input.is_null() { json!({}) } else { declaration.input.clone() };
    let started = Instant::now();
    let result = crate::functions::call(state, &reference, input, "planification").await;
    // Une fonction à intervalle peut avancer ou repousser son prochain passage ; sinon l’intervalle reprend.
    let next = match (&result, Trigger::of(&declaration)) {
        (Ok(output), Ok(Trigger::Every(_))) => requested_next(output)
            .map(|seconds| Local::now().naive_local() + chrono::Duration::seconds(seconds as i64)),
        _ => None,
    };
    set_requested(&space, &schedule, next);
    let duration = Some(started.elapsed().as_millis() as u64);
    let summary = format!("{} → fonction {reference}", if manual { "exécution manuelle" } else { "planification" });
    match &result {
        Ok(_) => {
            record(state, &space, &schedule, "ok", None, false);
            crate::functions::journal(state, "schedule", &schedule, true, duration, &summary, None);
        }
        Err(error) => {
            record(state, &space, &schedule, "error", Some(&error.message), false);
            crate::functions::journal(
                state,
                "schedule",
                &schedule,
                false,
                duration,
                &summary,
                Some(&json!({ "error": error.message })),
            );
        }
    }
    drop(slot);
    state.emit("schedules:changed", Value::Null);
    result
}

fn space_key(space: &Space) -> String {
    space.root.to_string_lossy().to_string()
}

/// Un réveil de la boucle : lance chaque planification due, chacune dans sa tâche. Renvoie celles lancées, et vrai
/// quand la boucle doit se réveiller à la seconde (planification à la seconde, ou prochain passage demandé).
fn tick(state: &Arc<AppState>, now: NaiveDateTime) -> (Vec<String>, bool) {
    let Some(space) = state.try_space() else { return (Vec::new(), false) };
    let key = space_key(&space);
    let mut launched = Vec::new();
    let mut fast = false;
    for module in space.module_ids() {
        let Ok(manifest) = space.module(&module) else { continue };
        for declaration in manifest.schedules {
            // Une déclaration invalide est signalée dans les Réglages ; elle ne part simplement pas.
            let Ok(trigger) = Trigger::of(&declaration) else { continue };
            let schedule = format!("{module}/{}", declaration.id);
            let Ok(run_state) = lock_db(state).and_then(|db| read_state(&db, &key, &schedule)) else { continue };
            let last = run_state.last_run_at.as_deref().and_then(to_local);
            let asked = requested_at(&key, &schedule);
            if run_state.enabled && (asked.is_some() || matches!(trigger, Trigger::Every(seconds) if seconds < 60)) {
                fast = true;
            }
            if !run_state.enabled || !is_due_with(trigger, last, now, asked) {
                continue;
            }
            // Encore en cours depuis le réveil précédent : on n’en lance pas une seconde.
            let Some(slot) = Slot::take(&key, &schedule) else { continue };
            launched.push(schedule);
            let (state, key, module) = (state.clone(), key.clone(), module.clone());
            tokio::spawn(async move {
                let _ = run(&state, key, module, declaration, false, slot).await;
            });
        }
    }
    (launched, fast)
}

/// Lance la boucle de planification ; appelée une fois au démarrage d’Alfred, dans le runtime tokio.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Toutes les 30 secondes, ou chaque seconde tant qu’un relevé rapproché l’exige.
        loop {
            let (_, fast) = tick(&state, Local::now().naive_local());
            tokio::time::sleep(if fast { WAKE_FAST } else { WAKE_EVERY }).await;
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

fn split_schedule(schedule: &str) -> AppResult<(&str, &str)> {
    schedule.split_once('/').filter(|(module, id)| valid_id(module) && valid_id(id)).ok_or_else(|| {
        AppError::new(format!("Planification désignée par « module/identifiant » attendue : « {schedule} »."))
    })
}

fn declared(space: &Space, schedule: &str) -> AppResult<(String, ScheduleDecl)> {
    let (module, id) = split_schedule(schedule)?;
    let manifest = space.module(module)?;
    let declaration =
        manifest.schedules.into_iter().find(|declared| declared.id == id).ok_or_else(|| {
            AppError::new(format!("La planification « {schedule} » n’est pas déclarée dans son module."))
        })?;
    Ok((module.to_string(), declaration))
}

fn writable(space: &Space, module: &str) -> AppResult<ModuleManifest> {
    let manifest = space.module(module)?;
    if manifest.read_only() {
        return Err(AppError::new(format!(
            "Le module « {} » est importé d’un marketplace : le détacher pour modifier ses planifications.",
            manifest.name
        )));
    }
    Ok(manifest)
}

fn function_exists(space: &Space, manifest: &ModuleManifest, function: &str) -> bool {
    manifest.functions.iter().any(|declared| declared.id == function)
        && space.function_file(&manifest.id, function).is_file()
}

fn list(state: &AppState, now: NaiveDateTime) -> AppResult<Value> {
    let space = state.space()?;
    let key = space_key(&space);
    let db = lock_db(state)?;
    let mut items = Vec::new();
    for module in space.module_ids() {
        let Ok(manifest) = space.module(&module) else { continue };
        for declaration in &manifest.schedules {
            let schedule = format!("{module}/{}", declaration.id);
            let run_state = read_state(&db, &key, &schedule)?;
            let trigger = Trigger::of(declaration);
            let last = run_state.last_run_at.as_deref().and_then(to_local);
            let next = match &trigger {
                Ok(Trigger::Every(_)) if run_state.enabled && requested_at(&key, &schedule).is_some() => {
                    requested_at(&key, &schedule).map(|at| at.max(now)).and_then(to_iso)
                }
                Ok(trigger) if run_state.enabled => to_iso(next_run(*trigger, last, now)),
                _ => None,
            };
            items.push(json!({
                "module": module,
                "id": declaration.id,
                "description": declaration.description,
                "function": declaration.function,
                "everyMinutes": declaration.every_minutes,
                "everySeconds": declaration.every_seconds,
                "at": declaration.at,
                "enabled": run_state.enabled,
                "running": is_running(&key, &schedule),
                "lastRunAt": run_state.last_run_at,
                "lastStatus": run_state.last_status,
                "lastError": run_state.last_error,
                "nextRunAt": next,
                "functionExists": function_exists(&space, &manifest, &declaration.function),
                "problem": trigger.err().map(|error| error.message),
            }));
        }
    }
    Ok(Value::Array(items))
}

/// Accepte « fonction » ou « module/fonction » du même module : une planification ne déclenche que son module.
fn local_function(module: &str, function: &str) -> AppResult<String> {
    let local = match function.split_once('/') {
        Some((owner, local)) if owner == module => local,
        Some(_) => {
            return Err(AppError::new("Une planification ne peut déclencher qu’une fonction de son propre module."))
        }
        None => function,
    };
    if !valid_id(local) {
        return Err(AppError::new(format!("Fonction invalide : « {function} ».")));
    }
    Ok(local.to_string())
}

fn declare(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let module: String = arg(args, "module")?;
    let id: String = arg(args, "id")?;
    if !valid_id(&id) {
        return Err(AppError::new(
            "Identifiant de planification invalide : minuscules, chiffres et tirets uniquement.",
        ));
    }
    let declaration = ScheduleDecl {
        id: id.clone(),
        description: opt_arg::<String>(args, "description")?.unwrap_or_default(),
        function: local_function(&module, &arg::<String>(args, "function")?)?,
        every_minutes: opt_arg(args, "everyMinutes")?,
        every_seconds: opt_arg(args, "everySeconds")?,
        at: opt_arg(args, "at")?,
        input: args.get("input").cloned().unwrap_or(Value::Null),
    };
    Trigger::of(&declaration)?;
    let mut manifest = writable(&space, &module)?;
    match manifest.schedules.iter_mut().find(|declared| declared.id == id) {
        Some(existing) => *existing = declaration,
        None => manifest.schedules.push(declaration),
    }
    space.write_module(&manifest)?;
    let schedule = format!("{module}/{id}");
    crate::git::commit_all(&space.root, &format!("Planification {schedule}"))?;
    state.emit("space:changed", Value::Null);
    Ok(json!({ "schedule": schedule }))
}

fn remove(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let schedule: String = arg(args, "schedule")?;
    let (module, id) = split_schedule(&schedule)?;
    let mut manifest = writable(&space, module)?;
    manifest.schedules.retain(|declared| declared.id != id);
    space.write_module(&manifest)?;
    lock_db(state)?.execute(
        "DELETE FROM schedule_state WHERE space = ?1 AND schedule = ?2",
        params![space_key(&space), schedule],
    )?;
    crate::git::commit_all(&space.root, &format!("Suppression de la planification {schedule}"))?;
    state.emit("space:changed", Value::Null);
    Ok(Value::Null)
}

fn set_enabled(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let schedule: String = arg(args, "schedule")?;
    let enabled: bool = arg(args, "enabled")?;
    declared(&space, &schedule)?;
    lock_db(state)?.execute(
        "INSERT INTO schedule_state (space, schedule, enabled) VALUES (?1, ?2, ?3)
         ON CONFLICT (space, schedule) DO UPDATE SET enabled = excluded.enabled",
        params![space_key(&space), schedule, i64::from(enabled)],
    )?;
    state.emit("schedules:changed", Value::Null);
    Ok(Value::Null)
}

async fn run_now(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let schedule: String = arg(args, "schedule")?;
    let (module, declaration) = declared(&space, &schedule)?;
    let key = space_key(&space);
    let slot = Slot::take(&key, &schedule)
        .ok_or_else(|| AppError::new("Cette planification est déjà en cours d’exécution."))?;
    Ok(match run(state, key, module, declaration, true, slot).await {
        Ok(output) => json!({ "ok": true, "output": output }),
        Err(error) => json!({ "ok": false, "error": error.message }),
    })
}

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "schedules.list" => list(state, Local::now().naive_local()),
        "schedules.setEnabled" => set_enabled(state, args),
        "schedules.runNow" => run_now(state, args).await,
        "schedules.declare" => declare(state, args),
        "schedules.remove" => remove(state, args),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::FunctionDecl;
    use chrono::NaiveDate;

    fn at(day: u32, hour: u32, minute: u32, second: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, day).unwrap().and_hms_opt(hour, minute, second).unwrap()
    }

    #[test]
    fn computes_due_and_next_run_on_several_clocks() {
        let every = Trigger::Every(15 * 60);
        // Jamais exécutée : part au premier réveil.
        assert!(is_due(every, None, at(12, 9, 0, 0)));
        assert_eq!(next_run(every, None, at(12, 9, 0, 0)), at(12, 9, 0, 0));
        // 15 minutes pile après la dernière exécution, pas avant.
        assert!(!is_due(every, Some(at(12, 10, 0, 0)), at(12, 10, 14, 59)));
        assert!(is_due(every, Some(at(12, 10, 0, 0)), at(12, 10, 15, 0)));
        assert_eq!(next_run(every, Some(at(12, 10, 0, 0)), at(12, 10, 5, 0)), at(12, 10, 15, 0));
        // Au passage de minuit.
        assert!(is_due(every, Some(at(12, 23, 50, 0)), at(13, 0, 5, 0)));

        let daily = Trigger::At(NaiveTime::from_hms_opt(8, 0, 0).unwrap());
        // Jamais exécutée : attend l’heure.
        assert!(!is_due(daily, None, at(12, 7, 59, 59)));
        assert_eq!(next_run(daily, None, at(12, 7, 0, 0)), at(12, 8, 0, 0));
        assert!(is_due(daily, None, at(12, 8, 0, 0)));
        // Alfred ouvert après l’heure : rattrapage le jour même.
        assert!(is_due(daily, Some(at(11, 8, 0, 20)), at(12, 14, 0, 0)));
        // Déjà passée aujourd’hui : rien avant demain 08:00.
        assert!(!is_due(daily, Some(at(12, 8, 0, 20)), at(12, 23, 59, 0)));
        assert_eq!(next_run(daily, Some(at(12, 8, 0, 20)), at(12, 9, 0, 0)), at(13, 8, 0, 0));
        assert!(!is_due(daily, Some(at(12, 8, 0, 20)), at(13, 7, 59, 0)));
        assert!(is_due(daily, Some(at(12, 8, 0, 20)), at(13, 8, 0, 0)));
        // Une exécution manuelle plus tôt dans la journée n’empêche pas le passage prévu.
        assert!(is_due(daily, Some(at(12, 7, 0, 0)), at(12, 8, 0, 30)));

        // Déclarations.
        let decl = |every_minutes: Option<u32>, at: Option<&str>| ScheduleDecl {
            every_minutes,
            at: at.map(str::to_string),
            ..ScheduleDecl::default()
        };
        assert_eq!(Trigger::of(&decl(Some(5), None)).unwrap(), Trigger::Every(300));
        let seconds = |every_seconds: u32| ScheduleDecl { every_seconds: Some(every_seconds), ..ScheduleDecl::default() };
        assert_eq!(Trigger::of(&seconds(10)).unwrap(), Trigger::Every(10));
        assert!(Trigger::of(&seconds(4)).is_err(), "au moins 5 secondes");
        assert!(Trigger::of(&ScheduleDecl { every_minutes: Some(1), ..seconds(10) }).is_err(), "un seul déclencheur");
        assert_eq!(
            Trigger::of(&decl(None, Some("08:30"))).unwrap(),
            Trigger::At(NaiveTime::from_hms_opt(8, 30, 0).unwrap())
        );
        for (every_minutes, at) in [
            (Some(0), None),
            (Some(5), Some("08:00")),
            (None, None),
            (None, Some("8:30")),
            (None, Some("24:00")),
            (None, Some("08:60")),
        ] {
            assert!(Trigger::of(&decl(every_minutes, at)).is_err(), "{every_minutes:?} {at:?}");
        }
    }

    #[test]
    fn a_function_can_ask_for_its_next_run() {
        assert_eq!(requested_next(&json!({ "nextInSeconds": 3 })), Some(5), "au moins 5 secondes");
        assert_eq!(requested_next(&json!({ "nextInSeconds": 42.4 })), Some(42));
        assert_eq!(requested_next(&json!({ "nextInSeconds": 1_000_000 })), Some(86_400), "au plus un jour");
        assert_eq!(requested_next(&json!({ "nextInSeconds": 0 })), None);
        assert_eq!(requested_next(&json!({ "nextInSeconds": "10" })), None);
        assert_eq!(requested_next(&json!({ "ok": true })), None);

        let every = Trigger::Every(600);
        let last = at(12, 10, 0, 0);
        // Rapproché : 3 secondes plus tard au lieu de 10 minutes.
        let soon = Some(at(12, 10, 0, 3));
        assert!(!is_due_with(every, Some(last), at(12, 10, 0, 2), soon));
        assert!(is_due_with(every, Some(last), at(12, 10, 0, 3), soon));
        // Espacé : l’intervalle échu ne suffit plus.
        let later = Some(at(12, 11, 0, 0));
        assert!(!is_due_with(every, Some(last), at(12, 10, 30, 0), later));
        // Une heure fixe ignore la demande.
        let daily = Trigger::At(NaiveTime::from_hms_opt(8, 0, 0).unwrap());
        assert!(!is_due_with(daily, None, at(12, 7, 0, 0), Some(at(12, 6, 0, 0))));
    }

    /// Joue l’interface : renvoie l’entrée reçue, ou échoue quand `fail` est vrai.
    fn fake_ui(state: &Arc<AppState>, fail: Arc<std::sync::atomic::AtomicBool>) -> Arc<Mutex<Vec<Value>>> {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut events = state.events.subscribe();
        let (state, seen) = (state.clone(), calls.clone());
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                if event.name != "function:call" {
                    continue;
                }
                seen.lock().unwrap().push(event.payload.clone());
                let id = event.payload["requestId"].as_str().unwrap();
                let result = if fail.load(std::sync::atomic::Ordering::SeqCst) {
                    Err("Le service ne répond pas.".to_string())
                } else {
                    Ok(json!({
                        "relances": 3,
                        "input": event.payload["input"],
                        "nextInSeconds": event.payload["input"]["nextInSeconds"],
                    }))
                };
                let _ = state.resolve_ui(id, result);
            }
        });
        calls
    }

    async fn settle(state: &Arc<AppState>, schedule: &str) -> Value {
        for _ in 0..100 {
            let listed = list(state, Local::now().naive_local()).unwrap();
            let item = listed
                .as_array()
                .unwrap()
                .iter()
                .find(|item| {
                    format!("{}/{}", item["module"].as_str().unwrap(), item["id"].as_str().unwrap()) == schedule
                })
                .cloned()
                .unwrap();
            if item["running"] == json!(false) && item["lastStatus"] != json!("running") {
                return item;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("la planification ne s’est pas terminée");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn declare_list_pause_and_run_now() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        space
            .write_module(&ModuleManifest {
                id: "factures".into(),
                name: "Factures".into(),
                functions: vec![FunctionDecl { id: "relancer".into(), ..FunctionDecl::default() }],
                ..ModuleManifest::default()
            })
            .unwrap();
        state.set_space(Some(space.clone()));
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let calls = fake_ui(&state, fail.clone());

        // Déclarations refusées : deux déclencheurs, heure invalide.
        let both = json!({ "module": "factures", "id": "x", "function": "relancer", "everyMinutes": 5, "at": "08:00" });
        assert!(handle(&state, "schedules.declare", &both).await.unwrap().is_err());
        let bad = json!({ "module": "factures", "id": "x", "function": "relancer", "at": "25:00" });
        assert!(handle(&state, "schedules.declare", &bad).await.unwrap().is_err());

        let declared = json!({
            "module": "factures", "id": "relance", "description": "Relance des impayés",
            "function": "relancer", "everyMinutes": 15, "input": { "seuil": 30 }
        });
        handle(&state, "schedules.declare", &declared).await.unwrap().unwrap();
        let daily = json!({ "module": "factures", "id": "rapport", "description": "Rapport", "function": "relancer", "at": "08:00" });
        handle(&state, "schedules.declare", &daily).await.unwrap().unwrap();
        assert_eq!(space.module("factures").unwrap().schedules.len(), 2);

        let listed = handle(&state, "schedules.list", &Value::Null).await.unwrap().unwrap();
        let relance = &listed[0];
        assert_eq!(relance["everyMinutes"], 15);
        assert_eq!(relance["enabled"], true);
        assert_eq!(relance["lastRunAt"], Value::Null);
        assert!(relance["nextRunAt"].is_string());
        assert_eq!(relance["functionExists"], false, "fonction déclarée mais fichier absent");
        assert_eq!(listed[1]["at"], "08:00");

        // Premier réveil : la planification à intervalle part, celle à heure fixe attend 08:00.
        let (launched, fast) = tick(&state, at(12, 7, 0, 0));
        assert_eq!(launched, ["factures/relance"]);
        assert!(!fast, "rien à la seconde : la boucle garde ses 30 secondes");
        let item = settle(&state, "factures/relance").await;
        assert_eq!(item["lastStatus"], "ok");
        assert!(item["lastRunAt"].is_string());
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0]["function"], "factures/relancer");
            assert_eq!(calls[0]["caller"], "planification");
            assert_eq!(calls[0]["input"], json!({ "seuil": 30 }));
        }
        // Juste après : rien n’est dû (celle à heure fixe est en pause pour ne pas dépendre de l’heure réelle).
        handle(&state, "schedules.setEnabled", &json!({ "schedule": "factures/rapport", "enabled": false }))
            .await
            .unwrap()
            .unwrap();
        assert!(tick(&state, Local::now().naive_local() + chrono::Duration::minutes(1)).0.is_empty());

        // Pause : plus rien ne part, même longtemps après.
        handle(&state, "schedules.setEnabled", &json!({ "schedule": "factures/relance", "enabled": false }))
            .await
            .unwrap()
            .unwrap();
        assert!(tick(&state, Local::now().naive_local() + chrono::Duration::hours(30)).0.is_empty());
        let listed = handle(&state, "schedules.list", &Value::Null).await.unwrap().unwrap();
        assert_eq!(listed[0]["enabled"], false);
        assert_eq!(listed[0]["nextRunAt"], Value::Null);

        // Exécuter maintenant, même en pause : succès, puis échec rapporté.
        let result =
            handle(&state, "schedules.runNow", &json!({ "schedule": "factures/relance" })).await.unwrap().unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["output"]["relances"], 3);
        fail.store(true, std::sync::atomic::Ordering::SeqCst);
        let result =
            handle(&state, "schedules.runNow", &json!({ "schedule": "factures/relance" })).await.unwrap().unwrap();
        assert_eq!(result, json!({ "ok": false, "error": "Le service ne répond pas." }));
        let item = settle(&state, "factures/relance").await;
        assert_eq!(item["lastStatus"], "error");
        assert_eq!(item["lastError"], "Le service ne répond pas.");

        // Jamais deux exécutions simultanées.
        let slot = Slot::take(&space_key(&space), "factures/relance").unwrap();
        assert!(handle(&state, "schedules.runNow", &json!({ "schedule": "factures/relance" })).await.unwrap().is_err());
        drop(slot);

        // Journal.
        let journal = {
            let db = state.app_db.lock().unwrap();
            crate::app_db::read_journal(&db, &space_key(&space), Some("schedule"), 10).unwrap()
        };
        assert_eq!(journal.len(), 3);
        assert_eq!(journal[0]["status"], "error");
        assert_eq!(journal[0]["summary"], "exécution manuelle → fonction factures/relancer");

        // Retirer.
        handle(&state, "schedules.remove", &json!({ "schedule": "factures/relance" })).await.unwrap().unwrap();
        let listed = handle(&state, "schedules.list", &Value::Null).await.unwrap().unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_fast_schedule_runs_every_few_seconds_and_follows_next_in_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        space
            .write_module(&ModuleManifest {
                id: "ci".into(),
                name: "CI".into(),
                functions: vec![FunctionDecl { id: "sonder".into(), ..FunctionDecl::default() }],
                ..ModuleManifest::default()
            })
            .unwrap();
        state.set_space(Some(space.clone()));
        let calls = fake_ui(&state, Arc::new(std::sync::atomic::AtomicBool::new(false)));

        let too_fast = json!({ "module": "ci", "id": "sonde", "function": "sonder", "everySeconds": 2 });
        assert!(handle(&state, "schedules.declare", &too_fast).await.unwrap().is_err());
        // La fonction demande à repasser dans 3 secondes (bornées à 5) au lieu de 10.
        let declared = json!({
            "module": "ci", "id": "sonde", "function": "sonder", "everySeconds": 10, "input": { "nextInSeconds": 3 }
        });
        handle(&state, "schedules.declare", &declared).await.unwrap().unwrap();
        let listed = handle(&state, "schedules.list", &Value::Null).await.unwrap().unwrap();
        assert_eq!(listed[0]["everySeconds"], 10);

        let now = Local::now().naive_local();
        let (launched, fast) = tick(&state, now);
        assert_eq!(launched, ["ci/sonde"]);
        assert!(fast, "une planification à la seconde réveille la boucle chaque seconde");
        settle(&state, "ci/sonde").await;
        assert_eq!(calls.lock().unwrap().len(), 1);
        let key = space_key(&space);
        let asked = requested_at(&key, "ci/sonde").expect("prochain passage demandé");
        let delay = (asked - Local::now().naive_local()).num_seconds();
        assert!((3..=5).contains(&delay), "{delay}");

        let after = Local::now().naive_local();
        assert!(tick(&state, after + chrono::Duration::seconds(1)).0.is_empty(), "pas avant le passage demandé");
        assert_eq!(tick(&state, after + chrono::Duration::seconds(6)).0, ["ci/sonde"]);
        settle(&state, "ci/sonde").await;
        set_requested(&key, "ci/sonde", None);
    }

}
