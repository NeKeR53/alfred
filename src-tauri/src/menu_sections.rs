//! Sections du menu de gauche créées pendant l’usage par une page ou une fonction d’un module (`menu.addSection`) :
//! une notion métier que l’utilisateur crée dans le module (un projet, un client, un chantier) devient une entrée du
//! menu, avec ses onglets et ses entrées. La section s’écrit dans l’espace (`alfred.json`, `layout.menu`, avec le
//! module d’origine) et chaque changement fait un commit ; ses entrées sont une zone du menu (`menu_zones.rs`),
//! gardée sur le poste comme les autres.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::menu::NewSection;
use crate::permissions::Subject;
use crate::state::AppState;

pub async fn handle(state: &AppState, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "frame.menuSections.update" => Some(update(state, args)),
        _ => None,
    }
}

fn update(state: &AppState, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let op: String = arg(args, "op")?;
    let space = state.space()?;
    let module = subject.module.clone();
    if !crate::space::valid_id(&module) {
        return Err(AppError::new("Section refusée : module inconnu."));
    }
    let (message, result) = match op.as_str() {
        "list" => return Ok(json!(space.created_sections(&module)?)),
        "add" => {
            let wanted = NewSection {
                id: arg(args, "id")?,
                title: arg(args, "title")?,
                icon: opt_arg(args, "icon")?,
                pages: opt_arg::<Vec<String>>(args, "pages")?.unwrap_or_default(),
            };
            let accounts: BTreeMap<String, String> = subject.accounts.clone();
            let title = wanted.title.trim().to_string();
            let (reference, created) = space.add_created_section(&module, wanted, &accounts)?;
            let message = if created {
                format!("Section « {title} » créée par le module {module}")
            } else {
                format!("Section « {title} » du module {module} mise à jour")
            };
            (message, json!({ "reference": reference, "created": created }))
        }
        "update" => {
            let id: String = arg(args, "id")?;
            let label =
                space.update_created_section(&module, &id, opt_arg(args, "title")?, opt_arg(args, "icon")?)?;
            (format!("Section « {label} » du module {module} modifiée"), Value::Null)
        }
        "remove" => {
            let id: String = arg(args, "id")?;
            match space.remove_created_section(&module, &id)? {
                // Ses entrées s’en vont avec elle.
                Some((label, tabs)) => {
                    crate::menu_zones::forget_pages(state, &tabs)?;
                    (format!("Section « {label} » retirée par le module {module}"), json!(true))
                }
                None => return Ok(json!(false)),
            }
        }
        other => return Err(AppError::new(format!("Opération de section inconnue : {other}"))),
    };
    crate::git::commit_all(&space.root, &message)?;
    state.emit("space:changed", Value::Null);
    Ok(result)
}
