//! Noyau Python d’un module : un processus Python long, un par module de l’espace ouvert, qui garde les objets que
//! les pages créent (`python.create`) et répond à leurs appels (`python.call`, `python.run`).
//!
//! Cycle de vie : démarré au premier appel ; arrêté après 10 minutes sans appel ([`IDLE`]) ; redémarré quand un
//! fichier `.py` du module change ; arrêté quand l’espace se ferme ou qu’Alfred quitte. Un appel en cours au moment
//! d’un arrêt reçoit une erreur qui en dit la raison ; les objets du noyau arrêté sont perdus.
//!
//! Protocole (lignes JSON, code Python embarqué dans `kernel_server.py`) :
//! - Alfred → noyau, sur stdin : `{"id": 1, "op": "create" | "call" | "run" | "main" | "dispose" | "ping", …}` ;
//! - noyau → Alfred, sur stdout : `{"ready": true, "python": "3.12.1", "pid": 42}` au démarrage, puis
//!   `{"id": 1, "ok": true, "result": …}`, `{"id": 1, "ok": false, "error": {"type", "message", "trace"}}`, et pendant
//!   un appel `{"id": 1, "event": "progress" | "data", "data": …}`.
//!
//! `print` du code du module ne casse rien : le noyau garde la vraie sortie standard pour le protocole et renvoie
//! `sys.stdout` vers stderr, qu’Alfred lit ligne à ligne pour le journal du module ([`Kernel::take_output`]).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};
use crate::scripts::{self, Interpreter};

/// Sans appel pendant ce temps, le noyau s’arrête.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// Délai d’un appel quand la page n’en donne pas.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Plus long délai qu’une page peut demander pour un appel.
pub const MAX_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Délai du démarrage : l’interpréteur se lance et annonce `ready` (les fichiers du module s’importent plus tard).
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// Lignes de stderr gardées : la fin, pour expliquer un arrêt ; le reste, pour le journal.
const TAIL_LINES: usize = 40;
const MAX_OUTPUT_LINES: usize = 400;
/// Taille maximale d’une ligne du protocole (un résultat) : au-delà, l’appel échoue.
const MAX_LINE: usize = 16 * 1024 * 1024;

const SERVER: &str = include_str!("kernel_server.py");

/// Raison donnée aux appels en cours quand un fichier `.py` du module change.
pub const RESTARTED: &str =
    "Le noyau Python du module a redémarré : un fichier .py a changé. Les objets créés avant sont perdus : recréez-les.";

// --- Points d’entrée ---------------------------------------------------------------------------------------------

/// Interpréteur du noyau d’un module. Point d’entrée unique : celui de son environnement isolé s’il déclare
/// `python.requirements` ou `python.version` (`python::env`, installé avec uv au premier usage), sinon le Python du
/// PATH de connexion. Bloquant : appelé hors de la boucle asynchrone ; l’erreur dit à l’utilisateur quoi faire.
pub fn interpreter(state: &crate::state::AppState, space: &crate::space::Space, module: &str) -> AppResult<Interpreter> {
    crate::python::env::interpreter(Some(state), space, &space.module(module)?)
}

/// Variables d’environnement du noyau d’un module, ajoutées à l’environnement réduit des scripts
/// (`scripts::base_env`), et ce qui doit vivre aussi longtemps que lui ([`Launch::keep`]). Point d’entrée unique :
/// le pont du SDK Python (`import alfred`, `python::bridge`) y donne `ALFRED_MODULE`, `ALFRED_SDK_URL`, `PYTHONPATH`
/// et un jeton propre au noyau, valable tant qu’il vit (le demandeur est « module/python »).
pub fn environment(
    state: &crate::state::AppState,
    space: &crate::space::Space,
    module: &str,
) -> AppResult<(Vec<(String, String)>, Vec<Box<dyn std::any::Any + Send + Sync>>)> {
    let bridge = super::bridge::env(state, module, None, false)?;
    let mut env = bridge.env.clone();
    env.push(("ALFRED_SPACE".to_string(), space.root.to_string_lossy().to_string()));
    env.push(("ALFRED_KERNEL".to_string(), "1".to_string()));
    Ok((env, vec![Box::new(bridge)]))
}

// --- Lancement -------------------------------------------------------------------------------------------------

/// Ce qu’il faut pour lancer le noyau d’un module.
pub struct Launch {
    pub module: String,
    /// Dossier du module : dossier courant du noyau ; ses classes sont dans `python/`.
    pub module_dir: PathBuf,
    pub interpreter: Interpreter,
    /// Variables ajoutées à l’environnement réduit.
    pub env: Vec<(String, String)>,
    /// Gardé tant que le noyau vit, puis relâché (jeton du pont du SDK, par exemple).
    pub keep: Vec<Box<dyn std::any::Any + Send + Sync>>,
}

/// Un objet créé dans le noyau : sa classe et le cadre qui le tient (libéré quand ce cadre se ferme).
#[derive(Debug, Clone)]
pub struct ObjectInfo {
    pub class: String,
    pub holder: String,
    pub created: Instant,
}

/// Reçoit les messages d’un appel en cours : `progress` ou `data`, et leur contenu.
pub type Events = Box<dyn Fn(&str, Value) + Send + Sync>;

struct Waiter {
    reply: oneshot::Sender<AppResult<Value>>,
    events: Option<Events>,
}

/// Un processus Python vivant.
pub struct Kernel {
    pub module: String,
    /// Version de Python annoncée au démarrage.
    python: OnceLock<String>,
    pub pid: u32,
    pub program: PathBuf,
    pub started: Instant,
    /// Fichier `.py` le plus récent au démarrage : un plus récent depuis demande un redémarrage.
    stamp: Option<SystemTime>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, Waiter>>,
    next: AtomicU64,
    last_used: Mutex<Instant>,
    stopped: Mutex<Option<String>>,
    tail: Mutex<VecDeque<String>>,
    output: Mutex<VecDeque<String>>,
    /// Valeurs à effacer de ce que le code écrit (jeton du pont).
    secrets: Vec<String>,
    pub objects: Mutex<HashMap<String, ObjectInfo>>,
    keep: Mutex<Vec<Box<dyn std::any::Any + Send + Sync>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Kernel {
    fn start(launch: Launch) -> AppResult<Arc<Kernel>> {
        let python_dir = launch.module_dir.join("python");
        let mut args = launch.interpreter.args.clone();
        args.extend(["-X".to_string(), "utf8".to_string(), "-c".to_string(), SERVER.to_string()]);
        args.push(python_dir.to_string_lossy().to_string());
        let mut command = Command::new(&launch.interpreter.program);
        command
            .args(&args)
            .current_dir(&launch.module_dir)
            .env_clear()
            .envs(scripts::base_env())
            .envs(launch.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Un groupe de processus à lui : l’arrêt emporte aussi ce que le code du module a lancé.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let (mut child, _owned) = crate::process_tree::spawn(&mut command).map_err(|error| {
            AppError::new(format!("Impossible de lancer Python ({}) : {error}", launch.interpreter.program.display()))
        })?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| AppError::new("Sortie du noyau Python indisponible."))?;
        let stderr = child.stderr.take().ok_or_else(|| AppError::new("Erreurs du noyau Python indisponibles."))?;
        let pid = child.id();

        let kernel = Arc::new(Kernel {
            module: launch.module.clone(),
            python: OnceLock::new(),
            pid,
            program: launch.interpreter.program.clone(),
            started: Instant::now(),
            stamp: newest_python_file(&launch.module_dir),
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            last_used: Mutex::new(Instant::now()),
            stopped: Mutex::new(None),
            tail: Mutex::new(VecDeque::new()),
            output: Mutex::new(VecDeque::new()),
            secrets: launch
                .env
                .iter()
                .filter(|(name, value)| name.ends_with("_TOKEN") && !value.is_empty())
                .map(|(_, value)| value.clone())
                .collect(),
            objects: Mutex::new(HashMap::new()),
            keep: Mutex::new(launch.keep),
        });

        let weak = Arc::downgrade(&kernel);
        std::thread::spawn(move || read_errors(weak, stderr));
        let (ready_tx, ready_rx) = mpsc::channel();
        let weak = Arc::downgrade(&kernel);
        std::thread::spawn(move || read_protocol(weak, stdout, ready_tx));

        match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(ready) => {
                let python = ready.get("python").and_then(Value::as_str).unwrap_or_default().to_string();
                let _ = kernel.python.set(python);
                Ok(kernel)
            }
            Err(_) => {
                let tail = kernel.tail_text();
                kernel.stop("Le noyau Python n’a pas démarré.");
                Err(AppError::with_detail(
                    match tail.lines().last() {
                        Some(last) => format!("Le noyau Python n’a pas démarré : {last}"),
                        None => format!("Le noyau Python n’a pas démarré en {} s.", START_TIMEOUT.as_secs()),
                    },
                    json!({ "stderr": tail }),
                ))
            }
        }
    }

    /// Version de Python du noyau (`3.12.1`).
    pub fn python(&self) -> &str {
        self.python.get().map(String::as_str).unwrap_or_default()
    }

    /// Raison de l’arrêt, si le noyau est arrêté.
    pub fn stopped(&self) -> Option<String> {
        locked(&self.stopped).clone()
    }

    pub fn is_alive(&self) -> bool {
        self.stopped().is_none()
    }

    /// Appels en cours.
    pub fn busy(&self) -> usize {
        locked(&self.pending).len()
    }

    pub fn idle_for(&self) -> Duration {
        locked(&self.last_used).elapsed()
    }

    /// Lignes écrites sur stderr (par `print` notamment) depuis la dernière lecture, pour le journal.
    pub fn take_output(&self) -> Vec<String> {
        locked(&self.output).drain(..).collect()
    }

    fn tail_text(&self) -> String {
        // Laisse au lecteur de stderr un instant pour lire les dernières lignes d’un processus qui vient de finir.
        std::thread::sleep(Duration::from_millis(50));
        locked(&self.tail).iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// Envoie une requête et attend sa réponse. `events` reçoit l’avancement et le flux de l’appel.
    /// Au délai dépassé, le noyau est arrêté : Python ne sait pas interrompre un calcul en cours.
    pub async fn request(&self, mut message: Value, timeout: Duration, events: Option<Events>) -> AppResult<Value> {
        if let Some(reason) = self.stopped() {
            return Err(AppError::new(reason));
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        message["id"] = json!(id);
        let (reply, receiver) = oneshot::channel();
        locked(&self.pending).insert(id, Waiter { reply, events });
        *locked(&self.last_used) = Instant::now();
        let mut line = serde_json::to_string(&message)?;
        line.push('\n');
        let written = match locked(&self.stdin).as_mut() {
            Some(stdin) => stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_ok(),
            None => false,
        };
        if !written {
            locked(&self.pending).remove(&id);
            return Err(AppError::new(
                self.stopped().unwrap_or_else(|| "Le noyau Python ne reçoit plus de requêtes.".to_string()),
            ));
        }
        let answer = tokio::time::timeout(timeout, receiver).await;
        *locked(&self.last_used) = Instant::now();
        match answer {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::new(self.stopped().unwrap_or_else(|| "Le noyau Python s’est arrêté.".into()))),
            Err(_) => {
                let reason = format!(
                    "L’appel n’a pas répondu en {} s : le noyau Python du module a été arrêté et ses objets sont perdus.",
                    timeout.as_secs_f64().round()
                );
                self.stop(&reason);
                Err(AppError::new(reason))
            }
        }
    }

    /// Arrête le processus (et ce qu’il a lancé) ; les appels en cours reçoivent `reason`.
    pub fn stop(&self, reason: &str) {
        {
            let mut stopped = locked(&self.stopped);
            if stopped.is_some() {
                return;
            }
            *stopped = Some(reason.to_string());
        }
        locked(&self.stdin).take();
        for (_, waiter) in locked(&self.pending).drain() {
            let _ = waiter.reply.send(Err(AppError::new(reason)));
        }
        locked(&self.objects).clear();
        let child = locked(&self.child).take();
        let pid = self.pid;
        std::thread::spawn(move || {
            #[cfg(unix)]
            // SAFETY: kill(2) on the kernel's own process group; a stale id only fails with ESRCH.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            let _ = crate::process_tree::terminate_tree(pid);
            if let Some(mut child) = child {
                let _ = child.kill();
                let _ = child.wait();
            }
        });
        locked(&self.keep).clear();
    }

    /// Fin de la sortie : le processus est parti de lui-même (ou a été arrêté).
    fn ended(&self) {
        let reason = {
            let tail = self.tail_text();
            let code = locked(&self.child).as_mut().and_then(|child| child.try_wait().ok().flatten()).and_then(|s| s.code());
            let last = tail.lines().rev().find(|line| !line.trim().is_empty()).map(str::to_string);
            match (code, last) {
                (_, Some(last)) => format!("Le noyau Python du module s’est arrêté : {last}"),
                (Some(code), None) => format!("Le noyau Python du module s’est arrêté (code {code})."),
                (None, None) => "Le noyau Python du module s’est arrêté.".to_string(),
            }
        };
        self.stop(&reason);
    }

    fn answer(&self, message: Value) {
        let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
        if let Some(kind) = message.get("event").and_then(Value::as_str) {
            if let Some(Waiter { events: Some(events), .. }) = locked(&self.pending).get(&id) {
                events(kind, message.get("data").cloned().unwrap_or(Value::Null));
            }
            return;
        }
        let Some(waiter) = locked(&self.pending).remove(&id) else { return };
        let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(python_error(message.get("error").cloned().unwrap_or(Value::Null)))
        };
        let _ = waiter.reply.send(result);
    }
}

/// Erreur rendue par le noyau : le message (`ValueError: …`), et dans le détail le type et la trace courte.
fn python_error(error: Value) -> AppError {
    let message = error.get("message").and_then(Value::as_str).unwrap_or("Erreur Python sans message.").to_string();
    let kind = error.get("type").and_then(Value::as_str).unwrap_or("Exception");
    let mut detail = json!({ "python": { "type": kind } });
    if let Some(trace) = error.get("trace").and_then(Value::as_str) {
        detail["python"]["trace"] = json!(trace);
    }
    AppError::with_detail(message, detail)
}

fn read_protocol(kernel: Weak<Kernel>, stdout: std::process::ChildStdout, ready: mpsc::Sender<Value>) {
    let mut reader = BufReader::new(stdout);
    let mut ready = Some(ready);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.len() > MAX_LINE {
            if let Some(kernel) = kernel.upgrade() {
                kernel.stop("Un résultat du noyau Python dépasse 16 Mo : le noyau a été arrêté.");
            }
            break;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
        if message.get("ready").and_then(Value::as_bool) == Some(true) {
            if let Some(ready) = ready.take() {
                let _ = ready.send(message);
            }
            continue;
        }
        match kernel.upgrade() {
            Some(kernel) => kernel.answer(message),
            None => break,
        }
    }
    if let Some(kernel) = kernel.upgrade() {
        kernel.ended();
    }
}

fn read_errors(kernel: Weak<Kernel>, stderr: std::process::ChildStderr) {
    let reader = BufReader::new(stderr);
    for line in reader.split(b'\n') {
        let Ok(line) = line else { break };
        let Some(kernel) = kernel.upgrade() else { break };
        let mut text = String::from_utf8_lossy(&line).trim_end().to_string();
        for secret in &kernel.secrets {
            text = text.replace(secret.as_str(), "[jeton]");
        }
        let mut tail = locked(&kernel.tail);
        tail.push_back(text.clone());
        while tail.len() > TAIL_LINES {
            tail.pop_front();
        }
        drop(tail);
        let mut output = locked(&kernel.output);
        output.push_back(text);
        while output.len() > MAX_OUTPUT_LINES {
            output.pop_front();
        }
    }
}

/// Dossiers jamais parcourus pour trouver les fichiers `.py` (environnements, caches, dépôts).
const SKIPPED: &[&str] = &[".venv", "venv", "__pycache__", "node_modules", ".git", "dist", "build", ".mypy_cache"];

/// Date du fichier `.py` le plus récent du module (2 000 entrées au plus parcourues).
pub fn newest_python_file(module_dir: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    let mut stack = vec![module_dir.to_path_buf()];
    let mut seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > 2000 {
                return newest;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                let name = entry.file_name();
                if !SKIPPED.iter().any(|skipped| name == *skipped) {
                    stack.push(path);
                }
            } else if path.extension().is_some_and(|extension| extension == "py") {
                if let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) {
                    newest = Some(newest.map_or(modified, |newest| newest.max(modified)));
                }
            }
        }
    }
    newest
}

// --- Registre des noyaux ---------------------------------------------------------------------------------------

/// Noyaux vivants, un par dossier de module.
pub struct Kernels {
    kernels: Mutex<HashMap<PathBuf, Arc<Kernel>>>,
    /// Un démarrage à la fois par module : deux premiers appels simultanés ne lancent qu’un noyau.
    starting: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    idle: Duration,
}

impl Kernels {
    /// Registre dont les noyaux s’arrêtent après `idle` sans appel (vérifié par un fil de fond).
    pub fn new(idle: Duration) -> Arc<Kernels> {
        let kernels = Arc::new(Kernels { kernels: Mutex::default(), starting: Mutex::default(), idle });
        let weak = Arc::downgrade(&kernels);
        let tick = (idle / 4).clamp(Duration::from_millis(20), Duration::from_secs(30));
        std::thread::spawn(move || loop {
            std::thread::sleep(tick);
            match weak.upgrade() {
                Some(kernels) => {
                    kernels.sweep();
                }
                None => break,
            }
        });
        kernels
    }

    /// Noyau vivant du module, s’il y en a un.
    pub fn running(&self, module_dir: &Path) -> Option<Arc<Kernel>> {
        locked(&self.kernels).get(module_dir).filter(|kernel| kernel.is_alive()).cloned()
    }

    /// Noyau du module, démarré si besoin (`launch` n’est appelé qu’alors). Un fichier `.py` changé depuis son
    /// démarrage le redémarre d’abord. Bloquant : à appeler hors de la boucle asynchrone.
    pub fn get_or_start(&self, module_dir: &Path, launch: impl FnOnce() -> AppResult<Launch>) -> AppResult<Arc<Kernel>> {
        let gate = locked(&self.starting).entry(module_dir.to_path_buf()).or_default().clone();
        let _gate = locked(&gate);
        if let Some(kernel) = self.running(module_dir) {
            if newest_python_file(module_dir) <= kernel.stamp {
                return Ok(kernel);
            }
            kernel.stop(RESTARTED);
        }
        let kernel = Kernel::start(launch()?)?;
        locked(&self.kernels).insert(module_dir.to_path_buf(), kernel.clone());
        Ok(kernel)
    }

    /// Arrête le noyau du module, s’il tourne.
    pub fn stop(&self, module_dir: &Path, reason: &str) -> bool {
        let kernel = locked(&self.kernels).remove(module_dir);
        let stopped = kernel.as_ref().is_some_and(|kernel| kernel.is_alive());
        if let Some(kernel) = kernel {
            kernel.stop(reason);
        }
        stopped
    }

    /// Arrête tous les noyaux (espace fermé, Alfred qui quitte).
    pub fn stop_all(&self, reason: &str) -> usize {
        let kernels: Vec<_> = locked(&self.kernels).drain().map(|(_, kernel)| kernel).collect();
        let count = kernels.iter().filter(|kernel| kernel.is_alive()).count();
        for kernel in kernels {
            kernel.stop(reason);
        }
        count
    }

    /// Arrête les noyaux des modules d’un espace (`root`) : il se ferme ou un autre s’ouvre.
    pub fn stop_under(&self, root: &Path, reason: &str) -> usize {
        let concerned: Vec<PathBuf> = locked(&self.kernels).keys().filter(|dir| dir.starts_with(root)).cloned().collect();
        concerned.iter().filter(|dir| self.stop(dir, reason)).count()
    }

    /// Des fichiers ont changé : le noyau d’un module dont un `.py` a changé redémarre (au prochain appel).
    pub fn files_changed(&self, paths: &[PathBuf]) -> usize {
        let concerned: Vec<PathBuf> = locked(&self.kernels)
            .keys()
            .filter(|dir| {
                paths.iter().any(|path| {
                    path.extension().is_some_and(|extension| extension == "py")
                        && path.strip_prefix(dir).is_ok_and(|relative| {
                            !relative.components().any(|part| SKIPPED.iter().any(|skipped| part.as_os_str() == *skipped))
                        })
                })
            })
            .cloned()
            .collect();
        concerned.iter().filter(|dir| self.stop(dir, RESTARTED)).count()
    }

    /// Arrête les noyaux sans appel depuis `idle` et retire ceux déjà arrêtés.
    pub fn sweep(&self) -> usize {
        let idle: Vec<PathBuf> = locked(&self.kernels)
            .iter()
            .filter(|(_, kernel)| kernel.is_alive() && kernel.busy() == 0 && kernel.idle_for() >= self.idle)
            .map(|(dir, _)| dir.clone())
            .collect();
        let reason = format!(
            "Le noyau Python du module s’est arrêté après {} min sans appel : ses objets sont perdus.",
            self.idle.as_secs() / 60
        );
        let stopped = idle.iter().filter(|dir| self.stop(dir, &reason)).count();
        locked(&self.kernels).retain(|_, kernel| kernel.is_alive());
        stopped
    }
}

/// Registre de l’application.
pub fn kernels() -> &'static Arc<Kernels> {
    static KERNELS: OnceLock<Arc<Kernels>> = OnceLock::new();
    KERNELS.get_or_init(|| Kernels::new(IDLE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripts::Runtime;

    fn python() -> Option<Interpreter> {
        let found = scripts::interpreter(Runtime::Python);
        if found.is_none() {
            eprintln!("python absent : test sauté");
        }
        found
    }

    fn module(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("python")).unwrap();
        for (name, body) in files {
            std::fs::write(dir.path().join("python").join(name), body).unwrap();
        }
        dir
    }

    fn launch(dir: &Path, interpreter: &Interpreter) -> Launch {
        Launch {
            module: "essai".into(),
            module_dir: dir.to_path_buf(),
            interpreter: interpreter.clone(),
            env: vec![("ALFRED_MODULE".into(), "essai".into()), ("ALFRED_SDK_TOKEN".into(), "s3cr3t-jeton".into())],
            keep: Vec::new(),
        }
    }

    const COMPTEUR: &str = "
import os
from alfred_kernel import progress

class Compteur:
    def __init__(self, depart=0):
        self.total = depart
        print('compteur créé')
        print('jeton', os.environ['ALFRED_SDK_TOKEN'])

    def ajouter(self, n=1):
        self.total += n
        print('ajout', n)
        return {'total': self.total, 'module': os.environ['ALFRED_MODULE']}

    def lent(self, secondes):
        import time
        time.sleep(secondes)
        return 'fini'

    def etapes(self, n):
        for i in range(n):
            progress((i + 1) / n, f'étape {i + 1}')
            yield i * 10
        return 'terminé'

    def echouer(self):
        raise ValueError('montant négatif')

    def _secret(self):
        return 'non'

def resumer(texte, mots=3):
    return ' '.join(texte.split()[:mots])
";

    async fn call(kernel: &Kernel, message: Value) -> AppResult<Value> {
        kernel.request(message, Duration::from_secs(20), None).await
    }

    #[tokio::test]
    async fn objet_garde_son_etat_et_print_ne_casse_rien() {
        let Some(interpreter) = python() else { return };
        let dir = module(&[("compteur.py", COMPTEUR)]);
        let kernels = Kernels::new(IDLE);
        let kernel = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        assert!(kernel.python().starts_with('3'), "{}", kernel.python());

        let created = call(&kernel, json!({ "op": "create", "class": "compteur.Compteur", "handle": "h1", "args": { "depart": 10 } }))
            .await
            .unwrap();
        assert_eq!(created, json!({ "handle": "h1" }));
        call(&kernel, json!({ "op": "call", "handle": "h1", "method": "ajouter", "args": { "n": 5 } })).await.unwrap();
        let second = call(&kernel, json!({ "op": "call", "handle": "h1", "method": "ajouter", "args": [2] })).await.unwrap();
        assert_eq!(second, json!({ "total": 17, "module": "essai" }));
        let summary = call(&kernel, json!({ "op": "run", "function": "compteur.resumer", "args": { "texte": "un deux trois quatre", "mots": 2 } }))
            .await
            .unwrap();
        assert_eq!(summary, json!("un deux"));

        // Le même noyau sert l’appel suivant ; `print` est allé sur stderr, au journal.
        let again = kernels.get_or_start(dir.path(), || panic!("pas de second démarrage")).unwrap();
        assert_eq!(again.pid, kernel.pid);
        std::thread::sleep(Duration::from_millis(100));
        let output = kernel.take_output();
        assert!(output.contains(&"compteur créé".to_string()), "{output:?}");
        assert!(output.contains(&"jeton [jeton]".to_string()), "le jeton est effacé : {output:?}");
        assert!(output.contains(&"ajout 5".to_string()), "{output:?}");
        assert!(!dir.path().join("python/__pycache__").exists());

        let disposed = call(&kernel, json!({ "op": "dispose", "handle": "h1" })).await.unwrap();
        assert_eq!(disposed, json!({ "disposed": true }));
        let error = call(&kernel, json!({ "op": "call", "handle": "h1", "method": "ajouter" })).await.unwrap_err();
        assert!(error.message.contains("inconnu"), "{}", error.message);
        kernels.stop_all("fin du test");
    }

    #[tokio::test]
    async fn erreur_python_avec_trace_courte_et_noms_refuses() {
        let Some(interpreter) = python() else { return };
        let dir = module(&[("compteur.py", COMPTEUR), ("outils.py", "from os import system\n")]);
        let kernels = Kernels::new(IDLE);
        let kernel = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        call(&kernel, json!({ "op": "create", "class": "compteur.Compteur", "handle": "h" })).await.unwrap();

        let error = call(&kernel, json!({ "op": "call", "handle": "h", "method": "echouer" })).await.unwrap_err();
        assert_eq!(error.message, "ValueError: montant négatif");
        let detail = error.detail.unwrap();
        assert_eq!(detail["python"]["type"], "ValueError");
        let trace = detail["python"]["trace"].as_str().unwrap();
        assert!(trace.contains("compteur.py") && trace.contains("echouer"), "{trace}");
        assert!(!trace.contains("<string>"), "la trace ne montre pas le noyau : {trace}");

        // Le noyau survit à l’erreur.
        let total = call(&kernel, json!({ "op": "call", "handle": "h", "method": "ajouter" })).await.unwrap();
        assert_eq!(total["total"], 1);

        for (message, expected) in [
            (json!({ "op": "call", "handle": "h", "method": "_secret" }), "privé"),
            (json!({ "op": "run", "function": "os.system", "args": ["true"] }), "dossier python/"),
            (json!({ "op": "run", "function": "outils.system", "args": ["true"] }), "importé d'ailleurs"),
            (json!({ "op": "run", "function": "absent.f" }), "introuvable"),
            (json!({ "op": "create", "class": "compteur.resumer" }), "pas une classe"),
            (json!({ "op": "run", "function": "compteur.Compteur" }), "pas une fonction"),
        ] {
            let error = call(&kernel, message).await.unwrap_err();
            assert!(error.message.contains(expected), "{} ≠ {expected}", error.message);
        }
        kernels.stop_all("fin du test");
    }

    #[tokio::test]
    async fn progression_et_flux_d_une_methode_generatrice() {
        let Some(interpreter) = python() else { return };
        let dir = module(&[("compteur.py", COMPTEUR)]);
        let kernels = Kernels::new(IDLE);
        let kernel = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        call(&kernel, json!({ "op": "create", "class": "compteur.Compteur", "handle": "h" })).await.unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let events: Events = Box::new(move |kind, data| locked(&sink).push((kind.to_string(), data)));
        let result = kernel
            .request(json!({ "op": "call", "handle": "h", "method": "etapes", "args": { "n": 2 } }), Duration::from_secs(20), Some(events))
            .await
            .unwrap();
        assert_eq!(result, json!("terminé"));
        let seen = locked(&seen).clone();
        assert_eq!(
            seen,
            vec![
                ("progress".to_string(), json!({ "fraction": 0.5, "message": "étape 1" })),
                ("data".to_string(), json!(0)),
                ("progress".to_string(), json!({ "fraction": 1.0, "message": "étape 2" })),
                ("data".to_string(), json!(10)),
            ]
        );
        kernels.stop_all("fin du test");
    }

    #[tokio::test]
    async fn delai_depasse_arrete_le_noyau() {
        let Some(interpreter) = python() else { return };
        let dir = module(&[("compteur.py", COMPTEUR)]);
        let kernels = Kernels::new(IDLE);
        let kernel = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        call(&kernel, json!({ "op": "create", "class": "compteur.Compteur", "handle": "h" })).await.unwrap();
        let error = kernel
            .request(json!({ "op": "call", "handle": "h", "method": "lent", "args": [30] }), Duration::from_millis(400), None)
            .await
            .unwrap_err();
        assert!(error.message.contains("n’a pas répondu"), "{}", error.message);
        assert!(!kernel.is_alive());
        let fresh = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        assert_ne!(fresh.pid, kernel.pid);
        kernels.stop_all("fin du test");
    }

    #[tokio::test]
    async fn arret_apres_inactivite() {
        let Some(interpreter) = python() else { return };
        let dir = module(&[("compteur.py", COMPTEUR)]);
        let kernels = Kernels::new(Duration::from_millis(300));
        let kernel = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        call(&kernel, json!({ "op": "ping" })).await.unwrap();
        assert!(kernels.running(dir.path()).is_some());
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(kernels.running(dir.path()).is_none(), "arrêté par le fil de fond");
        assert!(kernel.stopped().unwrap().contains("sans appel"));
        let error = call(&kernel, json!({ "op": "ping" })).await.unwrap_err();
        assert!(error.message.contains("sans appel"), "{}", error.message);
    }

    #[tokio::test]
    async fn fichier_py_change_redemarre_et_l_appel_en_cours_le_sait() {
        let Some(interpreter) = python() else { return };
        let dir = module(&[("compteur.py", COMPTEUR)]);
        let kernels = Kernels::new(IDLE);
        let kernel = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        call(&kernel, json!({ "op": "create", "class": "compteur.Compteur", "handle": "h" })).await.unwrap();

        // Un appel long est en cours quand le fichier change (signalé par la surveillance du dossier).
        let running = kernel.clone();
        let pending = tokio::spawn(async move {
            running.request(json!({ "op": "call", "handle": "h", "method": "lent", "args": [20] }), Duration::from_secs(30), None).await
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let file = dir.path().join("python/compteur.py");
        assert_eq!(kernels.files_changed(&[dir.path().join("python/.venv/x.py"), dir.path().join("page.tsx")]), 0);
        assert_eq!(kernels.files_changed(&[file.clone()]), 1);
        let error = pending.await.unwrap().unwrap_err();
        assert_eq!(error.message, RESTARTED);

        // Sans surveillance, la date du fichier suffit : le prochain appel démarre un noyau neuf.
        let fresh = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        assert_ne!(fresh.pid, kernel.pid);
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&file, COMPTEUR.replace("'fini'", "'fini v2'")).unwrap();
        let later = std::time::SystemTime::now() + Duration::from_secs(2);
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(later).unwrap();
        let third = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        assert_ne!(third.pid, fresh.pid);
        assert_eq!(fresh.stopped().as_deref(), Some(RESTARTED));
        kernels.stop_all("fin du test");
    }

    #[tokio::test]
    async fn noyau_qui_meurt_et_demarrage_rate() {
        let Some(interpreter) = python() else { return };
        let dir = module(&[("fin.py", "import os\ndef quitter():\n    print('au revoir')\n    os._exit(3)\n")]);
        let kernels = Kernels::new(IDLE);
        let kernel = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &interpreter))).unwrap();
        let error = call(&kernel, json!({ "op": "run", "function": "fin.quitter" })).await.unwrap_err();
        assert!(error.message.contains("s’est arrêté"), "{}", error.message);
        assert!(kernels.running(dir.path()).is_none());

        let broken = Interpreter { program: PathBuf::from("/chemin/absent/python3"), args: Vec::new() };
        let error = kernels.get_or_start(dir.path(), || Ok(launch(dir.path(), &broken))).err().unwrap();
        assert!(error.message.contains("Impossible de lancer Python"), "{}", error.message);
    }
}
