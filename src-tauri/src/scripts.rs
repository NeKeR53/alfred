//! Fonctions écrites en script : bash, PowerShell (pwsh) ou Python. Contrairement aux fonctions TypeScript, qui
//! tournent dans un cadre sans réseau ni disque, un script est un vrai processus lancé par Rust avec les droits de
//! l’utilisateur. Contrat : l’entrée arrive en JSON sur stdin ; stdout est la sortie (du JSON, sinon le texte tel
//! quel) ; un code de sortie non nul est une erreur dont le message est la fin de stderr.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::process_tree;

/// Langage d’une fonction. `ts` (par défaut) s’exécute dans l’interface, les autres sont des scripts.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    #[default]
    Ts,
    Bash,
    Pwsh,
    Python,
}

impl Runtime {
    pub fn extension(self) -> &'static str {
        match self {
            Runtime::Ts => "ts",
            Runtime::Bash => "sh",
            Runtime::Pwsh => "ps1",
            Runtime::Python => "py",
        }
    }

    pub fn is_script(self) -> bool {
        self != Runtime::Ts
    }

    pub fn is_ts(&self) -> bool {
        *self == Runtime::Ts
    }

    /// Nom de l’interpréteur et façon de l’installer, pour le message d’un interpréteur introuvable.
    fn missing_message(self) -> String {
        match self {
            Runtime::Ts => String::new(),
            Runtime::Bash => if cfg!(windows) {
                "Interpréteur bash introuvable : installer Git for Windows (Git Bash). Le bash de WSL n’est pas utilisé."
            } else {
                "Interpréteur bash introuvable dans le PATH."
            }
            .to_string(),
            Runtime::Pwsh => if cfg!(windows) {
                "Interpréteur PowerShell introuvable (ni pwsh ni powershell.exe)."
            } else {
                "Interpréteur PowerShell introuvable : installer PowerShell 7 (`brew install --cask powershell`), qui fournit `pwsh`."
            }
            .to_string(),
            Runtime::Python => if cfg!(windows) {
                "Interpréteur Python introuvable : installer Python 3 depuis python.org (l’alias du Microsoft Store ne suffit pas)."
            } else {
                "Interpréteur Python introuvable : installer Python 3 (`python3`)."
            }
            .to_string(),
        }
    }
}

/// Délai maximal d’un appel, comme pour une fonction TypeScript.
pub const TIMEOUT: Duration = Duration::from_secs(120);
/// Taille maximale de la sortie standard.
const MAX_STDOUT: usize = 1024 * 1024;
/// Fin de stderr gardée pour le message d’erreur et le journal.
const MAX_STDERR: usize = 64 * 1024;
/// Au-delà, les appels suivants sont refusés (un script qui s’appelle en boucle, par exemple).
const MAX_ACTIVE: usize = 40;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq)]
pub struct Interpreter {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Interpréteur d’un langage, cherché dans le PATH du shell de connexion (comme les CLI d’agent).
pub fn interpreter(runtime: Runtime) -> Option<Interpreter> {
    #[allow(unused_mut)]
    let mut extra = Vec::new();
    #[cfg(windows)]
    for variable in ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(variable) {
            extra.push(PathBuf::from(&base).join("Git").join("bin"));
            extra.push(PathBuf::from(&base).join("Programs").join("Git").join("bin"));
        }
    }
    find_interpreter(runtime, crate::agents::search_path(), cfg!(windows), &extra)
}

/// Un dossier que l’on n’utilise pas : le `bash.exe` de System32 lance WSL, et `WindowsApps` ne contient que des
/// alias qui ouvrent le Microsoft Store.
fn excluded(dir: &str, windows: bool) -> bool {
    let lower = dir.to_ascii_lowercase().replace('/', "\\");
    windows && (lower.ends_with("\\windows\\system32") || lower.contains("\\windowsapps"))
}

fn find_interpreter(runtime: Runtime, path: &str, windows: bool, extra: &[PathBuf]) -> Option<Interpreter> {
    let separator = if windows { ';' } else { ':' };
    let lookup = |name: &str, skip_system: bool| -> Option<PathBuf> {
        let file = if windows { format!("{name}.exe") } else { name.to_string() };
        path.split(separator)
            .filter(|dir| !dir.is_empty())
            .filter(|dir| !(skip_system && excluded(dir, windows)))
            .map(PathBuf::from)
            .chain(extra.iter().cloned())
            .map(|dir| dir.join(&file))
            .find(|candidate| candidate.is_file())
    };
    let found = |program: PathBuf, args: &[&str]| Interpreter {
        program,
        args: args.iter().map(|arg| arg.to_string()).collect(),
    };
    match runtime {
        Runtime::Ts => None,
        Runtime::Bash => lookup("bash", true).map(|program| found(program, &[])),
        Runtime::Pwsh => {
            let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
            lookup("pwsh", false)
                .or_else(|| if windows { lookup("powershell", false) } else { None })
                .map(|program| found(program, &args))
        }
        Runtime::Python => lookup("python3", true)
            .or_else(|| lookup("python", true))
            .map(|program| found(program, &[]))
            .or_else(|| if windows { lookup("py", false).map(|program| found(program, &["-3"])) } else { None }),
    }
}

/// Problème à signaler dans `check` pour une fonction en script, ou rien.
pub fn availability(runtime: Runtime) -> Option<String> {
    (runtime.is_script() && interpreter(runtime).is_none()).then(|| runtime.missing_message())
}

/// Appel d’un script.
pub struct ScriptCall {
    pub runtime: Runtime,
    pub file: PathBuf,
    /// Dossier courant du script : celui de son module.
    pub dir: PathBuf,
    /// Variables ajoutées à l’environnement réduit (`ALFRED_MODULE`…).
    pub env: Vec<(String, String)>,
    pub input: Value,
    pub timeout: Duration,
}

pub(crate) struct Slot;

impl Slot {
    pub(crate) fn take() -> AppResult<Self> {
        if ACTIVE.fetch_add(1, Ordering::SeqCst) >= MAX_ACTIVE {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
            return Err(AppError::new("Trop d’appels de fonctions en cours : une fonction s’appelle peut-être en boucle."));
        }
        Ok(Slot)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

pub async fn run(call: ScriptCall) -> AppResult<Value> {
    let slot = Slot::take()?;
    let result = tokio::task::spawn_blocking(move || run_blocking(&call))
        .await
        .map_err(|_| AppError::new("L’exécution du script a été interrompue."))?;
    drop(slot);
    result
}

/// Environnement réduit : de quoi trouver les programmes et le dossier de l’utilisateur, rien d’autre de la
/// session d’Alfred.
pub(crate) fn base_env() -> Vec<(String, String)> {
    let mut env = vec![("PATH".to_string(), crate::agents::search_path().to_string())];
    let kept: &[&str] = if cfg!(windows) {
        &[
            "SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "USERNAME",
            "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles",
            "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE", "OS",
        ]
    } else {
        &["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]
    };
    for name in kept {
        if let Ok(value) = std::env::var(name) {
            env.push((name.to_string(), value));
        }
    }
    // Une application ouverte depuis le Finder n’a pas de langue : les scripts liraient l’UTF-8 comme de l’ASCII.
    if !cfg!(windows) && std::env::var_os("LANG").is_none() {
        env.push(("LANG".to_string(), "en_US.UTF-8".to_string()));
    }
    for (name, value) in [("PYTHONUTF8", "1"), ("PYTHONIOENCODING", "utf-8"), ("PYTHONDONTWRITEBYTECODE", "1")] {
        env.push((name.to_string(), value.to_string()));
    }
    env
}

/// Lit tout le flux, n’en garde que `limit` octets (le début, ou la fin avec `tail`), et dit s’il a débordé.
fn drain(mut stream: impl Read, limit: usize, tail: bool) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut overflow = false;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                kept.extend_from_slice(&buffer[..read]);
                if kept.len() > limit {
                    overflow = true;
                    if tail {
                        kept.drain(..kept.len() - limit);
                    } else {
                        kept.truncate(limit);
                    }
                }
            }
        }
    }
    (kept, overflow)
}

/// Fin lisible de stderr, pour le message d’erreur.
fn stderr_message(stderr: &str) -> Option<String> {
    let text = stderr.trim();
    if text.is_empty() {
        return None;
    }
    let mut lines: Vec<&str> = text.lines().rev().filter(|line| !line.trim().is_empty()).take(5).collect();
    lines.reverse();
    let message = lines.join("\n");
    Some(if message.chars().count() > 1000 {
        let skipped = message.chars().count() - 1000;
        message.chars().skip(skipped).collect()
    } else {
        message
    })
}

/// La sortie : du JSON si stdout en contient, sinon le texte sans ses blancs finaux ; rien devient `null`.
pub fn parse_output(stdout: &str) -> Value {
    let text = stdout.trim_end();
    if text.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    // SAFETY: kill(2) on our own process group; a stale id only fails with ESRCH.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

/// Un programme à lancer, sans shell : le programme et ses arguments tels quels.
pub struct Process {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub dir: PathBuf,
    /// Variables ajoutées à l’environnement réduit.
    pub env: Vec<(String, String)>,
    pub input: Vec<u8>,
    pub timeout: Duration,
    /// Message quand le délai est dépassé et que le programme a été arrêté.
    pub timeout_message: String,
}

/// Ce que le programme a rendu.
pub struct ProcessOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// La sortie standard dépassait 1 Mo : elle est coupée.
    pub overflow: bool,
}

/// Lance un programme dans son propre groupe de processus (arrêté en entier au délai dépassé), avec
/// l’environnement réduit, et attend sa fin.
pub fn execute(process: &Process) -> AppResult<ProcessOutput> {
    let mut command = Command::new(&process.program);
    command
        .args(&process.args)
        .current_dir(&process.dir)
        .env_clear()
        .envs(base_env())
        .envs(process.env.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Un groupe de processus à lui : on arrête aussi ce que le programme a lancé en arrière-plan.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let (mut child, owned) = process_tree::spawn(&mut command)
        .map_err(|error| AppError::new(format!("Impossible de lancer {} : {error}", process.program.display())))?;
    let pid = child.id();
    #[cfg(not(unix))]
    let _ = pid;
    let stop = || {
        let _ = owned.terminate();
        #[cfg(unix)]
        kill_group(pid);
    };

    let input = process.input.clone();
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            // Un programme qui ne lit pas son entrée ferme le tube : l’erreur d’écriture est sans importance.
            let _ = stdin.write_all(&input);
        });
    }
    let (out_tx, out_rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let _ = out_tx.send(drain(stdout, MAX_STDOUT, false));
        });
    }
    let (err_tx, err_rx) = mpsc::channel();
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = err_tx.send(drain(stderr, MAX_STDERR, true));
        });
    }

    let deadline = Instant::now() + process.timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                stop();
                let _ = child.wait();
                return Err(AppError::new(process.timeout_message.clone()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                stop();
                return Err(AppError::new(format!("Attente du programme impossible : {error}")));
            }
        }
    };
    // Un processus resté en arrière-plan garde les tubes ouverts : on lui laisse un instant, puis on l’arrête.
    let collect = |rx: &mpsc::Receiver<(Vec<u8>, bool)>| {
        rx.recv_timeout(Duration::from_secs(2)).ok().or_else(|| {
            stop();
            rx.recv_timeout(Duration::from_secs(2)).ok()
        })
    };
    let (stdout, overflow) = collect(&out_rx).unwrap_or_default();
    let (stderr, _) = collect(&err_rx).unwrap_or_default();
    #[cfg(unix)]
    kill_group(pid);
    Ok(ProcessOutput {
        success: status.success(),
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        overflow,
    })
}

fn run_blocking(call: &ScriptCall) -> AppResult<Value> {
    let interpreter = interpreter(call.runtime).ok_or_else(|| AppError::new(call.runtime.missing_message()))?;
    if !call.file.is_file() {
        return Err(AppError::new("La fonction n’est pas encore écrite."));
    }
    let mut args = interpreter.args.clone();
    args.push(call.file.to_string_lossy().to_string());
    let output = execute(&Process {
        program: interpreter.program.clone(),
        args,
        dir: call.dir.clone(),
        env: call.env.clone(),
        input: serde_json::to_vec(&call.input)?,
        timeout: call.timeout,
        timeout_message: format!("La fonction n’a pas répondu en {} s : elle a été arrêtée.", call.timeout.as_secs()),
    })?;
    let stderr = output.stderr.as_str();
    let detail = |extra: Value| {
        let mut detail = json!({ "stderr": stderr.trim_end() });
        if let (Some(object), Value::Object(extra)) = (detail.as_object_mut(), extra) {
            object.extend(extra);
        }
        detail
    };

    if !output.success {
        let code = output.code.map(|code| code.to_string()).unwrap_or_else(|| "signal".to_string());
        let message = stderr_message(stderr).unwrap_or_else(|| format!("Le script s’est terminé avec le code {code}."));
        return Err(AppError::with_detail(message, detail(json!({ "exitCode": output.code }))));
    }
    if output.overflow {
        return Err(AppError::with_detail(
            format!("La sortie du script dépasse {} Mo.", MAX_STDOUT / (1024 * 1024)),
            detail(Value::Null),
        ));
    }
    Ok(parse_output(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let file = dir.join(name);
        std::fs::write(&file, body).unwrap();
        file
    }

    fn call(runtime: Runtime, file: PathBuf, input: Value) -> ScriptCall {
        let dir = file.parent().unwrap().to_path_buf();
        ScriptCall {
            runtime,
            file,
            dir,
            env: vec![("ALFRED_MODULE".to_string(), "essai".to_string())],
            input,
            timeout: Duration::from_secs(20),
        }
    }

    #[test]
    fn sortie_json_ou_texte() {
        assert_eq!(parse_output("{\"total\": 3}\n"), json!({ "total": 3 }));
        assert_eq!(parse_output("42\n"), json!(42));
        assert_eq!(parse_output("bonjour le monde  \n\n"), json!("bonjour le monde"));
        assert_eq!(parse_output("  \n"), Value::Null);
        assert_eq!(parse_output(""), Value::Null);
    }

    #[test]
    fn message_d_erreur_tire_de_stderr() {
        assert_eq!(stderr_message("\n  \n"), None);
        let long = (1..=8).map(|line| format!("ligne {line}")).collect::<Vec<_>>().join("\n");
        assert_eq!(stderr_message(&long).unwrap(), "ligne 4\nligne 5\nligne 6\nligne 7\nligne 8");
    }

    #[test]
    fn extension_et_serialisation() {
        assert_eq!(Runtime::Pwsh.extension(), "ps1");
        assert_eq!(serde_json::to_value(Runtime::Python).unwrap(), json!("python"));
        assert_eq!(serde_json::from_value::<Runtime>(json!("bash")).unwrap(), Runtime::Bash);
        assert!(serde_json::from_value::<Runtime>(json!("ruby")).is_err());
    }

    #[test]
    fn windows_ecarte_wsl_et_les_alias_du_store() {
        let root = tempfile::tempdir().unwrap();
        let make = |dir: &str, file: &str| {
            let dir = root.path().join(dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(file), "").unwrap();
            dir.to_string_lossy().to_string()
        };
        let wsl = make("Windows/System32", "bash.exe");
        let store = make("Microsoft/WindowsApps", "python.exe");
        let launcher = make("Python/Launcher", "py.exe");
        let git = make("Git/bin", "bash.exe");
        let powershell = make("WindowsPowerShell/v1.0", "powershell.exe");
        let path = [wsl.as_str(), store.as_str(), launcher.as_str(), powershell.as_str()].join(";");

        assert_eq!(find_interpreter(Runtime::Bash, &path, true, &[]), None);
        let bash = find_interpreter(Runtime::Bash, &path, true, &[PathBuf::from(&git)]).unwrap();
        assert_eq!(bash.program, PathBuf::from(&git).join("bash.exe"));
        let python = find_interpreter(Runtime::Python, &path, true, &[]).unwrap();
        assert_eq!(python.program, PathBuf::from(&launcher).join("py.exe"));
        assert_eq!(python.args, vec!["-3"]);
        let pwsh = find_interpreter(Runtime::Pwsh, &path, true, &[]).unwrap();
        assert_eq!(pwsh.program, PathBuf::from(&powershell).join("powershell.exe"));
        assert_eq!(pwsh.args.last().map(String::as_str), Some("-File"));
        // Hors Windows, pas de repli sur powershell.exe ni py.
        assert_eq!(find_interpreter(Runtime::Pwsh, &powershell, false, &[]), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_lit_stdin_et_renvoie_du_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = script(
            dir.path(),
            "saluer.sh",
            "nom=$(sed -E 's/.*\"nom\":\"([^\"]*)\".*/\\1/')\nprintf '{\"message\": \"Bonjour %s\", \"module\": \"%s\", \"dossier\": \"%s\"}' \"$nom\" \"$ALFRED_MODULE\" \"$(basename \"$PWD\")\"\n",
        );
        let output = run(call(Runtime::Bash, file, json!({ "nom": "Zoé" }))).await.unwrap();
        assert_eq!(output["message"], "Bonjour Zoé");
        assert_eq!(output["module"], "essai");
        assert_eq!(output["dossier"], dir.path().file_name().unwrap().to_string_lossy().as_ref());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_texte_brut_et_erreur() {
        let dir = tempfile::tempdir().unwrap();
        let text = script(dir.path(), "texte.sh", "echo 'pas du JSON'\n");
        assert_eq!(run(call(Runtime::Bash, text, json!({}))).await.unwrap(), json!("pas du JSON"));
        let failing = script(dir.path(), "echec.sh", "echo 'avant' >&2\necho 'compte introuvable' >&2\nexit 3\n");
        let error = run(call(Runtime::Bash, failing, json!({}))).await.unwrap_err();
        assert_eq!(error.message, "avant\ncompte introuvable");
        assert_eq!(error.detail.unwrap()["exitCode"], 3);
        let silent = script(dir.path(), "muet.sh", "exit 2\n");
        let error = run(call(Runtime::Bash, silent, json!({}))).await.unwrap_err();
        assert!(error.message.contains("code 2"), "{}", error.message);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delai_depasse_arrete_le_script_et_ses_enfants() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("vivant");
        let file = script(
            dir.path(),
            "lent.sh",
            &format!("(sleep 3; touch '{}') &\nsleep 30\n", marker.display()),
        );
        let mut slow = call(Runtime::Bash, file, json!({}));
        slow.timeout = Duration::from_millis(500);
        let started = Instant::now();
        let error = run(slow).await.unwrap_err();
        assert!(error.message.contains("n’a pas répondu"), "{}", error.message);
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_secs(4));
        assert!(!marker.exists(), "le processus en arrière-plan doit être arrêté");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sortie_trop_longue_refusee() {
        let dir = tempfile::tempdir().unwrap();
        let file = script(dir.path(), "bavard.sh", "head -c 2000000 /dev/zero | tr '\\0' 'a'\n");
        let error = run(call(Runtime::Bash, file, json!({}))).await.unwrap_err();
        assert!(error.message.contains("dépasse 1 Mo"), "{}", error.message);
    }

    #[tokio::test]
    async fn python_lit_stdin_et_renvoie_du_json() {
        if interpreter(Runtime::Python).is_none() {
            eprintln!("python absent : test sauté");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let file = script(
            dir.path(),
            "somme.py",
            "import json, os, sys\ndata = json.load(sys.stdin)\nprint(json.dumps({\"somme\": sum(data[\"nombres\"]), \"module\": os.environ[\"ALFRED_MODULE\"], \"texte\": \"été\"}))\n",
        );
        let output = run(call(Runtime::Python, file, json!({ "nombres": [1, 2, 3.5] }))).await.unwrap();
        assert_eq!(output, json!({ "somme": 6.5, "module": "essai", "texte": "été" }));
        assert!(!dir.path().join("__pycache__").exists());
    }

    #[tokio::test]
    async fn python_exception_devient_une_erreur() {
        if interpreter(Runtime::Python).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let file = script(dir.path(), "echec.py", "raise ValueError('montant négatif')\n");
        let error = run(call(Runtime::Python, file, json!({}))).await.unwrap_err();
        assert!(error.message.ends_with("ValueError: montant négatif"), "{}", error.message);
    }

    #[tokio::test]
    async fn pwsh_lit_stdin_et_renvoie_du_json() {
        if interpreter(Runtime::Pwsh).is_none() {
            eprintln!("pwsh absent : test sauté");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let file = script(
            dir.path(),
            "doubler.ps1",
            "$data = [Console]::In.ReadToEnd() | ConvertFrom-Json\n@{ double = $data.valeur * 2; module = $env:ALFRED_MODULE } | ConvertTo-Json -Compress\n",
        );
        let output = run(call(Runtime::Pwsh, file, json!({ "valeur": 21 }))).await.unwrap();
        assert_eq!(output, json!({ "double": 42, "module": "essai" }));
    }

    #[tokio::test]
    async fn interpreteur_absent_ou_fichier_absent() {
        let dir = tempfile::tempdir().unwrap();
        let error = run(call(Runtime::Bash, dir.path().join("absent.sh"), json!({}))).await.unwrap_err();
        let expected = if interpreter(Runtime::Bash).is_some() { "pas encore écrite" } else { "introuvable" };
        assert!(error.message.contains(expected), "{}", error.message);
    }
}
