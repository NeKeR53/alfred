//! Fenêtres de page : une page de l’espace ouverte seule dans sa propre fenêtre, dans le même processus que la
//! fenêtre principale. Elle partage le backend (accords, clients, coffre, journal) ; seule sa coquille diffère.

use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::space::{valid_id, ResolvedPage, Snapshot};
use crate::state::AppState;

/// Préfixe des étiquettes de ces fenêtres ; les capacités (`capabilities/default.json`) l’autorisent.
pub const PREFIX: &str = "page-";

/// Étiquette d’une fenêtre de page : une par page, si bien que la rouvrir ramène la même fenêtre au premier plan.
pub fn label_for(reference: &str) -> String {
    let safe: String =
        reference.chars().map(|character| if character.is_ascii_alphanumeric() { character } else { '-' }).collect();
    format!("{PREFIX}{safe}")
}

/// `module/page`, ou `module/page@instance` pour la copie d’une section par instance.
fn valid_reference(reference: &str) -> bool {
    let (base, instance) = match reference.split_once('@') {
        Some((base, instance)) => (base, Some(instance)),
        None => (reference, None),
    };
    base.split_once('/').is_some_and(|(module, page)| valid_id(module) && valid_id(page))
        && instance.is_none_or(valid_id)
}

/// Titre de la fenêtre : la page et, pour l’onglet d’une section, le nom de la section.
pub fn window_title(snapshot: &Snapshot, reference: &str) -> Option<String> {
    for section in &snapshot.sections {
        if let Some(page) = section.pages.iter().find(|page| page.reference == reference) {
            return Some(if section.pages.len() > 1 || page.title != section.label {
                format!("{} — {}", page.title, section.label)
            } else {
                page.title.clone()
            });
        }
    }
    snapshot.settings_pages.iter().find(|page: &&ResolvedPage| page.reference == reference).map(|page| page.title.clone())
}

/// Ouvre la page dans sa fenêtre, ou ramène au premier plan celle qui l’affiche déjà.
#[tauri::command]
pub async fn alfred_open_window(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    reference: String,
) -> Result<(), AppError> {
    open(&app, &state, &reference)
}

fn open(app: &AppHandle, state: &AppState, reference: &str) -> AppResult<()> {
    if !valid_reference(reference) {
        return Err(AppError::new(format!("Page invalide : « {reference} ». La forme attendue est « module/page ».")));
    }
    let snapshot = state.space()?.snapshot()?;
    let title = window_title(&snapshot, reference)
        .ok_or_else(|| AppError::new(format!("La page « {reference} » n’est pas dans la navigation de l’espace.")))?;
    let label = label_for(reference);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    // La coquille lit sa page au démarrage, avant tout script de l’application.
    let init = format!("window.__ALFRED_PAGE_WINDOW__ = {};", json!({ "reference": reference }));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 360.0)
        .initialization_script(&init);
    // Mêmes réglages que la fenêtre principale : sous Windows, toutes les vues du processus partagent un même
    // environnement WebView2, qui refuse des arguments différents.
    if let Some(main) = app.config().app.windows.first() {
        if let Some(arguments) = &main.additional_browser_args {
            builder = builder.additional_browser_args(arguments);
        }
        if let Some(color) = main.background_color {
            builder = builder.background_color(color);
        }
    }
    let window = builder.build().map_err(|error| AppError::new(format!("La fenêtre n’a pas pu s’ouvrir : {error}")))?;
    crate::webview::harden(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_window_has_one_label_per_page_and_refuses_anything_else() {
        assert_eq!(label_for("jira/tickets@acme"), "page-jira-tickets-acme");
        assert_ne!(label_for("jira/tickets@acme"), label_for("jira/tickets"));
        for valid in ["notes/liste", "jira/tickets@acme"] {
            assert!(valid_reference(valid), "{valid}");
        }
        for invalid in ["notes", "../x/y", "notes/liste@", "notes/liste@../a", "a/b/c", "Notes/Liste"] {
            assert!(!valid_reference(invalid), "{invalid}");
        }
    }
}
