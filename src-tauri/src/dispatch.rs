//! Point d’entrée unique des commandes de l’interface. La fenêtre Tauri et le pont de développement passent tous
//! deux par ici, si bien qu’un navigateur de test exerce exactement le même code que l’application.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{PlaceTarget, Space};
use crate::state::AppState;
use crate::{app_db, git};

const LAST_SPACE: &str = "space.last";

pub async fn dispatch(state: Arc<AppState>, command: &str, args: Value) -> AppResult<Value> {
    // Chaque domaine traite ses propres commandes ; le reste relève du socle ci-dessous.
    macro_rules! delegate {
        ($($module:ident),*) => {
            $(if let Some(result) = crate::$module::handle(&state, command, &args).await {
                return result;
            })*
        };
    }
    delegate!(vault, agent_workspace, clients, space_db, backups, module_files, documents, jobs, module_search, module_events, module_history, module_semantic, commands, functions, agents, conversations, mcp, webhooks, schedules, marketplace, permissions, pages, reorganize, composer, voice, badges, setup);
    match command {
        "app.info" => {
            let server = state.server()?;
            Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "serverPort": server.port,
                "pageBase": if cfg!(windows) { "http://alfred-page.localhost" } else { "alfred-page://localhost" },
                "platform": std::env::consts::OS,
                "home": home_dir().map(|path| path.to_string_lossy().to_string()),
            }))
        }
        "ui.waiting" => {
            let name: String = arg(&args, "name")?;
            Ok(Value::Array(state.waiting_ui(&name)))
        }
        "ui.claim" => {
            let id: String = arg(&args, "requestId")?;
            Ok(Value::Bool(state.claim_ui(&id)))
        }
        "ui.resolve" => {
            let id: String = arg(&args, "requestId")?;
            let result = match opt_arg::<String>(&args, "error")? {
                Some(message) => Err(message),
                None => Ok(args.get("result").cloned().unwrap_or(Value::Null)),
            };
            state.resolve_ui(&id, result)?;
            Ok(Value::Null)
        }
        "settings.get" => {
            let key: String = arg(&args, "key")?;
            let db = lock_db(&state)?;
            Ok(app_db::get_setting(&db, &key)?.unwrap_or(Value::Null))
        }
        "settings.set" => {
            let key: String = arg(&args, "key")?;
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            let db = lock_db(&state)?;
            app_db::set_setting(&db, &key, &value)?;
            Ok(Value::Null)
        }

        // Espace
        "space.restore" => {
            let last = {
                let db = lock_db(&state)?;
                app_db::get_setting(&db, LAST_SPACE)?
            };
            match last.as_ref().and_then(Value::as_str).map(PathBuf::from) {
                Some(path) if path.join(crate::space::SPACE_FILE).is_file() => {
                    open_space(&state, &path, None)?;
                    Ok(serde_json::to_value(state.space()?.snapshot()?)?)
                }
                _ => Ok(Value::Null),
            }
        }
        "space.open" => {
            let path: String = arg(&args, "path")?;
            let name: Option<String> = opt_arg(&args, "name")?;
            open_space(&state, &PathBuf::from(path), name.as_deref())?;
            Ok(serde_json::to_value(state.space()?.snapshot()?)?)
        }
        "space.close" => {
            state.set_space(None);
            if let Ok(mut watcher) = state.watcher.lock() {
                *watcher = None;
            }
            let db = lock_db(&state)?;
            app_db::set_setting(&db, LAST_SPACE, &Value::Null)?;
            Ok(Value::Null)
        }
        "space.snapshot" => Ok(serde_json::to_value(state.space()?.snapshot()?)?),
        "space.placePage" => {
            let space = state.space()?;
            let title: String = arg(&args, "title")?;
            let target: PlaceTarget = arg(&args, "target")?;
            let icon: Option<String> = opt_arg(&args, "icon")?;
            let description: Option<String> = opt_arg(&args, "description")?;
            let module: Option<String> = opt_arg(&args, "module")?;
            let placed =
                space.place_page(&title, icon, description.as_deref().unwrap_or(""), &target, module.as_deref())?;
            state.emit("space:changed", Value::Null);
            Ok(serde_json::to_value(placed)?)
        }
        "space.deletePage" => {
            let space = state.space()?;
            let reference: String = arg(&args, "reference")?;
            space.delete_page(&reference)?;
            crate::permissions::forget_page(&state, &reference)?;
            commit(&space, &format!("Suppression de la page {reference}"))?;
            state.emit("space:changed", Value::Null);
            Ok(Value::Null)
        }
        "space.updateLayout" => {
            let space = state.space()?;
            let mut manifest = space.manifest()?;
            if let Some(layout) = opt_arg(&args, "layout")? {
                manifest.layout = layout;
            }
            if let Some(name) = opt_arg::<String>(&args, "name")? {
                manifest.name = name;
            }
            if args.get("accent").is_some() {
                manifest.accent = opt_arg(&args, "accent")?;
            }
            space.write_manifest(&manifest)?;
            let message: Option<String> = opt_arg(&args, "message")?;
            commit(&space, message.as_deref().unwrap_or("Réorganisation de la navigation"))?;
            state.emit("space:changed", Value::Null);
            Ok(serde_json::to_value(space.snapshot()?)?)
        }
        "space.commit" => {
            let space = state.space()?;
            let message: String = arg(&args, "message")?;
            Ok(json!({ "commit": commit(&space, &message)? }))
        }
        "space.history" => {
            let space = state.space()?;
            let limit: Option<usize> = opt_arg(&args, "limit")?;
            let path: Option<String> = opt_arg(&args, "path")?;
            Ok(serde_json::to_value(git::log(&space.root, limit.unwrap_or(50), path.as_deref())?)?)
        }
        "space.commits" => {
            let space = state.space()?;
            let ids: Vec<String> = arg(&args, "ids")?;
            Ok(serde_json::to_value(git::commits(&space.root, &ids)?)?)
        }
        "space.undo" => {
            let space = state.space()?;
            let id: String = arg(&args, "commit")?;
            if git::has_changes(&space.root)? {
                commit(&space, "Modifications en cours avant annulation")?;
            }
            let reverted = git::revert(&space.root, &id)?;
            state.emit("space:changed", Value::Null);
            Ok(json!({ "commit": reverted }))
        }
        _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
    }
}

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn commit(space: &Space, message: &str) -> AppResult<Option<String>> {
    git::commit_all(&space.root, message)
}

/// Ouvre (ou crée) l’espace, le mémorise pour le prochain lancement et surveille son dossier : toute écriture de
/// l’agent recharge la navigation et les pages affichées.
fn open_space(state: &Arc<AppState>, path: &std::path::Path, name: Option<&str>) -> AppResult<()> {
    use notify::Watcher;

    let space = Space::open_or_create(path, name)?;
    crate::docs::materialize(&space)?;
    // La copie du jour passe avant les migrations en attente, qui feraient sinon la leur.
    if let Err(error) = crate::backups::ensure_daily(&space) {
        log::error!("sauvegarde quotidienne impossible : {}", error.message);
    }
    // Les migrations écrites pendant qu’Alfred était fermé passent dès l’ouverture : les pages trouvent leurs tables.
    // Une migration en échec n’empêche pas d’ouvrir l’espace ; `check` la signale.
    if let Err(error) = crate::space_db::apply_migrations(&space) {
        log::error!("migrations non appliquées à l’ouverture : {}", error.message);
    }
    git::commit_all(&space.root, "Ouverture de l’espace")?;
    // Les tâches de fond interrompues à la fermeture reprennent.
    crate::jobs::kick();
    crate::module_events::kick();
    let root = space.root.clone();
    state.set_space(Some(space));
    {
        let db = lock_db(state)?;
        app_db::set_setting(&db, LAST_SPACE, &Value::String(root.to_string_lossy().to_string()))?;
    }

    let watched = Arc::downgrade(state);
    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let relevant = event.paths.iter().any(|path| {
            path.strip_prefix(&watch_root).is_ok_and(|relative| {
                !relative.starts_with(".git") && !relative.starts_with(crate::space::LOCAL_DIR)
            })
        });
        if relevant {
            if let Some(state) = watched.upgrade() {
                state.emit("space:changed", Value::Null);
            }
        }
    })
    .map_err(|error| AppError::new(format!("Surveillance du dossier impossible : {error}")))?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|error| AppError::new(format!("Surveillance du dossier impossible : {error}")))?;
    if let Ok(mut current) = state.watcher.lock() {
        *current = Some(watcher);
    }
    Ok(())
}
