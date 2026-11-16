//! Notifications du système pour `shell.notify`. Tant qu’une fenêtre d’Alfred est au premier plan, la notification
//! reste dans Alfred (surimpression et centre de notifications) : l’utilisateur la voit déjà. Quand Alfred est en
//! arrière-plan, elle part aussi au centre de notifications du système, après la permission de celui-ci.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::{NotificationExt, PermissionState};

use crate::error::{AppError, AppResult};

/// Envoie la notification au système si aucune fenêtre d’Alfred n’a le focus ; dit si elle est partie.
#[tauri::command]
pub async fn alfred_notify_system(app: AppHandle, title: String, body: Option<String>) -> Result<bool, AppError> {
    if any_window_focused(&app) {
        return Ok(false);
    }
    show(&app, &title, body.as_deref())
}

fn any_window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.webview_windows().values().any(|window| window.is_focused().unwrap_or(false))
}

fn show<R: Runtime>(app: &AppHandle<R>, title: &str, body: Option<&str>) -> AppResult<bool> {
    let notifications = app.notification();
    let failed = |error: tauri_plugin_notification::Error| {
        AppError::new(format!("La notification du système n’a pas pu partir : {error}"))
    };
    let mut permission = notifications.permission_state().map_err(failed)?;
    if matches!(permission, PermissionState::Prompt | PermissionState::PromptWithRationale) {
        permission = notifications.request_permission().map_err(failed)?;
    }
    if permission != PermissionState::Granted {
        // Refusée dans les réglages du système : la notification reste dans Alfred.
        return Ok(false);
    }
    let title = clip(title, 120);
    let mut builder = notifications.builder().title(if title.is_empty() { "Alfred" } else { &title });
    if let Some(body) = body.filter(|body| !body.trim().is_empty()) {
        builder = builder.body(clip(body, 400));
    }
    builder.show().map_err(failed)?;
    Ok(true)
}

/// Coupe un texte trop long au dernier caractère entier.
fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max - 1).collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use super::clip;

    #[test]
    fn clips_long_texts() {
        assert_eq!(clip("  Bonjour ", 10), "Bonjour");
        assert_eq!(clip("éééééé", 4), "ééé…");
    }
}
