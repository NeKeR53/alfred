//! Point d’entrée unique des commandes de l’interface. La fenêtre Tauri et le pont de développement passent tous
//! deux par ici, si bien qu’un navigateur de test exerce exactement le même code que l’application.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{PlaceTarget, Space};
use crate::state::AppState;
use crate::{app_db, git};

const LAST_SPACE: &str = "space.last";

/// Vue de l’espace pour l’interface, avec les réglages du poste qui la complètent (données d’exemple).
fn ui_snapshot(state: &AppState, space: &Space) -> AppResult<Value> {
    let mut snapshot = space.snapshot()?;
    snapshot.examples = crate::examples::modules(state);
    Ok(serde_json::to_value(snapshot)?)
}

pub async fn dispatch(state: Arc<AppState>, command: &str, args: Value) -> AppResult<Value> {
    // Chaque domaine traite ses propres commandes ; le reste relève du socle ci-dessous.
    macro_rules! delegate {
        ($($module:ident),*) => {
            $(if let Some(result) = crate::$module::handle(&state, command, &args).await {
                return result;
            })*
        };
    }
    if let Some(result) = crate::code_mode::handle_command(&state, command, &args).await {
        return result;
    }
    if let Some(result) = crate::python::env::handle(&state, command, &args).await {
        return result;
    }
    if let Some(result) = crate::python::objects::handle(&state, command, &args).await {
        return result;
    }
    delegate!(vault, agent_workspace, examples, clients, states, space_db, function_tests, backups, module_files, folders, folder_git, documents, jobs, module_search, module_events, module_history, module_semantic, decisions, model_files, commands, functions, agents, conversations, mcp, webhooks, schedules, automations, marketplace, permissions, pages, reorganize, composer, voice, badges, menu_sections, menu_zones, setup, team_sync, spaces);
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
                    ui_snapshot(&state, &state.space()?)
                }
                _ => Ok(Value::Null),
            }
        }
        "space.open" => {
            let path: String = arg(&args, "path")?;
            let name: Option<String> = opt_arg(&args, "name")?;
            // Un espace de la liste des récents : son dossier doit encore en être un, sans quoi on en créerait un vide.
            let existing: Option<bool> = opt_arg(&args, "existing")?;
            let path = PathBuf::from(path);
            if existing == Some(true) && !path.join(crate::space::SPACE_FILE).is_file() {
                return Err(AppError::new(format!(
                    "Le dossier {} n’est plus un espace de travail : il a été déplacé ou supprimé. Retirez-le de la liste dans Réglages › Général.",
                    path.display()
                )));
            }
            open_space(&state, &path, name.as_deref())?;
            ui_snapshot(&state, &state.space()?)
        }
        "space.close" => {
            if state.try_space().is_some() {
                state.emit("space:switched", Value::Null);
            }
            state.set_space(None);
            if let Ok(mut watcher) = state.watcher.lock() {
                *watcher = None;
            }
            let db = lock_db(&state)?;
            app_db::set_setting(&db, LAST_SPACE, &Value::Null)?;
            Ok(Value::Null)
        }
        "space.snapshot" => ui_snapshot(&state, &state.space()?),
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
            let before = manifest.layout.clone();
            if let Some(layout) = opt_arg::<crate::space::Layout>(&args, "layout")? {
                // Les pages de l’utilisateur ne se changent que par `space.menu.*` : la coquille ne les renvoie pas.
                space.persist_menu()?;
                let stored = space.manifest()?.layout;
                manifest.layout =
                    crate::space::Layout { menu: stored.menu, menu_templates: stored.menu_templates, ..layout };
            }
            if let Some(name) = opt_arg::<String>(&args, "name")? {
                manifest.name = name;
            }
            if args.get("accent").is_some() {
                manifest.accent = opt_arg(&args, "accent")?;
            }
            space.write_manifest(&manifest)?;
            space.apply_placements(&before)?;
            let message: Option<String> = opt_arg(&args, "message")?;
            commit(&space, message.as_deref().unwrap_or("Réorganisation de la navigation"))?;
            state.emit("space:changed", Value::Null);
            ui_snapshot(&state, &space)
        }
        "space.menu.addPage" | "space.menu.addTab" | "space.menu.configure" | "space.menu.remove"
        | "space.menu.move" | "space.menu.moveTab" => {
            let space = state.space()?;
            ensure_shown_space(&space, &args)?;
            let (message, created) = menu_command(&space, command, &args)?;
            // Le compte d’un autre service, choisi ici par l’utilisateur : les fonctions du module y ont accès.
            grant_chosen_accounts(&state, &space, &args)?;
            commit(&space, &message)?;
            state.emit("space:changed", Value::Null);
            let mut snapshot = ui_snapshot(&state, &space)?;
            if let (Some(created), Some(object)) = (created, snapshot.as_object_mut()) {
                object.insert("created".into(), Value::String(created));
            }
            Ok(snapshot)
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

/// Comptes choisis pour une page, du service du besoin (`instance`) ou d’un autre service du même type
/// (`client/instance`) : le choix de l’utilisateur vaut accord pour les fonctions du module qui sert ce besoin, sans
/// demande d’accès à part au premier appel de la page. Seule l’interface passe ici, jamais l’agent.
fn grant_chosen_accounts(state: &AppState, space: &Space, args: &Value) -> AppResult<()> {
    let mut chosen: Vec<(String, String, String)> = Vec::new();
    let mut collect = |page: Option<&str>, accounts: Option<&Value>| {
        let module = page.and_then(|page| page.split('/').next()).unwrap_or_default().to_string();
        for (need, value) in accounts.and_then(Value::as_object).into_iter().flatten() {
            let Some(value) = value.as_str() else { continue };
            let client = match value.split_once('/') {
                Some((client, _)) => Some(client.to_string()),
                None => crate::clients::client_for(space, &module, need).ok().map(|client| client.id),
            };
            if let Some(client) = client {
                chosen.push((module.clone(), need.clone(), client));
            }
        }
    };
    for tab in args.get("tabs").and_then(Value::as_array).into_iter().flatten() {
        collect(tab.get("page").and_then(Value::as_str), tab.get("accounts"));
    }
    if let Some(tab) = args.get("tab") {
        collect(tab.get("page").and_then(Value::as_str), tab.get("accounts"));
    }
    if args.get("accounts").is_some() {
        let target: String = arg(args, "target")?;
        let template = space
            .snapshot()?
            .sections
            .iter()
            .flat_map(|section| section.pages.iter())
            .find(|page| page.reference == target)
            .map(|page| page.template.clone());
        collect(template.as_deref(), args.get("accounts"));
    }
    let key = space.root.to_string_lossy().to_string();
    let db = lock_db(state)?;
    for (module, need, client) in chosen {
        // Un besoin d’une dépendance (`dép/besoin`) est servi par les fonctions de ce module-là.
        let owner = need.split_once('/').map(|(owner, _)| owner.to_string()).unwrap_or(module);
        app_db::grant(&db, &key, &format!("function:{owner}/*"), &format!("client:{client}"))?;
    }
    Ok(())
}

/// L’espace que montrait la fenêtre (`space`, son dossier) doit être celui qui est ouvert : un autre, ouvert entre-temps
/// ailleurs, recevrait sinon une écriture pensée pour le premier.
pub fn ensure_shown_space(space: &Space, args: &Value) -> AppResult<()> {
    let Some(shown) = opt_arg::<String>(args, "space")? else { return Ok(()) };
    if Path::new(&shown) == space.root.as_path() {
        return Ok(());
    }
    Err(AppError::new(format!(
        "Un autre espace de travail est ouvert ({}) : rien n’a été écrit. Rechargez la fenêtre (Cmd+R).",
        space.root.display()
    )))
}

/// Pages de l’utilisateur : l’opération demandée, le message du commit et, pour un ajout, l’identifiant créé.
pub fn menu_command(space: &Space, command: &str, args: &Value) -> AppResult<(String, Option<String>)> {
    use crate::menu::NewTab;
    match command {
        "space.menu.addPage" => {
            let section: String = arg(args, "section")?;
            let tabs: Vec<NewTab> = arg(args, "tabs")?;
            let label: Option<String> = opt_arg(args, "label")?;
            let id = space.add_menu_page(&section, tabs, label.clone(), opt_arg(args, "icon")?)?;
            Ok((format!("Page {} ajoutée", label.unwrap_or_else(|| id.clone())), Some(id)))
        }
        "space.menu.addTab" => {
            let page: String = arg(args, "page")?;
            let tab: NewTab = arg(args, "tab")?;
            let id = space.add_menu_tab(&page, tab)?;
            Ok((format!("Onglet {id} ajouté à la page {page}"), Some(id)))
        }
        "space.menu.configure" => {
            let target: String = arg(args, "target")?;
            space.configure_menu_item(&target, opt_arg(args, "label")?, opt_arg(args, "icon")?, opt_arg(args, "accounts")?)?;
            Ok((format!("Page {target} modifiée"), None))
        }
        "space.menu.remove" => {
            let target: String = arg(args, "target")?;
            space.remove_menu_item(&target)?;
            Ok((format!("Page {target} retirée du menu"), None))
        }
        "space.menu.move" => {
            let target: String = arg(args, "target")?;
            space.move_menu_item(&target, arg(args, "delta")?)?;
            Ok((format!("Page {target} déplacée"), None))
        }
        "space.menu.moveTab" => {
            let tab: String = arg(args, "tab")?;
            let to: String = arg(args, "to")?;
            space.move_menu_tab(&tab, &to)?;
            Ok((format!("Onglet {tab} déplacé vers {to}"), None))
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

    crate::marketplace::refuse_as_workspace(state, path)?;
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
    // Les services restés après la suppression de leur module (avant que le retrait ne les emporte) s’en vont.
    if let Err(error) = crate::clients::forget_unused(state, &space) {
        log::error!("services sans module non retirés : {}", error.message);
    }
    git::commit_all(&space.root, "Ouverture de l’espace de travail")?;
    // Une seule écriture du menu, ici, dans son propre commit : un espace d’avant les pages de l’utilisateur reprend
    // son menu tel qu’il s’affichait ; ailleurs, les modèles nouveaux y entrent une fois.
    let migrating = space.manifest().map(|manifest| manifest.layout.menu.is_none()).unwrap_or(false);
    match space.persist_menu() {
        Ok(true) => {
            let message =
                if migrating { "Menu repris en pages personnalisables" } else { "Pages nouvelles ajoutées au menu" };
            git::commit_all(&space.root, message)?;
        }
        Ok(false) => {}
        Err(error) => log::error!("menu non repris : {}", error.message),
    }
    // Les tâches de fond et les livraisons d’événements interrompues à la fermeture reprennent.
    crate::jobs::kick();
    crate::module_events::kick();
    let root = space.root.clone();
    let previous = state.try_space().map(|space| space.root);
    state.set_space(Some(space));
    if previous.is_some_and(|previous| previous != root) {
        state.emit("space:switched", json!({ "path": root.to_string_lossy() }));
    }
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
        // Un fichier `.py` d’un module a changé : son noyau Python redémarre.
        crate::python::kernel::kernels().files_changed(&event.paths);
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
