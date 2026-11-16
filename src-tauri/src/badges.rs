//! Compteurs des pages : le nombre qu’une page (ou une fonction de son module) affiche en pastille sur son entrée du
//! menu, par exemple des messages non lus. Un compteur par page (`module/page`, ou `module/page@instance`),
//! conservé par espace dans la base d’Alfred : une page n’est chargée que lorsqu’on l’affiche, son compteur doit
//! donc lui survivre, y compris d’un lancement à l’autre.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::error::{arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::state::AppState;

/// Au-delà, la pastille n’apprend plus rien à personne.
const MAX_COUNT: i64 = 99_999;

pub type Badges = BTreeMap<String, i64>;

pub async fn handle(state: &AppState, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "badges.list" => Some(list(state).map(|badges| json!(badges))),
        "frame.badges.update" => Some(update(state, args)),
        _ => None,
    }
}

fn key(state: &AppState) -> AppResult<String> {
    Ok(format!("badges:{}", state.space()?.root.to_string_lossy()))
}

fn list(state: &AppState) -> AppResult<Badges> {
    if state.try_space().is_none() {
        return Ok(Badges::new());
    }
    let key = key(state)?;
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    Ok(crate::app_db::get_setting(&db, &key)?.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default())
}

/// `set` ou `increment` (qui accepte un pas négatif) ; le compteur ne descend jamais sous zéro.
fn update(state: &AppState, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let page: String = arg(args, "page")?;
    let op: String = arg(args, "op")?;
    let value: i64 = arg(args, "value")?;
    check_target(&subject, &page)?;
    let key = key(state)?;
    let (count, badges) = {
        let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
        let mut badges: Badges = crate::app_db::get_setting(&db, &key)?
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        let count = apply(&mut badges, &page, &op, value)?;
        crate::app_db::set_setting(&db, &key, &if badges.is_empty() { Value::Null } else { json!(badges) })?;
        (count, badges)
    };
    state.emit("badges:changed", json!(badges));
    Ok(json!({ "count": count }))
}

/// Une page ne règle que les compteurs de son module : celui d’une autre page du module, jamais d’un autre module.
fn check_target(subject: &Subject, page: &str) -> AppResult<()> {
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
            "Compteur refusé : « {page} » n’est pas une page du module « {} ».",
            subject.module
        )))
    }
}

fn apply(badges: &mut Badges, page: &str, op: &str, value: i64) -> AppResult<i64> {
    let current = badges.get(page).copied().unwrap_or(0);
    let next = match op {
        "set" => value,
        "increment" => current.saturating_add(value),
        _ => return Err(AppError::new(format!("Opération de compteur inconnue : {op}"))),
    }
    .clamp(0, MAX_COUNT);
    if next == 0 {
        badges.remove(page);
    } else {
        badges.insert(page.to_string(), next);
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(module: &str) -> Subject {
        serde_json::from_value(json!({ "kind": "page", "module": module, "reference": format!("{module}/boite") }))
            .unwrap()
    }

    #[test]
    fn set_increment_and_clear() {
        let mut badges = Badges::new();
        assert_eq!(apply(&mut badges, "mail/boite", "set", 3).unwrap(), 3);
        assert_eq!(apply(&mut badges, "mail/boite", "increment", 2).unwrap(), 5);
        assert_eq!(apply(&mut badges, "mail/boite", "increment", -9).unwrap(), 0);
        assert!(badges.is_empty(), "un compteur à zéro disparaît");
        assert_eq!(apply(&mut badges, "mail/boite", "set", 1_000_000).unwrap(), MAX_COUNT);
        assert!(apply(&mut badges, "mail/boite", "double", 1).is_err());
    }

    #[test]
    fn only_pages_of_the_same_module() {
        let mail = subject("mail");
        assert!(check_target(&mail, "mail/boite").is_ok());
        assert!(check_target(&mail, "mail/boite@pro").is_ok());
        assert!(check_target(&mail, "notes/liste").is_err());
        assert!(check_target(&mail, "mail").is_err());
        assert!(check_target(&mail, "mail/Boite").is_err());
        assert!(check_target(&mail, "mail/boite@").is_err());
    }
}
