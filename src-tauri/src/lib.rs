mod agent_setup;
mod agents;
mod app_db;
mod badges;
mod clients;
mod composer;
mod conversations;
mod dispatch;
mod docs;
mod error;
mod events;
mod functions;
mod git;
mod marketplace;
mod mcp;
mod oauth;
mod page_windows;
mod pages;
mod permissions;
mod process_tree;
mod reorganize;
mod schedules;
mod scripts;
mod server;
mod setup;
mod space;
mod space_db;
mod state;
mod system_notifications;
mod transpile;
mod vault;
#[cfg(feature = "verify")]
mod verify;
mod voice;
mod webhooks;
mod webview;
#[cfg(windows)]
mod windows_env;

use std::sync::Arc;

use serde_json::Value;
use tauri::{Emitter, Manager};

use error::AppError;
use state::AppState;

#[tauri::command]
async fn alfred_invoke(
    state: tauri::State<'_, Arc<AppState>>,
    command: String,
    args: Option<Value>,
) -> Result<Value, AppError> {
    dispatch::dispatch(state.inner().clone(), &command, args.unwrap_or(Value::Null)).await
}

/// Lance un agent dont les sorties arrivent par `on_event`, un canal propre à la session (voir `agents::Output`).
#[tauri::command]
async fn alfred_agent_spawn(
    state: tauri::State<'_, Arc<AppState>>,
    args: Value,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<Value, AppError> {
    agents::spawn(state.inner(), &args, agents::Output::Channel(on_event))
}

/// Réaction du cœur à ses propres événements, avant leur envoi à la fenêtre.
fn on_core_event(state: &AppState, event: &events::AppEvent) {
    // Désinstallation avec suppression des données : les tables du module partent avec lui.
    if event.name == "module:uninstalled" && event.payload.get("deleteData").and_then(Value::as_bool) == Some(true) {
        if let (Some(module), Ok(space)) = (event.payload.get("module").and_then(Value::as_str), state.space()) {
            if let Err(error) = space_db::drop_module(&space, module) {
                log::error!("tables du module {module} non supprimées : {error}");
            }
        }
    }
}

/// Commandes de la fenêtre ; le banc de vérification ajoute la sienne, absente des versions normales.
#[cfg(not(feature = "verify"))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        alfred_invoke,
        alfred_agent_spawn,
        page_windows::alfred_open_window,
        system_notifications::alfred_notify_system
    ]
}

#[cfg(feature = "verify")]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        alfred_invoke,
        alfred_agent_spawn,
        page_windows::alfred_open_window,
        system_notifications::alfred_notify_system,
        verify::verify_result
    ]
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_uri_scheme_protocol("alfred-page", |context, request| {
            let state = context.app_handle().state::<Arc<AppState>>();
            let origin = if cfg!(windows) { "http://alfred-page.localhost" } else { "alfred-page:" };
            let page = pages::respond(&state, request.uri().path(), "", origin);
            let mut response = tauri::http::Response::builder()
                .status(page.status)
                .header("Content-Type", page.content_type)
                .header("Cache-Control", "no-store")
                .header("Access-Control-Allow-Origin", "*");
            if let Some(csp) = &page.csp {
                response = response.header("Content-Security-Policy", csp);
            }
            response.body(page.body).unwrap_or_default()
        })
        .setup(|app| {
            // Avant tout chargement de page : aucun document de la fenêtre n’a WebRTC.
            if let Some(window) = app.get_webview_window("main") {
                webview::harden(&window);
            }
            let data_dir = app.path().app_data_dir()?;
            vault::init(&data_dir);
            let state = AppState::new(&data_dir)?;
            app.manage(state.clone());
            // La voix d’Alfred se charge pendant que la fenêtre s’ouvre.
            {
                let state = state.clone();
                tauri::async_runtime::spawn(async move { voice::preload(state) });
            }

            // Les événements du cœur partent vers la fenêtre ; le pont de développement s’y abonne aussi.
            let handle = app.handle().clone();
            let mut events = state.events.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            on_core_event(&handle.state::<Arc<AppState>>(), &event);
                            let _ = handle.emit("alfred:event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });

            tauri::async_runtime::block_on(server::start(state.clone()))?;
            #[cfg(feature = "verify")]
            verify::attach(app.handle(), &data_dir, state.server()?.port)?;
            let _runtime = tauri::async_runtime::handle().inner().enter();
            schedules::start(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer la fenêtre principale ferme ses fenêtres de page : sans elle, rien ne permet d’en rouvrir une
            // ni de changer d’espace.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                for (label, page) in window.app_handle().webview_windows() {
                    if label.starts_with(page_windows::PREFIX) {
                        let _ = page.close();
                    }
                }
            }
        })
        .invoke_handler(handlers())
        .build(tauri::generate_context!())
        .expect("Alfred n’a pas pu démarrer")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                agents::shutdown();
            }
        });
}

/// Accès réservé aux tests d’intégration (`src-tauri/tests/`) : le cœur d’Alfred sans la fenêtre Tauri. Rien ici ne
/// change le comportement de l’application ; ces fonctions assemblent ce que `run` assemble, sur un port libre.
#[doc(hidden)]
pub mod testing {
    use std::sync::Arc;

    pub use crate::dispatch::dispatch;
    pub use crate::error::{AppError, AppResult};
    pub use crate::events::AppEvent;
    pub use crate::state::AppState;

    /// Démarre les routes HTTP locales (outils MCP, webhooks, retour OAuth) sur un port libre et le déclare, comme
    /// `server::start`, sans prendre le port fixe de l’instance de développement.
    pub async fn start_server(state: &Arc<AppState>) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("port local libre");
        let port = listener.local_addr().expect("adresse locale").port();
        let _ = state.server.set(crate::state::ServerInfo { port });
        let router = axum::Router::new()
            .merge(crate::clients::routes())
            .merge(crate::mcp::routes())
            .merge(crate::webhooks::routes())
            .with_state(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        port
    }

    /// Abonne le cœur à ses propres événements, comme le fait `run` (suppression des tables d’un module désinstallé).
    pub fn start_core_events(state: &Arc<AppState>) {
        let mut events = state.events.subscribe();
        let state = Arc::downgrade(state);
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => match state.upgrade() {
                        Some(state) => super::on_core_event(&state, &event),
                        None => break,
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
    }

    /// Lance la boucle de planification, comme au démarrage d’Alfred.
    pub fn start_schedules(state: &Arc<AppState>) {
        crate::schedules::start(state.clone());
    }

    /// Réponse du protocole `alfred-page` à un chemin, telle que la reçoit un cadre isolé.
    pub struct Page {
        pub status: u16,
        pub content_type: &'static str,
        pub csp: Option<String>,
        pub body: String,
    }

    pub fn page(state: &AppState, path: &str) -> Page {
        let page = crate::pages::respond(state, path, "", "alfred-page:");
        Page {
            status: page.status,
            content_type: page.content_type,
            csp: page.csp,
            body: String::from_utf8_lossy(&page.body).into_owned(),
        }
    }

    /// Remet un jeton d’outils à une conversation, comme le fait le lancement d’un agent.
    pub fn register_agent(state: &AppState, token: &str, conversation: &str) {
        if let Ok(mut tokens) = state.agent_tokens.lock() {
            tokens.insert(token.to_string(), conversation.to_string());
        }
    }
}
