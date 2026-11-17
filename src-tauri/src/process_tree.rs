//! Arrêt complet d’un CLI d’agent (Claude Code, Codex, OpenCode) lancé par `agents`.
//!
//! Tuer le seul processus direct ne suffit pas, surtout par SIGKILL sur macOS. Or `codex` est souvent un script Node qui lance
//! le vrai binaire : SIGKILL ne peut pas être relayé, si bien que `codex app-server`, ses serveurs MCP et ses
//! commandes restaient vivants après l’archivage d’un agent. `terminate_tree` arrête tout l’arbre, en commençant par
//! une demande d’arrêt propre.
use crate::error::AppError;
use std::collections::{HashMap, HashSet};

/// Délai laissé aux processus pour s’arrêter proprement avant l’arrêt forcé.
#[cfg(not(windows))]
const GRACE_PERIOD: std::time::Duration = std::time::Duration::from_millis(1_500);

fn error() -> AppError {
    AppError::new("Impossible d’arrêter le processus de l’agent.")
}

/// Processus vivants et leur parent.
#[cfg(not(windows))]
fn parent_map() -> Result<HashMap<u32, u32>, AppError> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-Ao", "pid=,ppid="])
        .output()
        .map_err(|_| error())?;
    if !output.status.success() {
        return Err(error());
    }
    Ok(parse_parent_map(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(not(windows))]
fn parse_parent_map(text: &str) -> HashMap<u32, u32> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            Some((pid, ppid))
        })
        .collect()
}

#[cfg(windows)]
fn parent_map() -> Result<HashMap<u32, u32>, AppError> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };
    // SAFETY: Read-only snapshot of the process table; the handle is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(error());
    }
    let mut parents = HashMap::new();
    // SAFETY: PROCESSENTRY32W accepts zero-initialization with dwSize filled below.
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: Snapshot and entry are valid for the enumeration calls.
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) };
    while available != 0 {
        parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        // SAFETY: Same valid snapshot and entry used by Process32FirstW.
        available = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: The snapshot handle is owned by this function.
    unsafe { CloseHandle(snapshot) };
    Ok(parents)
}

/// Le processus et tous ses descendants, parents d’abord.
fn process_tree(root: u32, parents: &HashMap<u32, u32>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &ppid) in parents {
        if pid != ppid {
            children.entry(ppid).or_default().push(pid);
        }
    }
    let mut tree = vec![root];
    let mut seen = HashSet::from([root]);
    let mut index = 0;
    while index < tree.len() {
        for &child in children.get(&tree[index]).into_iter().flatten() {
            if seen.insert(child) {
                tree.push(child);
            }
        }
        index += 1;
    }
    tree
}

/// Seul un enfant direct de Alfred peut être arrêté : un identifiant recyclé ou étranger est ignoré.
fn owned_tree(pid: u32, parents: &HashMap<u32, u32>) -> Option<Vec<u32>> {
    (parents.get(&pid) == Some(&std::process::id())).then(|| process_tree(pid, parents))
}

#[cfg(not(windows))]
pub(crate) fn terminate_tree(pid: u32) -> Result<(), AppError> {
    let Some(tree) = owned_tree(pid, &parent_map()?) else {
        return Ok(());
    };
    let signal = |pids: &[u32], signal: i32| {
        for &pid in pids {
            // SAFETY: kill(2) only sends a signal; every pid belongs to the verified agent tree.
            unsafe { libc::kill(pid as libc::pid_t, signal) };
        }
    };
    signal(&tree, libc::SIGTERM);
    let started = std::time::Instant::now();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let alive = parent_map()?;
        let survivors: Vec<u32> = tree
            .iter()
            .copied()
            .filter(|pid| alive.contains_key(pid))
            .collect();
        if survivors.is_empty() {
            return Ok(());
        }
        if started.elapsed() >= GRACE_PERIOD {
            signal(&survivors, libc::SIGKILL);
            return Ok(());
        }
    }
}

#[cfg(windows)]
pub(crate) fn terminate_tree(pid: u32) -> Result<(), AppError> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    if owned_tree(pid, &parent_map()?).is_none() {
        return Ok(());
    }
    // taskkill /T parcourt lui-même l’arbre tant que la racine est vivante.
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| error())?;
    Ok(())
}

/// Processus d’agent lancé par Alfred. Comme dans OneApp, il est lancé directement, sans Job Object ; son arrêt
/// parcourt tout son arbre (`taskkill /T` sous Windows).
pub(crate) struct OwnedProcess {
    pid: u32,
}

impl OwnedProcess {
    /// Arrête le processus et tous ses descendants.
    pub(crate) fn terminate(&self) -> Result<(), AppError> {
        terminate_tree(self.pid)
    }
}

/// Lance `command` en gardant de quoi arrêter tout son arbre.
pub(crate) fn spawn(command: &mut std::process::Command) -> std::io::Result<(std::process::Child, OwnedProcess)> {
    // Sous Windows, un programme en mode console (script, interpréteur, outil du poste) ouvrirait sa propre
    // fenêtre noire à chaque lancement : il tourne sans fenêtre, sa sortie est lue par Alfred.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = command.spawn()?;
    let pid = child.id();
    Ok((child, OwnedProcess { pid }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbre_complet_et_limite_aux_enfants_de_alfred() {
        let me = std::process::id();
        // Alfred → wrapper Node (10) → binaire codex (11) → serveurs MCP (12, 13) ; 20 n’appartient pas à Alfred.
        let parents = HashMap::from([(10, me), (11, 10), (12, 11), (13, 11), (20, 1), (21, 20)]);
        let mut tree = owned_tree(10, &parents).expect("enfant de Alfred");
        assert_eq!(tree.remove(0), 10);
        tree.sort_unstable();
        assert_eq!(tree, vec![11, 12, 13]);
        assert_eq!(owned_tree(20, &parents), None);
        assert_eq!(owned_tree(99, &parents), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn arrete_un_enfant_et_ses_descendants() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .spawn()
            .expect("processus de test");
        std::thread::sleep(std::time::Duration::from_millis(200));
        let grandchildren = process_tree(child.id(), &parent_map().unwrap());
        assert!(grandchildren.len() >= 2, "le shell doit avoir lancé sleep");
        terminate_tree(child.id()).unwrap();
        child.wait().unwrap();
        let alive = parent_map().unwrap();
        assert!(grandchildren.iter().all(|pid| !alive.contains_key(pid)));
    }

    #[cfg(not(windows))]
    #[test]
    fn lit_la_table_des_processus() {
        let parents = parse_parent_map("  1     0\n 42 1\nligne invalide\n");
        assert_eq!(parents.get(&42), Some(&1));
        assert_eq!(parents.len(), 2);
    }
}
