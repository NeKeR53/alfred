//! États partagés : la seule source de vérité des données d’un service dans Alfred. Les pages s’abonnent à un état
//! (`useAlfredState`) ; l’interface suit l’état, et un changement met à jour toutes les interfaces au même moment.
//!
//! - **Entités normalisées.** Un objet (ticket, mail, job CI) est rangé une seule fois, sous sa clé d’entité
//!   (`jira/ticket` + son identifiant), dans la portée de son compte. Le module qui détient le client déclare ses types
//!   d’entité (`entities` : nom, champ identifiant, forme, version) : c’est un contrat entre modules.
//! - **États nommés.** `jira/mes-tickets`, `jenkins/ci` + sous-clé `<job>` (`states` du manifeste). Un état de liste
//!   (`entity`) garde seulement les identifiants ; la lecture rend la liste avec ses objets. Un autre état garde sa
//!   valeur telle quelle.
//! - **Alimentation.** Une fonction de lecture déclare l’état (`state`) ou l’entité (`entity`) qu’elle alimente : sa
//!   sortie met à jour le magasin, sans rien de plus à faire pour le module ([`feed`]). Une page, une fonction ou un
//!   script du module peut aussi publier (`frame.states.publish`).
//! - **Notification.** Chaque changement réel (valeur différente) émet `states:changed` avec les clés touchées : chaque
//!   coquille relit les abonnements qui en dépendent. Le bus d’événements reçoit `module/etat.<id>` et
//!   `module/entite.<id>` pour les fonctions abonnées (`events.subscribes`).
//! - **Portée.** Espace, mode « données d’exemple », compte (instance du client) : deux comptes ne partagent rien.
//!   Un module lit les états de son module et de ses dépendances (`requires`) seulement ; seul le module déclarant
//!   publie.
//! - **En mémoire.** Le magasin vit le temps du lancement d’Alfred. Sans lecture, un état ne change pas.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{EntityDecl, ModuleManifest, Space, StateDecl};
use crate::state::AppState;

/// Événement reçu par les coquilles à chaque changement : `{ keys: [...] }`.
pub const CHANGED: &str = "states:changed";
/// Une valeur plus grosse n’est pas rangée.
const MAX_VALUE: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

struct Stored {
    value: Value,
    at: u64,
}

#[derive(Default)]
struct Store {
    entries: HashMap<String, Stored>,
    /// Relecture périodique d’un état : la coquille qui la tient, jusqu’à quand.
    leases: HashMap<String, (String, Instant)>,
}

fn store() -> std::sync::MutexGuard<'static, Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

/// Portée d’une donnée : espace, mode exemple, compte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub space: String,
    pub examples: bool,
    pub instance: String,
}

fn state_key(scope: &Scope, owner: &str, id: &str, sub: &str) -> String {
    format!("etat\u{1f}{}\u{1f}{}\u{1f}{owner}/{id}\u{1f}{}\u{1f}{sub}", scope.space, scope.examples, scope.instance)
}

fn entity_key(scope: &Scope, owner: &str, entity: &str, id: &str) -> String {
    format!("entite\u{1f}{}\u{1f}{}\u{1f}{owner}/{entity}\u{1f}{}\u{1f}{id}", scope.space, scope.examples, scope.instance)
}

/// Texte d’un identifiant ou d’une sous-clé : une chaîne, ou un nombre.
fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Besoin dont le compte entre dans la portée : celui déclaré, sinon le seul besoin du module.
fn need_of(manifest: &ModuleManifest, declared: Option<&str>) -> Option<String> {
    match declared {
        Some(need) => Some(need.to_string()),
        None if manifest.clients.len() == 1 => Some(manifest.clients[0].id.clone()),
        None => None,
    }
}

/// Instance réelle du compte : celle demandée, sinon celle par défaut du client relié au besoin.
fn resolve_instance(space: &Space, owner: &str, need: Option<&str>, wanted: Option<String>) -> String {
    let Some(need) = need else { return String::new() };
    crate::clients::client_for(space, owner, need)
        .and_then(|def| def.effective(wanted.as_deref()))
        .map(|client| client.instance)
        .unwrap_or_else(|_| wanted.unwrap_or_default())
}

/// Ce que désigne un nom : un état ou un type d’entité du module.
enum Target<'a> {
    State(&'a StateDecl),
    Entity(&'a EntityDecl),
}

fn target<'a>(manifest: &'a ModuleManifest, id: &str) -> Option<Target<'a>> {
    if let Some(state) = manifest.states.iter().find(|state| state.id == id) {
        return Some(Target::State(state));
    }
    manifest.entities.iter().find(|entity| entity.id == id).map(Target::Entity)
}

/// Changements d’une opération : clés touchées, et événements du bus.
#[derive(Default)]
struct Changes {
    keys: Vec<String>,
    events: Vec<(String, Value)>,
}

fn set(changes: &mut Changes, key: String, value: Value, event: Option<(String, Value)>) {
    if value.to_string().len() > MAX_VALUE {
        return;
    }
    let mut store = store();
    if store.entries.get(&key).is_some_and(|stored| stored.value == value) {
        return;
    }
    if store.entries.len() >= MAX_ENTRIES && !store.entries.contains_key(&key) {
        if let Some(oldest) = store.entries.iter().min_by_key(|(_, stored)| stored.at).map(|(key, _)| key.clone()) {
            store.entries.remove(&oldest);
        }
    }
    store.entries.insert(key.clone(), Stored { value, at: now_ms() });
    changes.keys.push(key);
    if let Some(event) = event {
        changes.events.push(event);
    }
}

/// Range un objet sous sa clé d’entité, fusionné champ par champ avec celui déjà rangé (une liste qui rend moins de
/// champs que le détail ne les efface pas). Rend son identifiant.
fn upsert(changes: &mut Changes, scope: &Scope, owner: &str, entity: &EntityDecl, object: &Value) -> Option<String> {
    let fields = object.as_object()?;
    let id = id_text(fields.get(entity.key_field())?)?;
    let key = entity_key(scope, owner, &entity.id, &id);
    let merged = match store().entries.get(&key).map(|stored| stored.value.clone()) {
        Some(Value::Object(mut old)) => {
            for (name, value) in fields {
                old.insert(name.clone(), value.clone());
            }
            Value::Object(old)
        }
        _ => object.clone(),
    };
    let event = (
        format!("{owner}/entite.{}", entity.id),
        json!({ "entity": format!("{owner}/{}", entity.id), "id": id, "instance": scope.instance, "examples": scope.examples }),
    );
    set(changes, key, merged, Some(event));
    Some(id)
}

fn upsert_all(changes: &mut Changes, scope: &Scope, owner: &str, entity: &EntityDecl, value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().filter_map(|item| upsert(changes, scope, owner, entity, item)).collect(),
        Value::Object(_) => upsert(changes, scope, owner, entity, value).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Écrit la valeur d’un état : pour une liste d’entités, les objets vont au magasin et l’état garde leurs identifiants.
fn write_state(
    changes: &mut Changes,
    manifest: &ModuleManifest,
    scope: &Scope,
    declared: &StateDecl,
    sub: &str,
    value: &Value,
) -> AppResult<()> {
    let owner = manifest.id.as_str();
    let stored = match &declared.entity {
        Some(entity_id) => {
            let entity = manifest.entities.iter().find(|entity| &entity.id == entity_id).ok_or_else(|| {
                AppError::new(format!("L’état « {} » liste des « {entity_id} », type d’entité non déclaré.", declared.id))
            })?;
            let list = match &declared.items {
                Some(field) => value.get(field).unwrap_or(&Value::Null),
                None => value,
            };
            if !list.is_array() {
                return Err(AppError::new(format!(
                    "L’état « {} » attend une liste d’objets{} : la valeur reçue n’en est pas une.",
                    declared.id,
                    declared.items.as_deref().map(|field| format!(" dans « {field} »")).unwrap_or_default()
                )));
            }
            Value::Array(upsert_all(changes, scope, owner, entity, list).into_iter().map(Value::String).collect())
        }
        None => value.clone(),
    };
    let event = (
        format!("{owner}/etat.{}", declared.id),
        json!({ "state": format!("{owner}/{}", declared.id), "key": sub, "instance": scope.instance, "examples": scope.examples }),
    );
    set(changes, state_key(scope, owner, &declared.id, sub), stored, Some(event));
    Ok(())
}

/// Annonce les changements aux coquilles et au bus d’événements.
fn announce(state: &AppState, space: &Space, changes: Changes) {
    if changes.keys.is_empty() {
        return;
    }
    state.emit(CHANGED, json!({ "keys": changes.keys }));
    for (event, payload) in changes.events {
        if let Err(error) = crate::module_events::publish_internal(space, &event, &payload) {
            log::error!("bus d’événements, {event} : {}", error.message);
        }
    }
    crate::module_events::kick();
}

/// La sortie d’une fonction met à jour l’état ou l’entité qu’elle déclare (`state`, `entity`, `param`). Appelé par
/// le cœur après chaque fonction qu’il lance (`functions::call_in`) et par la coquille après une fonction TypeScript
/// (`states.feed`). Une fonction qui ne déclare rien ne change rien.
pub fn feed(
    state: &AppState,
    space: &Space,
    reference: &str,
    input: &Value,
    accounts: Option<&Map<String, Value>>,
    examples: bool,
    output: &Value,
) -> AppResult<()> {
    let Some((owner, id)) = reference.split_once('/') else { return Ok(()) };
    let manifest = space.module(owner)?;
    let Some(declared) = manifest.functions.iter().find(|function| function.id == id) else { return Ok(()) };
    if declared.state.is_none() && declared.entity.is_none() {
        return Ok(());
    }
    let examples = examples || crate::examples::is_on(state, owner);
    let wanted = |need: Option<&str>| -> Option<String> {
        input
            .get("instance")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| need.and_then(|need| accounts.and_then(|accounts| accounts.get(need))).and_then(Value::as_str).map(str::to_string))
    };
    let scope_for = |client: Option<&str>| {
        let need = need_of(&manifest, client);
        Scope {
            space: space.root.to_string_lossy().to_string(),
            examples,
            instance: resolve_instance(space, owner, need.as_deref(), wanted(need.as_deref())),
        }
    };
    let sub = declared.param.as_deref().and_then(|param| input.get(param)).and_then(id_text).unwrap_or_default();
    let mut changes = Changes::default();
    // Une liste (ou une valeur) : seulement une lecture la remplace.
    if let (Some(state_id), Some(crate::space::Effect::Read)) = (&declared.state, declared.effect) {
        let state_decl = manifest.states.iter().find(|candidate| &candidate.id == state_id).ok_or_else(|| {
            AppError::new(format!("La fonction « {reference} » alimente « {state_id} », état non déclaré dans `states`."))
        })?;
        write_state(&mut changes, &manifest, &scope_for(state_decl.client.as_deref()), state_decl, &sub, output)?;
    }
    // Un objet, ou des objets : une lecture d’un seul ticket, ou une écriture qui rend le ticket modifié.
    if let Some(entity_id) = &declared.entity {
        let entity = manifest.entities.iter().find(|entity| &entity.id == entity_id).ok_or_else(|| {
            AppError::new(format!("La fonction « {reference} » met à jour « {entity_id} », entité non déclarée dans `entities`."))
        })?;
        upsert_all(&mut changes, &scope_for(entity.client.as_deref()), owner, entity, output);
    }
    announce(state, space, changes);
    Ok(())
}

/// Nom d’un état ou d’une entité, vu du module qui le demande : « module/id », ou « id » dans son module. Le
/// module ne voit que les siens et ceux de ses dépendances (`requires`).
fn visible(space: &Space, subject: &Subject, name: &str) -> AppResult<(ModuleManifest, String)> {
    let (owner, id) = match name.split_once('/') {
        Some((owner, id)) => (owner.to_string(), id.to_string()),
        None => (subject.module.clone(), name.to_string()),
    };
    if owner != subject.module && !space.module(&subject.module).is_ok_and(|manifest| manifest.requires_module(&owner)) {
        return Err(AppError::new(format!(
            "« {owner}/{id} » est un état du module « {owner} » : déclare `requires: [{{ \"module\": \"{owner}\" }}]` pour t’y abonner."
        )));
    }
    let manifest = space.module(&owner)?;
    if target(&manifest, &id).is_none() {
        return Err(AppError::new(format!(
            "Le module « {owner} » ne déclare ni état ni entité « {id} » (`states`, `entities` de son module.json)."
        )));
    }
    Ok((manifest, id))
}

/// Compte visé par un demandeur : celui qu’il nomme, sinon celui choisi pour le besoin (par la page, ou pour
/// `dépendance/besoin`), sinon celui de sa page, sinon celui par défaut.
fn subject_scope(state: &AppState, space: &Space, subject: &Subject, manifest: &ModuleManifest, client: Option<&str>, args: &Value) -> AppResult<Scope> {
    let need = need_of(manifest, client);
    let wanted = opt_arg::<String>(args, "instance")?.or_else(|| {
        let need = need.as_deref()?;
        let named = if manifest.id == subject.module { need.to_string() } else { format!("{}/{need}", manifest.id) };
        subject.accounts.get(&named).cloned().or_else(|| subject.instance.clone())
    });
    Ok(Scope {
        space: space.root.to_string_lossy().to_string(),
        examples: subject.examples || crate::examples::is_on(state, &manifest.id),
        instance: resolve_instance(space, &manifest.id, need.as_deref(), wanted),
    })
}

/// Valeur courante d’un état (liste rendue avec ses objets) ou d’une entité, avec les clés dont elle dépend.
fn read(state: &AppState, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let name: String = arg(args, "name")?;
    let sub = opt_arg::<Value>(args, "key")?.as_ref().and_then(id_text).unwrap_or_default();
    let space = state.space()?;
    let (manifest, id) = visible(&space, &subject, &name)?;
    let owner = manifest.id.clone();
    let entries = |keys: &[String]| -> Vec<Option<(Value, u64)>> {
        let store = store();
        keys.iter().map(|key| store.entries.get(key).map(|stored| (stored.value.clone(), stored.at))).collect()
    };
    match target(&manifest, &id) {
        Some(Target::State(declared)) => {
            let scope = subject_scope(state, &space, &subject, &manifest, declared.client.as_deref(), args)?;
            let key = state_key(&scope, &owner, &id, &sub);
            let Some((stored, at)) = entries(std::slice::from_ref(&key)).remove(0) else {
                return Ok(json!({ "value": null, "empty": true, "deps": [key], "refreshEvery": declared.refresh_every, "instance": scope.instance }));
            };
            let mut deps = vec![key];
            let value = match (&declared.entity, &stored) {
                (Some(entity_id), Value::Array(ids)) => {
                    let entity_scope = manifest
                        .entities
                        .iter()
                        .find(|entity| &entity.id == entity_id)
                        .map(|entity| subject_scope(state, &space, &subject, &manifest, entity.client.as_deref(), args))
                        .transpose()?
                        .unwrap_or_else(|| scope.clone());
                    let keys: Vec<String> =
                        ids.iter().filter_map(id_text).map(|id| entity_key(&entity_scope, &owner, entity_id, &id)).collect();
                    let objects = entries(&keys).into_iter().flatten().map(|(object, _)| object).collect();
                    deps.extend(keys);
                    Value::Array(objects)
                }
                _ => stored,
            };
            Ok(json!({ "value": value, "empty": false, "updatedAt": at, "deps": deps, "refreshEvery": declared.refresh_every, "instance": scope.instance }))
        }
        Some(Target::Entity(entity)) => {
            if sub.is_empty() {
                return Err(AppError::new(format!("« {owner}/{id} » est une entité : donne son identifiant dans `key`.")));
            }
            let scope = subject_scope(state, &space, &subject, &manifest, entity.client.as_deref(), args)?;
            let key = entity_key(&scope, &owner, &id, &sub);
            let found = entries(std::slice::from_ref(&key)).remove(0);
            Ok(json!({
                "value": found.as_ref().map(|(value, _)| value.clone()),
                "empty": found.is_none(),
                "updatedAt": found.map(|(_, at)| at),
                "deps": [key],
                "instance": scope.instance,
            }))
        }
        None => Err(AppError::new("État inconnu.")),
    }
}

/// Publication par le module déclarant (page, fonction, script) : une valeur d’état, ou un ou des objets.
fn publish(state: &AppState, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let name: String = arg(args, "name")?;
    let value = args.get("value").cloned().unwrap_or(Value::Null);
    let sub = opt_arg::<Value>(args, "key")?.as_ref().and_then(id_text).unwrap_or_default();
    let space = state.space()?;
    let (manifest, id) = visible(&space, &subject, &name)?;
    if manifest.id != subject.module {
        return Err(AppError::new(format!(
            "Seul le module « {} » publie ses états : les autres s’y abonnent.",
            manifest.id
        )));
    }
    let mut changes = Changes::default();
    match target(&manifest, &id) {
        Some(Target::State(declared)) => {
            let scope = subject_scope(state, &space, &subject, &manifest, declared.client.as_deref(), args)?;
            write_state(&mut changes, &manifest, &scope, declared, &sub, &value)?;
        }
        Some(Target::Entity(entity)) => {
            let scope = subject_scope(state, &space, &subject, &manifest, entity.client.as_deref(), args)?;
            upsert_all(&mut changes, &scope, &manifest.id, entity, &value);
        }
        None => {}
    }
    let changed = changes.keys.len();
    announce(state, &space, changes);
    Ok(json!({ "changed": changed }))
}

/// Relecture périodique : une seule coquille la tient pour un état, renouvelée à chaque passage.
fn lease(args: &Value) -> AppResult<Value> {
    let key: String = arg(args, "key")?;
    let origin: String = arg(args, "origin")?;
    let seconds = opt_arg::<u64>(args, "seconds")?.unwrap_or(30).clamp(5, 86_400);
    let mut store = store();
    let now = Instant::now();
    let granted = match store.leases.get(&key) {
        Some((holder, until)) => holder == &origin || *until <= now,
        None => true,
    };
    if granted {
        store.leases.insert(key, (origin, now + Duration::from_secs(seconds * 2)));
    }
    Ok(Value::Bool(granted))
}

pub async fn handle(state: &AppState, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "frame.states.get" => Some(read(state, args)),
        "frame.states.publish" => Some(publish(state, args)),
        "states.lease" => Some(lease(args)),
        // La coquille a exécuté une fonction TypeScript : sa sortie alimente l’état qu’elle déclare.
        "states.feed" => Some((|| {
            let function: String = arg(args, "function")?;
            let space = state.space()?;
            let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
            let examples = args.get("examples").and_then(Value::as_bool).unwrap_or(false);
            let output = args.get("output").cloned().unwrap_or(Value::Null);
            feed(state, &space, &function, &input, args.get("accounts").and_then(Value::as_object), examples, &output)?;
            Ok(Value::Null)
        })()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{EntityDecl, FunctionDecl, StateDecl};

    fn jira(space: &Space) {
        let mut manifest = ModuleManifest { id: "jira".into(), name: "Jira".into(), ..Default::default() };
        manifest.entities.push(EntityDecl { id: "ticket".into(), key: Some("cle".into()), version: 1, ..Default::default() });
        manifest.states.push(StateDecl { id: "mes-tickets".into(), entity: Some("ticket".into()), ..Default::default() });
        manifest.states.push(StateDecl { id: "suivis".into(), entity: Some("ticket".into()), items: Some("issues".into()), ..Default::default() });
        manifest.states.push(StateDecl { id: "ci".into(), ..Default::default() });
        for (id, state, entity, param) in [
            ("mes-tickets", Some("mes-tickets"), None, None),
            ("suivis", Some("suivis"), None, None),
            ("ticket", None, Some("ticket"), Some("cle")),
            ("ci", Some("ci"), None, Some("job")),
        ] {
            manifest.functions.push(FunctionDecl {
                id: id.into(),
                effect: Some(crate::space::Effect::Read),
                state: state.map(str::to_string),
                entity: entity.map(str::to_string),
                param: param.map(str::to_string),
                ..Default::default()
            });
        }
        space.write_module(&manifest).unwrap();
        space.write_module(&ModuleManifest { id: "sprint".into(), name: "Sprint".into(), requires: vec![crate::space::Requirement { module: "jira".into(), ..Default::default() }], ..Default::default() }).unwrap();
        space.write_module(&ModuleManifest { id: "suivi".into(), name: "Suivi".into(), requires: vec![crate::space::Requirement { module: "jira".into(), ..Default::default() }], ..Default::default() }).unwrap();
        space.write_module(&ModuleManifest { id: "autre".into(), name: "Autre".into(), ..Default::default() }).unwrap();
    }

    fn page(module: &str) -> Subject {
        Subject { kind: "page".into(), module: module.into(), reference: format!("{module}/accueil"), ..Default::default() }
    }

    fn get(state: &AppState, subject: &Subject, name: &str, key: Option<&str>) -> AppResult<Value> {
        read(state, &json!({ "subject": subject, "name": name, "key": key }))
    }

    #[tokio::test]
    async fn one_ticket_lives_once_and_every_list_shows_its_latest_version() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        state.set_space(Some(space.clone()));
        jira(&space);
        let mut events = state.events.subscribe();

        // Vide tant que personne n’a lu.
        let empty = get(&state, &page("sprint"), "jira/mes-tickets", None).unwrap();
        assert_eq!(empty["empty"], json!(true));

        // Deux listes de deux formes, montrées par deux modules (sprint, suivi), partagent le ticket ALF-1.
        let tickets = json!([{ "cle": "ALF-1", "titre": "Export", "etat": "ouvert" }, { "cle": "ALF-2", "titre": "Menu" }]);
        feed(&state, &space, "jira/mes-tickets", &json!({}), None, false, &tickets).unwrap();
        feed(&state, &space, "jira/suivis", &json!({}), None, false, &json!({ "issues": [{ "cle": "ALF-1" }] })).unwrap();
        let changed = events.recv().await.unwrap();
        assert_eq!(changed.name, CHANGED);
        let mine = get(&state, &page("sprint"), "jira/mes-tickets", None).unwrap();
        assert_eq!(mine["value"][0]["titre"], json!("Export"));
        let followed = get(&state, &page("suivi"), "jira/suivis", None).unwrap();
        assert_eq!(followed["value"], json!([{ "cle": "ALF-1", "titre": "Export", "etat": "ouvert" }]), "fusion : la liste courte n’efface rien");

        // Relire ce seul ticket met à jour les deux listes ; la clé de l’entité est dans leurs dépendances.
        while events.try_recv().is_ok() {}
        feed(&state, &space, "jira/ticket", &json!({ "cle": "ALF-1" }), None, false, &json!({ "cle": "ALF-1", "etat": "fermé" })).unwrap();
        let changed = events.recv().await.unwrap();
        let keys: Vec<String> = serde_json::from_value(changed.payload["keys"].clone()).unwrap();
        assert_eq!(keys.len(), 1, "seul l’objet change");
        for list in [&mine, &followed] {
            assert!(list["deps"].as_array().unwrap().contains(&json!(keys[0])));
        }
        assert_eq!(get(&state, &page("sprint"), "jira/mes-tickets", None).unwrap()["value"][0]["etat"], json!("fermé"));
        assert_eq!(get(&state, &page("suivi"), "jira/suivis", None).unwrap()["value"][0]["etat"], json!("fermé"));
        assert_eq!(get(&state, &page("sprint"), "jira/ticket", Some("ALF-1")).unwrap()["value"]["titre"], json!("Export"));

        // La même valeur ne notifie personne.
        feed(&state, &space, "jira/ticket", &json!({}), None, false, &json!({ "cle": "ALF-1", "etat": "fermé" })).unwrap();
        assert!(events.try_recv().is_err());

        // Sous-clé, mode exemple, isolement entre modules, publication réservée au module déclarant.
        feed(&state, &space, "jira/ci", &json!({ "job": "alfred" }), None, false, &json!({ "etat": "vert" })).unwrap();
        assert_eq!(get(&state, &page("jira"), "ci", Some("alfred")).unwrap()["value"], json!({ "etat": "vert" }));
        assert_eq!(get(&state, &page("jira"), "ci", Some("autre")).unwrap()["empty"], json!(true));
        let sample = Subject { examples: true, ..page("sprint") };
        assert_eq!(get(&state, &sample, "jira/mes-tickets", None).unwrap()["empty"], json!(true));
        assert!(get(&state, &page("autre"), "jira/mes-tickets", None).unwrap_err().message.contains("requires"));
        let refused = publish(&state, &json!({ "subject": page("sprint"), "name": "jira/ci", "key": "alfred", "value": 1 }));
        assert!(refused.unwrap_err().message.contains("Seul le module"));
        publish(&state, &json!({ "subject": page("jira"), "name": "ci", "key": "alfred", "value": { "etat": "rouge" } })).unwrap();
        assert_eq!(get(&state, &page("sprint"), "jira/ci", Some("alfred")).unwrap()["value"]["etat"], json!("rouge"));
    }

    #[test]
    fn a_periodic_read_has_one_holder() {
        let key = json!({ "key": "etat-test", "origin": "a", "seconds": 5 });
        assert_eq!(lease(&key).unwrap(), json!(true));
        assert_eq!(lease(&json!({ "key": "etat-test", "origin": "b", "seconds": 5 })).unwrap(), json!(false));
        assert_eq!(lease(&key).unwrap(), json!(true), "renouvelée par sa coquille");
    }
}
