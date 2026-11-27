//! Fenêtre Agent détachée : la page Agent seule, dans une deuxième fenêtre (`src/features/agent/agentsWindow.ts`).
//! Son libellé commence par celui des fenêtres de page : elle a leurs droits, et se ferme avec la fenêtre principale
//! ou au changement d’espace, comme elles.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;

pub const LABEL: &str = "page-agents";

/// Ouvre la fenêtre Agent détachée, ou la ramène au premier plan.
#[tauri::command]
pub async fn alfred_open_agents_window(app: AppHandle) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Agent — Alfred")
        .inner_size(1000.0, 760.0)
        .min_inner_size(480.0, 360.0)
        // La coquille lit son rôle au démarrage, avant tout script de l’application.
        .initialization_script("window.__ALFRED_AGENTS_WINDOW__ = true;");
    // Mêmes réglages que la fenêtre principale : sous Windows, toutes les vues partagent un environnement WebView2.
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
    let window = builder.build().map_err(|error| AppError::new(format!("La fenêtre Agent n’a pas pu s’ouvrir : {error}")))?;
    crate::webview::harden(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_agents_window_is_a_page_window_without_clashing_with_one() {
        assert!(super::LABEL.starts_with(crate::page_windows::PREFIX));
        // Une page a toujours un module et un nom : son libellé a deux parties après le préfixe.
        assert_ne!(crate::page_windows::label_for("agents/conversations"), super::LABEL);
    }
}
