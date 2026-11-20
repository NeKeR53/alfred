//! Processus d’un harnais parlé ligne à ligne (Claude Code en `stream-json`, `codex app-server`) : Rust lit chaque
//! ligne de sa sortie, garde la fin de sa sortie d’erreur pour expliquer un arrêt, et seul le pilote du harnais écrit
//! sur son entrée. Rien de tout cela n’atteint l’interface.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::process_tree::{self, OwnedProcess};

/// Une ligne de plus de 8 Mo n’est pas un message du protocole : elle est ignorée.
const MAX_LINE: usize = 8 * 1024 * 1024;
const STDERR_TAIL: usize = 2000;

pub struct LineProcess {
    process: OwnedProcess,
    stdin: Mutex<Option<ChildStdin>>,
    stderr: Arc<Mutex<String>>,
}

pub fn unavailable() -> AppError {
    AppError::new("Le processus de l’agent n’est plus disponible.")
}

impl LineProcess {
    /// Lance `command` ; `on_line` reçoit chaque ligne de la sortie, puis `on_exit` le code de sortie, une fois la
    /// sortie entièrement lue : aucune ligne n’arrive après la fin.
    pub fn spawn(
        command: &mut Command,
        label: &str,
        on_line: impl FnMut(&str) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> AppResult<Arc<Self>> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut child, process) = process_tree::spawn(command)
            .map_err(|error| AppError::new(format!("Impossible de lancer {label} : {error}")))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let tail = Arc::new(Mutex::new(String::new()));
        let line_process =
            Arc::new(Self { process, stdin: Mutex::new(child.stdin.take()), stderr: tail.clone() });
        let reader = stdout.map(|stdout| std::thread::spawn(move || read_lines(stdout, on_line)));
        if let Some(mut stderr) = stderr {
            std::thread::spawn(move || {
                let mut buffer = [0_u8; 8192];
                while let Ok(count) = stderr.read(&mut buffer) {
                    if count == 0 {
                        return;
                    }
                    if let Ok(mut tail) = tail.lock() {
                        tail.push_str(&String::from_utf8_lossy(&buffer[..count]));
                        if tail.len() > STDERR_TAIL * 2 {
                            let cut = tail.len() - STDERR_TAIL;
                            let cut = (cut..tail.len()).find(|index| tail.is_char_boundary(*index)).unwrap_or(0);
                            tail.drain(..cut);
                        }
                    }
                }
            });
        }
        std::thread::spawn(move || {
            if let Some(reader) = reader {
                let _ = reader.join();
            }
            let code = child.wait().ok().and_then(|status| status.code());
            on_exit(code);
        });
        Ok(line_process)
    }

    /// Écrit un message JSON suivi d’un saut de ligne.
    pub fn write(&self, message: &Value) -> AppResult<()> {
        let mut line = serde_json::to_vec(message).map_err(|_| unavailable())?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().map_err(|_| unavailable())?;
        let stdin = stdin.as_mut().ok_or_else(unavailable)?;
        stdin.write_all(&line).and_then(|_| stdin.flush()).map_err(|_| unavailable())
    }

    /// Dernière ligne de la sortie d’erreur, expurgée.
    pub fn stderr_reason(&self) -> Option<String> {
        self.stderr.lock().ok().and_then(|tail| super::event::last_line(&tail))
    }

    /// Ferme l’entrée puis arrête tout l’arbre du processus.
    pub fn terminate(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        let _ = self.process.terminate();
    }
}

fn read_lines(stdout: impl Read, mut on_line: impl FnMut(&str)) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if line.len() > MAX_LINE {
                    continue;
                }
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                let text = String::from_utf8_lossy(&line);
                if !text.trim().is_empty() {
                    on_line(&text);
                }
            }
        }
    }
}
