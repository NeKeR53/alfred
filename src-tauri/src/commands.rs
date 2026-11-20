//! Commandes du poste : une page ou une fonction lance un programme installé sur l’ordinateur (`git`, `ffmpeg`,
//! `pandoc`, `python3`…) et lit sa sortie. Le programme se nomme sans chemin et Alfred le cherche dans le PATH ; il
//! est lancé sans shell (ses arguments passent tels quels, rien n’est interprété), dans le dossier du module, avec
//! l’environnement réduit des scripts et un délai. L’utilisateur accorde chaque programme une fois, à chaque page
//! (ou aux fonctions d’un module) : lancer un programme, c’est agir avec ses droits.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::scripts::{self, Process};
use crate::state::AppState;

const DEFAULT_TIMEOUT: u64 = 60;
const MAX_TIMEOUT: u64 = 120;
const MAX_ARGS: usize = 256;
const MAX_INPUT: usize = 1024 * 1024;

/// Un nom de programme : lettres, chiffres, `.`, `_`, `+`, `-` ; ni chemin, ni espace, ni rien qu’un shell lirait.
fn valid_program(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with(['.', '-'])
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// Chemin du programme dans le PATH du shell de connexion.
pub fn resolve(name: &str) -> AppResult<PathBuf> {
    if !valid_program(name) {
        return Err(AppError::new(format!(
            "Programme invalide : « {name} ». Donne son nom seul (« git », « ffmpeg »), sans chemin ni argument."
        )));
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    let candidates: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat", "com"].iter().map(|extension| format!("{name}.{extension}")).collect()
    } else {
        vec![name.to_string()]
    };
    crate::agents::search_path()
        .split(separator)
        .filter(|dir| !dir.is_empty())
        .flat_map(|dir| candidates.iter().map(move |file| PathBuf::from(dir).join(file)))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| AppError::new(format!("Le programme « {name} » est introuvable sur cet ordinateur.")))
}

pub struct Request {
    pub program: String,
    pub args: Vec<String>,
    pub input: Option<String>,
    pub timeout: Duration,
}

/// Lance le programme (accord déjà donné) et rend `{ code, ok, stdout, stderr, truncated }`. Un code de sortie non
/// nul n’est pas une erreur : c’est à l’appelant de le lire, comme un statut HTTP.
pub fn run(module_dir: PathBuf, env: Vec<(String, String)>, request: &Request) -> AppResult<Value> {
    if request.args.len() > MAX_ARGS {
        return Err(AppError::new(format!("Trop d’arguments : {MAX_ARGS} au plus.")));
    }
    if request.input.as_ref().is_some_and(|input| input.len() > MAX_INPUT) {
        return Err(AppError::new("L’entrée du programme dépasse 1 Mo."));
    }
    let program = resolve(&request.program)?;
    let _slot = scripts::Slot::take()?;
    std::fs::create_dir_all(&module_dir)?;
    let output = scripts::execute(&Process {
        program,
        args: request.args.clone(),
        dir: module_dir,
        env,
        input: request.input.clone().unwrap_or_default().into_bytes(),
        timeout: request.timeout,
        timeout_message: format!(
            "« {} » n’a pas répondu en {} s : le programme a été arrêté.",
            request.program,
            request.timeout.as_secs()
        ),
    })?;
    Ok(json!({
        "code": output.code,
        "ok": output.success,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "truncated": output.overflow,
    }))
}

async fn frame_run(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject: Subject = arg(args, "subject")?;
    let program: String = arg(args, "program")?;
    let request = Request {
        args: opt_arg::<Vec<String>>(args, "args")
            .map_err(|_| AppError::new("`args` est une liste de chaînes."))?
            .unwrap_or_default(),
        input: opt_arg(args, "input")?,
        timeout: Duration::from_secs(opt_arg::<u64>(args, "timeout")?.unwrap_or(DEFAULT_TIMEOUT).clamp(1, MAX_TIMEOUT)),
        program,
    };
    let path = resolve(&request.program)?;
    let space = state.space()?;
    crate::permissions::ensure(
        state,
        &subject,
        &format!("command:{}", request.program),
        &format!(
            "le lancement du programme « {} » ({}) avec les droits de votre compte",
            request.program,
            path.display()
        ),
    )
    .await?;
    let env = vec![
        ("ALFRED_MODULE".to_string(), subject.module.clone()),
        ("ALFRED_CALLER".to_string(), subject.reference.clone()),
        ("ALFRED_SPACE".to_string(), space.root.to_string_lossy().to_string()),
    ];
    // `cwd: { folder, path? }` : un dossier du poste accordé au module, au lieu du dossier du module.
    let module_dir = match args.get("cwd").filter(|cwd| !cwd.is_null()) {
        Some(cwd) => {
            let folder: String = arg(cwd, "folder").map_err(|_| AppError::new("`cwd.folder` : l’identifiant d’un dossier accordé."))?;
            let path: Option<String> = opt_arg(cwd, "path")?;
            crate::folders::resolve_dir(state, &subject.module, &folder, path.as_deref())?
        }
        None => space.module_dir(&subject.module),
    };
    let started = Instant::now();
    let summary = format!("{} {}", request.program, request.args.join(" ")).chars().take(200).collect::<String>();
    let result = tokio::task::spawn_blocking(move || run(module_dir, env, &request))
        .await
        .unwrap_or_else(|_| Err(AppError::new("La commande a été interrompue.")));
    let duration = Some(started.elapsed().as_millis() as u64);
    match &result {
        Ok(output) => crate::functions::journal(
            state,
            "command",
            &subject.reference,
            output["ok"] == true,
            duration,
            &format!("{summary} → code {}", output["code"]),
            Some(&json!({ "stderr": output["stderr"].as_str().map(|text| text.chars().take(2_000).collect::<String>()) })),
        ),
        Err(error) => crate::functions::journal(state, "command", &subject.reference, false, duration, &format!("{summary} : {}", error.message), None),
    }
    result
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "frame.commands.run" => Some(frame_run(state, args).await),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_is_named_never_a_path_nor_a_shell_line() {
        for bad in ["", "/bin/sh", "../x", "rm -rf", "a;b", "$(x)", "-c", ".hidden", "a/b"] {
            assert!(resolve(bad).is_err(), "{bad}");
        }
        assert!(resolve("programme-qui-n-existe-pas").unwrap_err().message.contains("introuvable"));
    }

    #[cfg(unix)]
    #[test]
    fn a_program_runs_without_a_shell_and_reports_its_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let request = |program: &str, args: &[&str], input: Option<&str>, timeout: u64| Request {
            program: program.into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            input: input.map(str::to_string),
            timeout: Duration::from_secs(timeout),
        };
        // Les arguments passent tels quels : rien n’est interprété par un shell.
        let echoed = run(dir.path().to_path_buf(), vec![], &request("echo", &["$HOME", "a;b", "`id`"], None, 10)).unwrap();
        assert_eq!(echoed["stdout"], "$HOME a;b `id`\n");
        assert_eq!(echoed["ok"], true);
        let counted = run(dir.path().to_path_buf(), vec![], &request("wc", &["-c"], Some("bonjour"), 10)).unwrap();
        assert_eq!(counted["stdout"].as_str().unwrap().trim(), "7");
        // Un code non nul n’est pas une erreur ; le dossier courant est celui du module.
        let failed = run(dir.path().to_path_buf(), vec![], &request("ls", &["absent"], None, 10)).unwrap();
        assert_eq!(failed["ok"], false);
        assert!(failed["code"].as_i64().unwrap() != 0);
        let here = run(dir.path().join("module"), vec![], &request("pwd", &[], None, 10)).unwrap();
        assert!(here["stdout"].as_str().unwrap().trim().ends_with("module"));
        // Un programme trop long est arrêté.
        let slow = run(dir.path().to_path_buf(), vec![], &request("sleep", &["5"], None, 1)).unwrap_err();
        assert!(slow.message.contains("n’a pas répondu"), "{}", slow.message);
    }
}
