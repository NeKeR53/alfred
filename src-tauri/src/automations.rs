//! Automatisations : l’utilisateur fait exécuter une fonction d’un module sans la lancer lui-même. Un déclencheur
//! (un planning cron, un appel HTTP local, un script), une fonction cible, son entrée (et le compte d’un client), et
//! l’historique de chaque passage au Journal. Les choix sont expliqués dans `docs/automatisations.md`.
//!
//! Une automatisation appartient au poste : elle est rangée dans la base d’Alfred, jamais dans le dossier de
//! l’espace, qui est versionné et que l’agent écrit. Elle ne tourne que si l’utilisateur l’a validée dans son état
//! actuel (empreinte de la fonction, de l’entrée, du compte et du déclencheur) et activée. L’agent peut en créer :
//! elles naissent « à valider », en pause. Rien ne tourne quand Alfred est fermé.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Json;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Timelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, Space};
use crate::state::AppState;

/// Réveil de la boucle du planning : un passage part au plus 15 secondes après sa minute.
const WAKE_EVERY: Duration = Duration::from_secs(15);
/// Taille maximale du corps d’un appel HTTP.
const BODY_LIMIT: usize = 2 * 1024 * 1024;
/// Au-delà, l’appelant HTTP reçoit 202 et la fonction continue (comme les webhooks des modules).
const SYNC_WAIT: Duration = if cfg!(test) { Duration::from_millis(400) } else { Duration::from_secs(25) };
/// Sortie gardée au Journal pour un passage, en caractères.
const OUTPUT_KEPT: usize = 4000;
/// Clé de l’entrée réservée à ce que le déclencheur apporte (corps d’un appel HTTP, données d’un script).
pub const EVENT_KEY: &str = "event";

// ---------------------------------------------------------------------------------------------------------------
// Planning cron : cinq champs (minute, heure, jour du mois, mois, jour de la semaine), en heure locale.
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    weekdays: u8,
    /// Le champ jour du mois, ou celui du jour de la semaine, est restreint (pas `*`) : règle de cron, quand les deux
    /// le sont, l’un ou l’autre suffit.
    days_restricted: bool,
    weekdays_restricted: bool,
}

fn cron_error(expression: &str, detail: &str) -> AppError {
    AppError::new(format!(
        "Planning invalide : « {expression} » ({detail}). Format attendu : cinq champs « minute heure jour mois jour-de-semaine », par exemple « 0 8 * * 1-5 » (8 h, du lundi au vendredi)."
    ))
}

/// Un champ : `*`, `n`, `a-b`, `*/pas`, `a-b/pas`, `a/pas`, et leurs listes séparées par des virgules.
fn cron_field(text: &str, min: u32, max: u32, expression: &str, name: &str) -> AppResult<(u64, bool)> {
    let mut bits = 0u64;
    let restricted = text != "*";
    let number = |value: &str| -> AppResult<u32> {
        value
            .parse::<u32>()
            .ok()
            .filter(|value| (min..=max).contains(value))
            .ok_or_else(|| cron_error(expression, &format!("{name} « {value} » hors de {min} à {max}")))
    };
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step = step.parse::<u32>().ok().filter(|step| *step > 0);
                (range, step.ok_or_else(|| cron_error(expression, &format!("pas invalide pour {name}")))?)
            }
            None => (part, 1),
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (number(start)?, number(end)?)
        } else {
            let start = number(range)?;
            // « 5/15 » : de 5 jusqu’au bout, de 15 en 15.
            (start, if part.contains('/') { max } else { start })
        };
        if start > end {
            return Err(cron_error(expression, &format!("plage inversée pour {name}")));
        }
        let mut value = start;
        while value <= end {
            bits |= 1 << value;
            value += step;
        }
    }
    Ok((bits, restricted))
}

impl Cron {
    pub fn parse(expression: &str) -> AppResult<Self> {
        let trimmed = expression.trim();
        let expanded = match trimmed {
            "@hourly" => "0 * * * *",
            "@daily" | "@midnight" => "0 0 * * *",
            "@weekly" => "0 0 * * 0",
            "@monthly" => "0 0 1 * *",
            "@yearly" | "@annually" => "0 0 1 1 *",
            other => other,
        };
        let fields: Vec<&str> = expanded.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(cron_error(expression, &format!("{} champs au lieu de 5", fields.len())));
        }
        let (minutes, _) = cron_field(fields[0], 0, 59, expression, "la minute")?;
        let (hours, _) = cron_field(fields[1], 0, 23, expression, "l’heure")?;
        let (days, days_restricted) = cron_field(fields[2], 1, 31, expression, "le jour du mois")?;
        let (months, _) = cron_field(fields[3], 1, 12, expression, "le mois")?;
        // 0 et 7 valent tous deux dimanche.
        let (weekdays, weekdays_restricted) = cron_field(fields[4], 0, 7, expression, "le jour de la semaine")?;
        let weekdays = (weekdays | (weekdays >> 7)) & 0x7f;
        Ok(Self {
            minutes,
            hours: hours as u32,
            days: days as u32,
            months: months as u16,
            weekdays: weekdays as u8,
            days_restricted,
            weekdays_restricted,
        })
    }

    fn day_matches(&self, at: NaiveDateTime) -> bool {
        use chrono::Datelike;
        let day = self.days & (1 << at.day()) != 0;
        let weekday = self.weekdays & (1 << at.weekday().num_days_from_sunday()) != 0;
        match (self.days_restricted, self.weekdays_restricted) {
            (true, true) => day || weekday,
            _ => day && weekday,
        }
    }

    /// La minute `at` (heure locale) est-elle prévue par le planning ?
    pub fn matches(&self, at: NaiveDateTime) -> bool {
        use chrono::Datelike;
        self.minutes & (1 << at.minute()) != 0
            && self.hours & (1 << at.hour()) != 0
            && self.months & (1 << at.month()) != 0
            && self.day_matches(at)
    }

    /// Première minute prévue strictement après `after`, dans les quatre ans qui suivent.
    pub fn next_after(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let mut at = minute_of(after) + chrono::Duration::minutes(1);
        let limit = at + chrono::Duration::days(366 * 4);
        while at < limit {
            use chrono::Datelike;
            if self.months & (1 << at.month()) == 0 || !self.day_matches(at) {
                // Jour exclu : on passe au lendemain, à minuit.
                at = at.date().succ_opt()?.and_hms_opt(0, 0, 0)?;
                continue;
            }
            if self.hours & (1 << at.hour()) == 0 {
                at = at.date().and_hms_opt(at.hour(), 0, 0)? + chrono::Duration::hours(1);
                continue;
            }
            if self.minutes & (1 << at.minute()) != 0 {
                return Some(at);
            }
            at += chrono::Duration::minutes(1);
        }
        None
    }
}

/// La minute qui contient `at`.
fn minute_of(at: NaiveDateTime) -> NaiveDateTime {
    at.with_second(0).and_then(|at| at.with_nanosecond(0)).unwrap_or(at)
}

fn to_iso(local: NaiveDateTime) -> Option<String> {
    Local
        .from_local_datetime(&local)
        .earliest()
        .map(|date| date.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn to_local(iso: &str) -> Option<NaiveDateTime> {
    DateTime::parse_from_rfc3339(iso).ok().map(|date| date.with_timezone(&Local).naive_local())
}

// ---------------------------------------------------------------------------------------------------------------
// Définition
// ---------------------------------------------------------------------------------------------------------------

/// Ce qui lance l’automatisation. L’exécution manuelle (« Exécuter maintenant ») vaut pour toutes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Trigger {
    /// Planning cron, en heure locale, tant qu’Alfred est ouvert.
    Cron { cron: String },
    /// Appel HTTP local `http://127.0.0.1:<port>/automations/<id>`, avec le secret : un service (webhook) ou un
    /// autre processus du poste (`curl`).
    Webhook,
    /// Un script ou une fonction de l’espace, par le SDK : `automations.trigger("<id>", event)`.
    Script,
}

impl Trigger {
    fn check(&self) -> AppResult<()> {
        if let Self::Cron { cron } = self {
            Cron::parse(cron)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Automation {
    pub id: String,
    pub name: String,
    /// `module/fonction`.
    pub function: String,
    /// Objet JSON passé à la fonction.
    pub input: Value,
    /// Compte d’un client que la fonction reçoit dans `input.instance`.
    pub instance: Option<String>,
    pub trigger: Trigger,
    pub enabled: bool,
    /// Empreinte validée par l’utilisateur ; absente : « à valider ».
    validated: Option<String>,
    /// `user` ou `agent`.
    pub created_by: String,
    created_at: String,
    secret: Option<String>,
    last_run_at: Option<String>,
    last_status: Option<String>,
    last_error: Option<String>,
    last_trigger: Option<String>,
}

impl Automation {
    /// Ce que l’utilisateur valide : ce qui est exécuté, avec quoi, et quand. Le nom n’en fait pas partie.
    fn fingerprint(&self) -> String {
        json!({
            "function": self.function,
            "input": self.input,
            "instance": self.instance,
            "trigger": self.trigger,
        })
        .to_string()
    }

    fn is_validated(&self) -> bool {
        self.validated.as_deref() == Some(self.fingerprint().as_str())
    }

    /// Peut-elle partir d’elle-même ? Validée dans son état actuel et active.
    fn is_active(&self) -> bool {
        self.enabled && self.is_validated()
    }
}

fn space_key(space: &Space) -> String {
    space.root.to_string_lossy().to_string()
}

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    // Table créée au premier usage, dans la base d’Alfred : hors de portée d’une écriture dans l’espace.
    db.execute(
        "CREATE TABLE IF NOT EXISTS automations (
            space TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, function TEXT NOT NULL, input TEXT NOT NULL,
            instance TEXT, trigger TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, validated TEXT,
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, secret TEXT,
            last_run_at TEXT, last_status TEXT, last_error TEXT, last_trigger TEXT,
            PRIMARY KEY (space, id))",
        [],
    )?;
    Ok(db)
}

const COLUMNS: &str = "id, name, function, input, instance, trigger, enabled, validated, created_by, created_at, secret, last_run_at, last_status, last_error, last_trigger";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let input: String = row.get(3)?;
    let trigger: String = row.get(5)?;
    Ok(Automation {
        id: row.get(0)?,
        name: row.get(1)?,
        function: row.get(2)?,
        input: serde_json::from_str(&input).unwrap_or_else(|_| json!({})),
        instance: row.get(4)?,
        // Un déclencheur illisible ne part jamais : il devient un appel par script, sans planning ni adresse.
        trigger: serde_json::from_str(&trigger).unwrap_or(Trigger::Script),
        enabled: row.get::<_, i64>(6)? != 0,
        validated: row.get(7)?,
        created_by: row.get(8)?,
        created_at: row.get(9)?,
        secret: row.get(10)?,
        last_run_at: row.get(11)?,
        last_status: row.get(12)?,
        last_error: row.get(13)?,
        last_trigger: row.get(14)?,
    })
}

fn load_all(db: &Connection, space: &str) -> AppResult<Vec<Automation>> {
    let mut statement = db.prepare(&format!("SELECT {COLUMNS} FROM automations WHERE space = ?1 ORDER BY name, id"))?;
    let rows = statement.query_map(params![space], from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn load(db: &Connection, space: &str, id: &str) -> AppResult<Option<Automation>> {
    Ok(db
        .query_row(&format!("SELECT {COLUMNS} FROM automations WHERE space = ?1 AND id = ?2"), params![space, id], from_row)
        .optional()?)
}

fn existing(db: &Connection, space: &str, id: &str) -> AppResult<Automation> {
    load(db, space, id)?.ok_or_else(|| AppError::new(format!("L’automatisation « {id} » n’existe pas.")))
}

fn store(db: &Connection, space: &str, automation: &Automation) -> AppResult<()> {
    db.execute(
        "INSERT INTO automations (space, id, name, function, input, instance, trigger, enabled, validated, created_by, created_at, updated_at, secret)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (space, id) DO UPDATE SET name = excluded.name, function = excluded.function, input = excluded.input,
           instance = excluded.instance, trigger = excluded.trigger, enabled = excluded.enabled,
           validated = excluded.validated, updated_at = excluded.updated_at, secret = excluded.secret",
        params![
            space,
            automation.id,
            automation.name,
            automation.function,
            automation.input.to_string(),
            automation.instance,
            serde_json::to_string(&automation.trigger)?,
            i64::from(automation.enabled),
            automation.validated,
            automation.created_by,
            automation.created_at,
            crate::app_db::now(),
            automation.secret,
        ],
    )?;
    Ok(())
}

fn record_run(state: &AppState, space: &str, id: &str, status: &str, error: Option<&str>, origin: Option<&str>) {
    let Ok(db) = lock_db(state) else { return };
    let result = match origin {
        Some(origin) => db.execute(
            "UPDATE automations SET last_run_at = ?3, last_status = ?4, last_error = NULL, last_trigger = ?5 WHERE space = ?1 AND id = ?2",
            params![space, id, crate::app_db::now(), status, origin],
        ),
        None => db.execute(
            "UPDATE automations SET last_status = ?3, last_error = ?4 WHERE space = ?1 AND id = ?2",
            params![space, id, status, error],
        ),
    };
    if let Err(error) = result {
        log::warn!("passage de l’automatisation {id} non enregistré : {error}");
    }
}

fn generate_secret() -> String {
    rand::random::<[u8; 32]>().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Identifiant tiré du nom : minuscules sans accents, chiffres et tirets.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        let c = match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            other => other,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').chars().take(48).collect::<String>();
    if out.is_empty() {
        "automatisation".into()
    } else {
        out
    }
}

/// Vérifie la définition contre l’espace ouvert : la fonction doit être déclarée par son module.
fn check(space: &Space, automation: &Automation) -> AppResult<()> {
    if !valid_id(&automation.id) {
        return Err(AppError::new("Identifiant invalide : minuscules, chiffres et tirets uniquement."));
    }
    if automation.name.trim().is_empty() {
        return Err(AppError::new("Donnez un nom à l’automatisation."));
    }
    function_problem(space, &automation.function).map_or(Ok(()), |problem| Err(AppError::new(problem)))?;
    let Some(input) = automation.input.as_object() else {
        return Err(AppError::new("L’entrée doit être un objet JSON, par exemple {} ou { \"projet\": \"ACME\" }."));
    };
    if input.contains_key(EVENT_KEY) {
        return Err(AppError::new(format!(
            "La clé « {EVENT_KEY} » de l’entrée est réservée : elle reçoit ce qu’apporte le déclencheur."
        )));
    }
    if automation.instance.as_deref().is_some_and(|instance| instance.trim().is_empty()) {
        return Err(AppError::new("Compte vide : choisissez un compte ou aucun."));
    }
    automation.trigger.check()
}

/// Ce qui empêche la fonction de partir, ou `None`.
fn function_problem(space: &Space, reference: &str) -> Option<String> {
    let Some((module, function)) = reference.split_once('/').filter(|(m, f)| valid_id(m) && valid_id(f)) else {
        return Some(format!("Fonction désignée par « module/fonction » attendue : « {reference} »."));
    };
    let Ok(manifest) = space.module(module) else {
        return Some(format!("Le module « {module} » n’existe pas dans l’espace de travail."));
    };
    if !manifest.functions.iter().any(|declared| declared.id == function) {
        return Some(format!("La fonction « {reference} » n’est pas déclarée dans son module."));
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------------------------------------------

/// Ce qui a lancé un passage.
#[derive(Debug, Clone)]
pub enum Origin {
    Cron,
    Http,
    /// Le demandeur : `module/fonction` ou `module/page`.
    Script(String),
    Manual,
}

impl Origin {
    fn label(&self) -> String {
        match self {
            Self::Cron => "planning".into(),
            Self::Http => "appel HTTP".into(),
            Self::Script(by) => format!("script {by}"),
            Self::Manual => "exécution manuelle".into(),
        }
    }
}

fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Place d’une automatisation en cours : une même automatisation ne tourne jamais deux fois à la fois.
struct Slot(String);

impl Slot {
    fn take(space: &str, id: &str) -> Option<Self> {
        let key = format!("{space}\u{0}{id}");
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

fn is_running(space: &str, id: &str) -> bool {
    running().lock().is_ok_and(|running| running.contains(&format!("{space}\u{0}{id}")))
}

/// Sortie gardée au Journal : entière si elle est courte, sinon son début.
fn kept_output(output: &Value) -> Value {
    let text = output.to_string();
    if text.chars().count() <= OUTPUT_KEPT {
        output.clone()
    } else {
        json!({ "truncated": true, "preview": text.chars().take(OUTPUT_KEPT).collect::<String>() })
    }
}

/// Refus d’un passage : noté au Journal, pour que l’utilisateur comprenne pourquoi rien ne s’est passé.
fn refuse(state: &AppState, id: &str, origin: &Origin, reason: &str) -> AppError {
    crate::functions::journal(state, "automation", id, false, None, &format!("{} refusé : {reason}", origin.label()), None);
    AppError::new(format!("Automatisation non lancée : {reason}."))
}

/// Lance un passage. `event` : ce qu’apporte le déclencheur, passé à la fonction dans `input.event`.
pub async fn run(
    state: &Arc<AppState>,
    space: &str,
    automation: &Automation,
    origin: Origin,
    event: Option<Value>,
) -> AppResult<Value> {
    let id = automation.id.as_str();
    if !automation.is_validated() {
        return Err(refuse(state, id, &origin, "elle est à valider dans Réglages → Automatisations"));
    }
    if !automation.enabled && !matches!(origin, Origin::Manual) {
        return Err(refuse(state, id, &origin, "elle est en pause"));
    }
    let Some(slot) = Slot::take(space, id) else {
        return Err(refuse(state, id, &origin, "le passage précédent n’est pas fini"));
    };
    let mut input: Map<String, Value> = automation.input.as_object().cloned().unwrap_or_default();
    if let Some(instance) = &automation.instance {
        input.insert("instance".into(), json!(instance));
    }
    if let Some(event) = event {
        input.insert(EVENT_KEY.into(), event);
    }
    record_run(state, space, id, "running", None, Some(&origin.label()));
    state.emit("automations:changed", Value::Null);
    let started = Instant::now();
    let result = crate::functions::call(state, &automation.function, Value::Object(input), "automatisation").await;
    let duration = Some(started.elapsed().as_millis() as u64);
    let summary = format!("{} → fonction {}", origin.label(), automation.function);
    match &result {
        Ok(output) => {
            record_run(state, space, id, "ok", None, None);
            let detail = json!({ "trigger": origin.label(), "output": kept_output(output) });
            crate::functions::journal(state, "automation", id, true, duration, &summary, Some(&detail));
        }
        Err(error) => {
            record_run(state, space, id, "error", Some(&error.message), None);
            let detail = json!({ "trigger": origin.label(), "error": error.message });
            crate::functions::journal(state, "automation", id, false, duration, &summary, Some(&detail));
        }
    }
    drop(slot);
    state.emit("automations:changed", Value::Null);
    result
}

/// Minute du dernier départ du planning, par automatisation : une minute ne part qu’une fois.
fn fired() -> &'static Mutex<HashMap<String, NaiveDateTime>> {
    static FIRED: OnceLock<Mutex<HashMap<String, NaiveDateTime>>> = OnceLock::new();
    FIRED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Un réveil de la boucle : lance chaque automatisation active dont le planning prévoit la minute de `now`.
/// Une minute passée pendant qu’Alfred était fermé (ou l’ordinateur en veille) n’est pas rattrapée.
pub fn tick(state: &Arc<AppState>, now: NaiveDateTime) -> Vec<String> {
    let Some(space) = state.try_space() else { return Vec::new() };
    let key = space_key(&space);
    let Ok(all) = lock_db(state).and_then(|db| load_all(&db, &key)) else { return Vec::new() };
    let minute = minute_of(now);
    let mut launched = Vec::new();
    for automation in all {
        let Trigger::Cron { cron } = &automation.trigger else { continue };
        if !automation.is_active() {
            continue;
        }
        let Ok(cron) = Cron::parse(cron) else { continue };
        if !cron.matches(minute) {
            continue;
        }
        // Déjà parti cette minute : au réveil précédent, ou avant un redémarrage d’Alfred.
        let fired_key = format!("{key}\u{0}{}", automation.id);
        let already = fired().lock().ok().and_then(|map| map.get(&fired_key).copied()) == Some(minute)
            || automation.last_trigger.as_deref() == Some("planning")
                && automation.last_run_at.as_deref().and_then(to_local).map(minute_of) == Some(minute);
        if already {
            continue;
        }
        if let Ok(mut map) = fired().lock() {
            map.insert(fired_key, minute);
        }
        launched.push(automation.id.clone());
        let (state, key) = (state.clone(), key.clone());
        tokio::spawn(async move {
            let _ = run(&state, &key, &automation, Origin::Cron, None).await;
        });
    }
    launched
}

/// Lance la boucle du planning ; appelée une fois au démarrage d’Alfred, dans le runtime tokio.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tick(&state, Local::now().naive_local());
            tokio::time::sleep(WAKE_EVERY).await;
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Appel HTTP local
// ---------------------------------------------------------------------------------------------------------------

/// Route HTTP locale des automatisations déclenchées par appel.
pub fn routes() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/automations/{id}", get(receive).post(receive))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn url_of(state: &AppState, id: &str) -> Option<String> {
    state.server().ok().map(|server| format!("http://127.0.0.1:{}/automations/{id}", server.port))
}

async fn receive(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    method: Method,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let unknown = || reply(StatusCode::NOT_FOUND, json!({ "error": "Automatisation inconnue." }));
    // Espace fermé, automatisation absente ou lancée autrement : 404, sans distinguer les cas.
    let Some(space) = state.try_space() else { return unknown() };
    if !valid_id(&id) {
        return unknown();
    }
    let key = space_key(&space);
    let Some(automation) = lock_db(&state).ok().and_then(|db| load(&db, &key, &id).ok().flatten()) else {
        return unknown();
    };
    if automation.trigger != Trigger::Webhook {
        return unknown();
    }
    let query: Vec<(String, String)> = raw_query
        .as_deref()
        .map(|raw| url::form_urlencoded::parse(raw.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let proven = automation
        .secret
        .as_deref()
        .is_some_and(|secret| crate::webhooks::verified(secret, &headers, &query, &body));
    if !proven {
        let _ = refuse(&state, &id, &Origin::Http, "preuve du secret absente ou invalide");
        return reply(StatusCode::UNAUTHORIZED, json!({ "error": "Non autorisé." }));
    }
    if !automation.is_active() {
        let reason = if automation.is_validated() { "elle est en pause" } else { "elle est à valider" };
        let _ = refuse(&state, &id, &Origin::Http, reason);
        return reply(StatusCode::FORBIDDEN, json!({ "error": "Automatisation inactive." }));
    }
    if is_running(&key, &id) {
        let _ = refuse(&state, &id, &Origin::Http, "le passage précédent n’est pas fini");
        return reply(StatusCode::CONFLICT, json!({ "error": "Passage précédent en cours." }));
    }
    let event = crate::webhooks::input_of(&method, &headers, &query, &body);
    // La fonction tourne dans sa propre tâche : si l’appelant n’attend plus, elle continue et se journalise seule.
    let task = tokio::spawn({
        let state = state.clone();
        async move { run(&state, &key, &automation, Origin::Http, Some(event)).await }
    });
    match tokio::time::timeout(SYNC_WAIT, task).await {
        Ok(Ok(Ok(output))) => reply(StatusCode::OK, output),
        Ok(Ok(Err(_))) | Ok(Err(_)) => {
            reply(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "La fonction de l’automatisation a échoué." }))
        }
        Err(_) => reply(StatusCode::ACCEPTED, json!({ "accepted": true })),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

/// État lisible : `active`, `paused`, `toValidate`, `invalid`.
fn status_of(space: &Space, automation: &Automation) -> (&'static str, Option<String>) {
    let problem = check(space, automation).err().map(|error| error.message);
    let status = if problem.is_some() {
        "invalid"
    } else if !automation.is_validated() {
        "toValidate"
    } else if automation.enabled {
        "active"
    } else {
        "paused"
    };
    (status, problem)
}

fn describe(state: &AppState, space: &Space, automation: &Automation, now: NaiveDateTime) -> Value {
    let key = space_key(space);
    let (status, problem) = status_of(space, automation);
    let next = match &automation.trigger {
        Trigger::Cron { cron } if status == "active" => {
            Cron::parse(cron).ok().and_then(|cron| cron.next_after(now)).and_then(to_iso)
        }
        _ => None,
    };
    json!({
        "id": automation.id,
        "name": automation.name,
        "function": automation.function,
        "input": automation.input,
        "instance": automation.instance,
        "trigger": automation.trigger,
        "enabled": automation.enabled,
        "status": status,
        "problem": problem,
        "createdBy": automation.created_by,
        "createdAt": automation.created_at,
        "running": is_running(&key, &automation.id),
        "lastRunAt": automation.last_run_at,
        "lastStatus": automation.last_status,
        "lastError": automation.last_error,
        "lastTrigger": automation.last_trigger,
        "nextRunAt": next,
        "url": (automation.trigger == Trigger::Webhook).then(|| url_of(state, &automation.id)).flatten(),
    })
}

/// Fonctions que peut viser une automatisation, par module, avec les comptes des clients qu’elles utilisent.
async fn catalog(state: &Arc<AppState>, space: &Space) -> Vec<Value> {
    let mut items = Vec::new();
    for module in space.module_ids() {
        let Ok(manifest) = space.module(&module) else { continue };
        for function in &manifest.functions {
            let needs: Vec<String> = if function.uses.clients.is_empty() {
                manifest.clients.iter().map(|need| need.id.clone()).collect()
            } else {
                function.uses.clients.clone()
            };
            let mut instances = Vec::new();
            for need in needs {
                let subject = Subject {
                    kind: "function".into(),
                    module: module.clone(),
                    reference: format!("{module}/{}", function.id),
                    instance: None,
                    accounts: Default::default(),
                    examples: false,
                };
                let args = json!({ "subject": subject, "client": need });
                let Some(Ok(Value::Array(found))) = Box::pin(crate::clients::handle(state, "frame.clients.instances", &args)).await
                else {
                    continue;
                };
                for instance in found {
                    instances.push(json!({ "client": need, "id": instance["id"], "label": instance["label"] }));
                }
            }
            items.push(json!({
                "reference": format!("{module}/{}", function.id),
                "module": module,
                "moduleName": manifest.name,
                "id": function.id,
                "description": function.description,
                "instances": instances,
            }));
        }
    }
    items
}

/// Définition lue dans les arguments d’une commande ou d’un outil de l’agent.
fn from_args(args: &Value, previous: Option<&Automation>, created_by: &str, taken: &[String]) -> AppResult<Automation> {
    let name: String = opt_arg::<String>(args, "name")?
        .or_else(|| previous.map(|previous| previous.name.clone()))
        .unwrap_or_default()
        .trim()
        .to_string();
    let id = match (opt_arg::<String>(args, "id")?, previous) {
        (Some(id), _) => id,
        (None, Some(previous)) => previous.id.clone(),
        (None, None) => {
            let base = slug(&name);
            let mut id = base.clone();
            let mut n = 2;
            while taken.contains(&id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            id
        }
    };
    let trigger: Trigger = match args.get("trigger") {
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| {
            AppError::new("Déclencheur invalide : { \"kind\": \"cron\", \"cron\": \"0 8 * * 1-5\" }, { \"kind\": \"webhook\" } ou { \"kind\": \"script\" }.")
        })?,
        None => previous.map(|previous| previous.trigger.clone()).ok_or_else(|| AppError::new("Déclencheur absent."))?,
    };
    let input = match args.get("input") {
        Some(Value::Null) | None => previous.map(|previous| previous.input.clone()).unwrap_or_else(|| json!({})),
        Some(value) => value.clone(),
    };
    let instance = match args.get("instance") {
        None => previous.and_then(|previous| previous.instance.clone()),
        Some(Value::Null) => None,
        Some(_) => opt_arg::<String>(args, "instance")?.filter(|value| !value.is_empty()),
    };
    let function = match opt_arg::<String>(args, "function")? {
        Some(function) => function,
        None => previous.map(|previous| previous.function.clone()).ok_or_else(|| AppError::new("Fonction absente."))?,
    };
    let mut secret = previous.and_then(|previous| previous.secret.clone());
    if trigger == Trigger::Webhook && secret.is_none() {
        secret = Some(generate_secret());
    }
    if trigger != Trigger::Webhook {
        secret = None;
    }
    Ok(Automation {
        id,
        name,
        function,
        input,
        instance,
        trigger,
        enabled: previous.is_some_and(|previous| previous.enabled),
        validated: previous.and_then(|previous| previous.validated.clone()),
        created_by: previous.map(|previous| previous.created_by.clone()).unwrap_or_else(|| created_by.to_string()),
        created_at: previous.map(|previous| previous.created_at.clone()).unwrap_or_else(crate::app_db::now),
        secret,
        last_run_at: None,
        last_status: None,
        last_error: None,
        last_trigger: None,
    })
}

/// Création ou modification par l’utilisateur (page Automatisations) : son geste vaut validation.
fn save(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let key = space_key(&space);
    let db = lock_db(state)?;
    let previous = match opt_arg::<String>(args, "id")? {
        Some(id) => load(&db, &key, &id)?,
        None => None,
    };
    let taken: Vec<String> = load_all(&db, &key)?.into_iter().map(|automation| automation.id).collect();
    let mut automation = from_args(args, previous.as_ref(), "user", &taken)?;
    check(&space, &automation)?;
    automation.validated = Some(automation.fingerprint());
    automation.enabled = opt_arg::<bool>(args, "enabled")?.unwrap_or(previous.is_none() || automation.enabled);
    store(&db, &key, &automation)?;
    drop(db);
    state.emit("automations:changed", Value::Null);
    Ok(json!({ "id": automation.id }))
}

/// Création ou modification par l’agent : l’automatisation est (re)mise « à valider » et en pause, sauf si rien de
/// ce que l’utilisateur a validé ne change.
pub fn agent_save(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let key = space_key(&space);
    let db = lock_db(state)?;
    let id: Option<String> = opt_arg(args, "id")?;
    let previous = match &id {
        Some(id) => load(&db, &key, id)?,
        None => None,
    };
    let taken: Vec<String> = load_all(&db, &key)?.into_iter().map(|automation| automation.id).collect();
    let mut automation = from_args(args, previous.as_ref(), "agent", &taken)?;
    check(&space, &automation)?;
    if !automation.is_validated() {
        automation.validated = None;
        automation.enabled = false;
    }
    store(&db, &key, &automation)?;
    drop(db);
    let status = if automation.is_validated() { "unchanged" } else { "toValidate" };
    if status == "toValidate" {
        let title = format!("Automatisation « {} » à valider", automation.name);
        crate::functions::journal(state, "agent", &format!("automation:{}", automation.id), true, None, &title, None);
        state.emit(
            "agent:notice",
            json!({ "title": title, "description": "Elle ne tournera qu’après votre accord, dans Réglages → Automatisations." }),
        );
    }
    state.emit("automations:changed", Value::Null);
    Ok(json!({
        "id": automation.id,
        "status": status,
        "next": if status == "toValidate" {
            "Dis à l’utilisateur que l’automatisation l’attend dans Réglages → Automatisations : il la valide et l’active lui-même. Tu ne peux ni la valider, ni l’activer, ni lire son secret."
        } else {
            "Rien de ce que l’utilisateur a validé n’a changé : l’automatisation garde son état."
        },
    }))
}

/// Retrait par l’agent : seulement celles qu’il a créées.
pub fn agent_remove(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let key = space_key(&space);
    let id: String = arg(args, "id")?;
    let db = lock_db(state)?;
    let automation = existing(&db, &key, &id)?;
    if automation.created_by != "agent" {
        return Err(AppError::new(
            "Cette automatisation a été créée par l’utilisateur : seul lui peut la supprimer (Réglages → Automatisations).",
        ));
    }
    db.execute("DELETE FROM automations WHERE space = ?1 AND id = ?2", params![key, id])?;
    drop(db);
    state.emit("automations:changed", Value::Null);
    Ok(json!({ "removed": id }))
}

/// Liste pour l’agent : sans secret, sans adresse à appeler lui-même.
pub fn agent_list(state: &AppState) -> AppResult<Value> {
    let space = state.space()?;
    let key = space_key(&space);
    let all = load_all(&*lock_db(state)?, &key)?;
    Ok(Value::Array(
        all.iter()
            .map(|automation| {
                let (status, problem) = status_of(&space, automation);
                json!({
                    "id": automation.id,
                    "name": automation.name,
                    "function": automation.function,
                    "input": automation.input,
                    "instance": automation.instance,
                    "trigger": automation.trigger,
                    "status": status,
                    "problem": problem,
                    "createdBy": automation.created_by,
                    "lastRunAt": automation.last_run_at,
                    "lastStatus": automation.last_status,
                    "lastError": automation.last_error,
                })
            })
            .collect(),
    ))
}

fn history(state: &AppState, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let id: Option<String> = opt_arg(args, "id")?;
    let limit: u32 = opt_arg::<u32>(args, "limit")?.unwrap_or(200).min(1000);
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    let entries = crate::app_db::read_journal(&db, &space_key(&space), Some("automation"), 1000)?;
    Ok(Value::Array(
        entries
            .into_iter()
            .filter(|entry| id.as_deref().is_none_or(|id| entry["subject"] == json!(id)))
            .take(limit as usize)
            .collect(),
    ))
}

/// Déclenchement par un script, une fonction ou une page de l’espace (SDK `automations.trigger`).
async fn trigger_from_script(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let id: String = arg(args, "id")?;
    let space = state.space()?;
    let key = space_key(&space);
    let automation = existing(&*lock_db(state)?, &key, &id)?;
    let origin = Origin::Script(subject.reference.clone());
    if automation.trigger != Trigger::Script {
        return Err(refuse(state, &id, &origin, "elle ne se lance pas par un script (voir son déclencheur)"));
    }
    let event = args.get("event").cloned().filter(|event| !event.is_null());
    let event = json!({ "from": subject.reference, "data": event });
    run(state, &key, &automation, origin, Some(event)).await
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("automations.") && command != "frame.automations.trigger" {
        return None;
    }
    let state = state.clone();
    Some(
        async move {
            let space = state.space()?;
            let key = space_key(&space);
            let id = || arg::<String>(args, "id");
            match command {
                "automations.list" => {
                    let now = Local::now().naive_local();
                    let all = load_all(&*lock_db(&state)?, &key)?;
                    let items: Vec<Value> = all.iter().map(|a| describe(&state, &space, a, now)).collect();
                    Ok(json!({
                        "automations": items,
                        "functions": catalog(&state, &space).await,
                        "baseUrl": url_of(&state, ""),
                    }))
                }
                "automations.save" => save(&state, args),
                "automations.validate" => {
                    let db = lock_db(&state)?;
                    let mut automation = existing(&db, &key, &id()?)?;
                    check(&space, &automation)?;
                    automation.validated = Some(automation.fingerprint());
                    automation.enabled = true;
                    store(&db, &key, &automation)?;
                    drop(db);
                    state.emit("automations:changed", Value::Null);
                    Ok(Value::Null)
                }
                "automations.setEnabled" => {
                    let enabled: bool = arg(args, "enabled")?;
                    let db = lock_db(&state)?;
                    let mut automation = existing(&db, &key, &id()?)?;
                    if enabled && !automation.is_validated() {
                        return Err(AppError::new("Validez d’abord l’automatisation : elle a changé depuis votre accord."));
                    }
                    automation.enabled = enabled;
                    store(&db, &key, &automation)?;
                    drop(db);
                    state.emit("automations:changed", Value::Null);
                    Ok(Value::Null)
                }
                "automations.remove" => {
                    let id = id()?;
                    lock_db(&state)?.execute("DELETE FROM automations WHERE space = ?1 AND id = ?2", params![key, id])?;
                    state.emit("automations:changed", Value::Null);
                    Ok(Value::Null)
                }
                "automations.runNow" => {
                    let automation = existing(&*lock_db(&state)?, &key, &id()?)?;
                    Ok(match run(&state, &key, &automation, Origin::Manual, None).await {
                        Ok(output) => json!({ "ok": true, "output": output }),
                        Err(error) => json!({ "ok": false, "error": error.message }),
                    })
                }
                "automations.secret" => {
                    let automation = existing(&*lock_db(&state)?, &key, &id()?)?;
                    let secret = automation.secret.ok_or_else(|| AppError::new("Cette automatisation n’a pas d’adresse."))?;
                    Ok(json!({ "secret": secret, "url": url_of(&state, &automation.id) }))
                }
                "automations.rotate" => {
                    let db = lock_db(&state)?;
                    let mut automation = existing(&db, &key, &id()?)?;
                    if automation.trigger != Trigger::Webhook {
                        return Err(AppError::new("Cette automatisation n’a pas d’adresse."));
                    }
                    let secret = generate_secret();
                    automation.secret = Some(secret.clone());
                    store(&db, &key, &automation)?;
                    Ok(json!({ "secret": secret }))
                }
                "automations.history" => history(&state, args),
                "frame.automations.trigger" => trigger_from_script(&state, args).await,
                _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
            }
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripts::Runtime;
    use crate::space::{FunctionDecl, ModuleManifest};
    use crate::state::ServerInfo;
    use chrono::NaiveDate;

    fn at(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn cron_reads_the_five_fields() {
        let cron = Cron::parse("0 8 * * 1-5").unwrap();
        // 2026-11-23 est un lundi.
        assert!(cron.matches(at("2026-11-23 08:00")));
        assert!(!cron.matches(at("2026-11-23 08:01")));
        assert!(!cron.matches(at("2026-11-22 08:00")), "dimanche exclu");
        assert_eq!(cron.next_after(at("2026-11-27 08:00")), Some(at("2026-11-30 08:00")), "du vendredi au lundi");

        let every = Cron::parse("*/15 * * * *").unwrap();
        assert!(every.matches(at("2026-11-23 10:45")));
        assert!(!every.matches(at("2026-11-23 10:46")));
        assert_eq!(every.next_after(at("2026-11-23 10:46")), Some(at("2026-11-23 11:00")));

        let list = Cron::parse("5,35 9-17/4 1 1,7 *").unwrap();
        assert!(list.matches(at("2026-07-01 13:35")));
        assert!(!list.matches(at("2026-07-01 11:35")));
        assert_eq!(list.next_after(at("2026-07-01 17:35")), Some(at("2027-01-01 09:05")));

        // Jour du mois et jour de la semaine restreints : l’un ou l’autre.
        let either = Cron::parse("0 0 13 * 5").unwrap();
        assert!(either.matches(at("2026-11-13 00:00")), "le 13");
        assert!(either.matches(at("2026-11-20 00:00")), "un vendredi");
        assert!(!either.matches(at("2026-11-19 00:00")));

        assert!(Cron::parse("0 0 * * 7").unwrap().matches(at("2026-11-22 00:00")), "7 = dimanche");
        assert_eq!(Cron::parse("@daily").unwrap(), Cron::parse("0 0 * * *").unwrap());
        assert_eq!(Cron::parse("0 0 31 2 *").unwrap().next_after(at("2026-01-01 00:00")), None);
        for bad in ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "5-1 * * * *", "a * * * *"] {
            let error = Cron::parse(bad).unwrap_err().message;
            assert!(error.contains("Planning invalide"), "{bad} : {error}");
        }
        let _ = NaiveDate::from_ymd_opt(2026, 1, 1);
    }

    #[test]
    fn slug_is_a_valid_identifier() {
        assert_eq!(slug("Relance des impayés !"), "relance-des-impayes");
        assert_eq!(slug("   "), "automatisation");
        assert!(valid_id(&slug("Été 2026 — Rapport")));
    }

    /// Espace de test : un module « outils » avec une fonction bash qui rend son entrée.
    fn setup(dir: &std::path::Path) -> (Arc<AppState>, Space) {
        let state = AppState::new(&dir.join("data")).unwrap();
        let space = Space::open_or_create(&dir.join("espace"), Some("Test")).unwrap();
        let mut manifest = ModuleManifest { id: "outils".into(), name: "Outils".into(), ..Default::default() };
        for id in ["echo", "lent", "boum"] {
            manifest.functions.push(FunctionDecl { id: id.into(), runtime: Runtime::Bash, ..Default::default() });
        }
        space.write_module(&manifest).unwrap();
        let functions = space.module_dir("outils").join("functions");
        std::fs::create_dir_all(&functions).unwrap();
        std::fs::write(functions.join("echo.sh"), "entree=$(cat)\nprintf '{\"recu\":%s}' \"$entree\"\n").unwrap();
        std::fs::write(functions.join("lent.sh"), "cat >/dev/null\nsleep 1\necho '{\"fini\":true}'\n").unwrap();
        std::fs::write(functions.join("boum.sh"), "echo 'panne du service' >&2\nexit 3\n").unwrap();
        state.set_space(Some(space.clone()));
        (state, space)
    }

    async fn serve(state: &Arc<AppState>) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = state.server.set(ServerInfo { port });
        let router = routes().merge(crate::script_sdk::routes()).with_state(state.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        port
    }

    async fn call(state: &Arc<AppState>, command: &str, args: Value) -> AppResult<Value> {
        handle(state, command, &args).await.unwrap()
    }

    fn journal(state: &AppState, space: &Space) -> Vec<Value> {
        let db = state.app_db.lock().unwrap();
        crate::app_db::read_journal(&db, &space_key(space), Some("automation"), 100).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_webhook_runs_only_when_created_validated_active_and_proven() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let port = serve(&state).await;
        let http = reqwest::Client::new();

        // L’agent la crée : à valider, en pause ; l’appel est refusé même avec le secret.
        let created = agent_save(
            &state,
            &json!({ "name": "Paiement reçu", "function": "outils/echo", "input": { "source": "banque" }, "instance": "pro", "trigger": { "kind": "webhook" } }),
        )
        .unwrap();
        assert_eq!(created["status"], "toValidate");
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(id, "paiement-recu");
        let url = format!("http://127.0.0.1:{port}/automations/{id}");
        let secret = call(&state, "automations.secret", json!({ "id": id })).await.unwrap()["secret"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(secret.len(), 64);
        // Le secret n’est jamais rendu à l’agent ni écrit dans l’espace.
        assert!(!agent_list(&state).unwrap().to_string().contains(&secret));
        let listed = call(&state, "automations.list", Value::Null).await.unwrap();
        assert_eq!(listed["automations"][0]["status"], "toValidate");
        assert_eq!(listed["automations"][0]["url"], json!(url));
        assert_eq!(listed["functions"].as_array().unwrap().len(), 3);
        let response = http.post(&url).header("X-Alfred-Secret", &secret).body("{}").send().await.unwrap();
        assert_eq!(response.status(), 403);
        assert!(call(&state, "automations.setEnabled", json!({ "id": id, "enabled": true })).await.is_err());

        // L’utilisateur valide : elle tourne, avec son entrée, son compte et le corps reçu dans `event`.
        call(&state, "automations.validate", json!({ "id": id })).await.unwrap();
        assert_eq!(http.post(&url).body("{}").send().await.unwrap().status(), 401, "sans preuve");
        assert_eq!(http.post(&url).header("X-Alfred-Secret", "faux").send().await.unwrap().status(), 401);
        let response = http
            .post(format!("{url}?secret={secret}&ref=42"))
            .header("Content-Type", "application/json")
            .body(r#"{"montant":12}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let output: Value = response.json().await.unwrap();
        assert_eq!(output["recu"]["source"], "banque");
        assert_eq!(output["recu"]["instance"], "pro");
        assert_eq!(output["recu"]["event"]["body"], json!({ "montant": 12 }));
        assert_eq!(output["recu"]["event"]["query"], json!({ "ref": "42" }));
        assert!(!output.to_string().contains(&secret), "le secret ne passe jamais à la fonction");

        // L’agent la modifie : elle repart à valider et en pause.
        let changed = agent_save(&state, &json!({ "id": id, "input": { "source": "autre" } })).unwrap();
        assert_eq!(changed["status"], "toValidate");
        assert_eq!(http.post(&url).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 403);
        // Renvoyer la même définition validée ne change rien.
        call(&state, "automations.validate", json!({ "id": id })).await.unwrap();
        let same = agent_save(&state, &json!({ "id": id, "name": "Autre nom" })).unwrap();
        assert_eq!(same["status"], "unchanged");

        // En pause : refusée ; régénérer le secret invalide l’ancien.
        call(&state, "automations.setEnabled", json!({ "id": id, "enabled": false })).await.unwrap();
        assert_eq!(http.post(&url).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 403);
        call(&state, "automations.setEnabled", json!({ "id": id, "enabled": true })).await.unwrap();
        let rotated = call(&state, "automations.rotate", json!({ "id": id })).await.unwrap()["secret"].clone();
        assert_eq!(http.post(&url).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 401);
        let response = http.get(&url).header("Authorization", format!("Bearer {}", rotated.as_str().unwrap())).send().await.unwrap();
        assert_eq!(response.status(), 200);

        // Journal : réussites et refus, jamais le secret.
        let entries = journal(&state, &space);
        assert!(entries.iter().any(|entry| entry["status"] == "ok" && entry["summary"] == "appel HTTP → fonction outils/echo"));
        assert!(entries.iter().any(|entry| entry["summary"].as_str().unwrap().contains("refusé : elle est à valider")));
        assert!(entries.iter().any(|entry| entry["summary"].as_str().unwrap().contains("refusé : preuve du secret")));
        assert!(!serde_json::to_string(&entries).unwrap().contains(&secret));
        let history = call(&state, "automations.history", json!({ "id": id, "limit": 3 })).await.unwrap();
        assert_eq!(history.as_array().unwrap().len(), 3);

        // Une automatisation d’un autre déclencheur ne répond pas par HTTP.
        call(&state, "automations.save", json!({ "name": "Rapport", "function": "outils/echo", "trigger": { "kind": "script" } })).await.unwrap();
        assert_eq!(http.post(format!("http://127.0.0.1:{port}/automations/rapport")).send().await.unwrap().status(), 404);

        // Supprimée : 404. L’agent ne supprime pas celle de l’utilisateur.
        assert!(agent_remove(&state, &json!({ "id": "rapport" })).is_err());
        agent_remove(&state, &json!({ "id": id })).unwrap();
        assert_eq!(http.post(&url).send().await.unwrap().status(), 404);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn the_planning_runs_each_planned_minute_once() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let created = call(
            &state,
            "automations.save",
            json!({ "name": "Relevé", "function": "outils/echo", "input": { "n": 1 }, "trigger": { "kind": "cron", "cron": "*/5 * * * *" } }),
        )
        .await
        .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        // Une seconde, en pause : ne part pas.
        call(&state, "automations.save", json!({ "name": "Pause", "function": "outils/echo", "enabled": false, "trigger": { "kind": "cron", "cron": "* * * * *" } })).await.unwrap();

        assert!(tick(&state, at("2026-11-25 10:01")).is_empty(), "minute non prévue");
        assert_eq!(tick(&state, at("2026-11-25 10:05")), vec![id.clone()]);
        assert!(tick(&state, at("2026-11-25 10:05")).is_empty(), "même minute : une seule fois");
        for _ in 0..50 {
            if journal(&state, &space).iter().any(|entry| entry["status"] == "ok") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let entries = journal(&state, &space);
        let entry = entries.iter().find(|entry| entry["subject"] == json!(id)).expect("passage au journal");
        assert_eq!(entry["status"], "ok");
        assert_eq!(entry["summary"], "planning → fonction outils/echo");
        assert_eq!(entry["detail"]["output"]["recu"]["n"], 1);
        let listed = call(&state, "automations.list", Value::Null).await.unwrap();
        let item = &listed["automations"].as_array().unwrap().iter().find(|item| item["id"] == json!(id)).unwrap().clone();
        assert_eq!(item["lastStatus"], "ok");
        assert_eq!(item["lastTrigger"], "planning");
        assert!(item["nextRunAt"].is_string());

        // L’agent change le planning : plus rien ne part tant que l’utilisateur n’a pas validé.
        agent_save(&state, &json!({ "id": id, "trigger": { "kind": "cron", "cron": "* * * * *" } })).unwrap();
        assert!(tick(&state, at("2026-11-25 10:06")).is_empty());
        call(&state, "automations.validate", json!({ "id": id })).await.unwrap();
        assert_eq!(tick(&state, at("2026-11-25 10:07")), vec![id.clone()]);

        // Planning invalide refusé à l’enregistrement.
        let refused = call(&state, "automations.save", json!({ "name": "X", "function": "outils/echo", "trigger": { "kind": "cron", "cron": "99 * * * *" } })).await;
        assert!(refused.unwrap_err().message.contains("Planning invalide"));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_script_triggers_an_automation_through_the_sdk() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let _port = serve(&state).await;
        // Une fonction bash du module déclenche l’automatisation par le pont du SDK.
        let mut manifest = space.module("outils").unwrap();
        manifest.functions.push(FunctionDecl { id: "declencheur".into(), runtime: Runtime::Bash, ..Default::default() });
        space.write_module(&manifest).unwrap();
        std::fs::write(
            space.module_dir("outils").join("functions/declencheur.sh"),
            "cat >/dev/null\ncurl -s -X POST \"$ALFRED_SDK_URL/automations.trigger\" -H \"Authorization: Bearer $ALFRED_SDK_TOKEN\" -H 'Content-Type: application/json' -d '{\"id\":\"rapport\",\"event\":{\"fichier\":\"a.csv\"}}'\n",
        )
        .unwrap();
        call(&state, "automations.save", json!({ "name": "Rapport", "function": "outils/echo", "trigger": { "kind": "script" } })).await.unwrap();
        let output = crate::functions::call(&state, "outils/declencheur", json!({}), "test").await.unwrap();
        assert_eq!(output["ok"]["recu"]["event"]["from"], "outils/declencheur", "{output}");
        assert_eq!(output["ok"]["recu"]["event"]["data"], json!({ "fichier": "a.csv" }));

        // Échec de la fonction : noté au Journal avec son message, et dans l’état.
        call(&state, "automations.save", json!({ "id": "rapport", "function": "outils/boum" })).await.unwrap();
        let failed = crate::functions::call(&state, "outils/declencheur", json!({}), "test").await.unwrap();
        assert!(failed["error"]["message"].as_str().unwrap().contains("panne du service"), "{failed}");
        let listed = call(&state, "automations.list", Value::Null).await.unwrap();
        assert_eq!(listed["automations"][0]["lastStatus"], "error");

        // Exécution manuelle d’une automatisation en pause : permise, c’est le geste de l’utilisateur.
        call(&state, "automations.save", json!({ "id": "rapport", "function": "outils/echo", "enabled": false })).await.unwrap();
        let manual = call(&state, "automations.runNow", json!({ "id": "rapport" })).await.unwrap();
        assert_eq!(manual["ok"], true);
        // Le planning, lui, n’accepte pas la clé réservée.
        let refused = call(&state, "automations.save", json!({ "id": "rapport", "input": { "event": 1 } })).await;
        assert!(refused.is_err());
        // Deux passages à la fois : refusé.
        call(&state, "automations.save", json!({ "name": "Long", "function": "outils/lent", "trigger": { "kind": "script" } })).await.unwrap();
        let first = tokio::spawn({
            let state = state.clone();
            async move { call(&state, "automations.runNow", json!({ "id": "long" })).await }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let second = call(&state, "automations.runNow", json!({ "id": "long" })).await.unwrap();
        assert_eq!(second["ok"], false);
        assert!(second["error"].as_str().unwrap().contains("pas fini"));
        assert_eq!(first.await.unwrap().unwrap()["ok"], true);
    }
}
