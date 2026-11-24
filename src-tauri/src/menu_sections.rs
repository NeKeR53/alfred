//! Sections du menu de gauche créées pendant l’usage par un module (`menu.addSection`) : quand une page, ou une
//! fonction de son module, ajoute des entrées au menu pour une notion de l’utilisateur (un projet, un client suivi),
//! elles vont dans une section repliable (`Sidebar.Section`) à leur nom, avec les entrées dessous. La section s’écrit
//! dans l’espace (`alfred.json`, `createdSections`, avec le module d’origine), un commit par changement, et part avec
//! le module. Ses entrées sont une zone du menu (`menu_zones.rs`, clé `section:<module>/<id>`), gardée sur le poste.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, Space};
use crate::state::AppState;

/// Sections qu’un module crée au plus : au-delà, le menu n’en est plus un.
pub const MAX_PER_MODULE: usize = 50;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CreatedSection {
    /// Module qui l’a créée ; elle part avec lui.
    pub module: String,
    /// Identifiant donné par le module (`atlas`), propre au module.
    pub id: String,
    pub title: String,
    /// Page du module ouverte par une entrée qui ne nomme pas la sienne (identifiant de page, `projet`).
    pub page: String,
}

/// Clé de la zone qui porte les entrées d’une section créée.
pub fn zone_key(module: &str, id: &str) -> String {
    format!("section:{module}/{id}")
}

/// Titre d’une section : une ligne, 120 caractères au plus, non vide.
fn clean_title(title: &str) -> AppResult<String> {
    if title.chars().any(char::is_control) {
        return Err(AppError::new("Le titre d’une section tient sur une ligne."));
    }
    let title: String = title.trim().chars().take(120).collect();
    if title.is_empty() {
        return Err(AppError::new("Une section a un titre : le nom de la notion (« Atlas »)."));
    }
    Ok(title)
}

/// Page d’un module, nommée par son identifiant (`projet`) ou sa référence (`projets/projet`).
fn module_page(space: &Space, module: &str, page: &str) -> AppResult<String> {
    let local = page.strip_prefix(&format!("{module}/")).unwrap_or(page);
    if valid_id(local) && space.module(module)?.pages.iter().any(|known| known.id == local) {
        Ok(local.to_string())
    } else {
        Err(AppError::new(format!("« {page} » n’est pas une page du module « {module} ».")))
    }
}

/// Crée la section, ou met à jour son titre (et sa page) si elle existe. Rend vrai si elle est nouvelle.
pub fn add(space: &Space, module: &str, id: &str, title: &str, page: Option<&str>) -> AppResult<bool> {
    if !valid_id(id) {
        return Err(AppError::new(format!(
            "Identifiant de section invalide « {id} » : minuscules, chiffres et tirets (« atlas »)."
        )));
    }
    let title = clean_title(title)?;
    let page = page.map(|page| module_page(space, module, page)).transpose()?;
    let mut manifest = space.manifest()?;
    let sections = &mut manifest.created_sections;
    if let Some(known) = sections.iter_mut().find(|known| known.module == module && known.id == id) {
        known.title = title;
        if let Some(page) = page {
            known.page = page;
        }
        space.write_manifest(&manifest)?;
        return Ok(false);
    }
    if sections.iter().filter(|known| known.module == module).count() >= MAX_PER_MODULE {
        return Err(AppError::new(format!(
            "Le module « {module} » a déjà {MAX_PER_MODULE} sections : retirez-en une (menu.removeSection)."
        )));
    }
    let Some(page) = page else {
        return Err(AppError::new("Une fonction nomme la page qu’ouvrent les entrées : { page: \"projet\" }."));
    };
    sections.push(CreatedSection { module: module.into(), id: id.into(), title, page });
    space.write_manifest(&manifest)?;
    Ok(true)
}

/// Retire la section ; rend son titre, ou `None` si elle n’y était plus.
pub fn remove(space: &Space, module: &str, id: &str) -> AppResult<Option<String>> {
    let mut manifest = space.manifest()?;
    let Some(index) = manifest.created_sections.iter().position(|known| known.module == module && known.id == id)
    else {
        return Ok(None);
    };
    let gone = manifest.created_sections.remove(index);
    space.write_manifest(&manifest)?;
    Ok(Some(gone.title))
}

pub fn list(space: &Space, module: &str) -> AppResult<Vec<CreatedSection>> {
    Ok(space.manifest()?.created_sections.into_iter().filter(|known| known.module == module).collect())
}

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
    let (message, result) = match op.as_str() {
        "list" => return Ok(json!(list(&space, &module)?)),
        "add" => {
            let id: String = arg(args, "id")?;
            let title: String = arg(args, "title")?;
            let page: Option<String> = opt_arg(args, "page")?;
            let created = add(&space, &module, &id, &title, page.as_deref())?;
            let title = title.trim();
            let message = if created {
                format!("Section « {title} » créée par le module {module}")
            } else {
                format!("Section « {title} » du module {module} mise à jour")
            };
            (message, json!(created))
        }
        "remove" => {
            let id: String = arg(args, "id")?;
            let Some(title) = remove(&space, &module, &id)? else { return Ok(json!(false)) };
            // Ses entrées partent avec elle.
            crate::menu_zones::forget(state, &zone_key(&module, &id))?;
            (format!("Section « {title} » retirée par le module {module}"), json!(true))
        }
        other => return Err(AppError::new(format!("Opération de section inconnue : {other}"))),
    };
    crate::git::commit_all(&space.root, &message)?;
    state.emit("space:changed", Value::Null);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::testing::*;
    use crate::space::PlaceTarget;

    fn projets(space: &Space) {
        let menu = PlaceTarget::Menu { label: "Projets".into(), icon: None, color: None };
        space.place_page("Liste", None, "", &menu, None).unwrap();
        let tab = PlaceTarget::Tab { section: "projets/principal".into() };
        space.place_page("Projet", None, "", &tab, Some("projets")).unwrap();
    }

    #[tokio::test]
    async fn a_module_creates_renames_and_removes_its_sections() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        projets(&space);
        assert!(add(&space, "projets", "atlas", "Atlas", Some("projets/projet")).unwrap());
        assert!(add(&space, "projets", "borea", "Boréa", Some("liste")).unwrap());
        // Recréée : le titre change, sans doublon ; la page reste celle donnée.
        assert!(!add(&space, "projets", "atlas", "Projet Atlas", None).unwrap());
        let sections = list(&space, "projets").unwrap();
        assert_eq!(sections.len(), 2);
        assert_eq!((sections[0].title.as_str(), sections[0].page.as_str()), ("Projet Atlas", "projet"));
        assert!(list(&space, "autre").unwrap().is_empty(), "un module ne voit que les siennes");
        assert_eq!(space.snapshot().unwrap().created_sections.len(), 2, "la vue les montre");

        assert_eq!(remove(&space, "projets", "atlas").unwrap().as_deref(), Some("Projet Atlas"));
        assert!(remove(&space, "projets", "atlas").unwrap().is_none());
        assert_eq!(list(&space, "projets").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn invalid_sections_are_refused() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        projets(&space);
        for (id, title, page) in [
            ("Atlas!", "Atlas", Some("projet")),
            ("atlas", "  ", Some("projet")),
            ("atlas", "A\nB", Some("projet")),
            ("atlas", "Atlas", Some("absente")),
            ("atlas", "Atlas", Some("autre/projet")),
            ("atlas", "Atlas", None),
        ] {
            assert!(add(&space, "projets", id, title, page).is_err(), "{id} {title} {page:?}");
        }
        assert!(list(&space, "projets").unwrap().is_empty(), "rien n’est écrit après un refus");
    }

    /// Le module retiré emporte ses sections ; celles d’un autre module restent.
    #[tokio::test]
    async fn sections_leave_with_their_module() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        projets(&space);
        add(&space, "projets", "atlas", "Atlas", Some("projet")).unwrap();
        let mut manifest = space.manifest().unwrap();
        manifest.created_sections.push(CreatedSection {
            module: "autre".into(),
            id: "x".into(),
            title: "X".into(),
            page: "p".into(),
        });
        crate::menu::forget_module(&mut manifest, "projets");
        let left: Vec<_> = manifest.created_sections.iter().map(|section| section.module.as_str()).collect();
        assert_eq!(left, ["autre"]);
    }

    /// Par le pont : un commit par changement ; retirée, la section emporte ses entrées.
    #[tokio::test]
    async fn the_bridge_commits_each_change_and_forgets_the_entries() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        projets(&space);
        crate::git::commit_all(&space.root, "Départ").unwrap();
        let subject = page_subject("projets");
        let added = invoke(
            &state,
            "frame.menuSections.update",
            json!({ "subject": subject, "op": "add", "id": "atlas", "title": "Atlas", "page": "projet" }),
        )
        .await
        .unwrap();
        assert_eq!(added, json!(true));
        let log = crate::git::log(&space.root, 1, None).unwrap();
        assert_eq!(log[0].message.trim(), "Section « Atlas » créée par le module projets");
        invoke(
            &state,
            "frame.menuZones.update",
            json!({ "subject": subject, "page": "section:projets/atlas", "op": "setEntries",
                    "entries": [{ "id": "lot-1", "label": "Lot 1", "page": "liste" }] }),
        )
        .await
        .unwrap();
        // Une section d’un autre module est refusée.
        assert!(invoke(
            &state,
            "frame.menuZones.update",
            json!({ "subject": subject, "page": "section:autre/atlas", "op": "setEntries", "entries": [] }),
        )
        .await
        .is_err());
        let listed = invoke(&state, "frame.menuSections.update", json!({ "subject": subject, "op": "list" })).await.unwrap();
        assert_eq!(listed[0]["page"], json!("projet"));
        let removed =
            invoke(&state, "frame.menuSections.update", json!({ "subject": subject, "op": "remove", "id": "atlas" }))
                .await
                .unwrap();
        assert_eq!(removed, json!(true));
        let zones = invoke(&state, "menuZones.list", json!({})).await.unwrap();
        assert!(zones.get("section:projets/atlas").is_none(), "les entrées partent avec la section");
    }
}
