//! Lectures d’un client partagées dans le cœur. Toute requête `GET` ou `HEAD` d’une fonction (TypeScript, bash,
//! PowerShell, Python) passe par `clients::frame_request`, donc par ici : la fonction n’a pas d’autre chemin vers le
//! service (le cadre n’a pas de réseau, le script n’a pas le secret).
//!
//! - **Une ressource** : compte (espace, client, instance) + requête normalisée (méthode, chemin, paramètres et
//!   en-têtes, ordre indifférent). Son identifiant ([`key`]) est rendu à la coquille avec la réponse.
//! - **En vol** : deux lectures identiques en cours ne font qu’une requête, la seconde attend la première.
//! - **Gardée** : chaque réponse réussie reste gardée [`KEEP`] au plus. Elle n’est servie qu’à une **relance** :
//!   une fonction de lecture que la coquille relance parce qu’une ressource dont elle dépend vient d’être relue par une
//!   autre fonction ([`replay`], ou `reuse` sur la requête). Ainsi deux fonctions différentes qui lisent le même
//!   service partagent une seule requête, et une lecture ordinaire (« Actualiser », suivi d’un CI) joint toujours le
//!   service.
//! - **Écriture** : toute autre méthode sur le compte oublie tout de suite ses réponses gardées, et une lecture partie
//!   avant elle n’est pas gardée : jamais de valeur d’avant une écriture.
//! - **Nouvelle réponse** : le cœur émet `clients:read` (ressource, module, fonction quand il la connaît) ; la coquille
//!   relance les lectures affichées qui dépendent de cette ressource (`src/shell/sharedQueries.ts`).
//!
//! La clé ne contient pas le module : l’accord est vérifié pour chaque demandeur avant d’arriver ici, et la réponse ne
//! dépend que du compte et de la requête. Une réponse scellée ne passe jamais par ici (ses références sont propres au
//! module qui les a lues).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tokio::sync::OnceCell;

use crate::error::AppResult;

/// Durée maximale pendant laquelle une réponse gardée sert à une relance.
pub const KEEP: Duration = Duration::from_secs(60);
const MAX_KEPT: usize = 500;
/// Une réponse plus grosse n’est pas gardée.
const MAX_KEPT_SIZE: usize = 2 * 1024 * 1024;

/// Compte visé : espace, client, instance.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Account {
    pub space: String,
    pub client: String,
    pub instance: String,
}

/// D’où vient la réponse rendue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Requête faite pour ce demandeur : une nouvelle réponse.
    Fetched,
    /// Réponse de la requête identique déjà en vol.
    Joined,
    /// Réponse gardée, servie à une relance.
    Kept,
}

type Cell = Arc<OnceCell<AppResult<Value>>>;

#[derive(Default)]
struct Store {
    inflight: HashMap<String, Cell>,
    kept: HashMap<String, (Instant, Account, Value)>,
    /// Monte à chaque écriture d’un compte.
    generations: HashMap<Account, u64>,
    /// Relances en cours, par fonction (`module/fonction`) : leurs lectures prennent la réponse gardée.
    replays: HashMap<String, usize>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Mutex::default)
}

fn locked() -> std::sync::MutexGuard<'static, Store> {
    store().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Identifiant d’une ressource : compte, empreinte du client (adresse, authentification, en-têtes), méthode, chemin,
/// paramètres et en-têtes de la requête (ordre indifférent).
pub fn key(
    account: &Account,
    fingerprint: &str,
    method: &str,
    path: &str,
    query: Option<&Map<String, Value>>,
    headers: Option<&Map<String, Value>>,
) -> String {
    let scope = format!("{}\u{1f}{}\u{1f}{}\u{1f}{fingerprint}", account.space, account.client, account.instance);
    crate::client_cache::key("", &scope, method, path, query, headers)
}

/// Relance d’une fonction de lecture par la coquille : tant que la garde vit, ses lectures prennent la réponse
/// gardée (pour un script, dont le cœur connaît le nom ; une fonction TypeScript passe `reuse` sur la requête).
pub struct Replay(String);

pub fn replay(reference: &str) -> Replay {
    *locked().replays.entry(reference.to_string()).or_default() += 1;
    Replay(reference.to_string())
}

impl Drop for Replay {
    fn drop(&mut self) {
        let mut store = locked();
        if let Some(count) = store.replays.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                store.replays.remove(&self.0);
            }
        }
    }
}

/// La fonction `reference` est-elle relancée en ce moment ?
pub fn replaying(reference: &str) -> bool {
    locked().replays.contains_key(reference)
}

/// Lit par le magasin : une relance (`reuse`) prend la réponse gardée ; sinon la lecture rejoint la lecture identique
/// en vol, ou appelle `perform`.
pub async fn read<F, Fut>(key: &str, account: &Account, reuse: bool, perform: F) -> (AppResult<Value>, Source)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<Value>>,
{
    let (cell, leader, generation) = {
        let mut store = locked();
        if reuse {
            if let Some((at, _, response)) = store.kept.get(key) {
                if at.elapsed() < KEEP {
                    return (Ok(response.clone()), Source::Kept);
                }
            }
        }
        let generation = store.generations.get(account).copied().unwrap_or_default();
        match store.inflight.get(key) {
            Some(cell) => (cell.clone(), false, generation),
            None => {
                let cell: Cell = Arc::new(OnceCell::new());
                store.inflight.insert(key.to_string(), cell.clone());
                (cell, true, generation)
            }
        }
    };
    // Le premier arrivé fait la requête ; s’il est annulé, le suivant la reprend (`OnceCell`).
    let result = cell.get_or_init(perform).await.clone();
    if leader {
        let mut store = locked();
        if store.inflight.get(key).is_some_and(|current| Arc::ptr_eq(current, &cell)) {
            store.inflight.remove(key);
        }
        let unchanged = store.generations.get(account).copied().unwrap_or_default() == generation;
        let ok = result.as_ref().is_ok_and(|response| response.get("ok").and_then(Value::as_bool) == Some(true));
        let small = result.as_ref().is_ok_and(|response| response.to_string().len() <= MAX_KEPT_SIZE);
        if unchanged && ok && small {
            if store.kept.len() >= MAX_KEPT {
                store.kept.retain(|_, (at, _, _)| at.elapsed() < KEEP);
                if store.kept.len() >= MAX_KEPT {
                    if let Some(oldest) =
                        store.kept.iter().min_by_key(|(_, (at, _, _))| *at).map(|(key, _)| key.clone())
                    {
                        store.kept.remove(&oldest);
                    }
                }
            }
            if let Ok(response) = &result {
                store.kept.insert(key.to_string(), (Instant::now(), account.clone(), response.clone()));
            }
        }
    }
    (result, if leader { Source::Fetched } else { Source::Joined })
}

/// Une écriture sur ce compte : ses réponses gardées sont oubliées, et celles en vol ne seront pas gardées.
pub fn written(account: &Account) {
    let mut store = locked();
    *store.generations.entry(account.clone()).or_default() += 1;
    store.kept.retain(|_, (_, owner, _)| owner != account);
}

/// Lecture ou écriture selon la méthode : `GET` et `HEAD` lisent, le reste écrit.
pub fn is_read(method: &reqwest::Method) -> bool {
    matches!(*method, reqwest::Method::GET | reqwest::Method::HEAD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn ok(body: &str) -> AppResult<Value> {
        Ok(json!({ "status": 200, "ok": true, "body": body }))
    }

    #[tokio::test]
    async fn identical_reads_in_flight_share_one_request() {
        let acme = Account { space: "espace-vol".into(), client: "jira".into(), instance: "acme".into() };
        let calls = Arc::new(AtomicUsize::new(0));
        let k = key(&acme, "f1", "GET", "/rest/api/3/search", json!({ "b": 1, "a": 2 }).as_object(), None);
        assert_eq!(k, key(&acme, "f1", "GET", "/rest/api/3/search", json!({ "a": 2, "b": 1 }).as_object(), None));
        let other = Account { instance: "interne".into(), ..acme.clone() };
        assert_ne!(k, key(&other, "f1", "GET", "/rest/api/3/search", None, None), "une autre instance");

        let slow = |calls: Arc<AtomicUsize>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
            ok("ALF-1")
        };
        let (first, second) = tokio::join!(
            read(&k, &acme, false, || slow(calls.clone())),
            read(&k, &acme, false, || slow(calls.clone()))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "une seule requête pour deux lectures en vol");
        assert_eq!(first.1, Source::Fetched);
        assert_eq!(second.1, Source::Joined);
        assert_eq!(second.0.unwrap()["body"], "ALF-1");
    }

    #[tokio::test]
    async fn a_kept_response_serves_only_replays_and_never_survives_a_write() {
        let acme = Account { space: "espace-garde".into(), client: "mail".into(), instance: "perso".into() };
        let k = key(&acme, "f1", "GET", "/messages", None, None);
        assert_eq!(read(&k, &acme, false, || async { ok("v1") }).await.1, Source::Fetched);
        // Une lecture ordinaire rappelle le service ; une relance prend la réponse gardée.
        let (fresh, source) = read(&k, &acme, false, || async { ok("v2") }).await;
        assert_eq!((source, fresh.unwrap()["body"].clone()), (Source::Fetched, json!("v2")));
        let (kept, source) = read(&k, &acme, true, || async { ok("jamais") }).await;
        assert_eq!((source, kept.unwrap()["body"].clone()), (Source::Kept, json!("v2")));

        // Une écriture sur un autre compte ne change rien ; sur le même, la relance rejoint le service.
        written(&Account { instance: "pro".into(), ..acme.clone() });
        assert_eq!(read(&k, &acme, true, || async { ok("x") }).await.1, Source::Kept);
        written(&acme);
        let (after, source) = read(&k, &acme, true, || async { ok("v3") }).await;
        assert_eq!((source, after.unwrap()["body"].clone()), (Source::Fetched, json!("v3")));

        // Une lecture partie avant une écriture, ou en échec, n’est pas gardée.
        let racing = Account { instance: "course".into(), ..acme.clone() };
        let r = key(&racing, "f1", "GET", "/messages", None, None);
        let _ = read(&r, &racing, false, || async {
            written(&Account { space: "espace-garde".into(), client: "mail".into(), instance: "course".into() });
            ok("avant")
        })
        .await;
        assert_eq!(read(&r, &racing, true, || async { ok("après") }).await.1, Source::Fetched);
        let failed = key(&acme, "f1", "GET", "/erreur", None, None);
        let _ = read(&failed, &acme, false, || async { Ok(json!({ "status": 503, "ok": false })) }).await;
        assert_eq!(read(&failed, &acme, true, || async { ok("") }).await.1, Source::Fetched);
    }

    #[test]
    fn a_replay_lasts_while_its_guard_lives() {
        assert!(!replaying("mail-b/lire"));
        let first = replay("mail-b/lire");
        let second = replay("mail-b/lire");
        drop(first);
        assert!(replaying("mail-b/lire"));
        drop(second);
        assert!(!replaying("mail-b/lire"));
    }
}
