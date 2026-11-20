//! Canaux : connexions longues ouvertes par une fonction vers un compte (réponse en continu, SSE, journal suivi,
//! WebSocket), que la page lit et écrit sans jamais joindre le compte. La fonction du connecteur ouvre le canal
//! (`client(id).stream(...)`, `client(id).socket(...)`, `transport.rs`) et rend son identifiant ; la page lit ses
//! événements par `channels.read`, écrit par `channels.write` et le ferme par `channels.close`.
//!
//! Un canal appartient au module qui l’a ouvert : seul ce module le lit. Il se ferme quand la page qui le lisait
//! disparaît, après 10 minutes sans lecture, ou deux minutes s’il n’a jamais été lu. Ce que reçoit le canal est
//! déjà débarrassé des secrets du compte (`transport.rs`).

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::state::AppState;

/// Canaux ouverts en même temps par un module.
pub const MAX_PER_MODULE: usize = 16;
/// Texte ou binaire envoyé par une écriture.
pub const MAX_WRITE: usize = 64 * 1024;
/// Événements gardés pour la lecture : au-delà, les plus anciens sont oubliés (`dropped`).
const MAX_EVENTS: usize = 5_000;
const MAX_BYTES: usize = 4 * 1024 * 1024;
/// Plus longue attente d’une lecture (`wait`), en secondes.
const MAX_WAIT: u64 = 25;
/// Sans lecture pendant ce temps, le canal se ferme.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// Un canal jamais lu se ferme plus tôt : la page qui devait le lire n’est pas venue.
pub const UNREAD: Duration = Duration::from_secs(2 * 60);
/// Un canal fermé reste lisible ce temps-là, pour que la page lise sa fin.
const KEEP_CLOSED: Duration = Duration::from_secs(2 * 60);

/// Ce que la page envoie par un WebSocket.
#[derive(Debug)]
pub enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

struct Channel {
    space: String,
    module: String,
    client: String,
    kind: &'static str,
    events: VecDeque<Value>,
    bytes: usize,
    next: u64,
    dropped: u64,
    closed: Option<String>,
    opened: Instant,
    last_read: Option<Instant>,
    closed_at: Option<Instant>,
    /// Cadres (pages, panneaux) qui lisent le canal : quand le dernier disparaît, le canal se ferme.
    holders: BTreeSet<String>,
    outgoing: Option<mpsc::Sender<Outgoing>>,
    task: Option<tokio::task::AbortHandle>,
    notify: Arc<Notify>,
}

fn registry() -> &'static Mutex<HashMap<String, Channel>> {
    static CHANNELS: OnceLock<Mutex<HashMap<String, Channel>>> = OnceLock::new();
    CHANNELS.get_or_init(Default::default)
}

fn lock() -> AppResult<std::sync::MutexGuard<'static, HashMap<String, Channel>>> {
    registry().lock().map_err(|_| AppError::new("Les canaux sont indisponibles."))
}

fn unknown(id: &str) -> AppError {
    AppError::new(format!("Le canal « {id} » n’existe pas ou n’est plus ouvert pour ce module."))
}

/// Ouvre un canal pour `module` ; `outgoing` : les écritures de la page (WebSocket), absent pour un flux en lecture.
pub fn open(
    space: &str,
    module: &str,
    client: &str,
    kind: &'static str,
    outgoing: Option<mpsc::Sender<Outgoing>>,
) -> AppResult<String> {
    start_sweeper();
    let mut channels = lock()?;
    let open = channels.values().filter(|channel| channel.module == module && channel.closed.is_none()).count();
    if open >= MAX_PER_MODULE {
        return Err(AppError::new(format!(
            "Trop de canaux ouverts pour ce module ({MAX_PER_MODULE} au plus) : fermez ceux qui ne servent plus avec `channels.close`."
        )));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    channels.insert(
        id.clone(),
        Channel {
            space: space.to_string(),
            module: module.to_string(),
            client: client.to_string(),
            kind,
            events: VecDeque::new(),
            bytes: 0,
            next: 1,
            dropped: 0,
            closed: None,
            opened: Instant::now(),
            last_read: None,
            closed_at: None,
            holders: BTreeSet::new(),
            outgoing,
            task: None,
            notify: Arc::new(Notify::new()),
        },
    );
    Ok(id)
}

/// Tâche qui alimente le canal : elle est arrêtée à sa fermeture.
pub fn attach(id: &str, task: tokio::task::AbortHandle) {
    let Ok(mut channels) = lock() else { return task.abort() };
    match channels.get_mut(id) {
        Some(channel) if channel.closed.is_none() => channel.task = Some(task),
        _ => task.abort(),
    }
}

fn record(channel: &mut Channel, mut event: Value) {
    event["seq"] = json!(channel.next);
    channel.next += 1;
    let size = event.get("data").and_then(Value::as_str).map_or(0, str::len) + 64;
    channel.bytes += size;
    channel.events.push_back(event);
    while channel.events.len() > MAX_EVENTS || channel.bytes > MAX_BYTES {
        let Some(old) = channel.events.pop_front() else { break };
        channel.bytes -= old.get("data").and_then(Value::as_str).map_or(0, str::len) + 64;
        channel.dropped += 1;
    }
    channel.notify.notify_waiters();
}

/// Ajoute un événement (`{ type, data, … }`) ; `false` si le canal est fermé : la tâche s’arrête alors.
pub fn push(id: &str, event: Value) -> bool {
    let Ok(mut channels) = lock() else { return false };
    match channels.get_mut(id) {
        Some(channel) if channel.closed.is_none() => {
            record(channel, event);
            true
        }
        _ => false,
    }
}

fn mark_closed(channel: &mut Channel, reason: &str, error: bool) {
    if channel.closed.is_some() {
        return;
    }
    let mut event = json!({ "type": if error { "error" } else { "close" } });
    if !reason.is_empty() {
        event["data"] = json!(reason);
    }
    record(channel, event);
    channel.closed = Some(reason.to_string());
    channel.closed_at = Some(Instant::now());
    channel.outgoing = None;
    channel.task = None;
}

/// Fin venue du service (flux terminé, WebSocket fermé, erreur réseau) : la tâche s’est arrêtée d’elle-même.
pub fn finish(id: &str, reason: &str, error: bool) {
    if let Ok(mut channels) = lock() {
        if let Some(channel) = channels.get_mut(id) {
            mark_closed(channel, reason, error);
        }
    }
}

/// Fermeture voulue par Alfred ou la page : un WebSocket reçoit d’abord sa trame de fermeture.
fn shut(channel: &mut Channel, reason: &str) {
    if channel.closed.is_some() {
        return;
    }
    let task = channel.task.take();
    match channel.outgoing.take() {
        Some(outgoing) if outgoing.try_send(Outgoing::Close).is_ok() => {
            // La tâche envoie la trame de fermeture puis s’arrête ; arrêtée de force si le service ne répond plus.
            if let Some(task) = task {
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        task.abort();
                    });
                } else {
                    task.abort();
                }
            }
        }
        _ => {
            if let Some(task) = task {
                task.abort();
            }
        }
    }
    mark_closed(channel, reason, false);
}

fn owned<'a>(
    channels: &'a mut HashMap<String, Channel>,
    space: &str,
    subject: &Subject,
    id: &str,
) -> AppResult<&'a mut Channel> {
    channels.get_mut(id).filter(|channel| channel.module == subject.module && channel.space == space).ok_or_else(|| unknown(id))
}

/// Événements après `after` ; attend jusqu’à `wait` secondes qu’il en arrive si aucun n’est là.
/// `holder` : le cadre qui lit (page, panneau, copie comprise) ; à défaut, la référence du demandeur.
pub async fn read(space: &str, subject: &Subject, holder: Option<&str>, id: &str, after: u64, wait: u64) -> AppResult<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait.min(MAX_WAIT));
    loop {
        let notify = {
            let mut channels = lock()?;
            let channel = owned(&mut channels, space, subject, id)?;
            channel.last_read = Some(Instant::now());
            if subject.kind != "function" {
                channel.holders.insert(holder.unwrap_or(&subject.reference).to_string());
            }
            let events: Vec<Value> = channel
                .events
                .iter()
                .filter(|event| event["seq"].as_u64().is_some_and(|seq| seq > after))
                .cloned()
                .collect();
            if !events.is_empty() || channel.closed.is_some() || tokio::time::Instant::now() >= deadline {
                let next = events.last().and_then(|event| event["seq"].as_u64()).unwrap_or(after);
                return Ok(json!({
                    "events": events,
                    "next": next,
                    "closed": channel.closed.is_some(),
                    "reason": channel.closed,
                    "dropped": channel.dropped,
                    "kind": channel.kind,
                    "client": channel.client,
                }));
            }
            channel.notify.clone()
        };
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        // Un événement arrivé entre la lecture et l’inscription : on relit tout de suite.
        if lock()?.get(id).is_some_and(|channel| {
            channel.closed.is_some() || channel.events.back().and_then(|event| event["seq"].as_u64()).is_some_and(|seq| seq > after)
        }) {
            continue;
        }
        let _ = tokio::time::timeout_at(deadline, notified).await;
    }
}

/// Envoie un message par le WebSocket du canal : `text`, ou `data` (base64) pour un binaire.
pub fn write(space: &str, subject: &Subject, id: &str, text: Option<String>, data: Option<String>) -> AppResult<()> {
    let message = match (text, data) {
        (Some(text), None) => {
            if text.len() > MAX_WRITE {
                return Err(AppError::new("Écriture trop longue : 64 Kio au plus par appel."));
            }
            Outgoing::Text(text)
        }
        (None, Some(data)) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|_| AppError::new("`data` doit être du base64."))?;
            if bytes.len() > MAX_WRITE {
                return Err(AppError::new("Écriture trop longue : 64 Kio au plus par appel."));
            }
            Outgoing::Binary(bytes)
        }
        _ => return Err(AppError::new("Fournir `text`, ou `data` en base64, pour écrire dans le canal.")),
    };
    let mut channels = lock()?;
    let channel = owned(&mut channels, space, subject, id)?;
    if channel.closed.is_some() {
        return Err(AppError::new("Le canal est fermé : rien n’a été envoyé."));
    }
    let Some(outgoing) = &channel.outgoing else {
        return Err(AppError::new("Ce canal est un flux en lecture seule : seul un WebSocket (`client(id).socket`) reçoit des écritures."));
    };
    channel.last_read = Some(Instant::now());
    outgoing.try_send(message).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => AppError::new("Le service ne lit pas assez vite : réessayez dans un instant."),
        mpsc::error::TrySendError::Closed(_) => AppError::new("Le canal est fermé : rien n’a été envoyé."),
    })
}

pub fn close(space: &str, subject: &Subject, id: &str) -> AppResult<()> {
    let mut channels = lock()?;
    let channel = owned(&mut channels, space, subject, id)?;
    shut(channel, "fermé par la page");
    Ok(())
}

/// Le demandeur d’une lecture, d’une écriture ou d’une fermeture : un cadre d’un module qui dépend du module qui a
/// ouvert le canal (la page Usine d’Atom et le connecteur `portainer`) agit pour ce module ; sa référence (qui tient
/// le canal) ne change pas.
fn reader(subject: Subject, id: &str, depends: impl Fn(&str) -> bool) -> Subject {
    let owner = lock().ok().and_then(|channels| channels.get(id).map(|channel| channel.module.clone()));
    match owner {
        Some(owner) if owner != subject.module && depends(&owner) => Subject { module: owner, ..subject },
        _ => subject,
    }
}

/// Un cadre disparaît : les canaux qu’il était seul à lire se ferment, y compris ceux d’un module dont il dépend
/// (le cadre est nommé par sa référence complète, « module/page »).
pub fn release(subject: &Subject, holder: Option<&str>) -> usize {
    let holder = holder.unwrap_or(&subject.reference).to_string();
    let Ok(mut channels) = lock() else { return 0 };
    let mut closed = 0;
    for channel in channels.values_mut() {
        if channel.holders.remove(&holder) && channel.holders.is_empty() && channel.closed.is_none() {
            shut(channel, "page fermée");
            closed += 1;
        }
    }
    closed
}

/// Ferme les canaux oubliés et retire ceux fermés depuis un moment ; rend le nombre de canaux fermés.
pub fn sweep(now: Instant) -> usize {
    sweep_where(now, |_| true)
}

fn sweep_where(now: Instant, concerned: impl Fn(&str) -> bool) -> usize {
    let Ok(mut channels) = lock() else { return 0 };
    let mut closed = 0;
    for channel in channels.values_mut().filter(|channel| channel.closed.is_none() && concerned(&channel.module)) {
        let idle = match channel.last_read {
            Some(read) => now.saturating_duration_since(read) > IDLE,
            None => now.saturating_duration_since(channel.opened) > UNREAD,
        };
        if idle {
            shut(channel, "fermé faute de lecture");
            channel.closed_at = Some(now);
            closed += 1;
        }
    }
    channels.retain(|_, channel| {
        !concerned(&channel.module) || channel.closed_at.is_none_or(|at| now.saturating_duration_since(at) <= KEEP_CLOSED)
    });
    closed
}

#[cfg(test)]
/// Canaux ouverts, pour les tests et le diagnostic : identifiant, module, compte, nature, fermé ou non.
pub fn list(module: &str) -> Vec<Value> {
    let Ok(channels) = lock() else { return Vec::new() };
    channels
        .iter()
        .filter(|(_, channel)| channel.module == module)
        .map(|(id, channel)| json!({ "id": id, "client": channel.client, "kind": channel.kind, "closed": channel.closed.is_some() }))
        .collect()
}

fn start_sweeper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if cfg!(test) || STARTED.get().is_some() {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    STARTED.get_or_init(|| {
        runtime.spawn(async {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                sweep(Instant::now());
            }
        });
    });
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("frame.channels.") {
        return None;
    }
    let result = async {
        let subject: Subject = arg(args, "subject")?;
        let holder: Option<String> = opt_arg(args, "holder")?;
        if command == "frame.channels.release" {
            return Ok(json!({ "closed": release(&subject, holder.as_deref()) }));
        }
        let open_space = state.space()?;
        let space = open_space.root.to_string_lossy().to_string();
        let id: String = arg(args, "channel")?;
        // Un canal ouvert par un connecteur dont le module dépend (`requires`) se lit comme le sien.
        let module = subject.module.clone();
        let subject = reader(subject, &id, |owner| open_space.module(&module).is_ok_and(|manifest| manifest.requires_module(owner)));
        match command {
            "frame.channels.read" => {
                let after = opt_arg::<u64>(args, "after")?.unwrap_or(0);
                let wait = opt_arg::<u64>(args, "wait")?.unwrap_or(0);
                read(&space, &subject, holder.as_deref(), &id, after, wait).await
            }
            "frame.channels.write" => {
                write(&space, &subject, &id, opt_arg(args, "text")?, opt_arg(args, "data")?)?;
                Ok(Value::Null)
            }
            "frame.channels.close" => {
                close(&space, &subject, &id)?;
                Ok(Value::Null)
            }
            _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
        }
    }
    .await;
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(kind: &str, module: &str, reference: &str) -> Subject {
        Subject {
            kind: kind.into(),
            module: module.into(),
            reference: reference.into(),
            instance: None,
            accounts: Default::default(),
            examples: false,
        }
    }

    #[tokio::test]
    async fn a_channel_is_read_by_its_module_only_and_closes_with_its_page() {
        let space = format!("/espace/{}", uuid::Uuid::new_v4());
        let id = open(&space, "portainer", "portainer", "stream", None).unwrap();
        let page = subject("page", "portainer", "portainer/journaux");
        assert!(push(&id, json!({ "type": "data", "data": "ligne 1" })));
        assert!(push(&id, json!({ "type": "data", "data": "ligne 2" })));

        let first = read(&space, &page, None, &id, 0, 0).await.unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(), 2);
        assert_eq!(first["next"], 2);
        let again = read(&space, &page, None, &id, 2, 0).await.unwrap();
        assert!(again["events"].as_array().unwrap().is_empty());

        // Un autre module, ou un autre espace, ne le voit pas.
        assert!(read(&space, &subject("page", "autre", "autre/p"), None, &id, 0, 0).await.is_err());
        // Un module qui dépend du connecteur le lit, et sa page qui disparaît le ferme.
        let dependant = reader(subject("page", "atom", "atom/usine"), &id, |owner| owner == "portainer");
        assert_eq!((dependant.module.as_str(), dependant.reference.as_str()), ("portainer", "atom/usine"));
        assert_eq!(read(&space, &dependant, None, &id, 0, 0).await.unwrap()["events"].as_array().unwrap().len(), 2);
        let stranger = reader(subject("page", "autre", "autre/p"), &id, |_| false);
        assert!(read(&space, &stranger, None, &id, 0, 0).await.is_err(), "sans dépendance, toujours refusé");
        assert_eq!(release(&subject("page", "atom", "atom/usine"), None), 0, "la page du connecteur le lit encore");
        assert!(read("/ailleurs", &page, None, &id, 0, 0).await.is_err());
        // Un flux ne reçoit pas d’écriture.
        assert!(write(&space, &page, &id, Some("x".into()), None).is_err());

        // Une lecture qui attend est réveillée par l’événement suivant.
        let waiting = {
            let (space, page, id) = (space.clone(), page.clone(), id.clone());
            tokio::spawn(async move { read(&space, &page, None, &id, 2, 5).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        push(&id, json!({ "type": "data", "data": "ligne 3" }));
        let woke = tokio::time::timeout(Duration::from_secs(2), waiting).await.unwrap().unwrap().unwrap();
        assert_eq!(woke["events"][0]["data"], "ligne 3");

        // La page disparaît : le canal se ferme, sa fin reste lisible.
        assert_eq!(release(&page, None), 1);
        let end = read(&space, &page, None, &id, 3, 0).await.unwrap();
        assert_eq!(end["closed"], true);
        assert_eq!(end["events"][0]["type"], "close");
        assert!(!push(&id, json!({ "type": "data", "data": "trop tard" })));
    }

    #[tokio::test]
    async fn a_forgotten_channel_closes_and_the_buffer_stays_bounded() {
        let space = format!("/espace/{}", uuid::Uuid::new_v4());
        let unread = open(&space, "oubli", "c", "stream", None).unwrap();
        let read_once = open(&space, "oubli", "c", "stream", None).unwrap();
        let function = subject("function", "oubli", "oubli/suivre");
        read(&space, &function, None, &read_once, 0, 0).await.unwrap();

        let later = Instant::now() + UNREAD + Duration::from_secs(1);
        sweep_where(later, |module| module == "oubli");
        let listed = list("oubli");
        let closed = |id: &str| listed.iter().find(|channel| channel["id"] == id).unwrap()["closed"] == true;
        assert!(closed(&unread), "jamais lu : fermé après deux minutes");
        assert!(!closed(&read_once), "lu il y a peu : ouvert");
        sweep_where(Instant::now() + IDLE + Duration::from_secs(1), |module| module == "oubli");
        assert!(list("oubli").iter().all(|channel| channel["closed"] == true));
        sweep_where(Instant::now() + IDLE + KEEP_CLOSED + Duration::from_secs(10), |module| module == "oubli");
        assert!(list("oubli").is_empty(), "les canaux fermés sont retirés");

        let big = open(&space, "gros", "c", "stream", None).unwrap();
        let chunk = "x".repeat(4096);
        for _ in 0..2_000 {
            push(&big, json!({ "type": "data", "data": chunk }));
        }
        let page = subject("page", "gros", "gros/p");
        let state = read(&space, &page, None, &big, 0, 0).await.unwrap();
        assert!(state["dropped"].as_u64().unwrap() > 0);
        assert!(state["events"].as_array().unwrap().len() < 2_000);

        // Pas plus de seize canaux ouverts par module.
        for _ in 0..MAX_PER_MODULE - 1 {
            open(&space, "gros", "c", "stream", None).unwrap();
        }
        assert!(open(&space, "gros", "c", "stream", None).is_err());
    }
}
