//! Automatisations : l’utilisateur fait exécuter une action sans la lancer lui-même. Un déclencheur (un planning
//! cron, un appel HTTP local, un script) lance une action : des fonctions dans l’ordre (étapes déterministes, avec
//! des conditions simples), un script (une fonction de module qui enchaîne les autres), ou une conversation avec
//! l’agent. L’historique de chaque passage, et de chaque étape, va au Journal. Les choix sont expliqués dans
//! `docs/automatisations.md`.
//!
//! Une automatisation appartient au poste : elle est rangée dans la base d’Alfred, jamais dans le dossier de
//! l’espace, qui est versionné et que l’agent écrit. Elle ne tourne que si l’utilisateur l’a validée dans son état
//! actuel (empreinte de l’action, du code d’un script et du déclencheur) et activée. L’agent peut en créer : elles
//! naissent « à valider », en pause. Rien ne tourne quand Alfred est fermé.

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
use sha2::{Digest, Sha256};

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

/// Que faire quand une étape échoue.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnError {
    /// Le passage s’arrête en échec (par défaut).
    #[default]
    Stop,
    /// L’étape suivante part ; `$prev` vaut `{ "error": "<message>" }`.
    Continue,
}

/// Une étape d’une action déterministe : une fonction, son entrée (où `$prev`, `$event` et `$steps.N` sont
/// remplacés), et deux conditions facultatives à une seule comparaison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// `module/fonction`.
    pub function: String,
    #[serde(default = "empty_object")]
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// L’étape ne part que si la condition est vraie ; sinon elle est passée.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    /// Après l’étape, le passage s’arrête (en réussite) si la condition est vraie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_if: Option<String>,
    #[serde(default, skip_serializing_if = "is_default_on_error")]
    pub on_error: OnError,
}

fn empty_object() -> Value {
    json!({})
}

fn is_default_on_error(value: &OnError) -> bool {
    *value == OnError::Stop
}

fn default_minutes() -> u32 {
    15
}

/// Durée maximale d’un passage agentique, en minutes.
pub const MAX_AGENT_MINUTES: u32 = 120;
/// Nombre maximal d’étapes.
pub const MAX_STEPS: usize = 20;

/// Ce que fait l’automatisation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    /// Déterministe : des fonctions, dans l’ordre.
    Steps { steps: Vec<Step> },
    /// Un script : une fonction de module (TypeScript, Python, bash, PowerShell) qui enchaîne les autres par le
    /// SDK. Son code fait partie de ce que l’utilisateur valide.
    Script {
        function: String,
        #[serde(default = "empty_object")]
        input: Value,
    },
    /// Agentique : une conversation avec l’agent d’Alfred, avec une consigne fixe et les données du déclencheur.
    #[serde(rename_all = "camelCase")]
    Agent {
        instruction: String,
        #[serde(default = "default_minutes")]
        max_minutes: u32,
        /// Conversation existante qui reçoit chaque passage ; absente : une conversation neuve à chaque passage.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<String>,
    },
}

impl Action {
    /// Ce qu’on montre dans une ligne : la fonction, le script ou l’agent.
    fn label(&self) -> String {
        match self {
            Self::Steps { steps } if steps.len() == 1 => steps[0].function.clone(),
            Self::Steps { steps } => {
                format!("{} étapes : {}", steps.len(), steps.iter().map(|s| s.function.as_str()).collect::<Vec<_>>().join(" → "))
            }
            Self::Script { function, .. } => format!("script {function}"),
            Self::Agent { conversation: Some(_), .. } => "agent, conversation existante".into(),
            Self::Agent { .. } => "agent".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub action: Action,
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
    last_conversation: Option<String>,
}

/// Empreinte du code d’un script : son fichier et sa déclaration. Toute modification remet l’automatisation à
/// valider.
fn code_hash(space: &Space, reference: &str) -> String {
    let Some((module, function)) = reference.split_once('/') else { return "absent".into() };
    let declaration = space
        .module(module)
        .ok()
        .and_then(|manifest| manifest.functions.into_iter().find(|declared| declared.id == function));
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(&declaration).unwrap_or_default());
    match std::fs::read(space.function_file(module, function)) {
        Ok(bytes) => hasher.update(&bytes),
        Err(_) => hasher.update(b"absent"),
    }
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Automation {
    /// Ce que l’utilisateur valide : l’action (et le code d’un script) et le déclencheur. Le nom n’en fait pas
    /// partie.
    fn fingerprint(&self, space: &Space) -> String {
        // Une fonction seule, sans condition : la forme des premières automatisations, validations comprises.
        if let Action::Steps { steps } = &self.action {
            if let [step] = steps.as_slice() {
                if step.when.is_none() && step.stop_if.is_none() && step.on_error == OnError::Stop {
                    return json!({
                        "function": step.function,
                        "input": step.input,
                        "instance": step.instance,
                        "trigger": self.trigger,
                    })
                    .to_string();
                }
            }
        }
        let mut print = json!({ "action": self.action, "trigger": self.trigger });
        if let Action::Script { function, .. } = &self.action {
            print["code"] = json!(code_hash(space, function));
        }
        print.to_string()
    }

    fn is_validated(&self, space: &Space) -> bool {
        self.validated.as_deref() == Some(self.fingerprint(space).as_str())
    }

    /// Peut-elle partir d’elle-même ? Validée dans son état actuel et active.
    fn is_active(&self, space: &Space) -> bool {
        self.enabled && self.is_validated(space)
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
    // Colonnes ajoutées avec les actions : une table d’avant les reçoit.
    for column in ["action", "last_conversation"] {
        let present: i64 = db.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('automations') WHERE name = ?1",
            params![column],
            |row| row.get(0),
        )?;
        if present == 0 {
            db.execute(&format!("ALTER TABLE automations ADD COLUMN {column} TEXT"), [])?;
        }
    }
    Ok(db)
}

const COLUMNS: &str = "id, name, function, input, instance, trigger, enabled, validated, created_by, created_at, secret, last_run_at, last_status, last_error, last_trigger, action, last_conversation";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let input: String = row.get(3)?;
    let trigger: String = row.get(5)?;
    let action: Option<String> = row.get(15)?;
    // Une automatisation d’avant les actions : sa fonction seule, en une étape.
    let action = action.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| Action::Steps {
        steps: vec![Step {
            function: row.get(2).unwrap_or_default(),
            input: serde_json::from_str(&input).unwrap_or_else(|_| json!({})),
            instance: row.get(4).unwrap_or_default(),
            when: None,
            stop_if: None,
            on_error: OnError::Stop,
        }],
    });
    Ok(Automation {
        id: row.get(0)?,
        name: row.get(1)?,
        action,
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
        last_conversation: row.get(16)?,
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
        "INSERT INTO automations (space, id, name, function, input, instance, trigger, enabled, validated, created_by, created_at, updated_at, secret, action)
         VALUES (?1, ?2, ?3, ?4, '{}', NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (space, id) DO UPDATE SET name = excluded.name, function = excluded.function, input = '{}',
           instance = NULL, trigger = excluded.trigger, enabled = excluded.enabled, validated = excluded.validated,
           updated_at = excluded.updated_at, secret = excluded.secret, action = excluded.action",
        params![
            space,
            automation.id,
            automation.name,
            automation.action.label(),
            serde_json::to_string(&automation.trigger)?,
            i64::from(automation.enabled),
            automation.validated,
            automation.created_by,
            automation.created_at,
            crate::app_db::now(),
            automation.secret,
            serde_json::to_string(&automation.action)?,
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

// ---------------------------------------------------------------------------------------------------------------
// Références et conditions des étapes
// ---------------------------------------------------------------------------------------------------------------

/// Ce que les références d’une étape lisent : les données du déclencheur, les sorties des étapes déjà passées.
#[derive(Debug, Default)]
struct Context {
    event: Value,
    /// Sortie de chaque étape, dans l’ordre ; `null` pour une étape passée.
    steps: Vec<Value>,
    /// Sortie de la dernière étape lancée.
    prev: Value,
}

/// Une référence : `$prev`, `$event` ou `$steps.N` (N à partir de 1), suivie d’un chemin `.cle.0.autre`.
fn parse_reference(text: &str, step_index: usize) -> AppResult<(String, Option<usize>, Vec<String>)> {
    let bad = || {
        AppError::new(format!(
            "Référence invalide : « {text} ». Attendu $prev, $event ou $steps.N, suivi d’un chemin (.cle.0)."
        ))
    };
    let body = text.strip_prefix('$').ok_or_else(bad)?;
    let mut parts = body.split('.');
    let root = parts.next().ok_or_else(bad)?.to_string();
    let mut index = None;
    match root.as_str() {
        "prev" | "event" => {}
        "steps" => {
            let n: usize = parts.next().and_then(|n| n.parse().ok()).ok_or_else(bad)?;
            if n == 0 || n > step_index {
                return Err(AppError::new(format!(
                    "« {text} » : l’étape {} ne peut lire que les étapes 1 à {step_index}.",
                    step_index + 1
                )));
            }
            index = Some(n - 1);
        }
        _ => return Err(bad()),
    }
    let path: Vec<String> = parts.map(str::to_string).collect();
    if path.iter().any(String::is_empty) {
        return Err(bad());
    }
    Ok((root, index, path))
}

fn is_reference(text: &str) -> bool {
    ["$prev", "$event", "$steps."].iter().any(|start| text.starts_with(start))
}

fn resolve(context: &Context, text: &str) -> Value {
    let Ok((root, index, path)) = parse_reference(text, context.steps.len()) else { return Value::Null };
    let mut value = match (root.as_str(), index) {
        ("prev", _) => &context.prev,
        ("event", _) => &context.event,
        (_, Some(index)) => context.steps.get(index).unwrap_or(&Value::Null),
        _ => &Value::Null,
    };
    for key in &path {
        value = match value {
            Value::Object(map) => map.get(key).unwrap_or(&Value::Null),
            Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)).unwrap_or(&Value::Null),
            _ => &Value::Null,
        };
    }
    value.clone()
}

/// Remplace dans l’entrée chaque texte qui est une référence entière par la valeur lue ; `$$` garde un `$`.
fn substitute(context: &Context, value: &Value) -> Value {
    match value {
        Value::String(text) if text.starts_with("$$") => Value::String(text[1..].to_string()),
        Value::String(text) if is_reference(text) => resolve(context, text),
        Value::Array(items) => Value::Array(items.iter().map(|item| substitute(context, item)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), substitute(context, v))).collect()),
        other => other.clone(),
    }
}

/// Références d’une entrée, pour les vérifier à l’enregistrement.
fn references(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(text) if !text.starts_with("$$") && text.starts_with('$') => found.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| references(item, found)),
        Value::Object(map) => map.values().for_each(|item| references(item, found)),
        _ => {}
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    Exists,
    Empty,
    NotEmpty,
}

/// Une condition : une seule comparaison, `<référence> <opérateur> [valeur]`. Pas de `et`, pas de `ou` : une étape
/// de plus suffit.
#[derive(Debug, Clone, PartialEq)]
struct Condition {
    reference: String,
    op: Op,
    value: Value,
}

const CONDITION_HELP: &str = "Forme attendue : « $prev.total > 0 », « $event.body.type == \"paiement\" », « $steps.1.items non-vide », « $prev.erreur existe ». Opérateurs : == != > >= < <= contient existe vide non-vide.";

fn parse_condition(text: &str, step_index: usize) -> AppResult<Condition> {
    let text = text.trim();
    let (reference, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    parse_reference(reference, step_index)
        .map_err(|error| AppError::new(format!("Condition « {text} » : {} {CONDITION_HELP}", error.message)))?;
    let rest = rest.trim();
    let bad = || AppError::new(format!("Condition invalide : « {text} ». {CONDITION_HELP}"));
    let unary = [("existe", Op::Exists), ("non-vide", Op::NotEmpty), ("vide", Op::Empty)];
    if let Some((_, op)) = unary.iter().find(|(word, _)| rest == *word) {
        return Ok(Condition { reference: reference.into(), op: *op, value: Value::Null });
    }
    let binary = [
        (">=", Op::Gte),
        ("<=", Op::Lte),
        ("!=", Op::Ne),
        ("==", Op::Eq),
        (">", Op::Gt),
        ("<", Op::Lt),
        ("=", Op::Eq),
        ("contient", Op::Contains),
    ];
    let (word, op) = binary.iter().find(|(word, _)| rest.starts_with(word)).ok_or_else(bad)?;
    let literal = rest[word.len()..].trim();
    if literal.is_empty() {
        return Err(bad());
    }
    let value = serde_json::from_str(literal).unwrap_or_else(|_| Value::String(literal.to_string()));
    Ok(Condition { reference: reference.into(), op: *op, value })
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

fn same(left: &Value, right: &Value) -> bool {
    match (number(left), number(right)) {
        (Some(a), Some(b)) if left.is_number() || right.is_number() => a == b,
        _ => left == right,
    }
}

fn holds(condition: &Condition, context: &Context) -> bool {
    let actual = resolve(context, &condition.reference);
    let order = || match (number(&actual), number(&condition.value)) {
        (Some(a), Some(b)) => a.partial_cmp(&b),
        _ => match (&actual, &condition.value) {
            (Value::String(a), Value::String(b)) => Some(a.cmp(b)),
            _ => None,
        },
    };
    use std::cmp::Ordering::*;
    match condition.op {
        Op::Eq => same(&actual, &condition.value),
        Op::Ne => !same(&actual, &condition.value),
        Op::Gt => order() == Some(Greater),
        Op::Gte => matches!(order(), Some(Greater | Equal)),
        Op::Lt => order() == Some(Less),
        Op::Lte => matches!(order(), Some(Less | Equal)),
        Op::Contains => match (&actual, &condition.value) {
            (Value::String(text), Value::String(part)) => text.contains(part.as_str()),
            (Value::Array(items), value) => items.iter().any(|item| same(item, value)),
            (Value::Object(map), Value::String(key)) => map.contains_key(key),
            _ => false,
        },
        Op::Exists => !actual.is_null(),
        Op::Empty => is_empty(&actual),
        Op::NotEmpty => !is_empty(&actual),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------------------------------------------

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

fn check_input(input: &Value, step_index: usize, label: &str) -> AppResult<()> {
    let Some(object) = input.as_object() else {
        return Err(AppError::new(format!(
            "{label} : l’entrée doit être un objet JSON, par exemple {{}} ou {{ \"projet\": \"ACME\" }}."
        )));
    };
    if object.contains_key(EVENT_KEY) {
        return Err(AppError::new(format!(
            "{label} : la clé « {EVENT_KEY} » de l’entrée est réservée ; elle reçoit ce qu’apporte le déclencheur."
        )));
    }
    let mut found = Vec::new();
    references(input, &mut found);
    for reference in found {
        parse_reference(&reference, step_index).map_err(|error| AppError::new(format!("{label} : {}", error.message)))?;
    }
    Ok(())
}

/// Vérifie la définition contre l’espace ouvert.
fn check(space: &Space, automation: &Automation) -> AppResult<()> {
    if !valid_id(&automation.id) {
        return Err(AppError::new("Identifiant invalide : minuscules, chiffres et tirets uniquement."));
    }
    if automation.name.trim().is_empty() {
        return Err(AppError::new("Donnez un nom à l’automatisation."));
    }
    match &automation.action {
        Action::Steps { steps } => {
            if steps.is_empty() {
                return Err(AppError::new("Ajoutez au moins une étape."));
            }
            if steps.len() > MAX_STEPS {
                return Err(AppError::new(format!("{MAX_STEPS} étapes au plus.")));
            }
            for (index, step) in steps.iter().enumerate() {
                let label = format!("Étape {}", index + 1);
                if let Some(problem) = function_problem(space, &step.function) {
                    return Err(AppError::new(format!("{label} : {problem}")));
                }
                check_input(&step.input, index, &label)?;
                if step.instance.as_deref().is_some_and(|instance| instance.trim().is_empty()) {
                    return Err(AppError::new(format!("{label} : compte vide ; choisissez un compte ou aucun.")));
                }
                if let Some(when) = &step.when {
                    parse_condition(when, index).map_err(|e| AppError::new(format!("{label} : {}", e.message)))?;
                }
                if let Some(stop) = &step.stop_if {
                    // Après l’étape : elle peut lire sa propre sortie.
                    parse_condition(stop, index + 1).map_err(|e| AppError::new(format!("{label} : {}", e.message)))?;
                }
            }
        }
        Action::Script { function, input } => {
            if let Some(problem) = function_problem(space, function) {
                return Err(AppError::new(format!("Script : {problem}")));
            }
            check_input(input, 0, "Script")?;
        }
        Action::Agent { instruction, max_minutes, conversation } => {
            if conversation.as_deref().is_some_and(|id| {
                id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            }) {
                return Err(AppError::new("Conversation invalide : choisissez-en une dans la liste."));
            }
            if instruction.trim().is_empty() {
                return Err(AppError::new("Donnez sa consigne à l’agent."));
            }
            if instruction.chars().count() > 8000 {
                return Err(AppError::new("La consigne dépasse 8 000 caractères."));
            }
            if !(1..=MAX_AGENT_MINUTES).contains(max_minutes) {
                return Err(AppError::new(format!(
                    "La durée maximale va de 1 à {MAX_AGENT_MINUTES} minutes."
                )));
            }
        }
    }
    automation.trigger.check()
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

/// Entrée d’une fonction : l’entrée fixe (références remplacées), le compte, puis les données du déclencheur.
fn input_for(context: &Context, input: &Value, instance: Option<&String>) -> Value {
    let mut object: Map<String, Value> = substitute(context, input).as_object().cloned().unwrap_or_default();
    if let Some(instance) = instance {
        object.insert("instance".into(), json!(instance));
    }
    if !context.event.is_null() {
        object.insert(EVENT_KEY.into(), context.event.clone());
    }
    Value::Object(object)
}

/// Action déterministe : chaque étape au Journal, puis la sortie de la dernière étape lancée.
async fn run_steps(state: &Arc<AppState>, automation: &Automation, steps: &[Step], event: Value) -> AppResult<Value> {
    let id = automation.id.as_str();
    let total = steps.len();
    // Une seule étape : la ligne du passage suffit au Journal.
    let journal = |ok: bool, duration: Option<u64>, summary: &str, detail: Option<&Value>| {
        if total > 1 {
            crate::functions::journal(state, "automation", id, ok, duration, summary, detail);
        }
    };
    let mut context = Context { event, ..Context::default() };
    for (index, step) in steps.iter().enumerate() {
        let n = index + 1;
        let head = format!("étape {n}/{total} {}", step.function);
        if let Some(when) = &step.when {
            let condition = parse_condition(when, index)?;
            if !holds(&condition, &context) {
                journal(true, Some(0), &format!("{head} : passée (« {when} » est faux)"), None);
                context.steps.push(Value::Null);
                continue;
            }
        }
        let input = input_for(&context, &step.input, step.instance.as_ref());
        let started = Instant::now();
        let result = crate::functions::call(state, &step.function, input, "automatisation").await;
        let duration = Some(started.elapsed().as_millis() as u64);
        match result {
            Ok(output) => {
                let detail = json!({ "step": n, "output": kept_output(&output) });
                journal(true, duration, &format!("{head} : réussie"), Some(&detail));
                context.steps.push(output.clone());
                context.prev = output;
            }
            Err(error) => {
                let detail = json!({ "step": n, "error": error.message });
                journal(false, duration, &format!("{head} : échec"), Some(&detail));
                if step.on_error == OnError::Stop {
                    return Err(AppError::new(format!("Étape {n} ({}) : {}", step.function, error.message)));
                }
                let failed = json!({ "error": error.message });
                context.steps.push(failed.clone());
                context.prev = failed;
            }
        }
        if let Some(stop) = &step.stop_if {
            let condition = parse_condition(stop, index + 1)?;
            if holds(&condition, &context) {
                journal(true, Some(0), &format!("arrêt après l’étape {n} (« {stop} » est vrai)"), None);
                break;
            }
        }
    }
    Ok(context.prev)
}

/// Consigne ajoutée à celle de l’utilisateur pour un passage agentique.
fn unattended(name: &str, minutes: u32) -> String {
    format!(
        "Tu es lancé par l’automatisation « {name} » d’Alfred. Personne ne regarde : ne pose aucune question et n’attends aucun accord. \
Tu peux appeler les fonctions de l’espace (outil call_function ou leurs outils fn__) et écrire dans ton dossier de travail, rien d’autre : \
ni pages, ni modules, ni réglages, ni fichiers hors de ce dossier. Tu as {minutes} minutes au plus. \
Si tu es bloqué, arrête-toi et dis pourquoi en une phrase. Termine par un compte rendu court de ce que tu as fait."
    )
}

/// Action agentique : Rust réserve la conversation (identifiant, périmètre, dossier), la coquille la lance et rend
/// son dernier message. Rend la sortie, et l’identifiant de la conversation dans tous les cas.
async fn run_agent(
    state: &Arc<AppState>,
    space: &Space,
    automation: &Automation,
    instruction: &str,
    max_minutes: u32,
    event: Value,
) -> (AppResult<Value>, Option<String>) {
    let suffix: String = rand::random::<[u8; 8]>().iter().map(|byte| format!("{byte:02x}")).collect();
    let conversation = format!("auto-{suffix}");
    let prepared = (|| -> AppResult<std::path::PathBuf> {
        let cwd = space.root.join(crate::space::LOCAL_DIR).join("automations").join(&automation.id);
        std::fs::create_dir_all(&cwd)?;
        let scope = space_scope(space, &automation.id);
        let db = lock_db(state)?;
        crate::app_db::set_agent_scope(&db, &conversation, &scope)?;
        db.execute(
            "UPDATE automations SET last_conversation = ?3 WHERE space = ?1 AND id = ?2",
            params![space_key(space), automation.id, conversation],
        )?;
        Ok(cwd)
    })();
    let cwd = match prepared {
        Ok(cwd) => cwd,
        Err(error) => return (Err(error), None),
    };
    let payload = json!({
        "conversation": conversation,
        "automation": automation.id,
        "name": automation.name,
        "cwd": crate::folders::plain(&cwd).to_string_lossy(),
        "text": format!("{instruction}\n\n{}", unattended(&automation.name, max_minutes)),
        "context": event,
        "maxMinutes": max_minutes,
    });
    // La coquille coupe la conversation à la durée maximale ; une marge couvre son démarrage.
    let wait = Duration::from_secs(u64::from(max_minutes) * 60 + 90);
    let answer = state.ask_ui("automation:agent", payload, wait).await;
    (agent_outcome(answer, &conversation, max_minutes), Some(conversation))
}

/// Conversation enregistrée de l’espace ouvert : son titre, et pourquoi un passage ne peut pas y aller.
fn conversation_problem(state: &AppState, space: &Space, id: &str) -> (String, Option<String>) {
    let row: Option<String> = state.app_db.lock().ok().and_then(|db| {
        db.query_row(
            "SELECT data FROM conversations WHERE id = ?1 AND space = ?2",
            params![id, space_key(space)],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    });
    let Some(data) = row.and_then(|text| serde_json::from_str::<Value>(&text).ok()) else {
        return (id.to_string(), Some(format!("la conversation « {id} » a été supprimée")));
    };
    let title = data["title"].as_str().unwrap_or(id).to_string();
    let problem = if data["archived"] == json!(true) {
        Some(format!("la conversation « {title} » est archivée"))
    } else if data["autonomy"].as_str() != Some("workspace") {
        Some(format!(
            "la conversation « {title} » n’est pas en mode « Seulement dans son dossier » : passez-la dans ce mode, ou visez une conversation neuve"
        ))
    } else {
        None
    };
    (title, problem)
}

/// Issue d’un passage agentique rendue par la coquille.
fn agent_outcome(answer: AppResult<Value>, conversation: &str, max_minutes: u32) -> AppResult<Value> {
    let answer = answer?;
    let text = answer["text"].as_str().unwrap_or_default().to_string();
    match answer["status"].as_str() {
        Some("done") => Ok(json!({ "conversation": conversation, "message": text })),
        Some("timeout") => Err(AppError::new(format!(
            "L’agent a dépassé {max_minutes} minutes (attente de son tour comprise) : le passage a été arrêté."
        ))),
        Some("cancelled") => Err(AppError::new("La conversation a été arrêtée.")),
        Some("gone") => Err(AppError::new(answer["error"].as_str().unwrap_or("La conversation n’existe plus.").to_string())),
        _ => Err(AppError::new(format!(
            "L’agent n’a pas pu finir : {}",
            answer["error"].as_str().unwrap_or("erreur inconnue")
        ))),
    }
}

/// Action agentique dans une conversation existante : le message s’y ajoute, et attend son tour si l’agent
/// travaille. Le périmètre A-15 n’est posé que pendant le tour de l’automatisation (`automations.agentScope`).
async fn run_agent_in(
    state: &Arc<AppState>,
    space: &Space,
    automation: &Automation,
    target: &str,
    instruction: &str,
    max_minutes: u32,
    event: Value,
) -> (AppResult<Value>, Option<String>) {
    let (title, problem) = conversation_problem(state, space, target);
    if let Some(problem) = problem {
        return (Err(AppError::new(format!("Passage impossible : {problem}."))), Some(target.to_string()));
    }
    if let Ok(db) = lock_db(state) {
        let _ = db.execute(
            "UPDATE automations SET last_conversation = ?3 WHERE space = ?1 AND id = ?2",
            params![space_key(space), automation.id, target],
        );
    }
    let payload = json!({
        "conversation": target,
        "existing": true,
        "title": title,
        "automation": automation.id,
        "name": automation.name,
        "text": format!("{instruction}\n\n{}", unattended_here(&automation.name, max_minutes)),
        "context": event,
        "maxMinutes": max_minutes,
    });
    let wait = Duration::from_secs(u64::from(max_minutes) * 60 + 90);
    let answer = state.ask_ui("automation:agent", payload, wait).await;
    (agent_outcome(answer, target, max_minutes), Some(target.to_string()))
}

/// Consigne ajoutée pour un passage dans une conversation existante.
fn unattended_here(name: &str, minutes: u32) -> String {
    format!(
        "Ce message vient de l’automatisation « {name} » d’Alfred, pas de l’utilisateur. Personne ne regarde : ne pose aucune question et n’attends aucun accord. \
Pour ce tour, tu peux appeler les fonctions de l’espace (outil call_function ou leurs outils fn__) et écrire dans ton dossier de travail, rien d’autre : \
ni pages, ni modules, ni réglages, ni fichiers hors de ce dossier. Tu as {minutes} minutes au plus. \
Si tu es bloqué, arrête-toi et dis pourquoi en une phrase. Termine par un compte rendu court de ce que tu as fait."
    )
}

/// Périmètres que les passages ont remplacés, par conversation, pour les rendre à la fin du tour.
fn borrowed_scopes() -> &'static Mutex<HashMap<String, Option<crate::app_db::AgentScope>>> {
    static BORROWED: OnceLock<Mutex<HashMap<String, Option<crate::app_db::AgentScope>>>> = OnceLock::new();
    BORROWED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pose (`on`) ou retire le périmètre A-15 d’une conversation existante, pendant le tour d’une automatisation.
/// Appelée par la coquille au début et à la fin de ce tour ; le périmètre d’avant revient ensuite.
fn agent_scope(state: &AppState, space: &Space, args: &Value) -> AppResult<Value> {
    let conversation: String = arg(args, "conversation")?;
    let on: bool = arg(args, "on")?;
    let db = lock_db(state)?;
    let mut borrowed = borrowed_scopes().lock().map_err(|_| AppError::new("Périmètres indisponibles."))?;
    if on {
        let id: String = arg(args, "automation")?;
        let automation = existing(&db, &space_key(space), &id)?;
        let aimed = matches!(&automation.action, Action::Agent { conversation: Some(target), .. } if *target == conversation);
        if !aimed || !automation.is_validated(space) {
            return Err(AppError::new("Cette automatisation ne vise pas cette conversation."));
        }
        if !borrowed.contains_key(&conversation) {
            borrowed.insert(conversation.clone(), crate::app_db::agent_scope(&db, &conversation)?);
        }
        crate::app_db::set_agent_scope(&db, &conversation, &space_scope(space, &automation.id))?;
    } else if let Some(previous) = borrowed.remove(&conversation) {
        match previous {
            Some(scope) => crate::app_db::set_agent_scope(&db, &conversation, &scope)?,
            None => {
                db.execute("DELETE FROM agent_scopes WHERE conversation = ?1", params![conversation])?;
            }
        }
    }
    Ok(Value::Null)
}

/// Périmètre d’un passage agentique : toutes les fonctions de l’espace, aucun outil qui change sa structure.
fn space_scope(space: &Space, id: &str) -> crate::app_db::AgentScope {
    let mut scope = crate::app_db::AgentScope { module: format!("automatisation:{id}"), ..Default::default() };
    for module in space.module_ids() {
        if let Ok(manifest) = space.module(&module) {
            scope.functions.extend(manifest.functions.iter().map(|f| format!("{module}/{}", f.id)));
        }
    }
    scope
}

/// Lance un passage. `event` : ce qu’apporte le déclencheur, passé à chaque fonction dans `input.event`, et à
/// l’agent comme contexte.
pub async fn run(
    state: &Arc<AppState>,
    space: &str,
    automation: &Automation,
    origin: Origin,
    event: Option<Value>,
) -> AppResult<Value> {
    let id = automation.id.as_str();
    let opened = state.space()?;
    if !automation.is_validated(&opened) {
        return Err(refuse(state, id, &origin, "elle est à valider dans Réglages → Automatisations"));
    }
    if !automation.enabled && !matches!(origin, Origin::Manual) {
        return Err(refuse(state, id, &origin, "elle est en pause"));
    }
    let Some(slot) = Slot::take(space, id) else {
        return Err(refuse(state, id, &origin, "le passage précédent n’est pas fini"));
    };
    record_run(state, space, id, "running", None, Some(&origin.label()));
    state.emit("automations:changed", Value::Null);
    let started = Instant::now();
    let event = event.unwrap_or(Value::Null);
    let (result, conversation) = match &automation.action {
        Action::Steps { steps } => (run_steps(state, automation, steps, event).await, None),
        Action::Script { function, input } => {
            let context = Context { event, ..Context::default() };
            (crate::functions::call(state, function, input_for(&context, input, None), "automatisation").await, None)
        }
        Action::Agent { instruction, max_minutes, conversation: Some(target) } => {
            run_agent_in(state, &opened, automation, target, instruction, *max_minutes, event).await
        }
        Action::Agent { instruction, max_minutes, conversation: None } => {
            run_agent(state, &opened, automation, instruction, *max_minutes, event).await
        }
    };
    let duration = Some(started.elapsed().as_millis() as u64);
    let summary = format!("{} → {}", origin.label(), automation.action.label());
    let mut detail = json!({ "trigger": origin.label() });
    if let Some(conversation) = &conversation {
        detail["conversation"] = json!(conversation);
    }
    match &result {
        Ok(output) => {
            record_run(state, space, id, "ok", None, None);
            detail["output"] = kept_output(output);
            crate::functions::journal(state, "automation", id, true, duration, &summary, Some(&detail));
        }
        Err(error) => {
            record_run(state, space, id, "error", Some(&error.message), None);
            detail["error"] = json!(error.message);
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
        if !automation.is_active(&space) {
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
    // Un tour d’automatisation interrompu par la fermeture d’Alfred a pu laisser le périmètre A-15 sur une
    // conversation existante : il est retiré. Les conversations neuves (`auto-…`) le gardent.
    if let Ok(db) = state.app_db.lock() {
        let _ = db.execute(
            "DELETE FROM agent_scopes WHERE module LIKE 'automatisation:%' AND conversation NOT LIKE 'auto-%'",
            [],
        );
    }
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
    if !automation.is_active(&space) {
        let reason = if automation.is_validated(&space) { "elle est en pause" } else { "elle est à valider" };
        let _ = refuse(&state, &id, &Origin::Http, reason);
        return reply(StatusCode::FORBIDDEN, json!({ "error": "Automatisation inactive." }));
    }
    if is_running(&key, &id) {
        let _ = refuse(&state, &id, &Origin::Http, "le passage précédent n’est pas fini");
        return reply(StatusCode::CONFLICT, json!({ "error": "Passage précédent en cours." }));
    }
    let event = crate::webhooks::input_of(&method, &headers, &query, &body);
    // L’action tourne dans sa propre tâche : si l’appelant n’attend plus, elle continue et se journalise seule.
    let task = tokio::spawn({
        let state = state.clone();
        async move { run(&state, &key, &automation, Origin::Http, Some(event)).await }
    });
    match tokio::time::timeout(SYNC_WAIT, task).await {
        Ok(Ok(Ok(output))) => reply(StatusCode::OK, output),
        Ok(Ok(Err(_))) | Ok(Err(_)) => {
            reply(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "L’action de l’automatisation a échoué." }))
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
    } else if !automation.is_validated(space) {
        "toValidate"
    } else if automation.enabled {
        "active"
    } else {
        "paused"
    };
    (status, problem)
}

fn script_file(space: &Space, automation: &Automation) -> Option<String> {
    let Action::Script { function, .. } = &automation.action else { return None };
    let (module, name) = function.split_once('/')?;
    Some(space.function_file(module, name).to_string_lossy().to_string())
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
        "action": automation.action,
        "summary": automation.action.label(),
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
        "lastConversation": automation.last_conversation,
        "nextRunAt": next,
        "scriptFile": script_file(space, automation),
        // Conversation existante visée : son titre, et ce qui empêcherait un passage d’y aller.
        "target": match &automation.action {
            Action::Agent { conversation: Some(target), .. } => {
                let (title, problem) = conversation_problem(state, space, target);
                json!({ "id": target, "title": title, "problem": problem })
            }
            _ => Value::Null,
        },
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
                let Some(Ok(Value::Array(found))) =
                    Box::pin(crate::clients::handle(state, "frame.clients.instances", &args)).await
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
                "runtime": function.runtime,
                "instances": instances,
            }));
        }
    }
    items
}

/// Définition lue dans les arguments d’une commande ou d’un outil de l’agent. `action` donne l’action ; à défaut,
/// `function` (avec `input` et `instance`) est une seule étape.
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
        Some(value) if !value.is_null() => serde_json::from_value(value.clone()).map_err(|_| {
            AppError::new("Déclencheur invalide : { \"kind\": \"cron\", \"cron\": \"0 8 * * 1-5\" }, { \"kind\": \"webhook\" } ou { \"kind\": \"script\" }.")
        })?,
        _ => previous.map(|previous| previous.trigger.clone()).ok_or_else(|| AppError::new("Déclencheur absent."))?,
    };
    let action = match (args.get("action").filter(|value| !value.is_null()), opt_arg::<String>(args, "function")?) {
        (Some(value), _) => serde_json::from_value::<Action>(value.clone()).map_err(|error| {
            AppError::new(format!(
                "Action invalide ({error}) : {{ \"kind\": \"steps\", \"steps\": [{{ \"function\": \"module/fonction\", \"input\": {{}} }}] }}, {{ \"kind\": \"script\", \"function\": \"module/fonction\" }} ou {{ \"kind\": \"agent\", \"instruction\": \"…\", \"maxMinutes\": 15 }}."
            ))
        })?,
        (None, Some(function)) => {
            // Forme courte : une fonction. Une entrée ou un compte omis gardent ceux de l’étape unique d’avant.
            let before = match previous.map(|previous| &previous.action) {
                Some(Action::Steps { steps }) if steps.len() == 1 => Some(&steps[0]),
                _ => None,
            };
            let input = match args.get("input") {
                Some(Value::Null) | None => before.map(|step| step.input.clone()).unwrap_or_else(empty_object),
                Some(value) => value.clone(),
            };
            let instance = match args.get("instance") {
                None => before.and_then(|step| step.instance.clone()),
                Some(Value::Null) => None,
                Some(_) => opt_arg::<String>(args, "instance")?.filter(|value| !value.is_empty()),
            };
            Action::Steps { steps: vec![Step { function, input, instance, when: None, stop_if: None, on_error: OnError::Stop }] }
        }
        (None, None) => {
            let mut action = previous.map(|previous| previous.action.clone()).ok_or_else(|| AppError::new("Action absente."))?;
            // Une entrée seule modifie l’étape unique.
            if let (Some(input), Action::Steps { steps }) = (args.get("input").filter(|v| !v.is_null()), &mut action) {
                if let [step] = steps.as_mut_slice() {
                    step.input = input.clone();
                }
            }
            action
        }
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
        action,
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
        last_conversation: None,
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
    automation.validated = Some(automation.fingerprint(&space));
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
    if !automation.is_validated(&space) {
        automation.validated = None;
        automation.enabled = false;
    }
    store(&db, &key, &automation)?;
    drop(db);
    let status = if automation.is_validated(&space) { "unchanged" } else { "toValidate" };
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
            "Dis à l’utilisateur que l’automatisation l’attend dans Réglages → Automatisations : il la valide et l’active lui-même. Tu ne peux ni la valider, ni l’activer, ni lire son secret. Pour un script, toute modification de son fichier la remet aussi à valider."
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
                    "action": automation.action,
                    "trigger": automation.trigger,
                    "status": status,
                    "problem": problem,
                    "createdBy": automation.created_by,
                    "lastRunAt": automation.last_run_at,
                    "lastStatus": automation.last_status,
                    "lastError": automation.last_error,
                    "lastConversation": automation.last_conversation,
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

/// Module local qui range les scripts créés depuis la page.
pub const SCRIPTS_MODULE: &str = "automatisations";

/// Crée un script vide (une fonction du module `automatisations`, créé au besoin) et rend sa référence et son
/// fichier. Le fichier n’est jamais écrasé.
async fn new_script(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let space = state.space()?;
    let name: String = arg(args, "name")?;
    let runtime: String = opt_arg(args, "runtime")?.unwrap_or_else(|| "python".into());
    if !matches!(runtime.as_str(), "python" | "ts") {
        return Err(AppError::new("Un script s’écrit en Python ou en TypeScript."));
    }
    if space.module(SCRIPTS_MODULE).is_err() {
        space.write_module(&crate::space::ModuleManifest {
            id: SCRIPTS_MODULE.into(),
            name: "Automatisations".into(),
            ..Default::default()
        })?;
    }
    let manifest = space.module(SCRIPTS_MODULE)?;
    let base = slug(&name).replace("automatisation", "script");
    let mut id = base.clone();
    let mut n = 2;
    while manifest.functions.iter().any(|declared| declared.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    let declared = crate::functions::handle(
        state,
        "functions.declare",
        &json!({
            "module": SCRIPTS_MODULE,
            "id": id,
            "description": format!("Script de l’automatisation « {name} »."),
            "runtime": runtime,
        }),
    )
    .await
    .unwrap_or_else(|| Err(AppError::new("Déclaration de fonction indisponible.")))?;
    let file = std::path::PathBuf::from(declared["file"].as_str().unwrap_or_default());
    if !file.exists() {
        let template = if runtime == "python" {
            format!(
                "# Script de l’automatisation « {name} » : il enchaîne des fonctions de l’espace.\n\
# Entrée : l’objet JSON lu sur stdin ; entree[\"event\"] porte ce qu’apporte le déclencheur.\n\
# Sortie : un objet JSON écrit sur stdout. Toute modification de ce fichier remet l’automatisation à valider.\n\
import json\nimport sys\n\nimport alfred\n\nentree = json.load(sys.stdin)\n\
# resultat = alfred.functions.call(\"module/fonction\", {{\"cle\": \"valeur\"}})\n\
# if resultat.get(\"total\", 0) > 0:\n#     alfred.functions.call(\"module/autre\", {{\"total\": resultat[\"total\"]}})\n\
print(json.dumps({{\"ok\": True}}))\n"
            )
        } else {
            format!(
                "// Script de l’automatisation « {name} » : il enchaîne des fonctions de l’espace.\n\
// `entree.event` porte ce qu’apporte le déclencheur. Toute modification de ce fichier remet l’automatisation à valider.\n\
import {{ functions }} from \"@alfred/sdk\";\n\n\
export default async function (entree: {{ event?: unknown }}) {{\n\
  // const resultat = await functions.call<{{ total: number }}>(\"module/fonction\", {{ cle: \"valeur\" }});\n\
  // if (resultat.total > 0) await functions.call(\"module/autre\", {{ total: resultat.total }});\n\
  void functions;\n  return {{ ok: true }};\n}}\n"
            )
        };
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&file, template)?;
    }
    let _ = crate::git::commit_all(&space.root, &format!("Script d’automatisation {SCRIPTS_MODULE}/{id}"));
    state.emit("space:changed", Value::Null);
    Ok(json!({ "reference": format!("{SCRIPTS_MODULE}/{id}"), "file": file.to_string_lossy() }))
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
                        "maxAgentMinutes": MAX_AGENT_MINUTES,
                    }))
                }
                "automations.save" => save(&state, args),
                "automations.validate" => {
                    let db = lock_db(&state)?;
                    let mut automation = existing(&db, &key, &id()?)?;
                    check(&space, &automation)?;
                    automation.validated = Some(automation.fingerprint(&space));
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
                    if enabled && !automation.is_validated(&space) {
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
                "automations.newScript" => new_script(&state, args).await,
                "automations.agentScope" => agent_scope(&state, &space, args),
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
        assert!(entries.iter().any(|entry| entry["status"] == "ok" && entry["summary"] == "appel HTTP → outils/echo"));
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
        assert_eq!(entry["summary"], "planning → outils/echo");
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

    #[test]
    fn conditions_compare_one_reference_with_one_value() {
        let context = Context {
            event: json!({ "body": { "type": "paiement", "montant": "12" } }),
            steps: vec![json!({ "items": [1, 2], "total": 3 })],
            prev: json!({ "total": 3, "nom": "acme", "vide": [] }),
        };
        let yes = |text: &str| holds(&parse_condition(text, 1).unwrap(), &context);
        assert!(yes("$prev.total > 2"));
        assert!(yes("$prev.total >= 3"));
        assert!(!yes("$prev.total < 3"));
        assert!(yes("$prev.total == 3"));
        assert!(yes("$prev.total = \"3\""), "nombre et texte numérique");
        assert!(yes("$event.body.type == \"paiement\""));
        assert!(yes("$event.body.type == paiement"), "mot nu : un texte");
        assert!(yes("$event.body.montant > 10"), "texte numérique comparé en nombre");
        assert!(yes("$steps.1.items contient 2"));
        assert!(yes("$prev.nom contient cm"));
        assert!(yes("$prev contient nom"), "clé d’un objet");
        assert!(yes("$prev.vide vide"));
        assert!(yes("$steps.1.items non-vide"));
        assert!(yes("$prev.total existe"));
        assert!(!yes("$prev.absent existe"));
        assert!(yes("$prev.absent vide"));
        assert!(yes("$prev.nom != autre"));
        for bad in ["prev.total > 1", "$prev.total", "$prev.total ~ 1", "$steps.2.x existe", "$steps.0 existe", "$autre existe", "$prev..x existe"] {
            assert!(parse_condition(bad, 1).is_err(), "{bad}");
        }
        // Références dans une entrée : valeur entière remplacée, `$$` échappe.
        let input = json!({ "total": "$prev.total", "items": ["$steps.1.items", "$$prev"], "type": "$event.body.type", "fixe": 2 });
        assert_eq!(
            substitute(&context, &input),
            json!({ "total": 3, "items": [[1, 2], "$prev"], "type": "paiement", "fixe": 2 })
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn steps_chain_outputs_and_follow_their_conditions() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let _port = serve(&state).await;
        let steps = json!({ "kind": "steps", "steps": [
            { "function": "outils/echo", "input": { "n": 5 } },
            { "function": "outils/echo", "input": { "double": "$prev.recu.n", "premier": "$steps.1.recu" }, "when": "$prev.recu.n > 3" },
            { "function": "outils/echo", "input": {}, "when": "$prev.recu.n > 100" },
            { "function": "outils/boum", "onError": "continue" },
            { "function": "outils/echo", "input": { "erreur": "$prev.error" }, "stopIf": "$prev.recu.erreur contient panne" },
            { "function": "outils/echo", "input": { "jamais": true } }
        ] });
        let created = call(&state, "automations.save", json!({ "name": "Chaîne", "action": steps, "trigger": { "kind": "script" } })).await.unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let run = call(&state, "automations.runNow", json!({ "id": id })).await.unwrap();
        assert_eq!(run["ok"], true, "{run}");
        assert!(run["output"]["recu"]["erreur"].as_str().unwrap().contains("panne du service"), "{run}");

        let entries: Vec<String> = journal(&state, &space).iter().rev().map(|e| e["summary"].as_str().unwrap().to_string()).collect();
        assert_eq!(
            entries,
            vec![
                "étape 1/6 outils/echo : réussie",
                "étape 2/6 outils/echo : réussie",
                "étape 3/6 outils/echo : passée (« $prev.recu.n > 100 » est faux)",
                "étape 4/6 outils/boum : échec",
                "étape 5/6 outils/echo : réussie",
                "arrêt après l’étape 5 (« $prev.recu.erreur contient panne » est vrai)",
                "exécution manuelle → 6 étapes : outils/echo → outils/echo → outils/echo → outils/boum → outils/echo → outils/echo",
            ]
        );
        let second = journal(&state, &space).into_iter().find(|e| e["summary"] == "étape 2/6 outils/echo : réussie").unwrap();
        assert_eq!(second["detail"]["output"]["recu"], json!({ "double": 5, "premier": { "n": 5 } }));

        // Une étape qui échoue sans « continuer » arrête le passage en échec.
        call(&state, "automations.save", json!({ "id": id, "action": { "kind": "steps", "steps": [
            { "function": "outils/boum" }, { "function": "outils/echo" }
        ] } })).await.unwrap();
        let failed = call(&state, "automations.runNow", json!({ "id": id })).await.unwrap();
        assert_eq!(failed["ok"], false);
        assert!(failed["error"].as_str().unwrap().starts_with("Étape 1 (outils/boum)"), "{failed}");

        // Vérifications à l’enregistrement : référence vers une étape à venir, condition illisible, aucune étape.
        for (action, expected) in [
            (json!({ "kind": "steps", "steps": [{ "function": "outils/echo", "input": { "x": "$steps.1.y" } }] }), "étapes 1 à 0"),
            (json!({ "kind": "steps", "steps": [{ "function": "outils/echo", "when": "$prev.x environ 3" }] }), "Condition invalide"),
            (json!({ "kind": "steps", "steps": [] }), "au moins une étape"),
            (json!({ "kind": "steps", "steps": [{ "function": "outils/absente" }] }), "n’est pas déclarée"),
        ] {
            let error = call(&state, "automations.save", json!({ "id": id, "action": action })).await.unwrap_err().message;
            assert!(error.contains(expected), "{error}");
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_script_action_is_validated_with_its_code() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let _port = serve(&state).await;
        // Le script appelle deux fonctions de l’espace par le pont et décide entre elles.
        let mut manifest = space.module("outils").unwrap();
        manifest.functions.push(FunctionDecl { id: "chef".into(), runtime: Runtime::Bash, ..Default::default() });
        space.write_module(&manifest).unwrap();
        let script = space.module_dir("outils").join("functions/chef.sh");
        std::fs::write(
            &script,
            "cat >/dev/null\nr=$(curl -s -X POST \"$ALFRED_SDK_URL/functions.call\" -H \"Authorization: Bearer $ALFRED_SDK_TOKEN\" -H 'Content-Type: application/json' -d '{\"function\":\"echo\",\"input\":{\"a\":1}}')\nprintf '{\"premier\":%s}' \"$r\"\n",
        )
        .unwrap();
        let created = call(&state, "automations.save", json!({
            "name": "Chef", "action": { "kind": "script", "function": "outils/chef" }, "trigger": { "kind": "script" }
        })).await.unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let run = call(&state, "automations.runNow", json!({ "id": id })).await.unwrap();
        assert_eq!(run["output"]["premier"]["ok"]["recu"]["a"], 1, "{run}");
        let listed = call(&state, "automations.list", Value::Null).await.unwrap();
        assert!(listed["automations"][0]["scriptFile"].as_str().unwrap().ends_with("functions/chef.sh"));

        // Le code change : à valider, et plus rien ne part, même à la main.
        std::fs::write(&script, "cat >/dev/null\necho '{\"autre\":true}'\n").unwrap();
        let listed = call(&state, "automations.list", Value::Null).await.unwrap();
        assert_eq!(listed["automations"][0]["status"], "toValidate");
        let refused = call(&state, "automations.runNow", json!({ "id": id })).await.unwrap();
        assert!(refused["error"].as_str().unwrap().contains("à valider"), "{refused}");
        call(&state, "automations.validate", json!({ "id": id })).await.unwrap();
        let run = call(&state, "automations.runNow", json!({ "id": id })).await.unwrap();
        assert_eq!(run["output"], json!({ "autre": true }));

        // Un script vide se crée dans le module « automatisations », sans écraser un fichier.
        let made = call(&state, "automations.newScript", json!({ "name": "Rapport du soir", "runtime": "python" })).await.unwrap();
        assert_eq!(made["reference"], "automatisations/rapport-du-soir");
        let text = std::fs::read_to_string(made["file"].as_str().unwrap()).unwrap();
        assert!(text.contains("import alfred"));
        let again = call(&state, "automations.newScript", json!({ "name": "Rapport du soir", "runtime": "ts" })).await.unwrap();
        assert_eq!(again["reference"], "automatisations/rapport-du-soir-2");
        assert!(std::fs::read_to_string(again["file"].as_str().unwrap()).unwrap().contains("@alfred/sdk"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_agent_action_opens_a_new_scoped_conversation_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        // L’interface simulée : elle répond à chaque demande de passage agentique.
        let asked = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let mut events = state.events.subscribe();
        tokio::spawn({
            let (state, asked) = (state.clone(), asked.clone());
            async move {
                while let Ok(event) = events.recv().await {
                    if event.name != "automation:agent" {
                        continue;
                    }
                    asked.lock().unwrap().push(event.payload.clone());
                    let id = event.payload["requestId"].as_str().unwrap().to_string();
                    let lent = event.payload["context"]["data"] == json!("lent");
                    let answer = if lent {
                        json!({ "status": "timeout", "text": "" })
                    } else {
                        json!({ "status": "done", "text": "Trois relances envoyées." })
                    };
                    let _ = state.resolve_ui(&id, Ok(answer));
                }
            }
        });
        let created = agent_save(&state, &json!({
            "name": "Relances", "action": { "kind": "agent", "instruction": "Relance les impayés.", "maxMinutes": 5 },
            "trigger": { "kind": "script" }
        })).unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["status"], "toValidate");
        call(&state, "automations.validate", json!({ "id": id })).await.unwrap();

        let subject = json!({ "kind": "function", "module": "outils", "reference": "outils/echo" });
        let output = call(&state, "frame.automations.trigger", json!({ "id": id, "event": { "client": "acme" }, "subject": subject })).await.unwrap();
        assert_eq!(output["message"], "Trois relances envoyées.");
        let conversation = output["conversation"].as_str().unwrap().to_string();
        assert!(conversation.starts_with("auto-"));
        let request = asked.lock().unwrap()[0].clone();
        assert_eq!(request["conversation"], json!(conversation));
        assert_eq!(request["maxMinutes"], 5);
        assert_eq!(request["context"]["data"], json!({ "client": "acme" }));
        let text = request["text"].as_str().unwrap();
        assert!(text.starts_with("Relance les impayés."));
        assert!(text.contains("Personne ne regarde"));
        let cwd = std::path::PathBuf::from(request["cwd"].as_str().unwrap());
        assert!(cwd.ends_with(".alfred/automations/relances") && cwd.is_dir(), "{cwd:?}");

        // Périmètre : toutes les fonctions de l’espace, aucun module à modifier.
        let scope = crate::app_db::agent_scope(&state.app_db.lock().unwrap(), &conversation).unwrap().unwrap();
        assert_eq!(scope.module, "automatisation:relances");
        assert_eq!(scope.functions, vec!["outils/echo", "outils/lent", "outils/boum"]);

        // Journal : le passage et le lien vers sa conversation ; la ligne de la page le garde aussi.
        let entry = journal(&state, &space).into_iter().find(|e| e["subject"] == json!(id)).unwrap();
        assert_eq!(entry["summary"], "script outils/echo → agent");
        assert_eq!(entry["detail"]["conversation"], json!(conversation));
        let listed = call(&state, "automations.list", Value::Null).await.unwrap();
        assert_eq!(listed["automations"][0]["lastConversation"], json!(conversation));

        // Durée dépassée : échec, conversation nommée quand même ; chaque passage a sa conversation.
        let late = call(&state, "frame.automations.trigger", json!({ "id": id, "event": "lent", "subject": subject })).await;
        assert!(late.unwrap_err().message.contains("dépassé 5 minutes"));
        let entry = journal(&state, &space).into_iter().find(|e| e["status"] == "error").unwrap();
        assert_ne!(entry["detail"]["conversation"], json!(conversation));

        // Limites vérifiées à l’enregistrement.
        let error = agent_save(&state, &json!({ "id": id, "action": { "kind": "agent", "instruction": "x", "maxMinutes": 500 } })).unwrap_err();
        assert!(error.message.contains("1 à 120 minutes"));
        let error = agent_save(&state, &json!({ "id": id, "action": { "kind": "agent", "instruction": "  " } })).unwrap_err();
        assert!(error.message.contains("consigne"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_agent_action_can_post_to_an_existing_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let asked = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let mut events = state.events.subscribe();
        tokio::spawn({
            let (state, asked) = (state.clone(), asked.clone());
            async move {
                while let Ok(event) = events.recv().await {
                    if event.name == "automation:agent" {
                        asked.lock().unwrap().push(event.payload.clone());
                        let id = event.payload["requestId"].as_str().unwrap().to_string();
                        let _ = state.resolve_ui(&id, Ok(json!({ "status": "done", "text": "Noté." })));
                    }
                }
            }
        });
        let save = |id: &str, archived: bool, autonomy: &str| {
            let data = json!({ "id": id, "title": "Suivi des ventes", "archived": archived, "autonomy": autonomy });
            state.app_db.lock().unwrap().execute(
                "INSERT INTO conversations (id, space, updated_at, data) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO UPDATE SET data = excluded.data",
                params![id, space_key(&space), crate::app_db::now(), data.to_string()],
            ).unwrap();
        };
        let created = agent_save(&state, &json!({
            "name": "Suivi", "trigger": { "kind": "script" },
            "action": { "kind": "agent", "instruction": "Note la vente.", "conversation": "conv-1" }
        })).unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        call(&state, "automations.validate", json!({ "id": id })).await.unwrap();

        // Supprimée, archivée, ou dans un autre mode : le passage échoue, la raison va au Journal.
        let failure = || async {
            let run = call(&state, "automations.runNow", json!({ "id": id })).await.unwrap();
            assert_eq!(run["ok"], false);
            run["error"].as_str().unwrap().to_string()
        };
        assert!(failure().await.contains("a été supprimée"));
        save("conv-1", true, "workspace");
        assert!(failure().await.contains("« Suivi des ventes » est archivée"));
        save("conv-1", false, "auto");
        assert!(failure().await.contains("Seulement dans son dossier"));
        assert!(asked.lock().unwrap().is_empty(), "rien n’a été envoyé");
        let entry = journal(&state, &space).into_iter().next().unwrap();
        assert_eq!(entry["detail"]["conversation"], "conv-1");
        assert!(entry["detail"]["error"].as_str().unwrap().contains("Seulement dans son dossier"));

        // Prête : le message part dans cette conversation, marqué par l’automatisation.
        save("conv-1", false, "workspace");
        let run = call(&state, "automations.runNow", json!({ "id": id })).await.unwrap();
        assert_eq!(run["output"], json!({ "conversation": "conv-1", "message": "Noté." }));
        let request = asked.lock().unwrap()[0].clone();
        assert_eq!(request["existing"], true);
        assert_eq!(request["conversation"], "conv-1");
        assert_eq!(request["title"], "Suivi des ventes");
        assert!(request["text"].as_str().unwrap().contains("vient de l’automatisation « Suivi »"));

        // Le périmètre A-15 ne vaut que pendant le tour, puis celui d’avant revient.
        let scope_of = || crate::app_db::agent_scope(&state.app_db.lock().unwrap(), "conv-1").unwrap();
        let page = crate::app_db::AgentScope { module: "ventes".into(), functions: vec!["outils/echo".into()], ..Default::default() };
        crate::app_db::set_agent_scope(&state.app_db.lock().unwrap(), "conv-1", &page).unwrap();
        call(&state, "automations.agentScope", json!({ "conversation": "conv-1", "automation": id, "on": true })).await.unwrap();
        assert_eq!(scope_of().unwrap().module, "automatisation:suivi");
        call(&state, "automations.agentScope", json!({ "conversation": "conv-1", "on": false })).await.unwrap();
        assert_eq!(scope_of().unwrap(), page);
        state.app_db.lock().unwrap().execute("DELETE FROM agent_scopes WHERE conversation = 'conv-1'", []).unwrap();
        call(&state, "automations.agentScope", json!({ "conversation": "conv-1", "automation": id, "on": true })).await.unwrap();
        call(&state, "automations.agentScope", json!({ "conversation": "conv-1", "on": false })).await.unwrap();
        assert!(scope_of().is_none(), "aucun périmètre avant : aucun après");
        // Une automatisation qui ne vise pas cette conversation ne pose rien.
        let other = call(&state, "automations.agentScope", json!({ "conversation": "conv-2", "automation": id, "on": true })).await;
        assert!(other.is_err());

        // Changer de conversation remet l’automatisation à valider.
        let changed = agent_save(&state, &json!({ "id": id, "action": { "kind": "agent", "instruction": "Note la vente.", "conversation": "conv-2" } })).unwrap();
        assert_eq!(changed["status"], "toValidate");
        // Sans conversation : l’empreinte d’avant ne change pas (une nouvelle conversation par passage).
        let plain = Automation {
            action: Action::Agent { instruction: "x".into(), max_minutes: 15, conversation: None },
            ..from_args(&json!({ "name": "p", "trigger": { "kind": "script" }, "function": "outils/echo" }), None, "user", &[]).unwrap()
        };
        assert!(!plain.fingerprint(&space).contains("conversation"));
    }
}
