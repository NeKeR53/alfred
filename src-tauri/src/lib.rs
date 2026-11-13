mod agents;
mod ai;
mod app_db;
mod clients;
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
mod pages;
mod permissions;
mod process_tree;
mod schedules;
mod server;
mod space;
mod space_db;
mod state;
mod transpile;
mod vault;
mod webhooks;
#[cfg(windows)]
mod windows_env;
#[cfg(windows)]
mod windows_job;

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
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::new(&data_dir)?;
            app.manage(state.clone());

            // Les événements du cœur partent vers la fenêtre ; le pont de développement s’y abonne aussi.
            let handle = app.handle().clone();
            let mut events = state.events.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            // Désinstallation avec suppression des données : les tables du module partent avec lui.
                            if event.name == "module:uninstalled"
                                && event.payload.get("deleteData").and_then(Value::as_bool) == Some(true)
                            {
                                let state = handle.state::<Arc<AppState>>();
                                if let (Some(module), Ok(space)) =
                                    (event.payload.get("module").and_then(Value::as_str), state.space())
                                {
                                    if let Err(error) = space_db::drop_module(&space, module) {
                                        log::error!("tables du module {module} non supprimées : {error}");
                                    }
                                }
                            }
                            let _ = handle.emit("alfred:event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });

            tauri::async_runtime::block_on(server::start(state.clone()))?;
            let _runtime = tauri::async_runtime::handle().inner().enter();
            schedules::start(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![alfred_invoke])
        .build(tauri::generate_context!())
        .expect("Alfred n’a pas pu démarrer")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                agents::shutdown();
            }
        });
}
