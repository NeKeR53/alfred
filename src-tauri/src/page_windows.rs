//! Fenêtres de page : une page de l’espace ouverte seule dans sa propre fenêtre, dans le même processus que la
//! fenêtre principale. Elle partage le backend (accords, clients, coffre, journal) ; seule sa coquille diffère.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::space::{valid_id, ResolvedPage, Snapshot};
use crate::state::AppState;

/// Préfixe des étiquettes de ces fenêtres ; les capacités (`capabilities/default.json`) l’autorisent.
pub const PREFIX: &str = "page-";

/// Paramètres d’une fenêtre (`shell.openWindow(page, { params })`) : un objet JSON de 16 Kio au plus.
const MAX_PARAMS: usize = 16 * 1024;

/// Étiquette d’une fenêtre de page : une par page, si bien que la rouvrir ramène la même fenêtre au premier plan.
pub fn label_for(reference: &str) -> String {
    let safe: String =
        reference.chars().map(|character| if character.is_ascii_alphanumeric() { character } else { '-' }).collect();
    format!("{PREFIX}{safe}")
}

/// Étiquette d’une fenêtre ouverte sur un élément précis : la page et une empreinte de sa clé. La même clé ramène
/// la même fenêtre ; une autre clé en ouvre une autre.
pub fn keyed_label(reference: &str, key: Option<&str>) -> String {
    match key.filter(|key| !key.is_empty()) {
        None => label_for(reference),
        Some(key) => {
            // FNV-1a : stable d’un lancement à l’autre, sans dépendance.
            let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
            });
            format!("{}-k{hash:016x}", label_for(reference))
        }
    }
}

/// Paramètres vérifiés : un objet, ou rien.
fn checked_params(params: Option<Value>) -> AppResult<Option<Value>> {
    match params {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => {
            if serde_json::to_string(&value)?.len() > MAX_PARAMS {
                return Err(AppError::new("Les paramètres d’une fenêtre font au plus 16 Kio."));
            }
            Ok(Some(value))
        }
        Some(_) => Err(AppError::new("Les paramètres d’une fenêtre sont un objet : { params: { id: \"42\" } }.")),
    }
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
    params: Option<Value>,
    key: Option<String>,
    title: Option<String>,
) -> Result<(), AppError> {
    open(&app, &state, &reference, checked_params(params)?, key, title)
}

/// Ouvre la page dans sa fenêtre, sur un élément précis quand `params` est donné. Sans `key`, la clé est celle des
/// paramètres : rouvrir la même page sur le même élément ramène sa fenêtre.
fn open(
    app: &AppHandle,
    state: &AppState,
    reference: &str,
    params: Option<Value>,
    key: Option<String>,
    title: Option<String>,
) -> AppResult<()> {
    if !valid_reference(reference) {
        return Err(AppError::new(format!("Page invalide : « {reference} ». La forme attendue est « module/page ».")));
    }
    let snapshot = state.space()?.snapshot()?;
    let page_title = window_title(&snapshot, reference)
        .ok_or_else(|| AppError::new(format!("La page « {reference} » n’est pas dans la navigation de l’espace de travail.")))?;
    // Le titre de l’élément précède celui de la page : « Build #42 — Journal CI ».
    let title = match title.as_deref().map(str::trim).filter(|title| !title.is_empty()) {
        Some(item) => format!("{} — {page_title}", item.chars().take(120).collect::<String>()),
        None => page_title,
    };
    let key = key.or_else(|| params.as_ref().map(Value::to_string));
    let label = keyed_label(reference, key.as_deref());
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    // La coquille lit sa page au démarrage, avant tout script de l’application.
    let init = format!(
        "window.__ALFRED_PAGE_WINDOW__ = {};",
        json!({ "reference": reference, "params": params.unwrap_or(Value::Null) })
    );
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
        // Sous Windows, pas de barre native : l’AppShell de Socle dessine réduire, agrandir et fermer
        // (`tauri.windows.conf.json`, D-422 de socle-ui), comme dans la fenêtre principale.
        #[cfg(target_os = "windows")]
        {
            builder = builder.decorations(main.decorations);
        }
        // Sous macOS, la barre de titre est intégrée à la barre du haut de l’AppShell, comme dans la fenêtre principale.
        #[cfg(target_os = "macos")]
        {
            builder = builder.title_bar_style(main.title_bar_style).hidden_title(main.hidden_title);
            if let Some(position) = &main.traffic_light_position {
                builder = builder.traffic_light_position(tauri::LogicalPosition::new(position.x, position.y));
            }
        }
    }
    let window = builder.build().map_err(|error| AppError::new(format!("La fenêtre n’a pas pu s’ouvrir : {error}")))?;
    crate::webview::harden(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tauri.windows.conf.json` remplace toute la liste des fenêtres (fusion JSON de Tauri) : la fenêtre principale
    /// y reste celle de `tauri.conf.json`, sans les réglages propres à macOS, et sans barre native.
    #[test]
    fn the_windows_main_window_is_the_main_window_without_native_decorations() {
        let base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows: Value = serde_json::from_str(include_str!("../tauri.windows.conf.json")).unwrap();
        let mut expected = base["app"]["windows"].clone();
        let main = expected[0].as_object_mut().unwrap();
        for key in ["titleBarStyle", "hiddenTitle", "trafficLightPosition"] {
            main.remove(key);
        }
        main.insert("decorations".into(), Value::Bool(false));
        assert_eq!(windows["app"]["windows"], expected);
        assert_eq!(windows["app"].as_object().unwrap().len(), 1, "seule la liste des fenêtres change sous Windows");
    }

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

    #[test]
    fn a_window_on_an_item_has_its_own_label_per_key() {
        assert_eq!(keyed_label("ci/journal", None), "page-ci-journal");
        assert_eq!(keyed_label("ci/journal", Some("")), "page-ci-journal");
        let build42 = keyed_label("ci/journal", Some("build-42"));
        assert_eq!(build42, keyed_label("ci/journal", Some("build-42")), "même clé, même fenêtre");
        assert_ne!(build42, keyed_label("ci/journal", Some("build-43")));
        assert!(build42.starts_with("page-ci-journal-k"));
        assert!(build42.chars().all(|character| character.is_ascii_alphanumeric() || character == '-'));

        assert_eq!(checked_params(None).unwrap(), None);
        assert_eq!(checked_params(Some(json!({ "build": 42 }))).unwrap(), Some(json!({ "build": 42 })));
        assert!(checked_params(Some(json!([1, 2]))).is_err());
        assert!(checked_params(Some(json!({ "x": "a".repeat(MAX_PARAMS) }))).is_err());
    }
}
