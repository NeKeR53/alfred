//! Objets Python appelables depuis une page : commandes `frame.python.*` (pont des cadres) et `python.*` (coquille).
//!
//! Une page crée un objet d’une classe de `python/` (`python.create("analyse.Graphe", { source })`) et reçoit une
//! poignée ; elle appelle ensuite ses méthodes (`python.call`), une fonction libre (`python.run`), le libère
//! (`python.dispose`). Les objets d’un cadre sont libérés quand il se ferme (`frame.python.release`). Tout passe par
//! le noyau du module (`kernel.rs`) ; un module n’atteint que le sien.
//!
//! Avancement et flux : la page ouvre un canal (`frame.python.channel`) et le passe à l’appel ; ce que le code
//! Python annonce (`alfred_kernel.progress`, `alfred_kernel.emit`, ou chaque `yield` d’une méthode génératrice) y
//! arrive comme un événement `data` (`event` vaut `progress` ou `data`) ; le canal se ferme à la fin de l’appel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use super::kernel::{self, Kernel, Launch, ObjectInfo};
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::scripts;
use crate::state::AppState;

/// Objets vivants d’un module, toutes pages confondues.
const MAX_OBJECTS: usize = 500;

/// Canaux d’avancement ouverts par `frame.python.channel` → module qui les a ouverts.
fn progress_channels() -> &'static Mutex<HashMap<String, String>> {
    static CHANNELS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CHANNELS.get_or_init(Default::default)
}

/// Délai d’un appel, en secondes (`timeout`), entre 1 s et une heure ; 120 s par défaut.
fn timeout(args: &Value) -> AppResult<Duration> {
    match opt_arg::<f64>(args, "timeout")? {
        None => Ok(kernel::DEFAULT_TIMEOUT),
        Some(seconds) if seconds.is_finite() && seconds > 0.0 => {
            Ok(Duration::from_secs_f64(seconds).clamp(Duration::from_secs(1), kernel::MAX_TIMEOUT))
        }
        Some(_) => Err(AppError::new("`timeout` est un nombre de secondes positif (120 par défaut).")),
    }
}

fn module_dir(state: &AppState, module: &str) -> AppResult<PathBuf> {
    let space = state.space()?;
    space.module(module)?;
    Ok(space.module_dir(module))
}

/// Noyau du module, démarré si besoin.
pub async fn kernel_for(state: &Arc<AppState>, module: &str) -> AppResult<Arc<Kernel>> {
    let dir = module_dir(state, module)?;
    let state = state.clone();
    let module = module.to_string();
    let started = tokio::task::spawn_blocking(move || {
        let mut launched = false;
        let result = kernel::kernels().get_or_start(&dir, || {
            launched = true;
            let space = state.space()?;
            let interpreter = kernel::interpreter(&state, &space, &module)?;
            let (env, keep) = kernel::environment(&state, &space, &module)?;
            Ok(Launch { module: module.clone(), module_dir: dir.clone(), interpreter, env, keep })
        });
        if launched {
            match &result {
                Ok(kernel) => crate::functions::journal(
                    &state,
                    "python",
                    &format!("{module}/python"),
                    true,
                    None,
                    &format!("Noyau Python {} démarré", kernel.python()),
                    Some(&json!({ "pid": kernel.pid, "interpreter": kernel.program.to_string_lossy() })),
                ),
                Err(error) => crate::functions::journal(
                    &state,
                    "python",
                    &format!("{module}/python"),
                    false,
                    None,
                    &format!("Noyau Python non démarré : {}", error.message),
                    error.detail.as_ref(),
                ),
            }
        }
        result
    })
    .await
    .map_err(|_| AppError::new("Le démarrage du noyau Python a été interrompu."))?;
    started
}

/// Envoie une requête au noyau et note au journal du module ce que le code a écrit (`print`) et les échecs.
async fn request(
    state: &Arc<AppState>,
    kernel: &Kernel,
    what: &str,
    message: Value,
    timeout: Duration,
    channel: Option<String>,
) -> AppResult<Value> {
    let started = std::time::Instant::now();
    let events: Option<kernel::Events> = channel.clone().map(|channel| -> kernel::Events {
        Box::new(move |kind, data| {
            // Toujours du JSON : un texte envoyé par `emit("…")` arrive entre guillemets.
            crate::channels::push(&channel, json!({ "type": "data", "event": kind, "data": data.to_string() }));
        })
    });
    let result = kernel.request(message, timeout, events).await;
    if let Some(channel) = &channel {
        match &result {
            Ok(_) => crate::channels::finish(channel, "terminé", false),
            Err(error) => crate::channels::finish(channel, &error.message, true),
        }
        if let Ok(mut channels) = progress_channels().lock() {
            channels.remove(channel);
        }
    }
    let output = kernel.take_output();
    if result.is_err() || !output.is_empty() {
        let duration = Some(started.elapsed().as_millis() as u64);
        let mut detail = json!({ "stderr": output.join("\n") });
        let summary = match &result {
            Ok(_) => format!("{what} : sortie du code Python"),
            Err(error) => {
                if let Some(python) = error.detail.as_ref().and_then(|detail| detail.get("python")) {
                    detail["python"] = python.clone();
                }
                format!("{what} : échec : {}", error.message)
            }
        };
        crate::functions::journal(state, "python", &format!("{}/python", kernel.module), result.is_ok(), duration, &summary, Some(&detail));
    }
    result
}

/// Le canal passé à un appel : ouvert par `frame.python.channel` pour ce module.
fn owned_channel(subject: &Subject, args: &Value) -> AppResult<Option<String>> {
    let Some(channel) = opt_arg::<String>(args, "channel")? else { return Ok(None) };
    let owner = progress_channels().lock().ok().and_then(|channels| channels.get(&channel).cloned());
    if owner.as_deref() != Some(subject.module.as_str()) {
        return Err(AppError::new(format!(
            "Le canal « {channel} » n’est pas un canal d’avancement de ce module : ouvrez-le avec python.channel()."
        )));
    }
    Ok(Some(channel))
}

/// L’objet doit vivre dans le noyau actuel : un noyau redémarré (fichier changé, inactivité, délai) l’a perdu.
fn known_object(kernel: &Kernel, handle: &str) -> AppResult<ObjectInfo> {
    kernel.objects.lock().ok().and_then(|objects| objects.get(handle).cloned()).ok_or_else(|| {
        AppError::with_detail(
            format!(
                "L’objet Python « {handle} » n’existe plus : le noyau du module a redémarré depuis sa création (fichier .py changé, inactivité ou délai dépassé), ou l’objet a été libéré. Recréez-le avec python.create."
            ),
            json!({ "code": "objectLost" }),
        )
    })
}

/// Libère les objets tenus par un cadre qui se ferme ; rend leur nombre.
pub async fn release(state: &Arc<AppState>, module: &str, holder: &str) -> usize {
    let Ok(dir) = module_dir(state, module) else { return 0 };
    let Some(kernel) = kernel::kernels().running(&dir) else { return 0 };
    let handles: Vec<String> = match kernel.objects.lock() {
        Ok(mut objects) => {
            let handles: Vec<String> =
                objects.iter().filter(|(_, info)| info.holder == holder).map(|(handle, _)| handle.clone()).collect();
            for handle in &handles {
                objects.remove(handle);
            }
            handles
        }
        Err(_) => return 0,
    };
    for handle in &handles {
        let _ = kernel.request(json!({ "op": "dispose", "handle": handle }), Duration::from_secs(10), None).await;
    }
    let _ = kernel.take_output();
    handles.len()
}

/// Fonction du module en `runtime: "python"` avec `kernel: true` : `main(input)` de son fichier, dans le noyau.
pub async fn run_function(state: &Arc<AppState>, module: &str, file: &std::path::Path, input: Value) -> AppResult<Value> {
    if !file.is_file() {
        return Err(AppError::new("La fonction n’est pas encore écrite."));
    }
    let kernel = kernel_for(state, module).await?;
    let message = json!({ "op": "main", "path": file.to_string_lossy(), "args": input });
    let name = file.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_default();
    request(state, &kernel, &format!("fonction {name}"), message, scripts::TIMEOUT, None).await
}

/// État du noyau d’un module, pour la page (`python.status`) et la coquille.
fn status(state: &AppState, module: &str) -> AppResult<Value> {
    let dir = module_dir(state, module)?;
    let idle_limit = kernel::IDLE.as_secs();
    let Some(kernel) = kernel::kernels().running(&dir) else {
        return Ok(json!({ "running": false, "idleLimitSeconds": idle_limit }));
    };
    let objects: Vec<Value> = kernel
        .objects
        .lock()
        .map(|objects| {
            objects
                .iter()
                .map(|(handle, info)| {
                    json!({ "handle": handle, "class": info.class, "holder": info.holder, "ageSeconds": info.created.elapsed().as_secs() })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "running": true,
        "python": kernel.python(),
        "pid": kernel.pid,
        "interpreter": kernel.program.to_string_lossy(),
        "uptimeSeconds": kernel.started.elapsed().as_secs(),
        "idleSeconds": kernel.idle_for().as_secs(),
        "busy": kernel.busy(),
        "objects": objects,
        "idleLimitSeconds": idle_limit,
    }))
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("frame.python.") && !command.starts_with("python.") {
        return None;
    }
    Some(handle_command(state, command, args).await)
}

async fn handle_command(state: &Arc<AppState>, command: &str, args: &Value) -> AppResult<Value> {
    // Commandes de la coquille et de l’agent : un module nommé.
    match command {
        "python.status" => return status(state, &arg::<String>(args, "module")?),
        "python.restart" => {
            let module: String = arg(args, "module")?;
            let stopped = kernel::kernels().stop(&module_dir(state, &module)?, "Le noyau Python du module a été redémarré à la demande.");
            return Ok(json!({ "stopped": stopped }));
        }
        _ => {}
    }
    let subject: Subject = arg(args, "subject")?;
    let module = subject.module.clone();
    match command {
        "frame.python.status" => status(state, &module),
        "frame.python.release" => {
            let holder: String = opt_arg(args, "holder")?.unwrap_or_else(|| format!("{}:{}", subject.kind, subject.reference));
            Ok(json!({ "released": release(state, &module, &holder).await }))
        }
        "frame.python.channel" => {
            let space = state.space()?.root.to_string_lossy().to_string();
            let channel = crate::channels::open(&space, &module, "python", "stream", None)?;
            if let Ok(mut channels) = progress_channels().lock() {
                channels.insert(channel.clone(), module.clone());
            }
            Ok(json!({ "channel": channel }))
        }
        "frame.python.create" => {
            let class: String = arg(args, "class")?;
            let holder: String = opt_arg(args, "holder")?.unwrap_or_else(|| format!("{}:{}", subject.kind, subject.reference));
            let timeout = timeout(args)?;
            let kernel = kernel_for(state, &module).await?;
            if kernel.objects.lock().map(|objects| objects.len()).unwrap_or(0) >= MAX_OBJECTS {
                return Err(AppError::new(format!(
                    "Trop d’objets Python vivants pour ce module ({MAX_OBJECTS} au plus) : libérez ceux qui ne servent plus avec dispose()."
                )));
            }
            let handle = format!("py_{}", uuid::Uuid::new_v4().simple());
            let message = json!({ "op": "create", "class": class, "handle": handle, "args": args.get("args").cloned().unwrap_or(Value::Null) });
            request(state, &kernel, &format!("création de {class}"), message, timeout, None).await?;
            if let Ok(mut objects) = kernel.objects.lock() {
                objects.insert(handle.clone(), ObjectInfo { class: class.clone(), holder, created: std::time::Instant::now() });
            }
            Ok(json!({ "handle": handle, "class": class }))
        }
        "frame.python.call" => {
            let handle: String = arg(args, "handle")?;
            let method: String = arg(args, "method")?;
            let timeout = timeout(args)?;
            let channel = owned_channel(&subject, args)?;
            let kernel = kernel_for(state, &module).await?;
            let info = known_object(&kernel, &handle)?;
            let message = json!({ "op": "call", "handle": handle, "method": method, "args": args.get("args").cloned().unwrap_or(Value::Null) });
            request(state, &kernel, &format!("{}.{method}", info.class), message, timeout, channel).await
        }
        "frame.python.run" => {
            let function: String = arg(args, "function")?;
            let timeout = timeout(args)?;
            let channel = owned_channel(&subject, args)?;
            let kernel = kernel_for(state, &module).await?;
            let message = json!({ "op": "run", "function": function, "args": args.get("args").cloned().unwrap_or(Value::Null) });
            request(state, &kernel, &function, message, timeout, channel).await
        }
        "frame.python.dispose" => {
            let handle: String = arg(args, "handle")?;
            let dir = module_dir(state, &module)?;
            let Some(kernel) = kernel::kernels().running(&dir) else { return Ok(json!({ "disposed": false })) };
            let known = kernel.objects.lock().ok().and_then(|mut objects| objects.remove(&handle)).is_some();
            if !known {
                return Ok(json!({ "disposed": false }));
            }
            request(state, &kernel, "libération", json!({ "op": "dispose", "handle": handle }), Duration::from_secs(10), None).await
        }
        _ => Err(AppError::new(format!("Commande inconnue : {command}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripts::Runtime;
    use crate::space::Space;

    const ANALYSE: &str = "
from alfred_kernel import progress

class Graphe:
    def __init__(self, source):
        self.aretes = [ligne.split(',') for ligne in source.split()]
        print('chargé', len(self.aretes))

    def compter(self):
        return len(self.aretes)

    def parcourir(self):
        for rang, arete in enumerate(self.aretes, start=1):
            progress(rang / len(self.aretes), f'arête {rang}')
            yield arete
        return 'fini'

    def close(self):
        print('libéré')

def sdk():
    import os
    import alfred
    return {'db': hasattr(alfred, 'db'), 'jeton': bool(os.environ.get('ALFRED_SDK_TOKEN')), 'noyau': os.environ['ALFRED_KERNEL']}
";

    const SOMME: &str = "
appels = 0

def main(entree):
    global appels
    appels += 1
    return {'somme': sum(entree['nombres']), 'appels': appels}
";

    fn setup() -> (Arc<AppState>, tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("alfred")).unwrap();
        let space = Space::open_or_create(&dir.path().join("espace"), Some("Test")).unwrap();
        let module = space.module_dir("reseau");
        std::fs::create_dir_all(module.join("python")).unwrap();
        std::fs::create_dir_all(module.join("functions")).unwrap();
        std::fs::write(module.join("python/analyse.py"), ANALYSE).unwrap();
        std::fs::write(module.join("functions/somme.py"), SOMME).unwrap();
        let manifest = json!({
            "id": "reseau", "name": "Réseau", "version": "0.1.0",
            "functions": [{ "id": "somme", "description": "Additionne.", "runtime": "python", "kernel": true }],
        });
        std::fs::write(module.join("module.json"), manifest.to_string()).unwrap();
        state.set_space(Some(space));
        (state, dir, module)
    }

    fn page(module: &str) -> Subject {
        Subject { kind: "page".into(), module: module.into(), reference: format!("{module}/graphe"), ..Default::default() }
    }

    async fn invoke(state: &Arc<AppState>, command: &str, args: Value) -> AppResult<Value> {
        crate::dispatch::dispatch(state.clone(), command, args).await
    }

    /// Brique 4 : le noyau d’un module qui déclare des paquets tourne dans son environnement (uv), et les importe.
    #[tokio::test(flavor = "multi_thread")]
    async fn le_noyau_d_un_module_a_paquets_les_importe() {
        if crate::python::env::uv().is_none() {
            eprintln!("uv absent : test sauté");
            return;
        }
        let (state, _dir, _module) = setup();
        let space = state.space().unwrap();
        let module = space.module_dir("paquets");
        std::fs::create_dir_all(module.join("python")).unwrap();
        std::fs::write(module.join("python/outil.py"), "import six, sys\n\ndef version():\n    return {'six': six.__version__, 'python': sys.executable}\n").unwrap();
        let manifest = json!({ "id": "paquets", "name": "Paquets", "version": "0.1.0", "python": { "requirements": ["six==1.16.0"] } });
        std::fs::write(module.join("module.json"), manifest.to_string()).unwrap();
        let found = match invoke(&state, "frame.python.run", json!({ "subject": page("paquets"), "function": "outil.version" })).await {
            Ok(found) => found,
            Err(error) if error.message.contains("sans réseau") => {
                eprintln!("hors ligne : test sauté ({})", error.message);
                return;
            }
            Err(error) => panic!("{}", error.message),
        };
        assert_eq!(found["six"], json!("1.16.0"));
        assert!(found["python"].as_str().unwrap().contains(".alfred/python/paquets"), "{found}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn une_page_cree_appelle_et_libere_ses_objets() {
        if scripts::interpreter(Runtime::Python).is_none() {
            eprintln!("python absent : test sauté");
            return;
        }
        let (state, _dir, module) = setup();
        let subject = page("reseau");
        let created = invoke(
            &state,
            "frame.python.create",
            json!({ "subject": subject, "holder": "page:reseau/graphe", "class": "analyse.Graphe", "args": { "source": "a,b b,c c,d" } }),
        )
        .await
        .unwrap();
        let handle = created["handle"].as_str().unwrap().to_string();
        let count = invoke(&state, "frame.python.call", json!({ "subject": subject, "handle": handle, "method": "compter" })).await.unwrap();
        assert_eq!(count, json!(3));
        // Le noyau a le SDK Python (`import alfred`) et un jeton du pont pour sa durée de vie.
        let sdk = invoke(&state, "frame.python.run", json!({ "subject": subject, "function": "analyse.sdk" })).await.unwrap();
        assert_eq!(sdk, json!({ "db": true, "jeton": true, "noyau": "1" }));

        // Avancement et flux par un canal, lu comme tout canal du module ; il se ferme à la fin de l’appel.
        let channel = invoke(&state, "frame.python.channel", json!({ "subject": subject })).await.unwrap()["channel"].clone();
        let stranger = page("autre");
        let refused = invoke(&state, "frame.python.call", json!({ "subject": stranger, "handle": handle, "method": "compter", "channel": channel })).await;
        assert!(refused.unwrap_err().message.contains("pas un canal d’avancement de ce module"));
        let done = invoke(&state, "frame.python.call", json!({ "subject": subject, "handle": handle, "method": "parcourir", "channel": channel }))
            .await
            .unwrap();
        assert_eq!(done, json!("fini"));
        let read = invoke(&state, "frame.channels.read", json!({ "subject": subject, "channel": channel, "after": 0 })).await.unwrap();
        assert_eq!(read["closed"], json!(true));
        let events: Vec<(String, String)> = read["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "data")
            .map(|event| (event["event"].as_str().unwrap().to_string(), event["data"].as_str().unwrap().to_string()))
            .collect();
        assert_eq!(events.len(), 6);
        assert_eq!(events[0], ("progress".to_string(), r#"{"fraction":0.3333333333333333,"message":"arête 1"}"#.to_string()));
        assert_eq!(events[1], ("data".to_string(), r#"["a","b"]"#.to_string()));

        let status = invoke(&state, "frame.python.status", json!({ "subject": subject })).await.unwrap();
        assert_eq!(status["running"], json!(true));
        assert_eq!(status["objects"].as_array().unwrap().len(), 1);

        // La page se ferme : ses objets sont libérés (`close()` appelé), une ancienne poignée est « perdue ».
        let released = invoke(&state, "frame.python.release", json!({ "subject": subject, "holder": "page:reseau/graphe" })).await.unwrap();
        assert_eq!(released["released"], json!(1));
        let lost = invoke(&state, "frame.python.call", json!({ "subject": subject, "handle": handle, "method": "compter" })).await.unwrap_err();
        assert_eq!(lost.detail.unwrap()["code"], json!("objectLost"));

        // Fonction libre, et objet d’un autre module jamais atteint.
        let other = invoke(&state, "frame.python.create", json!({ "subject": subject, "holder": "p", "class": "analyse.Graphe", "args": ["x,y"] }))
            .await
            .unwrap();
        assert!(invoke(&state, "frame.python.call", json!({ "subject": stranger, "handle": other["handle"], "method": "compter" })).await.is_err());

        // Un fichier .py qui change : le noyau redémarre au prochain appel et l’objet est perdu.
        let file = module.join("python/analyse.py");
        let later = std::time::SystemTime::now() + Duration::from_secs(2);
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(later).unwrap();
        let lost = invoke(&state, "frame.python.call", json!({ "subject": subject, "handle": other["handle"], "method": "compter" })).await.unwrap_err();
        assert_eq!(lost.detail.unwrap()["code"], json!("objectLost"));

        // L’espace se ferme : le noyau s’arrête.
        assert!(kernel::kernels().running(&module).is_some());
        state.set_space(None);
        assert!(kernel::kernels().running(&module).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn une_fonction_kernel_garde_son_etat_entre_deux_appels() {
        if scripts::interpreter(Runtime::Python).is_none() {
            return;
        }
        let (state, _dir, module) = setup();
        let first = crate::functions::call(&state, "reseau/somme", json!({ "nombres": [1, 2] }), "test").await.unwrap();
        assert_eq!(first, json!({ "somme": 3, "appels": 1 }));
        let second = crate::functions::call(&state, "reseau/somme", json!({ "nombres": [4] }), "test").await.unwrap();
        assert_eq!(second, json!({ "somme": 4, "appels": 2 }));
        kernel::kernels().stop(&module, "fin du test");
    }
}
