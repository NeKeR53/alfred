//! Niveaux de Whisper téléchargés par Alfred : les modèles ggml de whisper.cpp, publiés dans le dépôt Hugging Face
//! `ggerganov/whisper.cpp` (`ggml-<niveau>.bin`). Ils passent par la source des modèles (Hugging Face ou le miroir de
//! l’entreprise) et le même code que les autres modèles locaux (`model_files`) : liste des fichiers, GET simple,
//! empreinte annoncée, cache Hugging Face partagé avec Python.
//!
//! Le dépôt range tous les niveaux : chacun est un modèle à part, reconnu dans n’importe quelle révision du cache
//! (télécharger un niveau avance `refs/main`, ceux déjà là restent dans la leur).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::model_files::{short_revision, Installed, ModelSpec};
use crate::state::AppState;

pub const REPO: &str = "ggerganov/whisper.cpp";
/// Événement poussé à l’interface quand un niveau change (téléchargement, choix).
pub const EVENT: &str = "voice:whisper";

pub struct Level {
    pub id: &'static str,
    pub spec: ModelSpec,
    /// Taille du fichier, annoncée avant le téléchargement.
    pub bytes: u64,
    /// Ce qu’il apporte, en une ligne.
    pub summary: &'static str,
}

const fn level(id: &'static str, file: &'static [&'static str], bytes: u64, summary: &'static str) -> Level {
    Level { id, spec: ModelSpec { repo: REPO, legacy_dir: "", legacy_revision: "", files: file }, bytes, summary }
}

/// Du plus léger au plus précis. Tous multilingues : le français est pris en charge par chacun.
pub const LEVELS: [Level; 6] = [
    level("tiny", &["ggml-tiny.bin"], 77_691_713, "Le plus rapide, mais beaucoup de fautes : pour essayer."),
    level("base", &["ggml-base.bin"], 147_951_465, "Très rapide, encore des fautes fréquentes en français."),
    level("small", &["ggml-small.bin"], 487_601_967, "Rapide et correct en français : pour un ordinateur modeste."),
    level("medium", &["ggml-medium.bin"], 1_533_763_059, "Précis en français, mais lent sans carte graphique."),
    level(
        "large-v3-turbo",
        &["ggml-large-v3-turbo.bin"],
        1_624_555_275,
        "Presque aussi précis que large-v3, plusieurs fois plus rapide.",
    ),
    level("large-v3", &["ggml-large-v3.bin"], 3_095_033_483, "Le plus précis, mais lent et gourmand en mémoire."),
];

pub fn find(id: &str) -> Option<&'static Level> {
    LEVELS.iter().find(|level| level.id == id)
}

impl Level {
    pub fn file(&self) -> &'static str {
        self.spec.files[0]
    }

    fn installed_in(&self, hub_cache: &std::path::Path) -> Option<Installed> {
        self.spec.installed_in_any_snapshot(hub_cache)
    }

    pub fn installed(&self) -> Option<Installed> {
        self.installed_in(&crate::model_files::hub_cache())
    }

    /// Le fichier ggml du niveau, s’il est téléchargé.
    pub fn path(&self) -> Option<PathBuf> {
        self.installed().map(|installed| installed.dir.join(self.file()))
    }
}

/// Mémoire vive de l’ordinateur, en octets.
fn total_memory() -> Option<u64> {
    #[cfg(unix)]
    {
        // SAFETY : sysconf ne lit que des constantes du système.
        let (pages, size) = unsafe { (libc::sysconf(libc::_SC_PHYS_PAGES), libc::sysconf(libc::_SC_PAGESIZE)) };
        (pages > 0 && size > 0).then(|| pages as u64 * size as u64)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY : la structure est initialisée avec sa taille, comme l’API le demande.
        (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullTotalPhys)
    }
}

const GIB: u64 = 1024 * 1024 * 1024;

/// Le niveau conseillé : large-v3-turbo dès 16 Go de mémoire, small en dessous. La voix d’Alfred garde déjà
/// quelques Go en mémoire ; large-v3-turbo en demande environ 2 de plus et small moins d’1.
pub fn recommended(memory: Option<u64>) -> &'static str {
    match memory {
        // Un peu de marge : « 16 Go » s’affiche parfois 15,9.
        Some(bytes) if bytes < 15 * GIB => "small",
        _ => "large-v3-turbo",
    }
}

fn recommended_reason(memory: Option<u64>) -> String {
    match memory {
        Some(bytes) if bytes < 15 * GIB => {
            format!("Conseillé avec {} Go de mémoire : la voix d’Alfred en garde déjà une partie.", bytes.div_ceil(GIB))
        }
        Some(bytes) => format!("Conseillé avec {} Go de mémoire.", bytes.div_ceil(GIB)),
        None => "Conseillé.".into(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Download {
    /// Niveau en cours, reçu, total.
    current: Option<(&'static str, u64, u64)>,
    /// Dernier échec : niveau et message.
    error: Option<(&'static str, String)>,
}

fn download_state() -> &'static Mutex<Download> {
    static STATE: OnceLock<Mutex<Download>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Download::default()))
}

fn model_error(message: String) -> AppError {
    AppError::new(message)
}

/// État des niveaux pour Réglages. `current` : le niveau choisi (absent : un fichier ggml indiqué à la main).
pub fn status(current: Option<&str>, custom: &std::path::Path) -> Value {
    let memory = total_memory();
    let download = download_state().lock().ok();
    let downloading = download.as_ref().and_then(|download| download.current);
    let error = download.as_ref().and_then(|download| download.error.clone());
    let levels: Vec<Value> = LEVELS
        .iter()
        .map(|level| {
            let installed = level.installed();
            json!({
                "id": level.id,
                "file": level.file(),
                "bytes": level.bytes,
                "summary": level.summary,
                "installed": installed.is_some(),
                "revision": installed.map(|installed| short_revision(&installed.revision)),
            })
        })
        .collect();
    json!({
        "repo": REPO,
        "levels": levels,
        "current": current,
        "custom": (!custom.as_os_str().is_empty()).then(|| custom.to_string_lossy().into_owned()),
        "recommended": recommended(memory),
        "recommendedReason": recommended_reason(memory),
        "downloading": downloading.map(|(level, received, total)| json!({ "level": level, "received": received, "total": total })),
        "error": error.map(|(level, message)| json!({ "level": level, "message": message })),
    })
}

/// Télécharge un niveau en arrière-plan ; `done` est appelé une fois le fichier en place. Un seul téléchargement à
/// la fois.
pub fn download<F, Fut>(state: Arc<AppState>, id: &str, done: F) -> AppResult<()>
where
    F: FnOnce(Arc<AppState>, &'static str) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let level = find(id).ok_or_else(|| AppError::new(format!("Niveau de Whisper inconnu : {id}.")))?;
    {
        let mut current = download_state().lock().map_err(|_| AppError::new("Téléchargement indisponible."))?;
        if let Some((other, _, _)) = current.current {
            return Err(AppError::new(format!("Whisper {other} est déjà en cours de téléchargement.")));
        }
        current.current = Some((level.id, 0, level.bytes));
        current.error = None;
    }
    tokio::spawn(async move {
        let notifier = state.clone();
        let notified = std::sync::atomic::AtomicU64::new(0);
        let result = crate::model_files::fetch(&level.spec, &state, level.bytes, model_error, move |received, total| {
            if let Ok(mut current) = download_state().lock() {
                current.current = Some((level.id, received, total));
            }
            if received >= notified.load(std::sync::atomic::Ordering::Relaxed) + 8 * 1024 * 1024 {
                notified.store(received, std::sync::atomic::Ordering::Relaxed);
                notifier.emit(EVENT, Value::Null);
            }
        })
        .await;
        if let Ok(mut current) = download_state().lock() {
            current.current = None;
            current.error = result.as_ref().err().map(|error| (level.id, error.message.clone()));
        }
        if result.is_ok() {
            done(state.clone(), level.id).await;
        }
        state.emit(EVENT, Value::Null);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn levels_name_the_ggml_files_of_whisper_cpp() {
        let files: Vec<&str> = LEVELS.iter().map(Level::file).collect();
        assert_eq!(
            files,
            [
                "ggml-tiny.bin",
                "ggml-base.bin",
                "ggml-small.bin",
                "ggml-medium.bin",
                "ggml-large-v3-turbo.bin",
                "ggml-large-v3.bin"
            ]
        );
        assert_eq!(find("large-v3-turbo").unwrap().spec.repo, "ggerganov/whisper.cpp");
        assert!(find("large-v2").is_none());
    }

    #[test]
    fn the_recommended_level_follows_the_memory() {
        assert_eq!(recommended(Some(8 * GIB)), "small");
        assert_eq!(recommended(Some(16 * GIB - 100 * 1024 * 1024)), "large-v3-turbo");
        assert_eq!(recommended(Some(64 * GIB)), "large-v3-turbo");
        assert_eq!(recommended(None), "large-v3-turbo");
        assert!(recommended_reason(Some(8 * GIB)).contains("8 Go"));
        assert!(total_memory().is_some_and(|bytes| bytes > GIB));
    }

    /// Un niveau téléchargé à une révision reste reconnu quand un autre avance `refs/main`.
    #[test]
    fn each_level_is_found_in_its_own_revision() {
        let hub = tempfile::tempdir().unwrap();
        let tiny = find("tiny").unwrap();
        let small = find("small").unwrap();
        let put = |level: &Level, revision: &str| {
            let dir = level.spec.snapshot_dir(hub.path(), revision);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(level.file()), "ggml").unwrap();
        };
        assert_eq!(tiny.installed_in(hub.path()), None);
        put(tiny, "ancienne");
        put(small, "nouvelle");
        let refs = tiny.spec.snapshot_dir(hub.path(), "x").parent().unwrap().parent().unwrap().join("refs");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(refs.join("main"), "nouvelle").unwrap();
        assert_eq!(small.installed_in(hub.path()).unwrap().revision, "nouvelle");
        let found = tiny.installed_in(hub.path()).unwrap();
        assert_eq!(found.revision, "ancienne");
        assert!(found.dir.join("ggml-tiny.bin").is_file());
        assert_eq!(find("medium").unwrap().installed_in(hub.path()), None);
        assert!(!Path::new(&found.dir).ends_with("nouvelle"));
    }
}
