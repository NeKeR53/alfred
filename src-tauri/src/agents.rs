//! Processus des harnais d’agents : Claude Code, Codex et OpenCode. L’interface nomme un harnais et des options
//! connues ; elle ne choisit jamais le programme, ses arguments libres ni son environnement. Le protocole de chaque
//! CLI est parlé côté interface, ligne à ligne, à travers ces processus.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::process_tree::{self, OwnedProcess};
use crate::state::AppState;

const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSIONS: usize = 32;
/// Marqueur de la configuration OpenCode, remplacé par le vrai jeton au lancement : l’interface ne le connaît jamais.
/// Il n’est jamais remplacé dans ce qui est écrit vers l’agent, qui peut contenir un texte venu d’une page.
pub const TOKEN_PLACEHOLDER: &str = "__ALFRED_MCP_TOKEN__";

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

/// Options de lancement de Claude Code que l’interface peut demander. Chacune est validée puis traduite en
/// arguments ; aucune chaîne libre ne devient un argument.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ClaudeOptions {
    model: Option<String>,
    effort: Option<String>,
    /// Session à reprendre.
    resume: Option<String>,
    /// `manual`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`.
    permission_mode: Option<String>,
    add_dirs: Vec<String>,
    append_system_prompt: Option<String>,
    /// Appel unique : aucun outil, aucune demande d’autorisation, rien n’est gardé dans l’historique du CLI.
    one_shot: bool,
    json_schema: Option<Value>,
}

struct Session {
    process: OwnedProcess,
    stdin: Mutex<Option<ChildStdin>>,
    token: Option<String>,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unavailable() -> AppError {
    AppError::new("Le processus de l’agent n’est plus disponible.")
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
            if let Ok(output) =
                Command::new(shell).args(["-l", "-c", "printf %s \"$PATH\""]).stdin(Stdio::null()).output()
            {
                for entry in String::from_utf8_lossy(&output.stdout).split(':') {
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
fn resolve_program(program: &str) -> Option<PathBuf> {
    program_candidates(program, search_path(), cfg!(windows)).into_iter().find(|candidate| candidate.is_file())
}

/// Une valeur de variable d’environnement tient-elle sous la limite de Windows (32 767 caractères, zéro final
/// compris) ? Ailleurs, seule la taille totale des arguments et de l’environnement est bornée, bien au-delà.
fn fits_in_environment(value: &str, windows: bool) -> bool {
    !windows || value.encode_utf16().count() < 32_767
}

/// Consignes de Claude Code, passées par fichier : en argument, des sauts de ligne empêchent de lancer un
/// `claude.cmd` sous Windows et la ligne de commande y est bornée à 32 767 caractères.
fn prompt_file(state: &AppState, session: &str) -> PathBuf {
    state.data_dir.join("consignes").join(format!("{session}.md"))
}

fn write_prompt(state: &AppState, session: &str, prompt: &str) -> AppResult<PathBuf> {
    let path = prompt_file(state, session);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, prompt)?;
    Ok(path)
}

fn command(program: &Path, cwd: Option<&str>) -> Command {
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

fn missing(provider: Provider) -> AppError {
    AppError::new(format!(
        "{} n’est pas installé sur ce poste, ou introuvable dans le PATH.",
        match provider {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
            Provider::Opencode => "OpenCode",
        }
    ))
}

fn checked_dir(path: &str) -> AppResult<&str> {
    if Path::new(path).is_dir() {
        Ok(path)
    } else {
        Err(AppError::new(format!("Le dossier de travail de l’agent est introuvable : {path}")))
    }
}

fn simple_value(name: &str, value: &str) -> AppResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 200
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/' | '[' | ']'));
    if valid {
        Ok(())
    } else {
        Err(AppError::new(format!("Option d’agent invalide : {name}.")))
    }
}

fn claude_arguments(
    options: &ClaudeOptions,
    mcp: Option<(&str, u16)>,
    prompt_file: Option<&Path>,
) -> AppResult<Vec<String>> {
    let mut args: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    if let Some(model) = &options.model {
        simple_value("modèle", model)?;
        args.extend(["--model".to_string(), model.clone()]);
    }
    if let Some(effort) = &options.effort {
        if !["low", "medium", "high", "xhigh", "max"].contains(&effort.as_str()) {
            return Err(AppError::new("Niveau d’effort inconnu."));
        }
        args.extend(["--effort".to_string(), effort.clone()]);
    }
    if let Some(prompt) = &options.append_system_prompt {
        if prompt.len() > 200_000 {
            return Err(AppError::new("Les consignes de l’agent sont trop longues."));
        }
        let file = prompt_file.ok_or_else(|| AppError::new("Les consignes de l’agent n’ont pas pu être préparées."))?;
        args.extend(["--append-system-prompt-file".to_string(), file.to_string_lossy().to_string()]);
    }
    if options.one_shot {
        // Aucun outil, aucune question, aucune trace : une transformation bornée, en un tour.
        args.extend(
            ["--tools", "", "--strict-mcp-config", "--permission-prompts", "none", "--no-session-persistence"]
                .iter()
                .map(|value| value.to_string()),
        );
        if let Some(schema) = &options.json_schema {
            args.extend(["--json-schema".to_string(), schema.to_string()]);
        }
        return Ok(args);
    }
    args.extend(["--include-partial-messages", "--permission-prompt-tool", "stdio"].iter().map(|v| v.to_string()));
    if let Some(resume) = &options.resume {
        if uuid::Uuid::parse_str(resume).is_err() {
            return Err(AppError::new("Identifiant de session Claude Code invalide."));
        }
        args.extend(["--resume".to_string(), resume.clone()]);
    }
    let mode = options.permission_mode.as_deref().unwrap_or("manual");
    if !["manual", "acceptEdits", "bypassPermissions", "plan", "dontAsk"].contains(&mode) {
        return Err(AppError::new("Mode d’autorisation inconnu."));
    }
    args.extend(["--permission-mode".to_string(), mode.to_string()]);
    for dir in &options.add_dirs {
        args.extend(["--add-dir".to_string(), checked_dir(dir)?.to_string()]);
    }
    if let Some((token, port)) = mcp {
        let config = json!({ "mcpServers": { "alfred": {
            "type": "http",
            "url": format!("http://127.0.0.1:{port}/mcp"),
            "headers": { "Authorization": format!("Bearer {token}") },
        }}});
        args.extend(["--mcp-config".to_string(), config.to_string()]);
    }
    Ok(args)
}

/// Destination des sorties d’un agent. Dans la fenêtre, comme dans OneApp, un `Channel` Tauri propre à la session :
/// rapide et sans perte. Le bus d’événements commun, borné, jette les messages quand la fenêtre prend du retard,
/// ce qui arrive sous Windows avec un CLI bavard comme Codex ; il ne sert plus qu’au pont de développement.
#[derive(Clone)]
pub enum Output {
    Events,
    Channel(tauri::ipc::Channel<Value>),
}

fn emit(state: &AppState, output: &Output, session: &str, payload: Value) {
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        object.insert("session".to_string(), Value::String(session.to_string()));
    }
    match output {
        Output::Events => state.emit("agent:output", payload),
        Output::Channel(channel) => {
            let _ = channel.send(payload);
        }
    }
}

fn forward_stdout(state: Arc<AppState>, output: Output, session: String, stdout: impl Read) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                emit(&state, &output, &session, json!({ "kind": "stdout", "line": String::from_utf8_lossy(&line) }));
            }
        }
    }
}

fn forward_stderr(state: Arc<AppState>, output: Output, session: String, mut stderr: impl Read) {
    let mut buffer = [0_u8; 8192];
    while let Ok(count) = stderr.read(&mut buffer) {
        if count == 0 {
            return;
        }
        emit(&state, &output, &session, json!({ "kind": "stderr", "chunk": String::from_utf8_lossy(&buffer[..count]) }));
    }
}

pub fn spawn(state: &Arc<AppState>, args: &Value, output: Output) -> AppResult<Value> {
    let provider: Provider = arg(args, "provider")?;
    let cwd: String = arg(args, "cwd")?;
    checked_dir(&cwd)?;
    // Conversation à laquelle rattacher les outils d’Alfred ; absente pour un appel unique ou une simple lecture.
    let conversation: Option<String> = opt_arg(args, "conversation")?;
    if sessions().lock().map_err(|_| unavailable())?.len() >= MAX_SESSIONS {
        return Err(AppError::new("Trop d’agents sont déjà lancés. Fermer une conversation avant d’en ouvrir une autre."));
    }
    let program = resolve_program(provider.program()).ok_or_else(|| missing(provider))?;
    let server = state.server()?;
    let token = conversation.as_ref().map(|conversation| {
        let token = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut tokens) = state.agent_tokens.lock() {
            tokens.insert(token.clone(), conversation.clone());
        }
        token
    });

    let id = uuid::Uuid::new_v4().to_string();
    let mut command = command(&program, Some(&cwd));
    match provider {
        Provider::Claude => {
            let options: ClaudeOptions = opt_arg(args, "claude")?.unwrap_or_default();
            let prompt = match &options.append_system_prompt {
                Some(prompt) if prompt.len() <= 200_000 => Some(write_prompt(state, &id, prompt)?),
                _ => None,
            };
            command.args(claude_arguments(
                &options,
                token.as_deref().map(|token| (token, server.port)),
                prompt.as_deref(),
            )?);
        }
        Provider::Codex => {
            command.arg("app-server");
            if let Some(token) = &token {
                command.env("ALFRED_MCP_TOKEN", token);
            }
        }
        Provider::Opencode => {
            command.arg("acp");
            if let Some(config) = opt_arg::<String>(args, "opencodeConfig")? {
                if config.len() > 256 * 1024 || serde_json::from_str::<Value>(&config).is_err() {
                    return Err(AppError::new("La configuration OpenCode de la session est invalide."));
                }
                let config = match &token {
                    Some(token) => config.replace(TOKEN_PLACEHOLDER, token),
                    None => config,
                };
                // Windows borne une variable d’environnement à 32 767 caractères : mieux vaut le dire que laisser
                // OpenCode démarrer avec une configuration tronquée ou absente.
                if !fits_in_environment(&config, cfg!(windows)) {
                    return Err(AppError::new("La configuration OpenCode de la session est trop longue pour Windows."));
                }
                command.env("OPENCODE_CONFIG_CONTENT", config);
            }
        }
    }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let (mut child, process): (Child, OwnedProcess) = process_tree::spawn(&mut command).map_err(|error| {
        let _ = std::fs::remove_file(prompt_file(state, &id));
        AppError::new(format!("Impossible de lancer {} : {error}", provider.program()))
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    sessions().lock().map_err(|_| unavailable())?.insert(
        id.clone(),
        Arc::new(Session { process, stdin: Mutex::new(child.stdin.take()), token: token.clone() }),
    );

    let reader = stdout.map(|stdout| {
        let (state, output, session) = (state.clone(), output.clone(), id.clone());
        std::thread::spawn(move || forward_stdout(state, output, session, stdout))
    });
    if let Some(stderr) = stderr {
        let (state, output, session) = (state.clone(), output.clone(), id.clone());
        std::thread::spawn(move || forward_stderr(state, output, session, stderr));
    }
    let (state, session) = (state.clone(), id.clone());
    std::thread::spawn(move || {
        // La sortie est vidée avant d’annoncer la fin : aucun message n’arrive après « closed ».
        if let Some(reader) = reader {
            let _ = reader.join();
        }
        let code = child.wait().ok().and_then(|status| status.code());
        forget(&state, &session);
        emit(&state, &output, &session, json!({ "kind": "closed", "code": code }));
    });
    Ok(json!({ "session": id }))
}

fn forget(state: &AppState, session: &str) {
    let _ = std::fs::remove_file(prompt_file(state, session));
    let removed = sessions().lock().ok().and_then(|mut sessions| sessions.remove(session));
    if let Some(token) = removed.and_then(|session| session.token.clone()) {
        if let Ok(mut tokens) = state.agent_tokens.lock() {
            tokens.remove(&token);
        }
    }
}

fn write(args: &Value) -> AppResult<Value> {
    let id: String = arg(args, "session")?;
    let data: String = arg(args, "data")?;
    if data.len() > MAX_INPUT_BYTES {
        return Err(AppError::new("Le message envoyé à l’agent est trop volumineux."));
    }
    let session = sessions().lock().map_err(|_| unavailable())?.get(&id).cloned().ok_or_else(unavailable)?;
    let mut stdin = session.stdin.lock().map_err(|_| unavailable())?;
    let stdin = stdin.as_mut().ok_or_else(unavailable)?;
    stdin.write_all(data.as_bytes()).and_then(|_| stdin.flush()).map_err(|_| unavailable())?;
    Ok(Value::Null)
}

async fn kill(args: &Value) -> AppResult<Value> {
    let id: String = arg(args, "session")?;
    let session = sessions().lock().map_err(|_| unavailable())?.get(&id).cloned();
    if let Some(session) = session {
        // Fermer l’entrée laisse au CLI une chance de s’arrêter seul avant l’arrêt de l’arbre.
        if let Ok(mut stdin) = session.stdin.lock() {
            stdin.take();
        }
        tokio::task::spawn_blocking(move || session.process.terminate()).await.map_err(|_| unavailable())??;
    }
    Ok(Value::Null)
}

/// Arrête tous les agents à la fermeture d’Alfred : aucun processus ne doit lui survivre.
pub fn shutdown() {
    let running: Vec<Arc<Session>> =
        sessions().lock().map(|sessions| sessions.values().cloned().collect()).unwrap_or_default();
    for session in running {
        let _ = session.process.terminate();
    }
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
    let version = run(&["--version"]).await.map_err(|_| unavailable())?;
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
    Some(match command {
        "agents.probe" => probe(args).await,
        "agents.spawn" => spawn(state, args, Output::Events),
        "agents.write" => write(args),
        "agents.kill" => kill(args).await,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn claude_auth_status_gives_login_state() {
        assert_eq!(claude_logged_in(br#"{"loggedIn": false, "authMethod": "none"}"#), Some(false));
        assert_eq!(claude_logged_in(br#"{"loggedIn": true, "authMethod": "claude.ai"}"#), Some(true));
        assert_eq!(claude_logged_in(b"Not logged in"), None);
    }

    use super::*;

    #[test]
    fn claude_arguments_come_only_from_validated_options() {
        let session = claude_arguments(
            &ClaudeOptions {
                model: Some("opus".into()),
                resume: Some("7a0c1c1e-5b0e-4a51-9d0f-0a3b0c9a1f10".into()),
                ..ClaudeOptions::default()
            },
            Some(("jeton", 4242)),
            None,
        )
        .unwrap();
        assert!(session.windows(2).any(|pair| pair == ["--permission-mode", "manual"]));
        assert!(session.iter().any(|value| value.contains("http://127.0.0.1:4242/mcp") && value.contains("Bearer jeton")));

        let one_shot = claude_arguments(
            &ClaudeOptions { one_shot: true, json_schema: Some(json!({ "type": "object" })), ..ClaudeOptions::default() },
            Some(("jeton", 4242)),
            None,
        )
        .unwrap();
        assert!(one_shot.windows(2).any(|pair| pair == ["--tools", ""]));
        assert!(!one_shot.iter().any(|value| value.contains("mcpServers")), "un appel unique n’a aucun outil");

        for invalid in [
            ClaudeOptions { model: Some("opus; rm -rf /".into()), ..ClaudeOptions::default() },
            ClaudeOptions { resume: Some("../../etc".into()), ..ClaudeOptions::default() },
            ClaudeOptions { permission_mode: Some("root".into()), ..ClaudeOptions::default() },
            ClaudeOptions { add_dirs: vec!["/dossier/absent".into()], ..ClaudeOptions::default() },
        ] {
            assert!(claude_arguments(&invalid, None, None).is_err());
        }
    }

    /// Les consignes multilignes partent par fichier : aucun argument ne porte de saut de ligne, ce qui empêcherait
    /// de lancer un `claude.cmd` sous Windows.
    #[test]
    fn instructions_go_through_a_file() {
        let options = ClaudeOptions {
            append_system_prompt: Some("Première ligne.\nDeuxième ligne.".into()),
            ..ClaudeOptions::default()
        };
        let file = Path::new("/donnees/consignes/session.md");
        let args = claude_arguments(&options, Some(("jeton", 4242)), Some(file)).unwrap();
        assert!(args.windows(2).any(|pair| pair[0] == "--append-system-prompt-file" && pair[1] == file.to_string_lossy()));
        assert!(!args.iter().any(|value| value == "--append-system-prompt"));
        assert!(!args.iter().any(|value| value.contains('\n') || value.contains('\r')), "{args:?}");
        assert!(claude_arguments(&options, None, None).is_err(), "sans fichier, les consignes ne partent pas");
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
    fn opencode_configuration_respects_the_windows_environment_limit() {
        assert!(fits_in_environment(&"a".repeat(32_766), true));
        assert!(!fits_in_environment(&"a".repeat(32_767), true));
        assert!(fits_in_environment(&"a".repeat(200_000), false));
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

    /// Une consigne écrite par une page peut contenir le marqueur du jeton : il part tel quel, le jeton des outils
    /// d’Alfred ne doit jamais se retrouver dans ce que lit le modèle.
    #[cfg(unix)]
    #[test]
    fn the_tools_token_never_reaches_what_the_agent_reads() {
        let (mut child, process) =
            process_tree::spawn(Command::new("cat").stdin(Stdio::piped()).stdout(Stdio::piped())).unwrap();
        let id = "session-de-test-jeton".to_string();
        sessions().lock().unwrap().insert(
            id.clone(),
            Arc::new(Session { process, stdin: Mutex::new(child.stdin.take()), token: Some("jeton-secret".into()) }),
        );
        let data = format!("{{\"text\":\"répète {TOKEN_PLACEHOLDER}\"}}\n");
        write(&json!({ "session": id, "data": data })).unwrap();
        sessions().lock().unwrap().remove(&id);
        let output = child.wait_with_output().unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(!text.contains("jeton-secret"), "{text}");
        assert!(text.contains(TOKEN_PLACEHOLDER), "{text}");
    }
    /// Diagnostic Windows, lancé à la main en CI (`cargo test -- --ignored windows_clis`) : Codex et OpenCode,
    /// installés par npm, sont lancés comme le fait Alfred et doivent répondre à leurs premières requêtes.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn windows_clis_answer_their_first_requests() {
        use std::sync::mpsc;
        use std::time::Duration;
        let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();
        let cwd_json = serde_json::to_string(&cwd).unwrap();
        let v1 = r#"{"permission":{"external_directory":"ask","alfred_*":"allow"},"mcp":{"alfred":{"type":"remote","url":"http://127.0.0.1:9/mcp","oauth":false,"headers":{"Authorization":"Bearer x"},"enabled":true}}}"#;
        let v2 = r#"{"permissions":[{"action":"external_directory","resource":"*","effect":"ask"}],"mcp":{"servers":{"alfred":{"type":"remote","url":"http://127.0.0.1:9/mcp","oauth":false,"codemode":false,"disabled":false,"headers":{"Authorization":"Bearer x"}}}}}"#;
        let cases: Vec<(&str, &str, Option<&str>, Vec<String>)> = vec![
            ("codex", "app-server", None, vec![
                r#"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"alfred","title":"Alfred","version":"0.1.0"},"capabilities":null}}"#.to_string(),
                r#"{"method":"initialized","params":{}}"#.to_string(),
                format!(r#"{{"method":"thread/start","id":2,"params":{{"cwd":{cwd_json},"approvalPolicy":"never","sandbox":"danger-full-access","ephemeral":true}}}}"#),
            ]),
            ("codex", "app-server", None, vec![
                r#"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"alfred","title":"Alfred","version":"0.1.0"},"capabilities":null}}"#.to_string(),
                r#"{"method":"initialized","params":{}}"#.to_string(),
                format!(r#"{{"method":"thread/start","id":2,"params":{{"cwd":{cwd_json},"approvalPolicy":"on-request","sandbox":"workspace-write","ephemeral":true}}}}"#),
            ]),
            ("opencode", "acp", Some(v2), vec![
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"alfred","version":"0.1.0"}}}"#.to_string(),
                format!(r#"{{"jsonrpc":"2.0","id":2,"method":"session/new","params":{{"cwd":{cwd_json},"mcpServers":[]}}}}"#),
            ]),
            ("opencode", "acp", Some(v1), vec![
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"alfred","version":"0.1.0"}}}"#.to_string(),
                format!(r#"{{"jsonrpc":"2.0","id":2,"method":"session/new","params":{{"cwd":{cwd_json},"mcpServers":[]}}}}"#),
            ]),
        ];
        let mut failures = Vec::new();
        for (program, subcommand, config, requests) in cases {
            let path = resolve_program(program).unwrap_or_else(|| panic!("{program} introuvable"));
            println!("=== {program} : {} ; configuration : {}", path.display(), config.unwrap_or("aucune"));
            let mut command = command(&path, Some(&cwd));
            if let Some(config) = config {
                command.env("OPENCODE_CONFIG_CONTENT", config);
            }
            let started = std::time::Instant::now();
            command.arg(subcommand).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let (mut child, process) = process_tree::spawn(&mut command).unwrap();
            let (sender, receiver) = mpsc::channel::<String>();
            let stdout = child.stdout.take().unwrap();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if sender.send(line).is_err() {
                        return;
                    }
                }
            });
            let mut stderr = child.stderr.take().unwrap();
            let errors = std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            });
            let mut stdin = child.stdin.take().unwrap();
            for request in &requests {
                let id = serde_json::from_str::<Value>(request).unwrap().get("id").cloned();
                println!("--> {request}");
                stdin.write_all(format!("{request}\n").as_bytes()).unwrap();
                stdin.flush().unwrap();
                let Some(id) = id else { continue };
                let answered = loop {
                    match receiver.recv_timeout(Duration::from_secs(90)) {
                        Ok(line) => {
                            println!("<-- [{:.1} s] {}", started.elapsed().as_secs_f32(), line.chars().take(600).collect::<String>());
                            if serde_json::from_str::<Value>(&line).ok().and_then(|value| value.get("id").cloned())
                                == Some(id.clone())
                            {
                                break true;
                            }
                        }
                        Err(_) => break false,
                    }
                };
                if !answered {
                    println!("!!! {program} : aucune réponse à la requête {id}");
                    failures.push(format!("{program} {} / {id}", config.map(|_| "(config)").unwrap_or("")));
                    break;
                }
            }
            drop(stdin);
            let _ = process.terminate();
            let _ = child.wait();
            println!("--- stderr de {program} :\n{}", errors.join().unwrap_or_default());
        }
        assert!(failures.is_empty(), "sans réponse : {failures:?}");
    }
}
