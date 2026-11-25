//! Agents pilotés depuis Rust : Claude Code (`claude -p` en `stream-json`), Codex (`codex app-server`, types générés
//! depuis son JSON Schema) et OpenCode (`opencode serve` privé, client généré depuis son OpenAPI). L’interface n’a que
//! des commandes fermées (`session.rs`) et reçoit des événements normalisés (`event.rs`) ; elle ne choisit jamais le
//! programme, ses arguments ni son environnement, et ne parle aucun protocole.

mod claude;
mod codex;
mod content;
pub mod delegation;
pub mod event;
mod opencode;
mod process;
pub mod session;
pub mod watches;
pub mod window;
#[cfg(test)]
mod tests_reel;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{arg, AppError, AppResult};
use crate::state::AppState;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Claude,
    Codex,
    Opencode,
}

impl Provider {
    fn program(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

/// Chemin de recherche des programmes. Une application lancée depuis le Finder ou le menu Démarrer n’hérite pas du
/// PATH du terminal, où sont installés les CLI : on y ajoute celui du shell de connexion et les dossiers usuels.
pub(crate) fn search_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let separator = if cfg!(windows) { ';' } else { ':' };
        let mut entries: Vec<String> = Vec::new();
        let mut push = |entry: &str| {
            if !entry.is_empty() && !entries.iter().any(|known| known == entry) {
                entries.push(entry.to_string());
            }
        };
        for entry in std::env::var("PATH").unwrap_or_default().split(separator) {
            push(entry);
        }
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            if let Some(path) = login_shell_path(&shell, LOGIN_SHELL_WAIT) {
                for entry in path.split(':') {
                    push(entry.trim());
                }
            }
            let home = std::env::var("HOME").unwrap_or_default();
            for entry in ["/opt/homebrew/bin", "/usr/local/bin"] {
                push(entry);
            }
            for entry in [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin", ".opencode/bin", ".claude/local"] {
                push(&format!("{home}/{entry}"));
            }
        }
        #[cfg(windows)]
        {
            let var = |name: &str| std::env::var(name).ok();
            for registered in crate::windows_env::registered_path() {
                for entry in expand_env(&registered, var).split(';') {
                    push(entry.trim());
                }
            }
            for entry in windows_user_dirs(var) {
                push(&entry);
            }
        }
        entries.join(&separator.to_string())
    })
}

/// Attente du PATH du shell de connexion : au-delà, les chemins connus suffisent.
#[cfg(unix)]
const LOGIN_SHELL_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Le PATH vu par un shell de connexion (`$SHELL -l`), ou `None` s'il ne répond pas à temps.
///
/// `Command::output()` attend la fin de la sortie, pas celle du shell : si le profil laisse un processus qui garde
/// la sortie ouverte, ou si un autre processus lancé au même instant en hérite, la lecture ne finit jamais. Comme
/// `search_path` tient alors son `OnceLock`, toutes les commandes qui en dépendent (`app.info` compris) restaient
/// bloquées, et la fenêtre d'Alfred restait blanche. La lecture se fait donc dans un fil à part, avec un délai ; au
/// délai, le shell est arrêté et la lecture abandonnée.
#[cfg(unix)]
pub(crate) fn login_shell_path(shell: &str, wait: std::time::Duration) -> Option<String> {
    use std::io::Read;
    let mut child = Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = sender.send(text);
    });
    let path = receiver.recv_timeout(wait).ok();
    if path.is_none() {
        log::warn!("le shell de connexion n'a pas donné son PATH en {} s : chemins connus seulement", wait.as_secs());
        let _ = child.kill();
    }
    // Le shell est récolté dans un fil : il ne reste pas zombie, sans retenir l'appelant.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    path
}

/// Remplace les `%VARIABLE%` d’une valeur du registre, comme `ExpandEnvironmentStringsW` : une variable inconnue
/// reste écrite telle quelle.
#[cfg(any(windows, test))]
fn expand_env(text: &str, var: impl Fn(&str) -> Option<String>) -> String {
    let mut expanded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%').filter(|&end| end > 0).and_then(|end| var(&after[..end]).map(|value| (end, value))) {
            Some((end, value)) => {
                expanded.push_str(&value);
                rest = &after[end + 1..];
            }
            None => {
                expanded.push('%');
                rest = after;
            }
        }
    }
    expanded.push_str(rest);
    expanded
}

/// Dossiers où les installateurs usuels posent les CLI sous Windows. Une application ouverte depuis le menu
/// Démarrer garde le PATH de l’ouverture de session : un CLI installé depuis n’y figure pas encore.
#[cfg(any(windows, test))]
fn windows_user_dirs(var: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(appdata) = var("APPDATA").filter(|value| !value.is_empty()) {
        dirs.push(format!("{appdata}\\npm"));
    }
    if let Some(home) = var("USERPROFILE").filter(|value| !value.is_empty()) {
        for entry in [".local\\bin", ".bun\\bin", ".opencode\\bin", ".cargo\\bin"] {
            dirs.push(format!("{home}\\{entry}"));
        }
    }
    if let Some(local) = var("LOCALAPPDATA").filter(|value| !value.is_empty()) {
        for entry in ["pnpm", "Microsoft\\WinGet\\Links"] {
            dirs.push(format!("{local}\\{entry}"));
        }
    }
    dirs
}

/// Fichiers essayés, dans l’ordre. Sous Windows, un vrai exécutable passe avant un script `.cmd` ou `.bat`, quel
/// que soit son dossier : un script est lancé par `cmd.exe`, qui coupe la ligne de commande à 8 191 caractères et
/// pour lequel Rust refuse tout argument contenant un saut de ligne.
fn program_candidates(program: &str, path: &str, windows: bool) -> Vec<PathBuf> {
    let separator = if windows { ';' } else { ':' };
    let names: Vec<String> = if windows {
        ["exe", "cmd", "bat"].iter().map(|extension| format!("{program}.{extension}")).collect()
    } else {
        vec![program.to_string()]
    };
    names
        .iter()
        .flat_map(|name| {
            path.split(separator).filter(|dir| !dir.trim().is_empty()).map(move |dir| Path::new(dir.trim()).join(name))
        })
        .collect()
}

/// Emplacement du programme sur ce poste, ou `None` s’il n’est pas installé.
pub(crate) fn resolve_program(program: &str) -> Option<PathBuf> {
    program_candidates(program, search_path(), cfg!(windows)).into_iter().find(|candidate| candidate.is_file())
}


pub(crate) fn command(program: &Path, cwd: Option<&str>) -> Command {
    let mut command = Command::new(program);
    command.env("PATH", search_path());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

pub(crate) fn missing(provider: Provider) -> AppError {
    AppError::new(format!(
        "{} n’est pas installé sur ce poste, ou introuvable dans le PATH.",
        match provider {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
            Provider::Opencode => "OpenCode",
        }
    ))
}

pub(crate) fn checked_dir(path: &str) -> AppResult<&str> {
    if Path::new(path).is_dir() {
        Ok(path)
    } else {
        Err(AppError::new(format!("Le dossier de travail de l’agent est introuvable : {path}")))
    }
}

pub(crate) fn simple_value(name: &str, value: &str) -> AppResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 200
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/' | '[' | ']'));
    if valid {
        Ok(())
    } else {
        Err(AppError::new(format!("Option d’agent invalide : {name}.")))
    }
}

/// Destination des sorties d’un agent. Dans la fenêtre, comme dans OneApp, un `Channel` Tauri propre à la session :
/// rapide et sans perte. Le bus d’événements commun, borné, jette les messages quand la fenêtre prend du retard,
/// ce qui arrive sous Windows avec un CLI bavard comme Codex ; il ne sert plus qu’au pont de développement.
#[derive(Clone)]
pub enum Output {
    Events,
    Channel(tauri::ipc::Channel<Value>),
}

/// Ouvre une session dont les événements arrivent par `output` (voir `session::start`).
pub async fn spawn(state: &Arc<AppState>, args: &Value, output: Output) -> AppResult<Value> {
    session::start(state, args, output).await
}

/// Arrête tous les agents à la fermeture d’Alfred : aucun processus ne doit lui survivre.
pub fn shutdown() {
    session::shutdown();
}

/// Lit `loggedIn` dans la sortie JSON de `claude auth status` ; une sortie illisible laisse l’état inconnu.
fn claude_logged_in(stdout: &[u8]) -> Option<bool> {
    serde_json::from_slice::<Value>(stdout).ok()?.get("loggedIn")?.as_bool()
}

/// Vérifie l’installation d’un harnais : version et, quand le CLI sait le dire, état de la connexion.
async fn probe(args: &Value) -> AppResult<Value> {
    let provider: Provider = arg(args, "provider")?;
    let Some(program) = resolve_program(provider.program()) else {
        return Ok(json!({ "installed": false }));
    };
    let run = move |arguments: &'static [&'static str]| {
        let program = program.clone();
        tokio::task::spawn_blocking(move || command(&program, None).args(arguments).stdin(Stdio::null()).output())
    };
    let version = run(&["--version"]).await.map_err(|_| process::unavailable())?;
    let version = version
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or_default().trim().to_string());
    let logged_in = match provider {
        Provider::Codex => run(&["login", "status"]).await.ok().and_then(Result::ok).map(|output| output.status.success()),
        // `claude auth status` répond en JSON, avec un code de sortie non nul quand personne n’est connecté.
        Provider::Claude => run(&["auth", "status"]).await.ok().and_then(Result::ok).and_then(|output| claude_logged_in(&output.stdout)),
        // OpenCode n’a pas d’état de connexion unique : ses modèles gratuits répondent sans compte.
        Provider::Opencode => None,
    };
    Ok(json!({ "installed": version.is_some(), "version": version, "loggedIn": logged_in }))
}


pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if command == "agents.probe" {
        return Some(probe(args).await);
    }
    if command == "agents.skills" {
        return Some(codex::skills_command(args).await);
    }
    if command.starts_with("agents.tasks.") || command == "agents.coordinator.set" {
        return delegation::handle(state, command, args).await;
    }
    if command.starts_with("agents.watches.")
        || matches!(command, "frame.agents.watch" | "frame.agents.cancelWatch" | "frame.agents.owns")
    {
        return watches::handle(state, command, args).await;
    }
    session::handle(state, command, args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[cfg(unix)]
    #[test]
    fn login_shell_path_reads_the_path() {
        let path = login_shell_path("/bin/sh", std::time::Duration::from_secs(5)).expect("PATH du shell");
        assert!(!path.is_empty());
    }

    /// Un shell dont la sortie reste ouverte (ici, un processus en arrière-plan qui en hérite) ne bloque plus.
    #[cfg(unix)]
    #[test]
    fn login_shell_path_gives_up_when_the_output_never_closes() {
        let dir = std::env::temp_dir().join(format!("alfred-shell-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shell = dir.join("shell-bloque");
        std::fs::write(&shell, "#!/bin/sh\nsleep 30 &\nprintf %s /usr/bin\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let started = std::time::Instant::now();
        let path = login_shell_path(shell.to_str().unwrap(), std::time::Duration::from_millis(500));
        assert!(path.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_auth_status_gives_login_state() {
        assert_eq!(claude_logged_in(br#"{"loggedIn": false, "authMethod": "none"}"#), Some(false));
        assert_eq!(claude_logged_in(br#"{"loggedIn": true, "authMethod": "claude.ai"}"#), Some(true));
        assert_eq!(claude_logged_in(b"Not logged in"), None);
    }

    #[test]
    fn windows_executables_come_before_scripts() {
        let path = "C:\\Users\\camille\\AppData\\Roaming\\npm; ;C:\\Users\\camille\\.local\\bin";
        let names: Vec<String> =
            program_candidates("claude", path, true).iter().map(|path| path.to_string_lossy().replace('/', "\\")).collect();
        assert_eq!(
            names,
            [
                "C:\\Users\\camille\\AppData\\Roaming\\npm\\claude.exe",
                "C:\\Users\\camille\\.local\\bin\\claude.exe",
                "C:\\Users\\camille\\AppData\\Roaming\\npm\\claude.cmd",
                "C:\\Users\\camille\\.local\\bin\\claude.cmd",
                "C:\\Users\\camille\\AppData\\Roaming\\npm\\claude.bat",
                "C:\\Users\\camille\\.local\\bin\\claude.bat",
            ]
        );
        assert_eq!(program_candidates("codex", "/usr/bin::/opt/bin", false), [
            PathBuf::from("/usr/bin/codex"),
            PathBuf::from("/opt/bin/codex")
        ]);
    }

    #[test]
    fn registry_paths_are_expanded_like_windows() {
        let env = HashMap::from([("USERPROFILE", "C:\\Users\\c"), ("SystemRoot", "C:\\Windows")]);
        let var = |name: &str| env.get(name).map(|value| value.to_string());
        assert_eq!(
            expand_env("%USERPROFILE%\\.local\\bin;%SystemRoot%\\system32;%INCONNUE%\\bin;100%", var),
            "C:\\Users\\c\\.local\\bin;C:\\Windows\\system32;%INCONNUE%\\bin;100%"
        );
        assert_eq!(expand_env("%%USERPROFILE%", var), "%C:\\Users\\c");
    }

    #[test]
    fn usual_windows_install_folders_are_searched() {
        let env = HashMap::from([
            ("APPDATA", "C:\\Users\\c\\AppData\\Roaming"),
            ("USERPROFILE", "C:\\Users\\c"),
            ("LOCALAPPDATA", ""),
        ]);
        let dirs = windows_user_dirs(|name| env.get(name).map(|value| value.to_string()));
        assert!(dirs.contains(&"C:\\Users\\c\\AppData\\Roaming\\npm".to_string()));
        assert!(dirs.contains(&"C:\\Users\\c\\.local\\bin".to_string()));
        assert!(!dirs.iter().any(|dir| dir.starts_with('\\')), "une variable vide n’ajoute rien : {dirs:?}");
    }

}
