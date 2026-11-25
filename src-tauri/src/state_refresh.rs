//! Rafraîchissement des états par leur fournisseur, dans le cœur. Le module qui déclare un état en est le
//! fournisseur : il sait le mieux le tenir à jour, avec le moins de requêtes (par exemple, toutes les 30 s, seulement
//! les tickets modifiés depuis la dernière lecture). Les pages, les fonctions, les scripts et les automatisations
//! s’abonnent seulement.
//!
//! - **Abonnés.** Une page (`frame.states.subscribe`, renouvelé par sa coquille), une fonction ou un script
//!   (`states.subscribe`, avec une durée), une automatisation déclenchée par un état (active). Deux abonnés au même
//!   état, avec les mêmes paramètres normalisés et le même compte, sont une seule cible.
//! - **Politique** (`refresh` de l’état) : fonction, période, lecture incrémentale ou non, mode (`subscribed` : tant
//!   qu’il y a un abonné ; `always` : toujours, dès que le module est là).
//! - **Une seule lecture par cible**, quel que soit le nombre d’abonnés ; elle s’arrête quand le dernier part.
//! - **Garde-fous** : période minimale ([`MIN_EVERY`]), quatre lectures au plus à la fois, un écart entre deux départs
//!   ([`GAP`]), un recul progressif après un échec (période × 2ⁿ, 30 minutes au plus), et l’état du dernier
//!   rafraîchissement (heure, erreur, prochain passage) rendu aux abonnés avec la valeur.
//! - **Sans politique** : un état vide est lu une fois au premier abonnement (sa fonction de lecture) ; ensuite il
//!   change seulement quand quelqu’un le lit, ou quand le module écrit (une écriture fait relire ses états suivis).
//!
//! Tout cela tourne tant qu’Alfred est ouvert, avec ou sans page affichée. Alfred fermé, rien ne tourne.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{RefreshMode, Space};
use crate::state::AppState;
use crate::states::{StateTarget, CHANGED};

/// Période minimale d’un rafraîchissement.
pub const MIN_EVERY: Duration = if cfg!(test) { Duration::ZERO } else { Duration::from_secs(10) };
/// Écart minimal entre deux départs de rafraîchissement, toutes cibles confondues.
pub const GAP: Duration = if cfg!(test) { Duration::ZERO } else { Duration::from_millis(250) };
/// Lectures simultanées au plus.
const MAX_RUNNING: usize = 4;
/// Recul maximal après des échecs.
const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);
/// Un abonnement de page non renouvelé par sa coquille expire.
pub const PAGE_TTL: Duration = Duration::from_secs(90);
/// Durée d’un abonnement de fonction ou de script : par défaut 10 minutes, un jour au plus.
const SCRIPT_TTL: Duration = Duration::from_secs(600);
const MAX_SCRIPT_TTL: Duration = Duration::from_secs(86_400);
/// Réveil de la boucle.
const WAKE_EVERY: Duration = Duration::from_secs(1);

struct Subscription {
    target: StateTarget,
    /// Qui s’abonne : `page module/page`, `fonction module/fonction`.
    by: String,
    expires: Instant,
}

/// État du rafraîchissement d’une cible.
#[derive(Debug, Clone)]
struct Status {
    next: Instant,
    running: bool,
    runs: u64,
    failures: u32,
    last_run_at: Option<u64>,
    last_ok_at: Option<u64>,
    last_error: Option<String>,
    /// Une lecture sans politique a déjà été faite (état vide au premier abonnement).
    loaded: bool,
    /// Lecture demandée maintenant (« Actualiser », écriture du module), même pour un état sans politique.
    forced: bool,
}

impl Status {
    fn new() -> Self {
        Self {
            next: Instant::now(),
            running: false,
            runs: 0,
            failures: 0,
            last_run_at: None,
            last_ok_at: None,
            last_error: None,
            loaded: false,
            forced: false,
        }
    }
}

#[derive(Default)]
struct Registry {
    subscriptions: HashMap<String, Subscription>,
    statuses: HashMap<String, Status>,
    last_start: Option<Instant>,
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

fn new_id() -> String {
    use rand::Rng;
    let suffix: String = rand::rng().sample_iter(rand::distr::Alphanumeric).take(16).map(char::from).collect();
    format!("abo-{suffix}")
}

/// État du rafraîchissement d’une cible, pour ses abonnés (`refresh` de `frame.states.get`).
pub fn status_of(key: &str) -> Value {
    let registry = registry();
    let Some(status) = registry.statuses.get(key) else { return Value::Null };
    let next_in = status.next.saturating_duration_since(Instant::now()).as_millis() as u64;
    json!({
        "running": status.running,
        "lastRunAt": status.last_run_at,
        "lastOkAt": status.last_ok_at,
        "lastError": status.last_error,
        "failures": status.failures,
        "nextAt": now_ms() + next_in,
    })
}

/// Abonne `by` à un état : rend l’identifiant de l’abonnement. Le premier abonné d’une cible lance sa lecture.
pub fn subscribe(target: StateTarget, by: &str, ttl: Duration) -> String {
    let id = new_id();
    let mut registry = registry();
    let key = target.key.clone();
    registry.subscriptions.insert(id.clone(), Subscription { target, by: by.to_string(), expires: Instant::now() + ttl });
    registry.statuses.entry(key).or_insert_with(Status::new);
    id
}

pub fn unsubscribe(id: &str) -> bool {
    registry().subscriptions.remove(id).is_some()
}

/// La coquille renouvelle les abonnements de ses pages ouvertes.
pub fn renew(ids: &[String]) -> usize {
    let mut registry = registry();
    let until = Instant::now() + PAGE_TTL;
    let mut renewed = 0;
    for id in ids {
        if let Some(subscription) = registry.subscriptions.get_mut(id) {
            subscription.expires = until;
            renewed += 1;
        }
    }
    renewed
}

/// Une cible : l’état visé et ceux qui le suivent.
#[derive(Debug, Clone)]
pub(crate) struct Watched {
    pub target: StateTarget,
    pub subscribers: Vec<String>,
}

/// Cibles suivies maintenant : abonnements en cours, automatisations actives déclenchées par un état, et états
/// `always` des modules présents. Les abonnements expirés sont oubliés.
fn watched(state: &AppState, space: &Space) -> HashMap<String, Watched> {
    let mut found: HashMap<String, Watched> = HashMap::new();
    let root = space.root.to_string_lossy().to_string();
    {
        let mut registry = registry();
        let now = Instant::now();
        registry.subscriptions.retain(|_, subscription| subscription.expires > now);
        // Seuls les abonnements de l’espace ouvert comptent.
        for subscription in registry.subscriptions.values().filter(|subscription| subscription.target.scope.space == root) {
            found
                .entry(subscription.target.key.clone())
                .or_insert_with(|| Watched { target: subscription.target.clone(), subscribers: Vec::new() })
                .subscribers
                .push(subscription.by.clone());
        }
    }
    for (automation, args) in crate::automations::state_watchers(state) {
        let subject = Subject { kind: "automation".into(), module: owner_of(&args), reference: format!("automatisation/{automation}"), ..Default::default() };
        if let Ok(target) = crate::states::state_target(state, space, &subject, &args) {
            found
                .entry(target.key.clone())
                .or_insert_with(|| Watched { target, subscribers: Vec::new() })
                .subscribers
                .push(format!("automatisation {automation}"));
        }
    }
    for module in space.module_ids() {
        let Ok(manifest) = space.module(&module) else { continue };
        for declared in &manifest.states {
            let always = declared.refresh.as_ref().is_some_and(|refresh| refresh.mode == RefreshMode::Always);
            if !always || !declared.params.is_empty() {
                continue;
            }
            let subject = Subject { kind: "module".into(), module: module.clone(), reference: format!("{module}/*"), ..Default::default() };
            let args = json!({ "name": format!("{module}/{}", declared.id) });
            if let Ok(target) = crate::states::state_target(state, space, &subject, &args) {
                found.entry(target.key.clone()).or_insert_with(|| Watched { target, subscribers: vec!["toujours".into()] });
            }
        }
    }
    found
}

fn owner_of(args: &Value) -> String {
    args.get("name").and_then(Value::as_str).and_then(|name| name.split_once('/')).map(|(owner, _)| owner.to_string()).unwrap_or_default()
}

/// Entrée de la lecture : les paramètres de l’état (ou l’identifiant d’une entité, dans son `param`), et le compte.
fn input_for(target: &StateTarget, param: Option<&str>) -> Map<String, Value> {
    let mut input = match (&target.entity, param) {
        (Some(_), Some(param)) => Map::from_iter([(param.to_string(), json!(target.sub))]),
        _ => match crate::states::params_of(&target.sub) {
            Value::Object(fields) => fields,
            _ => Map::new(),
        },
    };
    if !target.scope.instance.is_empty() {
        input.insert("instance".into(), json!(target.scope.instance));
    }
    input
}

/// Lance ce qui est dû : un passage de la boucle. Rend les lectures lancées (les tests les attendent).
pub fn tick(state: &Arc<AppState>) -> Vec<tokio::task::JoinHandle<()>> {
    let Some(space) = state.try_space() else { return Vec::new() };
    let targets = watched(state, &space);
    let mut handles = Vec::new();
    let mut registry = registry();
    // Le dernier abonné est parti : la cible s’arrête (seules celles de l’espace ouvert sont en jeu : états et entités).
    let marker = format!("\u{1f}{}\u{1f}", space.root.to_string_lossy());
    registry.statuses.retain(|key, status| !key.contains(&marker) || targets.contains_key(key) || status.running);
    let mut running = registry.statuses.iter().filter(|(key, status)| key.contains(&marker) && status.running).count();
    for (key, watched) in targets {
        let status = registry.statuses.entry(key.clone()).or_insert_with(Status::new).clone();
        let now = Instant::now();
        if status.running || status.next > now || running >= MAX_RUNNING {
            continue;
        }
        if registry.last_start.is_some_and(|last| now.duration_since(last) < GAP) {
            break;
        }
        let policy = watched.target.declared.refresh.clone();
        // Sans politique : une seule lecture, si l’état est vide au premier abonnement.
        if policy.is_none() && !status.forced && (status.loaded || !crate::states::is_empty(&key)) {
            if let Some(status) = registry.statuses.get_mut(&key) {
                status.loaded = true;
                status.next = now + Duration::from_secs(86_400 * 365);
            }
            continue;
        }
        let Some(function) = policy
            .as_ref()
            .map(|refresh| (refresh.function.clone(), None))
            .or_else(|| feeder(&watched.target))
        else {
            continue;
        };
        if let Some(status) = registry.statuses.get_mut(&key) {
            status.running = true;
            status.loaded = true;
            status.forced = false;
        }
        registry.last_start = Some(now);
        running += 1;
        let state = state.clone();
        let space = space.clone();
        handles.push(tokio::spawn(async move {
            run(&state, &space, &watched.target, &function.0, function.1.as_deref()).await;
        }));
    }
    handles
}

/// Fonction de lecture qui alimente un état sans politique (la première qui le déclare), ou une entité suivie seule
/// (la première qui la déclare avec `param`), avec ce `param`.
fn feeder(target: &StateTarget) -> Option<(String, Option<String>)> {
    target
        .manifest
        .functions
        .iter()
        .filter(|function| function.effect == Some(crate::space::Effect::Read))
        .find(|function| match &target.entity {
            Some(entity) => function.entity.as_deref() == Some(entity.id.as_str()) && function.param.is_some(),
            None => function.state.as_deref() == Some(target.declared.id.as_str()),
        })
        .map(|function| (function.id.clone(), function.param.clone()))
}

/// Une lecture du fournisseur : elle fusionne (incrémentale) ou remplace l’état, puis note son issue.
async fn run(state: &Arc<AppState>, space: &Space, target: &StateTarget, function: &str, param: Option<&str>) {
    let reference = format!("{}/{function}", target.manifest.id);
    let policy = target.declared.refresh.clone();
    let incremental = policy.as_ref().is_some_and(|refresh| refresh.incremental);
    let mut input = input_for(target, param);
    let since = registry().statuses.get(&target.key).and_then(|status| status.last_ok_at);
    if incremental {
        input.insert("current".into(), crate::states::current_value(&target.manifest, &target.scope, &target.declared, &target.sub));
        input.insert("since".into(), json!(since));
    }
    let started = now_ms();
    // Sans politique (lecture au premier abonnement, « Actualiser ») : la fonction range elle-même sa sortie, selon ce
    // qu’elle déclare (`state` ou `entity`).
    if policy.is_none() {
        let result = crate::functions::call_in(state, &reference, Value::Object(input), "abonnement", target.scope.examples).await;
        finish(state, target, &reference, started, None, result.map(|_| ()));
        return;
    }
    let result = crate::functions::call_unfed(state, &reference, Value::Object(input), "rafraîchissement", target.scope.examples).await;
    let outcome = result.and_then(|output| {
        let mut changes = crate::states::Changes::default();
        if incremental && since.is_some() {
            crate::states::merge_state(&mut changes, &target.manifest, &target.scope, &target.declared, &target.sub, &output)?;
        } else {
            crate::states::write_state(&mut changes, &target.manifest, &target.scope, &target.declared, &target.sub, &output)?;
        }
        crate::states::announce(state, space, changes);
        Ok(())
    });
    let every = policy.as_ref().map(|refresh| Duration::from_secs(refresh.every).max(MIN_EVERY));
    finish(state, target, &reference, started, every, outcome);
}

/// Note l’issue d’une lecture (heure, erreur, prochain passage, recul après un échec) et prévient les abonnés.
fn finish(state: &Arc<AppState>, target: &StateTarget, reference: &str, started: u64, every: Option<Duration>, outcome: AppResult<()>) {
    {
        let mut registry = registry();
        if let Some(status) = registry.statuses.get_mut(&target.key) {
            status.running = false;
            status.runs += 1;
            status.last_run_at = Some(started);
            match &outcome {
                Ok(()) => {
                    status.failures = 0;
                    status.last_ok_at = Some(started);
                    status.last_error = None;
                    status.next = Instant::now() + every.unwrap_or(Duration::from_secs(86_400 * 365));
                }
                Err(error) => {
                    status.failures += 1;
                    status.last_error = Some(error.message.clone());
                    let base = every.unwrap_or(Duration::from_secs(60)).max(Duration::from_secs(1));
                    let backoff = base.saturating_mul(1u32 << status.failures.min(10)).min(MAX_BACKOFF);
                    status.next = Instant::now() + if cfg!(test) { Duration::ZERO } else { backoff };
                }
            }
        }
    }
    if let Err(error) = &outcome {
        crate::functions::journal(state, "function", reference, false, None, &format!("Rafraîchissement de {} en échec : {}", target.name(), error.message), None);
    }
    // Les abonnés relisent la valeur et l’état du rafraîchissement (heure, erreur).
    state.emit(CHANGED, json!({ "keys": [target.key] }));
    state.emit("states:refreshers", Value::Null);
}

/// Relit maintenant une cible suivie (« Actualiser ») : elle part au prochain passage de la boucle.
pub fn refresh_now(key: &str) -> bool {
    let mut registry = registry();
    let Some(status) = registry.statuses.get_mut(key) else { return false };
    status.next = Instant::now();
    status.forced = true;
    true
}

/// Une écriture du module : ses états suivis se relisent (une lecture par cible).
pub fn module_written(state: &AppState, module: &str) {
    let mut registry = registry();
    let keys: Vec<String> = registry
        .subscriptions
        .values()
        .filter(|subscription| subscription.target.manifest.id == module)
        .map(|subscription| subscription.target.key.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    for key in keys {
        if let Some(status) = registry.statuses.get_mut(&key) {
            status.next = Instant::now();
            status.forced = true;
        }
    }
    let _ = state;
}

/// Ce qui tourne, pour les Réglages : chaque cible suivie, ses abonnés et son dernier rafraîchissement.
pub fn overview(state: &AppState) -> AppResult<Value> {
    let space = state.space()?;
    let targets = watched(state, &space);
    let registry = registry();
    let mut rows: Vec<Value> = targets
        .values()
        .map(|watched| {
            let status = registry.statuses.get(&watched.target.key);
            let policy = watched.target.declared.refresh.as_ref();
            json!({
                "key": watched.target.key,
                "state": watched.target.name(),
                "description": watched.target.declared.description,
                "params": crate::states::params_of(&watched.target.sub),
                "instance": watched.target.scope.instance,
                "examples": watched.target.scope.examples,
                "subscribers": watched.subscribers,
                "every": policy.map(|refresh| refresh.every.max(MIN_EVERY.as_secs())),
                "incremental": policy.is_some_and(|refresh| refresh.incremental),
                "mode": policy.map(|refresh| refresh.mode),
                "function": policy.map(|refresh| refresh.function.clone()),
                "running": status.is_some_and(|status| status.running),
                "runs": status.map(|status| status.runs).unwrap_or(0),
                "lastRunAt": status.and_then(|status| status.last_run_at),
                "lastError": status.and_then(|status| status.last_error.clone()),
                "failures": status.map(|status| status.failures).unwrap_or(0),
            })
        })
        .collect();
    rows.sort_by(|a, b| a["state"].as_str().cmp(&b["state"].as_str()).then(a["key"].as_str().cmp(&b["key"].as_str())));
    Ok(json!({ "refreshers": rows }))
}

/// Démarre la boucle ; appelée une fois au lancement d’Alfred.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tick(&state);
            tokio::time::sleep(WAKE_EVERY).await;
        }
    });
}

pub fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    let result = match command {
        // Une page s’abonne (sa coquille renouvelle l’abonnement tant que la page est ouverte), ou une fonction, un
        // script, pour `seconds` secondes.
        "frame.states.subscribe" => (|| {
            let subject: Subject = arg(args, "subject")?;
            let space = state.space()?;
            let target = crate::states::state_target(state, &space, &subject, args)?;
            let page = subject.kind == "page" || subject.kind == "panel";
            let ttl = if page {
                PAGE_TTL
            } else {
                opt_arg::<u64>(args, "seconds")?.map(Duration::from_secs).unwrap_or(SCRIPT_TTL).min(MAX_SCRIPT_TTL)
            };
            let by = format!("{} {}", if page { "page" } else { "fonction" }, subject.reference);
            let key = target.key.clone();
            let id = subscribe(target, &by, ttl);
            Ok(json!({ "id": id, "key": key }))
        })(),
        "frame.states.unsubscribe" | "states.unsubscribe" => (|| {
            let id: String = arg(args, "id")?;
            Ok(json!({ "removed": unsubscribe(&id) }))
        })(),
        "states.renew" => (|| {
            let ids: Vec<String> = arg(args, "ids")?;
            Ok(json!({ "renewed": renew(&ids) }))
        })(),
        // « Actualiser » : relit l’état chez le service, par son fournisseur.
        "frame.states.refresh" => (|| {
            let subject: Subject = arg(args, "subject")?;
            let space = state.space()?;
            let target = crate::states::state_target(state, &space, &subject, args)?;
            let key = target.key.clone();
            if !refresh_now(&key) {
                // Pas encore suivi : un abonnement court le temps de la lecture.
                subscribe(target, &format!("actualisation {}", subject.reference), Duration::from_secs(30));
                refresh_now(&key);
            }
            Ok(Value::Null)
        })(),
        "states.written" => (|| {
            let module: String = arg(args, "module")?;
            module_written(state, &module);
            Ok(Value::Null)
        })(),
        "states.overview" => overview(state),
        _ => return None,
    };
    Some(result.map_err(|error: AppError| error))
}

#[cfg(test)]
pub(crate) fn is_tracked(key: &str) -> bool {
    registry().statuses.contains_key(key)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::scripts::Runtime;
    use crate::space::{EntityDecl, FunctionDecl, ModuleManifest, RefreshDecl, Requirement, StateDecl};

    /// Un module « jira » fournisseur de `tickets-du-filtre` (par `jql`), rafraîchi par une lecture incrémentale en
    /// bash qui compte ses passages ; un module « sprint » qui en dépend.
    fn setup(dir: &std::path::Path) -> (Arc<AppState>, Space) {
        let state = AppState::new(&dir.join("data")).unwrap();
        let space = Space::open_or_create(&dir.join("espace"), Some("Test")).unwrap();
        let mut jira = ModuleManifest { id: "jira".into(), name: "Jira".into(), ..Default::default() };
        jira.entities.push(EntityDecl { id: "ticket".into(), key: Some("cle".into()), version: 1, ..Default::default() });
        jira.states.push(StateDecl {
            id: "tickets-du-filtre".into(),
            entity: Some("ticket".into()),
            params: vec!["jql".into()],
            refresh: Some(RefreshDecl { function: "rafraichir".into(), every: 30, incremental: true, ..Default::default() }),
            ..Default::default()
        });
        jira.functions.push(FunctionDecl {
            id: "rafraichir".into(),
            runtime: Runtime::Bash,
            effect: Some(crate::space::Effect::Read),
            state: Some("tickets-du-filtre".into()),
            ..Default::default()
        });
        jira.functions.push(FunctionDecl { id: "noter".into(), runtime: Runtime::Bash, ..Default::default() });
        jira.functions.push(FunctionDecl {
            id: "lire-ticket".into(),
            runtime: Runtime::Bash,
            effect: Some(crate::space::Effect::Read),
            entity: Some("ticket".into()),
            param: Some("cle".into()),
            ..Default::default()
        });
        space.write_module(&jira).unwrap();
        let sprint = ModuleManifest {
            id: "sprint".into(),
            name: "Sprint".into(),
            requires: vec![Requirement { module: "jira".into(), ..Default::default() }],
            ..Default::default()
        };
        space.write_module(&sprint).unwrap();
        let functions = space.module_dir("jira").join("functions");
        std::fs::create_dir_all(&functions).unwrap();
        // Premier passage (`since` nul) : toute la liste. Ensuite : seulement les changements.
        std::fs::write(
            functions.join("rafraichir.sh"),
            "entree=$(cat)\nn=$(cat passages 2>/dev/null || echo 0); n=$((n+1)); echo $n > passages\n\
             case \"$entree\" in *'\"since\":null'*) echo '[{\"cle\":\"ALF-1\",\"etat\":\"ouvert\"},{\"cle\":\"ALF-2\",\"etat\":\"ouvert\"}]' ;;\n\
             *) echo '{\"changed\":[{\"cle\":\"ALF-2\",\"etat\":\"fermé\"},{\"cle\":\"ALF-3\",\"etat\":\"nouveau\"}],\"removed\":[\"ALF-1\"]}' ;; esac\n",
        )
        .unwrap();
        std::fs::write(functions.join("noter.sh"), "cat > recu.json\necho '{}'\n").unwrap();
        // Lit un ticket seul : rend l’objet de la clé reçue dans `cle`.
        std::fs::write(
            functions.join("lire-ticket.sh"),
            "entree=$(cat)\ncle=$(printf '%s' \"$entree\" | sed 's/.*\"cle\":\"\\([^\"]*\\)\".*/\\1/')\nprintf '{\"cle\":\"%s\",\"etat\":\"lu seul\"}' \"$cle\"\n",
        )
        .unwrap();
        state.set_space(Some(space.clone()));
        (state, space)
    }

    fn page(module: &str, page: &str) -> Subject {
        Subject { kind: "page".into(), module: module.into(), reference: format!("{module}/{page}"), ..Default::default() }
    }

    async fn passage(state: &Arc<AppState>) -> usize {
        let handles = tick(state);
        let count = handles.len();
        for handle in handles {
            handle.await.unwrap();
        }
        count
    }

    fn passages(space: &Space) -> String {
        std::fs::read_to_string(space.module_dir("jira").join("passages")).unwrap_or_default().trim().to_string()
    }

    fn value(state: &Arc<AppState>, subject: &Subject) -> Value {
        let args = json!({ "subject": subject, "name": "jira/tickets-du-filtre", "params": { "jql": "assignee = moi" } });
        crate::states::read_for_tests(state, &args)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn one_refresh_for_two_subscribers_merged_incrementally_and_stopped_by_the_last_one() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        // Deux abonnés au même filtre, les paramètres dans un autre ordre d’écriture : une seule cible.
        let a = handle(&state, "frame.states.subscribe", &json!({ "subject": page("sprint", "tableau"), "name": "jira/tickets-du-filtre", "params": { "jql": "assignee = moi" } })).unwrap().unwrap();
        let b = handle(&state, "frame.states.subscribe", &json!({ "subject": page("jira", "liste"), "name": "tickets-du-filtre", "key": "assignee = moi" })).unwrap().unwrap();
        assert_eq!(a["key"], b["key"]);
        let key = a["key"].as_str().unwrap().to_string();

        assert_eq!(passage(&state).await, 1, "un seul rafraîchissement");
        assert_eq!(passages(&space), "1");
        assert_eq!(passage(&state).await, 0, "rien avant la période");
        let first = value(&state, &page("sprint", "tableau"));
        assert_eq!(first["value"], json!([{ "cle": "ALF-1", "etat": "ouvert" }, { "cle": "ALF-2", "etat": "ouvert" }]));
        assert_eq!(first["refresh"]["lastError"], Value::Null);
        assert!(first["refresh"]["lastOkAt"].is_u64());

        // Deuxième passage : incrémental, les changements sont fusionnés (nouveau en tête, retiré, modifié).
        assert!(refresh_now(&key));
        assert_eq!(passage(&state).await, 1);
        assert_eq!(passages(&space), "2");
        let merged = value(&state, &page("sprint", "tableau"));
        assert_eq!(merged["value"], json!([{ "cle": "ALF-3", "etat": "nouveau" }, { "cle": "ALF-2", "etat": "fermé" }]));

        // Le premier abonné part : la cible tourne encore ; le dernier part : elle s’arrête.
        handle(&state, "states.unsubscribe", &json!({ "id": a["id"] })).unwrap().unwrap();
        passage(&state).await;
        assert!(is_tracked(&key));
        handle(&state, "states.unsubscribe", &json!({ "id": b["id"] })).unwrap().unwrap();
        passage(&state).await;
        assert!(!is_tracked(&key), "plus d’abonné : plus de rafraîchissement");
        assert!(!refresh_now(&key));
        passage(&state).await;
        assert_eq!(passages(&space), "2");
        assert_eq!(overview(&state).unwrap()["refreshers"], json!([]));
    }

    /// Une page suit un objet seul (`useAlfredState("jira/ticket", { key })`) : au premier abonnement, la fonction
    /// qui déclare l’entité avec `param` le lit et le range ; ensuite, il ne change que si quelqu’un le relit.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_follows_a_single_entity_read_once_by_its_function() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _space) = setup(dir.path());
        let subject = page("sprint", "ticket");
        let subscribed = handle(&state, "frame.states.subscribe", &json!({ "subject": subject, "name": "jira/ticket", "key": "ALF-9" })).unwrap().unwrap();
        let key = subscribed["key"].as_str().unwrap().to_string();
        let empty = crate::states::read_for_tests(&state, &json!({ "subject": subject, "name": "jira/ticket", "key": "ALF-9" }));
        assert_eq!(empty["empty"], json!(true));

        assert_eq!(passage(&state).await, 1, "lu au premier abonnement");
        let read = crate::states::read_for_tests(&state, &json!({ "subject": subject, "name": "jira/ticket", "key": "ALF-9" }));
        assert_eq!(read["value"], json!({ "cle": "ALF-9", "etat": "lu seul" }));
        assert_eq!(passage(&state).await, 0, "sans politique : pas de relecture");

        // « Actualiser » le relit ; le dernier abonné parti, rien ne tourne plus.
        assert!(refresh_now(&key));
        assert_eq!(passage(&state).await, 1);
        handle(&state, "states.unsubscribe", &json!({ "id": subscribed["id"] })).unwrap().unwrap();
        passage(&state).await;
        assert!(!is_tracked(&key));
        // Une entité sans identifiant est refusée.
        let refused = handle(&state, "frame.states.subscribe", &json!({ "subject": subject, "name": "jira/ticket" })).unwrap();
        assert!(refused.unwrap_err().message.contains("identifiant"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_automation_subscribed_to_a_state_runs_on_a_change_without_any_page() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let call = |command: &'static str, args: Value| {
            let state = state.clone();
            async move { crate::automations::handle(&state, command, &args).await.unwrap() }
        };
        let created = call(
            "automations.save",
            json!({ "name": "Nouveaux tickets", "function": "jira/noter", "trigger": { "kind": "state", "state": "jira/tickets-du-filtre", "params": { "jql": "assignee = moi" } } }),
        )
        .await
        .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        call("automations.validate", json!({ "id": id })).await.unwrap();

        // Aucune page : l’automatisation active est l’abonnée ; le fournisseur rafraîchit.
        let listed = overview(&state).unwrap();
        assert_eq!(listed["refreshers"][0]["subscribers"], json!([format!("automatisation {id}")]));
        assert_eq!(passage(&state).await, 1);
        assert_eq!(passages(&space), "1");
        // Le changement fait partir l’automatisation, avec l’état et ses paramètres.
        let received = space.module_dir("jira").join("recu.json");
        for _ in 0..100 {
            if received.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(received.exists(), "l’automatisation est partie");

        // En pause, elle n’est plus abonnée : plus rien ne tourne.
        call("automations.setEnabled", json!({ "id": id, "enabled": false })).await.unwrap();
        passage(&state).await;
        assert_eq!(overview(&state).unwrap()["refreshers"], json!([]));
    }
}
