//! Lectures d’un client partagées dans le cœur. Toute requête `GET` ou `HEAD` d’une fonction (TypeScript, bash,
//! PowerShell, Python) passe par `clients::frame_request`, donc par ici : la fonction n’a pas d’autre chemin vers le
//! service (le cadre n’a pas de réseau, le script n’a pas le secret).
//!
//! Deux lectures identiques en vol (même compte, même requête) ne font qu’une requête : la seconde attend la réponse
//! de la première. Rien n’est gardé après la réponse : une fonction qui relit reçoit l’état du service. La donnée
//! gardée et sa diffusion aux pages sont le rôle du magasin des états (`states.rs`), qu’alimente la sortie des
//! fonctions de lecture. Une écriture prévient les coquilles (`clients:changed`).
//!
//! La clé ne contient pas le module : l’accord est vérifié pour chaque demandeur avant d’arriver ici, et la réponse ne
//! dépend que du compte et de la requête. Une réponse scellée ne passe jamais par ici (ses références sont propres au
//! module qui les a lues).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};
use tokio::sync::OnceCell;

use crate::error::AppResult;

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
    /// Requête faite pour ce demandeur.
    Fetched,
    /// Réponse de la requête identique déjà en vol.
    Joined,
}

type Cell = Arc<OnceCell<AppResult<Value>>>;

fn inflight() -> &'static Mutex<HashMap<String, Cell>> {
    static INFLIGHT: OnceLock<Mutex<HashMap<String, Cell>>> = OnceLock::new();
    INFLIGHT.get_or_init(Mutex::default)
}

/// Clé d’une lecture : compte, empreinte du client (adresse, authentification, en-têtes), méthode, chemin,
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

/// Lit par le magasin : rejoint la lecture identique en vol, ou appelle `perform`.
pub async fn read<F, Fut>(key: &str, perform: F) -> (AppResult<Value>, Source)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<Value>>,
{
    let (cell, leader) = {
        let mut map = inflight().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match map.get(key) {
            Some(cell) => (cell.clone(), false),
            None => {
                let cell: Cell = Arc::new(OnceCell::new());
                map.insert(key.to_string(), cell.clone());
                (cell, true)
            }
        }
    };
    // Le premier arrivé fait la requête ; s’il est annulé, le suivant la reprend (`OnceCell`).
    let result = cell.get_or_init(perform).await.clone();
    if leader {
        let mut map = inflight().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if map.get(key).is_some_and(|current| Arc::ptr_eq(current, &cell)) {
            map.remove(key);
        }
    }
    (result, if leader { Source::Fetched } else { Source::Joined })
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
    use std::time::Duration;

    #[tokio::test]
    async fn identical_reads_in_flight_share_one_request() {
        let acme = Account { space: "espace-lectures".into(), client: "jira".into(), instance: "acme".into() };
        let calls = Arc::new(AtomicUsize::new(0));
        let k = key(&acme, "f1", "GET", "/rest/api/3/search", json!({ "b": 1, "a": 2 }).as_object(), None);
        assert_eq!(k, key(&acme, "f1", "GET", "/rest/api/3/search", json!({ "a": 2, "b": 1 }).as_object(), None));
        let other = Account { instance: "interne".into(), ..acme.clone() };
        assert_ne!(k, key(&other, "f1", "GET", "/rest/api/3/search", None, None), "une autre instance");

        let slow = |calls: Arc<AtomicUsize>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(json!({ "status": 200, "ok": true, "body": ["ALF-1"] }))
        };
        let (first, second) = tokio::join!(read(&k, || slow(calls.clone())), read(&k, || slow(calls.clone())));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "une seule requête pour deux lectures en vol");
        assert_eq!(first.1, Source::Fetched);
        assert_eq!(second.1, Source::Joined);
        assert_eq!(second.0.unwrap()["body"], json!(["ALF-1"]));

        // Après la réponse, rien n’est gardé : la lecture suivante rappelle le service.
        assert_eq!(read(&k, || slow(calls.clone())).await.1, Source::Fetched);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
