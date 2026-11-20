//! Événements entre modules. Un module publie un événement qu’il a déclaré (« ticket-cree ») ; les modules qui s’y
//! abonnent reçoivent son contenu dans une de leurs fonctions. Le module qui publie ne connaît pas ses abonnés :
//! c’est ce qui remplace l’appel direct à la fonction d’un autre module.
//!
//! La livraison passe par une file gardée dans la base de l’espace : elle survit à une fermeture d’Alfred, garde
//! l’ordre des événements pour chaque abonné et retente trois fois une fonction qui échoue. Un module qui s’abonne
//! à un autre sans en dépendre (`requires`) doit en avoir l’accord de l’utilisateur, demandé à la première
//! livraison.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, Space};
use crate::state::AppState;

const ATTEMPTS: i64 = 3;
/// Livraisons terminées gardées.
const KEEP: i64 = 2_000;
/// Contenu d’un événement : 256 Ko au plus (un événement signale, il ne transporte pas un fichier).
const MAX_PAYLOAD: usize = 256 * 1024;

fn open(space: &Space) -> AppResult<Connection> {
    let db = crate::space_db::open(space)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_event_deliveries (
           id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, payload TEXT NOT NULL, subscriber TEXT NOT NULL,
           status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
           published_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS _alfred_event_deliveries_status ON _alfred_event_deliveries (status, id);",
    )?;
    Ok(db)
}

/// « module/événement » d’un abonnement, l’événement local étant écrit sans module.
fn qualified(module: &str, event: &str) -> String {
    if event.contains('/') { event.to_string() } else { format!("{module}/{event}") }
}

/// Abonnés d’un événement : « module/fonction ».
pub fn subscribers(space: &Space, event: &str) -> Vec<String> {
    let mut found = Vec::new();
    for module in space.module_ids() {
        let Ok(manifest) = space.module(&module) else { continue };
        for subscription in &manifest.events.subscribes {
            if qualified(&module, &subscription.event) == event {
                found.push(format!("{module}/{}", subscription.function));
            }
        }
    }
    found
}

/// Publie un événement déclaré par le module : une livraison par abonné, dans l’ordre de publication.
pub fn publish(space: &Space, module: &str, id: &str, payload: &Value) -> AppResult<Value> {
    let manifest = space.module(module)?;
    if !manifest.events.publishes.iter().any(|event| event.id == id) {
        return Err(AppError::new(format!(
            "L’événement « {id} » n’est pas déclaré dans `events.publishes` du module « {module} »."
        )));
    }
    let text = payload.to_string();
    if text.len() > MAX_PAYLOAD {
        return Err(AppError::new("Contenu d’événement trop gros (256 Ko au plus) : transmettre un identifiant, pas les données."));
    }
    let event = format!("{module}/{id}");
    let targets = subscribers(space, &event);
    let db = open(space)?;
    let now = crate::app_db::now();
    for subscriber in &targets {
        db.execute(
            "INSERT INTO _alfred_event_deliveries (event, payload, subscriber, status, published_at, updated_at)
             VALUES (?1, ?2, ?3, 'pending', ?4, ?4)",
            params![event, text, subscriber, now],
        )?;
    }
    db.execute(
        "DELETE FROM _alfred_event_deliveries WHERE status != 'pending' AND id <= (SELECT max(id) FROM _alfred_event_deliveries) - ?1",
        [KEEP],
    )?;
    // Les conversations d’agent qui attendent cet événement sont relancées (suivis, `ai.watch`).
    crate::agents::watches::published(space, &event, payload);
    Ok(json!({ "event": event, "subscribers": targets.len() }))
}

/// Occurrences publiées, pour la règle « une fois par occurrence observée » : la première publication d’un
/// identifiant d’occurrence rend vrai, les suivantes faux. Les 10 000 dernières sont gardées.
pub fn first_occurrence(space: &Space, event: &str, occurrence: &str) -> AppResult<bool> {
    if occurrence.is_empty() || occurrence.len() > 200 {
        return Err(AppError::new("L’identifiant d’occurrence fait de 1 à 200 caractères."));
    }
    let db = open(space)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS _alfred_event_occurrences (
           id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, occurrence TEXT NOT NULL, UNIQUE (event, occurrence));",
    )?;
    let inserted = db.execute(
        "INSERT OR IGNORE INTO _alfred_event_occurrences (event, occurrence) VALUES (?1, ?2)",
        params![event, occurrence],
    )?;
    db.execute(
        "DELETE FROM _alfred_event_occurrences WHERE id <= (SELECT max(id) FROM _alfred_event_occurrences) - 10000",
        [],
    )?;
    Ok(inserted > 0)
}

/// Dernières livraisons, les plus récentes d’abord.
pub fn list(space: &Space, limit: usize) -> AppResult<Vec<Value>> {
    let db = open(space)?;
    let mut statement = db.prepare(
        "SELECT id, event, subscriber, status, attempts, error, published_at, updated_at
         FROM _alfred_event_deliveries ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = statement
        .query_map([limit as i64], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "event": row.get::<_, String>(1)?,
                "subscriber": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "attempts": row.get::<_, i64>(4)?,
                "error": row.get::<_, Option<String>>(5)?,
                "publishedAt": row.get::<_, String>(6)?,
                "updatedAt": row.get::<_, String>(7)?,
            }))
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Problèmes de déclaration, pour `check` : abonnement à un événement que personne ne déclare, fonction absente.
pub fn problems(space: &Space, only: Option<&str>) -> Vec<Value> {
    let mut problems = Vec::new();
    let modules = space.module_ids();
    let declared = |event: &str| -> bool {
        let Some((module, id)) = event.split_once('/') else { return false };
        space.module(module).is_ok_and(|manifest| manifest.events.publishes.iter().any(|published| published.id == id))
    };
    for module in modules.iter().filter(|module| only.is_none_or(|only| only == module.as_str())) {
        let Ok(manifest) = space.module(module) else { continue };
        for event in &manifest.events.publishes {
            if !valid_id(&event.id) {
                problems.push(json!({ "module": module, "event": event.id, "problem": "Identifiant d’événement invalide : minuscules, chiffres et tirets." }));
            }
        }
        for subscription in &manifest.events.subscribes {
            let event = qualified(module, &subscription.event);
            if !declared(&event) {
                problems.push(json!({
                    "module": module,
                    "event": event,
                    "problem": "Aucun module ne déclare cet événement dans `events.publishes` : l’abonnement ne recevra rien.",
                }));
            }
            if !manifest.functions.iter().any(|function| function.id == subscription.function) {
                problems.push(json!({
                    "module": module,
                    "event": event,
                    "problem": format!("La fonction « {} » n’est pas déclarée dans le module (identifiant local, sans « module/ »).", subscription.function),
                }));
            }
        }
    }
    problems
}

// ---------------------------------------------------------------------------------------------------------------
// Livraison
// ---------------------------------------------------------------------------------------------------------------

struct Courier {
    wake: tokio::sync::Notify,
    /// Abonnés en cours de livraison : un seul événement à la fois par abonné, pour garder l’ordre.
    busy: Mutex<HashSet<String>>,
}

fn courier() -> &'static Courier {
    static COURIER: OnceLock<Courier> = OnceLock::new();
    COURIER.get_or_init(|| Courier { wake: tokio::sync::Notify::new(), busy: Mutex::new(HashSet::new()) })
}

pub fn kick() {
    courier().wake.notify_one();
}

pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            let _ = tokio::time::timeout(Duration::from_secs(5), courier().wake.notified()).await;
            if let Some(space) = state.try_space() {
                if let Err(error) = dispatch_pending(&state, &space) {
                    log::error!("événements : {}", error.message);
                }
            }
        }
    });
}

fn dispatch_pending(state: &Arc<AppState>, space: &Space) -> AppResult<()> {
    let db = open(space)?;
    let mut statement =
        db.prepare("SELECT DISTINCT subscriber FROM _alfred_event_deliveries WHERE status = 'pending' ORDER BY id")?;
    let waiting: Vec<String> = statement.query_map([], |row| row.get(0))?.filter_map(Result::ok).collect();
    for subscriber in waiting {
        {
            let mut busy = courier().busy.lock().map_err(|_| AppError::new("Événements indisponibles."))?;
            if !busy.insert(subscriber.clone()) {
                continue;
            }
        }
        let state = state.clone();
        let space = space.clone();
        tokio::spawn(async move {
            if let Err(error) = deliver_all(&state, &space, &subscriber).await {
                log::error!("livraison à {subscriber} : {}", error.message);
            }
            if let Ok(mut busy) = courier().busy.lock() {
                busy.remove(&subscriber);
            }
            state.emit("events:changed", Value::Null);
        });
    }
    Ok(())
}

/// L’abonné a-t-il le droit de recevoir cet événement ? Son propre module ou une dépendance : oui ; sinon,
/// l’accord de l’utilisateur, demandé une fois.
async fn authorized(state: &Arc<AppState>, space: &Space, subscriber: &str, event: &str) -> AppResult<()> {
    let (module, _) = subscriber.split_once('/').unwrap_or_default();
    let (publisher, id) = event.split_once('/').unwrap_or_default();
    if module == publisher || space.module(module).is_ok_and(|manifest| manifest.requires_module(publisher)) {
        return Ok(());
    }
    let subject = Subject {
        kind: "function".into(),
        module: module.to_string(),
        reference: format!("{module}/*"),
        instance: None,
        ..Default::default()
    };
    let name = space.module(publisher).map(|manifest| manifest.name).unwrap_or_else(|_| publisher.to_string());
    crate::permissions::ensure(state, &subject, &format!("event:{event}"), &format!("l’événement « {id} » du module {name}")).await
}

async fn deliver_all(state: &Arc<AppState>, space: &Space, subscriber: &str) -> AppResult<()> {
    loop {
        if state.try_space().is_none_or(|current| current.root != space.root) {
            return Ok(());
        }
        let next: Option<(i64, String, String, String, i64)> = {
            let db = open(space)?;
            let mut statement = db.prepare(
                "SELECT id, event, payload, published_at, attempts FROM _alfred_event_deliveries
                 WHERE subscriber = ?1 AND status = 'pending' ORDER BY id LIMIT 1",
            )?;
            let mut rows = statement.query_map([subscriber], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?;
            rows.next().transpose()?
        };
        let Some((id, event, payload, published_at, attempts)) = next else { return Ok(()) };
        let mark = |status: &str, attempts: i64, error: Option<&str>| -> AppResult<()> {
            open(space)?.execute(
                "UPDATE _alfred_event_deliveries SET status = ?2, attempts = ?3, error = ?4, updated_at = ?5 WHERE id = ?1",
                params![id, status, attempts, error, crate::app_db::now()],
            )?;
            Ok(())
        };
        if let Err(error) = authorized(state, space, subscriber, &event).await {
            mark("refused", attempts, Some(&error.message))?;
            crate::functions::journal(state, "event", subscriber, false, None, &format!("{event} non livré : {}", error.message), None);
            continue;
        }
        let input = json!({
            "event": event,
            "from": event.split_once('/').map(|(module, _)| module).unwrap_or_default(),
            "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),
            "publishedAt": published_at,
        });
        let started = std::time::Instant::now();
        match crate::functions::call(state, subscriber, input, "événement").await {
            Ok(_) => {
                mark("done", attempts + 1, None)?;
                crate::functions::journal(
                    state,
                    "event",
                    subscriber,
                    true,
                    Some(started.elapsed().as_millis() as u64),
                    &format!("{event} livré"),
                    Some(&json!({ "delivery": id })),
                );
            }
            Err(error) => {
                let attempts = attempts + 1;
                if attempts >= ATTEMPTS {
                    mark("failed", attempts, Some(&error.message))?;
                    crate::functions::journal(
                        state,
                        "event",
                        subscriber,
                        false,
                        None,
                        &format!("{event} non livré après {ATTEMPTS} essais : {}", error.message),
                        Some(&json!({ "delivery": id, "error": error.message })),
                    );
                } else {
                    mark("pending", attempts, Some(&error.message))?;
                    tokio::time::sleep(Duration::from_secs(2 * attempts as u64)).await;
                }
            }
        }
    }
}

/// Relivre une livraison en échec ou refusée.
pub fn retry(space: &Space, id: i64) -> AppResult<()> {
    let changed = open(space)?.execute(
        "UPDATE _alfred_event_deliveries SET status = 'pending', attempts = 0, error = NULL WHERE id = ?1 AND status IN ('failed', 'refused')",
        [id],
    )?;
    if changed == 0 {
        return Err(AppError::new("Seule une livraison en échec ou refusée se relance."));
    }
    Ok(())
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    let result = match command {
        "frame.events.publish" => (|| {
            let subject: Subject = arg(args, "subject")?;
            let id: String = arg(args, "event")?;
            let space = state.space()?;
            // Une occurrence déjà publiée (même identifiant pour cet événement) ne l’est pas une seconde fois.
            if let Some(occurrence) = opt_arg::<String>(args, "occurrence")? {
                if !first_occurrence(&space, &format!("{}/{id}", subject.module), &occurrence)? {
                    return Ok(json!({ "event": format!("{}/{id}", subject.module), "subscribers": 0, "duplicate": true }));
                }
            }
            let result = publish(&space, &subject.module, &id, args.get("payload").unwrap_or(&Value::Null))?;
            kick();
            Ok(result)
        })(),
        "events.deliveries" => (|| {
            let limit: Option<usize> = opt_arg(args, "limit")?;
            Ok(Value::Array(list(&state.space()?, limit.unwrap_or(200).min(1000))?))
        })(),
        "events.retry" => (|| {
            retry(&state.space()?, arg(args, "id")?)?;
            kick();
            Ok(Value::Null)
        })(),
        _ => return None,
    };
    if result.is_ok() {
        state.emit("events:changed", Value::Null);
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{EventDecl, FunctionDecl, ModuleManifest, Requirement, SubscriptionDecl};

    fn module(space: &Space, manifest: ModuleManifest, scripts: &[(&str, &str)]) {
        space.write_module(&manifest).unwrap();
        let dir = space.module_dir(&manifest.id).join("functions");
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in scripts {
            std::fs::write(dir.join(format!("{name}.sh")), body).unwrap();
        }
    }

    fn script(id: &str) -> FunctionDecl {
        FunctionDecl { id: id.into(), runtime: crate::scripts::Runtime::Bash, ..Default::default() }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_published_event_reaches_each_subscriber_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        let mut support = ModuleManifest { id: "support".into(), name: "Support".into(), ..Default::default() };
        support.events.publishes.push(EventDecl { id: "ticket-cree".into(), ..Default::default() });
        module(&space, support, &[]);
        // « taches » dépend de « support » : livré sans question. Il écrit chaque contenu reçu dans un fichier.
        let journal = dir.path().join("recus.txt");
        let mut taches = ModuleManifest { id: "taches".into(), name: "Tâches".into(), ..Default::default() };
        taches.requires.push(Requirement { module: "support".into(), ..Default::default() });
        taches.functions.push(script("creer"));
        taches.events.subscribes.push(SubscriptionDecl { event: "support/ticket-cree".into(), function: "creer".into() });
        module(&space, taches, &[("creer", &format!("cat >> '{}'; echo >> '{}'", journal.display(), journal.display()))]);
        // « echecs » échoue toujours : trois essais, puis l’échec reste visible.
        let mut echecs = ModuleManifest { id: "echecs".into(), name: "Échecs".into(), ..Default::default() };
        echecs.requires.push(Requirement { module: "support".into(), ..Default::default() });
        echecs.functions.push(script("casser"));
        echecs.events.subscribes.push(SubscriptionDecl { event: "support/ticket-cree".into(), function: "casser".into() });
        module(&space, echecs, &[("casser", "echo 'refus' >&2; exit 2")]);
        state.set_space(Some(space.clone()));

        assert!(publish(&space, "support", "inconnu", &json!({})).is_err());
        assert!(publish(&space, "taches", "ticket-cree", &json!({})).is_err(), "seul le module qui le déclare publie");
        assert_eq!(publish(&space, "support", "ticket-cree", &json!({ "id": 1 })).unwrap()["subscribers"], 2);
        publish(&space, "support", "ticket-cree", &json!({ "id": 2 })).unwrap();
        start(state.clone());
        kick();
        for _ in 0..150 {
            let rows = list(&space, 10).unwrap();
            if rows.iter().all(|row| row["status"] != "pending") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let received = std::fs::read_to_string(&journal).unwrap();
        let lines: Vec<Value> = received.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["payload"], json!({ "id": 1 }), "dans l’ordre");
        assert_eq!(lines[1]["payload"], json!({ "id": 2 }));
        assert_eq!(lines[0]["event"], "support/ticket-cree");
        assert_eq!(lines[0]["from"], "support");
        let rows = list(&space, 10).unwrap();
        let failed: Vec<&Value> = rows.iter().filter(|row| row["subscriber"] == "echecs/casser").collect();
        assert!(failed.iter().all(|row| row["status"] == "failed" && row["attempts"] == 3), "{failed:?}");
        assert!(failed[0]["error"].as_str().unwrap().contains("refus"));
        retry(&space, failed[0]["id"].as_i64().unwrap()).unwrap();
        assert!(retry(&space, rows.iter().find(|row| row["status"] == "done").unwrap()["id"].as_i64().unwrap()).is_err());
    }

    #[test]
    fn check_reports_dangling_subscriptions() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let mut taches = ModuleManifest { id: "taches".into(), name: "Tâches".into(), ..Default::default() };
        taches.events.subscribes.push(SubscriptionDecl { event: "support/ticket-cree".into(), function: "creer".into() });
        module(&space, taches, &[]);
        let found = problems(&space, None);
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(problems(&space, Some("autre")).is_empty());
    }
}
