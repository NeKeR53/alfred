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
//! - **Fraîcheur** (`maxAge` de l’état, choisi par le fournisseur ; l’utilisateur peut le changer dans Réglages →
//!   États) : à l’abonnement, à l’ouverture d’une page et au retour sur une page (`states.revisit`), l’état est relu
//!   seulement si sa valeur (gardée sur le disque, `states_disk.rs`) est plus vieille que cet âge. Une valeur fraîche
//!   s’affiche telle quelle, sans requête. Omis : `refresh.every`, sinon [`DEFAULT_MAX_AGE`].
//! - **Période** (`refresh.every`) : tant qu’il a un abonné, un état à politique se relit à cette période, comptée
//!   depuis sa dernière lecture réussie, même d’un lancement précédent.
//! - **Sans politique** : l’état est lu à l’abonnement s’il est vide ou périmé ; ensuite il change seulement quand
//!   quelqu’un le lit, ou quand le module écrit (une écriture fait relire ses états suivis).
//! - **Relecture demandée** (`refresh()`, « Actualiser ») : toujours, une seule pour tous les abonnés ; une lecture en
//!   cours en tient lieu.
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
/// Âge maximal d’une valeur quand le fournisseur n’en dit rien (ni `maxAge`, ni `refresh.every`).
pub const DEFAULT_MAX_AGE: Duration = Duration::from_secs(600);
/// « Jamais » : une échéance lointaine.
const FAR: Duration = Duration::from_secs(86_400 * 365);

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
    /// Une cible qu’on se met à suivre : sa prochaine lecture dépend de l’âge de sa valeur connue (disque compris).
    fn for_target(target: &StateTarget) -> Self {
        let checked = crate::states::checked_of(target);
        Self {
            next: Instant::now() + due_in(target, checked),
            running: false,
            runs: 0,
            failures: 0,
            last_run_at: None,
            last_ok_at: checked,
            last_error: None,
            loaded: false,
            forced: false,
        }
    }
}

/// Âge maximal d’une valeur : celui choisi par l’utilisateur (Réglages → États), sinon celui du fournisseur
/// (`maxAge`), sinon sa période (`refresh.every`), sinon [`DEFAULT_MAX_AGE`].
pub(crate) fn max_age(target: &StateTarget) -> Duration {
    crate::states_disk::override_of(&target.scope.space, &target.name())
        .map(Duration::from_secs)
        .unwrap_or_else(|| provider_max_age(&target.declared))
        .max(MIN_EVERY)
}

/// Âge maximal choisi par le fournisseur.
pub(crate) fn provider_max_age(declared: &crate::space::StateDecl) -> Duration {
    declared
        .max_age
        .or(declared.refresh.as_ref().map(|refresh| refresh.every))
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_MAX_AGE)
        .max(MIN_EVERY)
}

/// Dans combien de temps la cible est à relire, d’après sa dernière lecture réussie (`checked`, ms). Vide ou
/// périmée : maintenant. Fraîche : à sa période s’il en a une (comptée depuis cette lecture), sinon jamais.
fn due_in(target: &StateTarget, checked: Option<u64>) -> Duration {
    let Some(checked) = checked else { return Duration::ZERO };
    let age = Duration::from_millis(now_ms().saturating_sub(checked));
    let max_age = max_age(target);
    if age >= max_age {
        return Duration::ZERO;
    }
    match &target.declared.refresh {
        Some(refresh) => {
            let every = Duration::from_secs(refresh.every).max(MIN_EVERY);
            let period = if age < every { every - age } else { every };
            period.min(max_age - age)
        }
        None => FAR,
    }
}

/// La cible est-elle périmée (ou vide) ?
fn is_stale(target: &StateTarget) -> bool {
    due_in(target, crate::states::checked_of(target)).is_zero()
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
        "runs": status.runs,
    })
}

/// Abonne `by` à un état : rend l’identifiant de l’abonnement. Le premier abonné d’une cible lance sa lecture.
/// Une cible déjà suivie (par un autre abonné) mais périmée se relit pour le nouveau venu.
pub fn subscribe(target: StateTarget, by: &str, ttl: Duration) -> String {
    let id = new_id();
    let stale = is_stale(&target);
    let mut registry = registry();
    let key = target.key.clone();
    match registry.statuses.get_mut(&key) {
        Some(status) if stale && !status.running => status.next = Instant::now(),
        Some(_) => {}
        None => {
            let status = Status::for_target(&target);
            registry.statuses.insert(key, status);
        }
    }
    registry.subscriptions.insert(id.clone(), Subscription { target, by: by.to_string(), expires: Instant::now() + ttl });
    id
}

/// Retour sur une page (ou ouverture) : ses états périmés se relisent ; les frais ne bougent pas.
pub fn revisit(ids: &[String]) -> usize {
    let targets: Vec<StateTarget> = {
        let registry = registry();
        ids.iter().filter_map(|id| registry.subscriptions.get(id)).map(|subscription| subscription.target.clone()).collect()
    };
    let stale: Vec<String> = targets.iter().filter(|target| is_stale(target)).map(|target| target.key.clone()).collect();
    let mut registry = registry();
    let mut count = 0;
    for key in stale {
        if let Some(status) = registry.statuses.get_mut(&key).filter(|status| !status.running) {
            status.next = Instant::now();
            count += 1;
        }
    }
    count
}

/// L’âge maximal d’un état a changé : ses cibles suivies recalculent leur prochaine lecture.
fn rescheduled(name: &str) {
    let targets: Vec<StateTarget> = {
        let registry = registry();
        registry.subscriptions.values().filter(|subscription| subscription.target.name() == name).map(|subscription| subscription.target.clone()).collect()
    };
    let due: Vec<(String, Duration)> =
        targets.iter().map(|target| (target.key.clone(), due_in(target, crate::states::checked_of(target)))).collect();
    let mut registry = registry();
    for (key, due) in due {
        if let Some(status) = registry.statuses.get_mut(&key).filter(|status| !status.running) {
            status.next = Instant::now() + due;
        }
    }
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
        // Automatisation, état `always` : suivis sans abonnement, leur échéance part de l’âge de leur valeur.
        if !registry.statuses.contains_key(&key) {
            registry.statuses.insert(key.clone(), Status::for_target(&watched.target));
        }
        let Some(status) = registry.statuses.get(&key).cloned() else { continue };
        let now = Instant::now();
        if status.running || status.next > now || running >= MAX_RUNNING {
            continue;
        }
        if registry.last_start.is_some_and(|last| now.duration_since(last) < GAP) {
            break;
        }
        let policy = watched.target.declared.refresh.clone();
        let Some(function) = policy
            .as_ref()
            .map(|refresh| (refresh.function.clone(), None))
            .or_else(|| feeder(&watched.target))
        else {
            // Personne ne sait lire cet état : il attend une publication.
            if let Some(status) = registry.statuses.get_mut(&key) {
                status.next = now + FAR;
                status.forced = false;
            }
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
                    status.next = Instant::now() + every.unwrap_or(FAR);
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
    // La valeur date du départ de cette lecture, même inchangée : c’est son âge, gardé sur le disque.
    if outcome.is_ok() {
        crate::states::mark_checked(&target.key, started);
    }
    if let Err(error) = &outcome {
        crate::functions::journal(state, "function", reference, false, None, &format!("Rafraîchissement de {} en échec : {}", target.name(), error.message), None);
    }
    // Les abonnés relisent la valeur et l’état du rafraîchissement (heure, erreur).
    state.emit(CHANGED, json!({ "keys": [target.key] }));
    state.emit("states:refreshers", Value::Null);
}

/// Relit maintenant une cible suivie (« Actualiser ») : elle part au prochain passage de la boucle. Une lecture en
/// cours en tient lieu : une seule pour tous.
pub fn refresh_now(key: &str) -> bool {
    let mut registry = registry();
    let Some(status) = registry.statuses.get_mut(key) else { return false };
    if !status.running {
        status.next = Instant::now();
        status.forced = true;
    }
    true
}

/// Lectures terminées d’une cible : la page attend la suivante après « Actualiser ».
fn runs_of(key: &str) -> u64 {
    registry().statuses.get(key).map(|status| status.runs).unwrap_or(0)
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
                "maxAge": max_age(&watched.target).as_secs(),
                "checkedAt": crate::states::checked_of(&watched.target),
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

/// Âge maximal le plus court qu’on peut choisir dans les Réglages.
const MIN_AGE_SETTING: u64 = 10;

/// Chaque état déclaré de l’espace, avec l’âge maximal du fournisseur et celui choisi par l’utilisateur.
fn freshness(state: &AppState) -> AppResult<Value> {
    let space = state.space()?;
    let overrides = crate::states_disk::overrides(&space.root.to_string_lossy());
    let mut rows = Vec::new();
    for module in space.module_ids() {
        let Ok(manifest) = space.module(&module) else { continue };
        for declared in &manifest.states {
            let name = format!("{module}/{}", declared.id);
            rows.push(json!({
                "state": name,
                "module": manifest.name,
                "description": declared.description,
                "defaultMaxAge": provider_max_age(declared).as_secs(),
                "maxAge": overrides.get(&name),
                "every": declared.refresh.as_ref().map(|refresh| refresh.every.max(MIN_EVERY.as_secs())),
            }));
        }
    }
    Ok(json!({ "states": rows }))
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
            let runs = runs_of(&key);
            let reading = target.declared.refresh.is_some() || feeder(&target).is_some();
            if !refresh_now(&key) {
                // Pas encore suivi : un abonnement court le temps de la lecture.
                subscribe(target, &format!("actualisation {}", subject.reference), Duration::from_secs(30));
                refresh_now(&key);
            }
            // La page attend la fin de la lecture (`runs` dépassé) ; sans fonction de lecture, rien ne part.
            Ok(json!({ "key": key, "runs": runs, "reading": reading }))
        })(),
        "states.revisit" => (|| {
            let ids: Vec<String> = arg(args, "ids")?;
            Ok(json!({ "stale": revisit(&ids) }))
        })(),
        // Réglages → États : l’âge maximal de chaque état déclaré, celui du fournisseur et celui choisi.
        "states.freshness" => freshness(state),
        "states.setMaxAge" => (|| {
            let name: String = arg(args, "name")?;
            let seconds: Option<u64> = opt_arg(args, "seconds")?;
            let space = state.space()?;
            let (owner, id) = name.split_once('/').ok_or_else(|| AppError::new(format!("État inconnu : « {name} ».")))?;
            let manifest = space.module(owner)?;
            if !manifest.states.iter().any(|declared| declared.id == id) {
                return Err(AppError::new(format!("Le module « {owner} » ne déclare pas l’état « {id} ».")));
            }
            if let Some(seconds) = seconds.filter(|seconds| *seconds < MIN_AGE_SETTING) {
                return Err(AppError::new(format!("{seconds} s : l’âge maximal vaut {MIN_AGE_SETTING} secondes au moins.")));
            }
            crate::states_disk::set_override(&space.root.to_string_lossy(), &name, seconds)?;
            rescheduled(&name);
            state.emit("states:refreshers", Value::Null);
            freshness(state)
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

/// Redémarrage d’Alfred, pour les tests : plus d’abonnement ni de rafraîchissement dans cet espace.
#[cfg(test)]
pub(crate) fn drop_registry_for_tests(root: &str) {
    let mut registry = registry();
    registry.subscriptions.retain(|_, subscription| subscription.target.scope.space != root);
    registry.statuses.retain(|key, _| crate::states_disk::space_of(key) != Some(root));
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

    /// Alfred redémarre : la mémoire se vide, le disque reste ; l’espace se rouvre.
    fn restart(state: &Arc<AppState>, space: &Space) {
        let root = space.root.to_string_lossy().to_string();
        state.set_space(None);
        crate::states::drop_memory_for_tests(&root);
        drop_registry_for_tests(&root);
        state.set_space(Some(space.clone()));
    }

    /// Un état sans politique, lu par une fonction qui compte ses passages, et gardé 10 minutes.
    fn mes_tickets(space: &Space, max_age: Option<u64>) {
        let mut jira = space.module("jira").unwrap();
        jira.states.push(StateDecl { id: "mes-tickets".into(), entity: Some("ticket".into()), max_age, ..Default::default() });
        jira.functions.push(FunctionDecl {
            id: "lire-mes-tickets".into(),
            runtime: Runtime::Bash,
            effect: Some(crate::space::Effect::Read),
            state: Some("mes-tickets".into()),
            ..Default::default()
        });
        space.write_module(&jira).unwrap();
        std::fs::write(
            space.module_dir("jira").join("functions").join("lire-mes-tickets.sh"),
            "n=$(cat lectures 2>/dev/null || echo 0); n=$((n+1)); echo $n > lectures\nprintf '[{\"cle\":\"ALF-7\",\"lecture\":%s}]' \"$n\"\n",
        )
        .unwrap();
    }

    fn lectures(space: &Space) -> String {
        std::fs::read_to_string(space.module_dir("jira").join("lectures")).unwrap_or_default().trim().to_string()
    }

    fn mine(state: &Arc<AppState>) -> Value {
        crate::states::read_for_tests(state, &json!({ "subject": page("sprint", "tableau"), "name": "jira/mes-tickets" }))
    }

    fn subscribe_mine(state: &Arc<AppState>) -> Value {
        handle(state, "frame.states.subscribe", &json!({ "subject": page("sprint", "tableau"), "name": "jira/mes-tickets" })).unwrap().unwrap()
    }

    /// La valeur survit au redémarrage : la page l’a tout de suite, sans lecture tant qu’elle est fraîche. Une valeur
    /// d’une demi-heure se relit ; une de deux minutes, non.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_last_known_value_survives_a_restart_and_is_reread_only_when_stale() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        mes_tickets(&space, Some(600));
        let first = subscribe_mine(&state);
        let key = first["key"].as_str().unwrap().to_string();
        assert_eq!(passage(&state).await, 1, "vide : lu au premier abonnement");
        assert_eq!(mine(&state)["value"], json!([{ "cle": "ALF-7", "lecture": 1 }]));
        assert!(space.local_dir().join(crate::states_disk::FILE).is_file(), "gardé sur le disque");

        restart(&state, &space);
        let after = mine(&state);
        assert_eq!(after["empty"], json!(false), "la dernière valeur connue est là tout de suite");
        assert_eq!(after["value"], json!([{ "cle": "ALF-7", "lecture": 1 }]), "liste et objets reviennent du disque");
        assert!(after["updatedAt"].is_u64() && after["checkedAt"].is_u64());
        let second = subscribe_mine(&state);
        assert_eq!(passage(&state).await, 0, "fraîche : aucune relecture");
        assert_eq!(lectures(&space), "1");

        // Deux minutes : encore fraîche (âge maximal de 10 minutes), même au retour sur la page.
        crate::states::mark_checked(&key, now_ms() - 2 * 60_000);
        restart(&state, &space);
        let third = subscribe_mine(&state);
        assert_eq!(revisit(&[third["id"].as_str().unwrap().to_string()]), 0);
        assert_eq!(passage(&state).await, 0, "2 minutes : pas de relecture");

        // Une demi-heure : périmée. Le retour sur la page la relit, une fois.
        crate::states::mark_checked(&key, now_ms() - 30 * 60_000);
        assert_eq!(revisit(&[third["id"].as_str().unwrap().to_string()]), 1);
        assert_eq!(passage(&state).await, 1, "30 minutes : relue");
        assert_eq!(passage(&state).await, 0);
        assert_eq!(lectures(&space), "2");
        assert_eq!(mine(&state)["value"][0]["lecture"], json!(2));

        // Et après un redémarrage, une valeur périmée se relit dès l’abonnement.
        crate::states::mark_checked(&key, now_ms() - 30 * 60_000);
        restart(&state, &space);
        assert_eq!(mine(&state)["value"][0]["lecture"], json!(2), "affichée d’abord");
        subscribe_mine(&state);
        assert_eq!(passage(&state).await, 1, "puis relue");
        assert_eq!(lectures(&space), "3");
        let _ = (first, second);
    }

    /// L’utilisateur choisit l’âge maximal d’un état (Réglages → États) : il prime sur celui du fournisseur.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_user_max_age_overrides_the_provider_one() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        mes_tickets(&space, Some(3600));
        let subscribed = subscribe_mine(&state);
        let key = subscribed["key"].as_str().unwrap().to_string();
        passage(&state).await;
        crate::states::mark_checked(&key, now_ms() - 5 * 60_000);
        let ids = [subscribed["id"].as_str().unwrap().to_string()];
        assert_eq!(revisit(&ids), 0, "1 heure chez le fournisseur : fraîche");

        let listed = handle(&state, "states.setMaxAge", &json!({ "name": "jira/mes-tickets", "seconds": 60 })).unwrap().unwrap();
        let row = listed["states"].as_array().unwrap().iter().find(|row| row["state"] == json!("jira/mes-tickets")).unwrap().clone();
        assert_eq!(row["defaultMaxAge"], json!(3600));
        assert_eq!(row["maxAge"], json!(60));
        assert_eq!(passage(&state).await, 1, "1 minute choisie : la valeur de 5 minutes se relit");
        // Le choix survit au redémarrage ; le retirer rend la valeur du fournisseur.
        restart(&state, &space);
        assert_eq!(crate::states_disk::override_of(&space.root.to_string_lossy(), "jira/mes-tickets"), Some(60));
        handle(&state, "states.setMaxAge", &json!({ "name": "jira/mes-tickets", "seconds": null })).unwrap().unwrap();
        assert_eq!(crate::states_disk::override_of(&space.root.to_string_lossy(), "jira/mes-tickets"), None);
        let refused = handle(&state, "states.setMaxAge", &json!({ "name": "jira/mes-tickets", "seconds": 2 })).unwrap();
        assert!(refused.unwrap_err().message.contains("10 secondes"));
    }

    /// « Actualiser » relit toujours, même une valeur fraîche ; une lecture en cours en tient lieu.
    #[tokio::test(flavor = "multi_thread")]
    async fn refresh_always_rereads_once_for_everyone() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        mes_tickets(&space, Some(3600));
        subscribe_mine(&state);
        subscribe_mine(&state);
        assert_eq!(passage(&state).await, 1);
        let asked = handle(&state, "frame.states.refresh", &json!({ "subject": page("sprint", "tableau"), "name": "jira/mes-tickets" })).unwrap().unwrap();
        assert_eq!(asked["reading"], json!(true));
        assert_eq!(asked["runs"], json!(1));
        handle(&state, "frame.states.refresh", &json!({ "subject": page("jira", "liste"), "name": "jira/mes-tickets" })).unwrap().unwrap();
        assert_eq!(passage(&state).await, 1, "deux demandes, deux abonnés : une lecture");
        assert_eq!(lectures(&space), "2");
        assert_eq!(mine(&state)["refresh"]["runs"], json!(2));
    }

    /// Jamais sur le disque : une réponse scellée, un état `persist: false`. Oubliés : une autre version du contrat,
    /// un compte supprimé, un module retiré.
    #[tokio::test(flavor = "multi_thread")]
    async fn secrets_other_versions_and_removed_owners_are_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let mut jira = space.module("jira").unwrap();
        jira.states.push(StateDecl { id: "coffre".into(), ..Default::default() });
        jira.states.push(StateDecl { id: "jetons".into(), persist: Some(false), ..Default::default() });
        jira.states.push(StateDecl { id: "profil".into(), ..Default::default() });
        space.write_module(&jira).unwrap();
        let publish = |name: &str, value: Value| {
            crate::states::publish_for_tests(&state, &json!({ "subject": page("jira", "liste"), "name": name, "value": value }));
        };
        let read = |name: &str| crate::states::read_for_tests(&state, &json!({ "subject": page("jira", "liste"), "name": name }));
        publish("coffre", json!({ "motDePasse": format!("{}{}", crate::secret_refs::PREFIX, "a".repeat(43)) }));
        publish("jetons", json!(["t1"]));
        publish("profil", json!({ "nom": "Ada" }));
        assert_eq!(read("coffre")["empty"], json!(false), "en mémoire pendant le lancement");

        restart(&state, &space);
        assert_eq!(read("coffre")["empty"], json!(true), "une réponse scellée n’est pas gardée");
        assert_eq!(read("jetons")["empty"], json!(true), "`persist: false` n’est pas gardé");
        assert_eq!(read("profil")["value"], json!({ "nom": "Ada" }));

        // Le contrat change de version : la valeur gardée est oubliée, au lancement comme pendant.
        let mut jira = space.module("jira").unwrap();
        jira.states.iter_mut().find(|declared| declared.id == "profil").unwrap().version = 2;
        space.write_module(&jira).unwrap();
        assert_eq!(read("profil")["empty"], json!(true), "autre version : oubliée tout de suite");
        publish("profil", json!({ "nom": "Ada", "role": "admin" }));
        restart(&state, &space);
        assert_eq!(read("profil")["value"]["role"], json!("admin"), "la nouvelle version se garde");

        // Un module retiré : ses valeurs partent, du disque aussi.
        crate::states::forget_module(&state, &space, "jira");
        restart(&state, &space);
        assert_eq!(read("profil")["empty"], json!(true));
    }

    /// Un état à période : après un redémarrage, sa valeur fraîche s’affiche sans lecture ; la lecture suivante reste
    /// incrémentale (`since` et `current` lus sur le disque).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_periodic_state_resumes_incrementally_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (state, space) = setup(dir.path());
        let subscribe = || {
            handle(&state, "frame.states.subscribe", &json!({ "subject": page("sprint", "tableau"), "name": "jira/tickets-du-filtre", "params": { "jql": "assignee = moi" } })).unwrap().unwrap()
        };
        subscribe();
        assert_eq!(passage(&state).await, 1);
        restart(&state, &space);
        let shown = value(&state, &page("sprint", "tableau"));
        assert_eq!(shown["value"], json!([{ "cle": "ALF-1", "etat": "ouvert" }, { "cle": "ALF-2", "etat": "ouvert" }]));
        let key = subscribe()["key"].as_str().unwrap().to_string();
        assert_eq!(passage(&state).await, 0, "plus jeune que sa période : pas de lecture");
        assert!(refresh_now(&key));
        assert_eq!(passage(&state).await, 1);
        assert_eq!(passages(&space), "2");
        let merged = value(&state, &page("sprint", "tableau"));
        assert_eq!(merged["value"], json!([{ "cle": "ALF-3", "etat": "nouveau" }, { "cle": "ALF-2", "etat": "fermé" }]), "fusion incrémentale");
    }
}
