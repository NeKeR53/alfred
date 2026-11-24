//! Zones du menu de gauche : les entrées qu’une page (ou une fonction de son module) fait apparaître sous l’entrée de
//! sa section, à part du reste du menu, par exemple une entrée par produit lue dans une table. Une zone par page
//! (`module/page`, ou la copie `module/page@suffixe`), conservée par espace dans la base d’Alfred comme les compteurs :
//! une page n’est chargée que lorsqu’on l’affiche, ses entrées doivent lui survivre d’un lancement à l’autre.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::state::AppState;

/// Au-delà, une zone n’est plus un menu.
const MAX_ENTRIES: usize = 200;
const MAX_ACTIONS: usize = 3;
const MAX_TEXT: usize = 120;
const MAX_BADGE: i64 = 99_999;
const STATUSES: [&str; 5] = ["ok", "warning", "error", "running", "waiting"];
const COLORS: [&str; 8] = ["steel", "blue", "violet", "pink", "red", "orange", "green", "teal"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `page` : l’ordre donné par la page ; `user` : l’utilisateur déplace les entrées (Alt+↑, Alt+↓).
    #[serde(default = "page_order")]
    pub order: String,
    /// Entrées affichées avant « Afficher plus » ; absent : toutes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<u32>,
    #[serde(default)]
    pub entries: Vec<Entry>,
    /// Ordre choisi par l’utilisateur (identifiants), appliqué quand `order` vaut `user`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_order: Vec<String>,
}

fn page_order() -> String {
    "page".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<i64>,
    /// Autre page du module ouverte au clic (identifiant de page), sinon celle de la zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<EntryAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryAction {
    pub id: String,
    pub label: String,
    pub icon: String,
    /// Fonction du module appelée avec `{ entry, action, page, value? }` ; sinon la page reçoit l’action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
}

pub type Zones = BTreeMap<String, Zone>;

pub async fn handle(state: &AppState, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "menuZones.list" => Some(list(state).map(|zones| json!(zones))),
        "frame.menuZones.update" => Some(update(state, args)),
        // Ordre choisi par l’utilisateur : la coquille seule le règle, jamais une page.
        "menuZones.reorder" => Some(reorder(state, args)),
        _ => None,
    }
}

fn key(state: &AppState) -> AppResult<String> {
    Ok(format!("menuZones:{}", state.space()?.root.to_string_lossy()))
}

fn list(state: &AppState) -> AppResult<Zones> {
    if state.try_space().is_none() {
        return Ok(Zones::new());
    }
    let key = key(state)?;
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    Ok(crate::app_db::get_setting(&db, &key)?.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default())
}

/// Lit, modifie et réécrit les zones de l’espace, puis prévient toutes les fenêtres.
fn modify<T>(state: &AppState, change: impl FnOnce(&mut Zones) -> AppResult<T>) -> AppResult<T> {
    let key = key(state)?;
    let (result, zones) = {
        let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
        let mut zones: Zones = crate::app_db::get_setting(&db, &key)?
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        let result = change(&mut zones)?;
        crate::app_db::set_setting(&db, &key, &if zones.is_empty() { Value::Null } else { json!(zones) })?;
        (result, zones)
    };
    state.emit("menuZones:changed", json!(zones));
    Ok(result)
}

/// Oublie la zone `page` (les entrées d’une section créée qui s’en va).
pub fn forget(state: &AppState, page: &str) -> AppResult<()> {
    modify(state, |zones| {
        zones.remove(page);
        Ok(())
    })
}

fn update(state: &AppState, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let page: String = arg(args, "page")?;
    let op: String = arg(args, "op")?;
    check_target(&subject, &page)?;
    let module = subject.module.clone();
    modify(state, |zones| apply(zones, &module, &page, &op, args))?;
    Ok(Value::Null)
}

fn apply(zones: &mut Zones, module: &str, page: &str, op: &str, args: &Value) -> AppResult<()> {
    match op {
        "setZone" => {
            let title = opt_arg::<String>(args, "title")?.map(|title| clean_text(&title, "titre")).transpose()?;
            let order = match opt_arg::<String>(args, "order")?.as_deref() {
                None | Some("page") => "page".to_string(),
                Some("user") => "user".to_string(),
                Some(other) => return Err(AppError::new(format!("Ordre inconnu : « {other} » (page ou user)."))),
            };
            let visible = opt_arg::<u32>(args, "visible")?.filter(|count| *count > 0);
            let zone = zones.entry(page.to_string()).or_default();
            zone.title = title.filter(|title| !title.is_empty());
            zone.order = order;
            zone.visible = visible;
        }
        "setEntries" => {
            let raw: Vec<Value> = arg(args, "entries")?;
            if raw.len() > MAX_ENTRIES {
                return Err(AppError::new(format!("Une zone du menu compte au plus {MAX_ENTRIES} entrées.")));
            }
            let mut entries = Vec::with_capacity(raw.len());
            for value in raw {
                let entry = parse_entry(module, value)?;
                if entries.iter().any(|known: &Entry| known.id == entry.id) {
                    return Err(AppError::new(format!("Entrée en double dans le menu : « {} ».", entry.id)));
                }
                entries.push(entry);
            }
            let zone = zones.entry(page.to_string()).or_default();
            zone.user_order.retain(|id| entries.iter().any(|entry| &entry.id == id));
            zone.entries = entries;
        }
        "updateEntry" => {
            let id: String = arg(args, "id")?;
            let patch: Value = arg(args, "patch")?;
            let Some(patch) = patch.as_object() else {
                return Err(AppError::new("La modification d’une entrée attend un objet."));
            };
            let zone = zones.get_mut(page).ok_or_else(|| missing_entry(&id))?;
            let entry = zone.entries.iter_mut().find(|entry| entry.id == id).ok_or_else(|| missing_entry(&id))?;
            let mut merged = serde_json::to_value(&*entry)?;
            for (field, value) in patch {
                if field == "id" {
                    continue;
                }
                merged[field] = value.clone();
            }
            *entry = parse_entry(module, merged)?;
        }
        "removeEntry" => {
            let id: String = arg(args, "id")?;
            if let Some(zone) = zones.get_mut(page) {
                zone.entries.retain(|entry| entry.id != id);
                zone.user_order.retain(|known| known != &id);
            }
        }
        "clear" => {
            zones.remove(page);
            return Ok(());
        }
        _ => return Err(AppError::new(format!("Opération du menu inconnue : {op}"))),
    }
    if zones.get(page).is_some_and(|zone| zone.entries.is_empty() && zone.title.is_none() && zone.visible.is_none()) {
        zones.remove(page);
    }
    Ok(())
}

fn missing_entry(id: &str) -> AppError {
    AppError::new(format!("L’entrée « {id} » n’est pas dans la zone du menu de la page."))
}

/// Une entrée lue et vérifiée : texte court, valeurs prises dans les listes fermées, page du même module.
fn parse_entry(module: &str, value: Value) -> AppResult<Entry> {
    // Les champs `null` d’une modification effacent la valeur.
    let value = match value {
        Value::Object(map) => Value::Object(map.into_iter().filter(|(_, value)| !value.is_null()).collect()),
        other => other,
    };
    let mut entry: Entry = serde_json::from_value(value)
        .map_err(|error| AppError::new(format!("Entrée du menu invalide : {error}")))?;
    entry.id = clean_text(&entry.id, "identifiant")?;
    if entry.id.is_empty() {
        return Err(AppError::new("Une entrée du menu a un identifiant."));
    }
    entry.label = clean_text(&entry.label, "libellé")?;
    if entry.label.is_empty() {
        return Err(AppError::new(format!("L’entrée « {} » du menu a un libellé.", entry.id)));
    }
    if let Some(status) = &entry.status {
        if !STATUSES.contains(&status.as_str()) {
            return Err(AppError::new(format!(
                "État inconnu « {status} » : ok, warning, error, running ou waiting."
            )));
        }
    }
    if let Some(color) = &entry.color {
        if !COLORS.contains(&color.as_str()) {
            return Err(AppError::new(format!("Couleur inconnue « {color} » : {}.", COLORS.join(", "))));
        }
    }
    if let Some(icon) = &entry.icon {
        if icon.len() > 200 || icon.chars().any(char::is_control) {
            return Err(AppError::new("Icône invalide : un nom Lucide ou le chemin d’une image du module."));
        }
    }
    entry.badge = entry.badge.map(|badge| badge.clamp(0, MAX_BADGE)).filter(|badge| *badge > 0);
    if let Some(page) = &entry.page {
        let (base, suffix) = page.split_once('@').map_or((page.as_str(), None), |(base, suffix)| (base, Some(suffix)));
        let base = base.strip_prefix(&format!("{module}/")).unwrap_or(base);
        if !crate::space::valid_id(base) || suffix.is_some_and(|suffix| !crate::space::valid_id(suffix)) {
            return Err(AppError::new(format!("« {page} » n’est pas une page du module « {module} ».")));
        }
        entry.page = Some(match suffix {
            Some(suffix) => format!("{base}@{suffix}"),
            None => base.to_string(),
        });
    }
    if entry.actions.len() > MAX_ACTIONS {
        return Err(AppError::new(format!("Une entrée du menu porte au plus {MAX_ACTIONS} actions.")));
    }
    for action in &mut entry.actions {
        action.id = clean_text(&action.id, "action")?;
        action.label = clean_text(&action.label, "libellé d’action")?;
        if action.id.is_empty() || action.label.is_empty() || action.icon.is_empty() || action.icon.len() > 64 {
            return Err(AppError::new("Une action d’entrée a un identifiant, un libellé et une icône Lucide."));
        }
        if let Some(function) = &action.function {
            let local = function.strip_prefix(&format!("{module}/")).unwrap_or(function);
            if !crate::space::valid_id(local) {
                return Err(AppError::new(format!("« {function} » n’est pas une fonction du module « {module} ».")));
            }
            action.function = Some(local.to_string());
        }
    }
    Ok(entry)
}

/// Texte d’une entrée : une ligne, sans caractère de contrôle, coupé à `MAX_TEXT` caractères.
fn clean_text(text: &str, what: &str) -> AppResult<String> {
    if text.chars().any(|character| character.is_control()) {
        return Err(AppError::new(format!("Le {what} d’une entrée du menu tient sur une ligne.")));
    }
    Ok(text.trim().chars().take(MAX_TEXT).collect())
}

/// Une page ne règle que les zones de son module : la sienne, celle d’une autre page du module, ou celle d’une section
/// créée par le module (`section:<module>/<id>`).
fn check_target(subject: &Subject, page: &str) -> AppResult<()> {
    if let Some(section) = page.strip_prefix("section:") {
        let valid = section
            .split_once('/')
            .is_some_and(|(module, id)| module == subject.module && crate::space::valid_id(id));
        return if valid {
            Ok(())
        } else {
            Err(AppError::new(format!("Menu refusé : « {section} » n’est pas une section du module « {} ».", subject.module)))
        };
    }
    let (base, instance) = match page.split_once('@') {
        Some((base, instance)) => (base, Some(instance)),
        None => (page, None),
    };
    let valid = base.split_once('/').is_some_and(|(module, id)| {
        crate::space::valid_id(module) && crate::space::valid_id(id) && module == subject.module
    }) && instance.is_none_or(crate::space::valid_id);
    if valid {
        Ok(())
    } else {
        Err(AppError::new(format!(
            "Menu refusé : « {page} » n’est pas une page du module « {} ».",
            subject.module
        )))
    }
}

fn reorder(state: &AppState, args: &Value) -> AppResult<Value> {
    let page: String = arg(args, "page")?;
    let order: Vec<String> = arg(args, "order")?;
    modify(state, |zones| {
        let zone = zones.get_mut(&page).ok_or_else(|| AppError::new("Cette zone du menu n’existe plus."))?;
        if zone.order != "user" {
            return Err(AppError::new("La page range elle-même les entrées de sa zone."));
        }
        zone.user_order = order.into_iter().filter(|id| zone.entries.iter().any(|entry| &entry.id == id)).collect();
        Ok(())
    })?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(module: &str) -> Subject {
        serde_json::from_value(json!({ "kind": "page", "module": module, "reference": format!("{module}/liste") }))
            .unwrap()
    }

    fn run(zones: &mut Zones, op: &str, args: Value) -> AppResult<()> {
        apply(zones, "produits", "produits/liste", op, &args)
    }

    #[test]
    fn zone_entries_are_set_updated_and_removed() {
        let mut zones = Zones::new();
        run(&mut zones, "setZone", json!({ "title": "Produits", "order": "user", "visible": 5 })).unwrap();
        run(
            &mut zones,
            "setEntries",
            json!({ "entries": [
                { "id": "atlas", "label": "Atlas", "status": "ok", "badge": 3, "icon": "box" },
                { "id": "borea", "label": "  Boréa  ", "color": "teal", "page": "produits/vue",
                  "actions": [{ "id": "rename", "label": "Renommer", "icon": "pencil" },
                              { "id": "archive", "label": "Archiver", "icon": "archive", "function": "produits/archiver" }] },
            ] }),
        )
        .unwrap();
        let zone = &zones["produits/liste"];
        assert_eq!(zone.title.as_deref(), Some("Produits"));
        assert_eq!(zone.order, "user");
        assert_eq!(zone.visible, Some(5));
        assert_eq!(zone.entries[1].label, "Boréa");
        assert_eq!(zone.entries[1].page.as_deref(), Some("vue"), "la page se garde sans le module");
        assert_eq!(zone.entries[1].actions[1].function.as_deref(), Some("archiver"));

        run(&mut zones, "updateEntry", json!({ "id": "atlas", "patch": { "status": "error", "badge": null, "id": "x" } }))
            .unwrap();
        let atlas = &zones["produits/liste"].entries[0];
        assert_eq!((atlas.id.as_str(), atlas.status.as_deref(), atlas.badge), ("atlas", Some("error"), None));
        assert!(run(&mut zones, "updateEntry", json!({ "id": "absent", "patch": {} })).is_err());

        run(&mut zones, "removeEntry", json!({ "id": "atlas" })).unwrap();
        assert_eq!(zones["produits/liste"].entries.len(), 1);
        run(&mut zones, "clear", json!({})).unwrap();
        assert!(zones.is_empty());
    }

    #[test]
    fn invalid_entries_are_refused() {
        let mut zones = Zones::new();
        for entries in [
            json!([{ "id": "a", "label": "A", "status": "vert" }]),
            json!([{ "id": "a", "label": "A", "color": "fuchsia" }]),
            json!([{ "id": "a", "label": "" }]),
            json!([{ "id": "", "label": "A" }]),
            json!([{ "id": "a", "label": "A\nB" }]),
            json!([{ "id": "a", "label": "A" }, { "id": "a", "label": "B" }]),
            json!([{ "id": "a", "label": "A", "page": "autre/vue/x" }]),
            json!([{ "id": "a", "label": "A", "page": "../vue" }]),
            json!([{ "id": "a", "label": "A", "actions": [{ "id": "x", "label": "X", "icon": "" }] }]),
            json!([{ "id": "a", "label": "A", "actions": [{ "id": "x", "label": "X", "icon": "x", "function": "Mauvais" }] }]),
        ] {
            assert!(run(&mut zones, "setEntries", json!({ "entries": entries })).is_err(), "{entries}");
        }
        let many: Vec<Value> = (0..=MAX_ENTRIES).map(|i| json!({ "id": i.to_string(), "label": "x" })).collect();
        assert!(run(&mut zones, "setEntries", json!({ "entries": many })).is_err());
        assert!(run(&mut zones, "setZone", json!({ "order": "alpha" })).is_err());
        assert!(zones.is_empty(), "rien n’est écrit après un refus");
    }

    #[test]
    fn user_order_follows_the_entries() {
        let mut zones = Zones::new();
        run(&mut zones, "setZone", json!({ "order": "user" })).unwrap();
        run(&mut zones, "setEntries", json!({ "entries": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }] }))
            .unwrap();
        zones.get_mut("produits/liste").unwrap().user_order = vec!["b".into(), "a".into()];
        run(&mut zones, "setEntries", json!({ "entries": [{ "id": "b", "label": "B" }, { "id": "c", "label": "C" }] }))
            .unwrap();
        assert_eq!(zones["produits/liste"].user_order, vec!["b".to_string()], "une entrée retirée quitte l’ordre");
    }

    #[test]
    fn only_pages_of_the_same_module() {
        let produits = subject("produits");
        assert!(check_target(&produits, "produits/liste").is_ok());
        assert!(check_target(&produits, "produits/liste@recette").is_ok());
        assert!(check_target(&produits, "tickets/liste").is_err());
        assert!(check_target(&produits, "produits").is_err());
    }
}
