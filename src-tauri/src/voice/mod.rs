//! Voix d’Alfred : dictée (Whisper local, par `whisper-server`) et lecture à voix haute (voix du système ou
//! Kokoro). Le moteur est repris d’Argos (`argos-voice`), sans l’écoute mains libres.
//!
//! Un seul micro pour toute l’application : la page Agent ou une page de l’espace l’ouvre, et seul celui qui l’a
//! ouvert peut le fermer. Une page de l’espace doit avoir l’accord de l’utilisateur (« le micro »), demandé une fois.
//! La lecture, elle, est une file unique : une nouvelle lecture coupe la précédente.

mod audio;
mod capture;
mod config;
mod engine;
mod error;
mod http;
mod sentences;
mod stt;
mod tts;
mod whisper;
mod whisper_models;

use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

pub use config::VoiceConfig;
pub use engine::{VoiceEngine, VoiceEvent};
pub use error::VoiceError;

use crate::app_db;
use crate::error::{arg, AppError, AppResult};
use crate::permissions::{self, Subject};
use crate::state::AppState;

/// Réglage de l’application qui garde la configuration vocale.
const SETTING: &str = "voice";
/// Événement poussé vers l’interface, avec un [`VoiceEvent`] pour charge.
const EVENT: &str = "voice:event";
/// Garde-fou d’une lecture attendue jusqu’au bout.
const MAX_SPEECH: Duration = Duration::from_secs(600);
/// Texte lu en une fois, au plus.
const MAX_SPEECH_CHARS: usize = 20_000;
/// Refus d’ouvrir le micro quand l’utilisateur a bloqué la dictée.
const DICTATION_BLOCKED: &str = "La dictée est bloquée (Réglages, onglet Voix).";
/// Propriétaire de l’écoute ouverte depuis la page Agent.
const AGENT_OWNER: &str = "agent";

#[derive(Default)]
struct Voice {
    /// Moteur construit à la première utilisation, refait quand les réglages changent.
    engine: Mutex<Option<Arc<VoiceEngine>>>,
    /// Qui écoute : `agent`, ou la clé d’accord de la page (`page:module/page`).
    owner: StdMutex<Option<String>>,
}

fn voice() -> &'static Voice {
    static VOICE: OnceLock<Voice> = OnceLock::new();
    VOICE.get_or_init(Voice::default)
}

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .app_db
        .lock()
        .map_err(|_| AppError::new("La base d’Alfred est indisponible."))
}

fn voice_error(error: VoiceError) -> AppError {
    let text = error.to_string();
    let mut chars = text.chars();
    let first = chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_default();
    AppError::new(format!("{first}{}.", chars.as_str().trim_end_matches('.')))
}

/// Paquets de la voix d’Alfred : mlx-audio sur Mac Apple Silicon (son diffusé pendant le calcul),
/// qwen-tts (PyTorch) ailleurs. soxr convertit la voix au taux du haut-parleur : sans lui, elle grésille.
const QWEN_PACKAGES: [&str; 3] = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    ["mlx-audio==0.6.5", "sounddevice", "soxr"]
} else {
    ["qwen-tts==0.1.1", "sounddevice", "soxr"]
};
/// La voix d’Alfred : l’échantillon cloné par Qwen3-TTS.
const ALFRED_REFERENCE: &[u8] = include_bytes!("alfred-majordome.wav");

/// Dossier des fichiers de la voix : environnement Python de Qwen, échantillon.
fn voice_dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("voice")
}

fn qwen_env(state: &AppState) -> std::path::PathBuf {
    voice_dir(state).join("qwen")
}

fn qwen_python(state: &AppState) -> std::path::PathBuf {
    let env = qwen_env(state);
    if cfg!(windows) {
        env.join("Scripts").join("python.exe")
    } else {
        env.join("bin").join("python")
    }
}

/// Les réglages, avec les chemins par défaut de la voix d’Alfred : le Python qu’Alfred installe, et
/// l’échantillon fourni avec l’application (écrit au besoin dans le dossier de la voix).
fn effective_config(state: &AppState) -> AppResult<VoiceConfig> {
    let mut config = load_config(state)?;
    // Réglage enregistré avant la version MLX, ou avec un ancien défaut MLX (pleine, puis grande en 8 bits) :
    // sur Mac Apple Silicon, la petite version 8 bits le remplace.
    if config.qwen_model == config::TORCH_QWEN_MODEL
        || config.qwen_model == config::MLX_BF16_QWEN_MODEL
        || config.qwen_model == config::MLX_LARGE_QWEN_MODEL
    {
        config.qwen_model = config::DEFAULT_QWEN_MODEL.into();
    }
    // Niveau de Whisper choisi : son fichier dans le cache, ou ce qui manque.
    if let Some(level) = config.whisper_level.clone() {
        match whisper_models::find(&level).and_then(whisper_models::Level::path) {
            Some(path) => config.whisper_model = path,
            None => {
                config.whisper_model = std::path::PathBuf::new();
                config.whisper_missing = Some(level);
            }
        }
    }
    if config.qwen_python.is_none() {
        config.qwen_python = Some(qwen_python(state));
    }
    if config.qwen_reference.is_none() {
        let path = voice_dir(state).join("alfred-majordome.wav");
        let current =
            std::fs::metadata(&path).map(|meta| meta.len() == ALFRED_REFERENCE.len() as u64);
        if !matches!(current, Ok(true)) {
            std::fs::create_dir_all(voice_dir(state))
                .and_then(|_| std::fs::write(&path, ALFRED_REFERENCE))
                .map_err(|error| {
                    AppError::new(format!("Écriture de la voix d’Alfred impossible : {error}"))
                })?;
        }
        config.qwen_reference = Some(path);
        config.qwen_reference_text = config::ALFRED_REFERENCE_TEXT.into();
    }
    Ok(config)
}

/// Installe la voix d’Alfred : un environnement Python avec `qwen-tts`, créé par `uv`. Le modèle
/// (≈ 4 Go) se télécharge ensuite au premier usage, s’il n’est pas déjà dans le cache de Hugging Face.
async fn install_qwen(state: &Arc<AppState>) -> AppResult<Value> {
    let uv = find_program("uv").ok_or_else(|| {
        AppError::new("L’installation passe par uv, introuvable : installez-le (brew install uv), puis réessayez.")
    })?;
    let env = qwen_env(state);
    std::fs::create_dir_all(voice_dir(state)).map_err(|error| {
        AppError::new(format!("Dossier de la voix impossible à créer : {error}"))
    })?;
    let run = |args: Vec<std::ffi::OsString>| {
        let uv = uv.clone();
        async move {
            let mut command = tokio::process::Command::new(&uv);
            command
                .args(&args)
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let output = tokio::time::timeout(Duration::from_secs(1200), command.output())
                .await
                .map_err(|_| AppError::new("L’installation de la voix a pris plus de 20 minutes."))?
                .map_err(|error| AppError::new(format!("uv n’a pas pu être lancé : {error}")))?;
            if output.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: Vec<&str> = stderr.lines().rev().take(6).collect();
            Err(AppError::new(format!(
                "L’installation de la voix a échoué : {}",
                tail.into_iter().rev().collect::<Vec<_>>().join(" ")
            )))
        }
    };
    run(vec![
        "venv".into(),
        "--allow-existing".into(),
        "--python".into(),
        "3.12".into(),
        env.clone().into(),
    ])
    .await?;
    let mut args: Vec<std::ffi::OsString> = vec![
        "pip".into(),
        "install".into(),
        "--python".into(),
        qwen_python(state).into(),
    ];
    args.extend(QWEN_PACKAGES.iter().map(Into::into));
    run(args).await?;
    reset().await;
    status(state)
}

/// Programme trouvé dans le PATH, ou dans les dossiers où Homebrew et uv l’installent.
fn find_program(name: &str) -> Option<std::path::PathBuf> {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.push(std::path::PathBuf::from(&home).join(".local").join("bin"));
        dirs.push(std::path::PathBuf::from(&home).join(".cargo").join("bin"));
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    dirs.into_iter()
        .map(|dir| dir.join(&file))
        .find(|path| path.is_file())
}

pub fn load_config(state: &AppState) -> AppResult<VoiceConfig> {
    let stored = app_db::get_setting(&*lock_db(state)?, SETTING)?;
    Ok(stored
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default())
}

/// Le moteur, construit au besoin, et la tâche qui relaie ses événements à l’interface.
async fn engine(state: &Arc<AppState>) -> AppResult<Arc<VoiceEngine>> {
    let mut config = effective_config(state)?;
    if !config.enabled {
        return Err(AppError::new(
            "La voix est désactivée (Réglages, onglet Voix).",
        ));
    }
    let mut slot = voice().engine.lock().await;
    if let Some(engine) = slot.as_ref() {
        return Ok(engine.clone());
    }
    // Le modèle de la voix d’Alfred se télécharge par la source des modèles (Hugging Face ou le miroir de
    // l’entreprise), même quand Alfred est ouvert depuis le Dock ou le menu Démarrer, sans les variables du terminal.
    if config.tts_backend == config::TTS_QWEN {
        config.hub_env = crate::model_files::python_env(state).await?;
    }
    // Voix d’Alfred pas encore installée : la voix du système parle en attendant.
    if config.tts_backend == config::TTS_QWEN && config.check_speech().is_err() {
        config.tts_backend = config::TTS_SYSTEM.into();
    }
    let engine = Arc::new(VoiceEngine::start(&config).map_err(voice_error)?);
    let mut events = engine.subscribe();
    let relay = Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => match relay.upgrade() {
                    Some(state) => {
                        state.emit(EVENT, serde_json::to_value(&event).unwrap_or(Value::Null))
                    }
                    None => return,
                },
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    *slot = Some(engine.clone());
    Ok(engine)
}

/// Charge la voix d’Alfred et le modèle de dictée en arrière-plan, pour que la première lecture et la
/// première dictée n’attendent pas leur chargement (≈ 10 s). Rien si la voix est coupée.
pub fn preload(state: Arc<AppState>) {
    tokio::spawn(async move {
        let Ok(config) = effective_config(&state) else {
            return;
        };
        // Seuls les modèles lents à charger méritent d’être préparés : la voix du système parle tout de suite.
        let alfred_voice = config.tts_backend == config::TTS_QWEN && config.check_speech().is_ok();
        let dictation = config.check().is_ok();
        if !config.enabled || !(alfred_voice || dictation) {
            return;
        }
        // Construire le moteur lance le processus de la voix d’Alfred, qui charge et préchauffe son modèle.
        let Ok(engine) = engine(&state).await else {
            return;
        };
        if dictation {
            let _ = engine.warm_up().await;
        }
    });
}

/// Active ou coupe la voix. Coupée, le moteur s’arrête et rend sa mémoire ; activée, il se recharge.
async fn set_enabled(state: &Arc<AppState>, enabled: bool) -> AppResult<Value> {
    let mut config = load_config(state)?;
    config.enabled = enabled;
    app_db::set_setting(&*lock_db(state)?, SETTING, &serde_json::to_value(config)?)?;
    reset().await;
    if enabled {
        preload(state.clone());
    }
    status(state)
}

/// Bloque ou permet la dictée, et active ou non la lecture des notifications, sans recharger le moteur. Bloquer la
/// dictée ferme le micro s’il est ouvert, sans rien transcrire.
async fn set_preferences(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let dictation: Option<bool> = crate::error::opt_arg(args, "dictation")?;
    let read_notifications: Option<bool> = crate::error::opt_arg(args, "readNotifications")?;
    let pause_send_ms: Option<u64> = crate::error::opt_arg(args, "pauseSendMs")?;
    let mut config = load_config(state)?;
    if let Some(pause) = pause_send_ms {
        config.pause_send_ms = pause.min(10_000);
    }
    if let Some(dictation) = dictation {
        config.dictation = dictation;
    }
    if let Some(read_notifications) = read_notifications {
        config.read_notifications = read_notifications;
    }
    app_db::set_setting(&*lock_db(state)?, SETTING, &serde_json::to_value(config)?)?;
    if dictation == Some(false) && owner().is_some() {
        if let Some(engine) = voice().engine.lock().await.as_ref() {
            engine.cancel().await;
        }
        set_owner(None);
    }
    status(state)
}

/// Arrête le moteur (micro, lecture, `whisper-server`) ; le prochain usage le refait avec les réglages du moment.
async fn reset() {
    let engine = voice().engine.lock().await.take();
    if let Some(engine) = engine {
        engine.shutdown().await;
    }
    *voice()
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn owner() -> Option<String> {
    voice()
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn set_owner(value: Option<String>) {
    *voice()
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
}

fn describe(owner: &str) -> String {
    match owner.strip_prefix("page:") {
        Some(page) => format!("la page {page}"),
        None => "la page Agent".into(),
    }
}

/// Ouvre le micro pour `who`. Le premier usage lance `whisper-server` et attend que le modèle soit chargé.
async fn listen_start(state: &Arc<AppState>, who: &str) -> AppResult<Value> {
    if !effective_config(state)?.dictation {
        return Err(AppError::new(DICTATION_BLOCKED));
    }
    match owner() {
        Some(current) if current == who => return Ok(Value::Null),
        Some(current) => {
            return Err(AppError::new(format!(
                "Le micro est déjà utilisé par {}.",
                describe(&current)
            )))
        }
        None => {}
    }
    let engine = engine(state).await?;
    engine.warm_up().await.map_err(voice_error)?;
    // Une autre écoute a pu s’ouvrir pendant le chargement du modèle.
    {
        let mut slot = voice()
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match slot.as_deref() {
            Some(current) if current != who => {
                return Err(AppError::new(format!(
                    "Le micro est déjà utilisé par {}.",
                    describe(current)
                )))
            }
            _ => *slot = Some(who.to_string()),
        }
    }
    if let Err(error) = engine.press().await {
        set_owner(None);
        return Err(voice_error(error));
    }
    Ok(Value::Null)
}

fn ensure_owner(who: &str) -> AppResult<()> {
    match owner() {
        Some(current) if current == who => Ok(()),
        Some(current) => Err(AppError::new(format!(
            "Le micro est utilisé par {}.",
            describe(&current)
        ))),
        None => Err(AppError::new("Aucune écoute n’est en cours.")),
    }
}

async fn listen_stop(state: &Arc<AppState>, who: &str) -> AppResult<Value> {
    ensure_owner(who)?;
    let engine = engine(state).await?;
    let result = engine.release().await;
    set_owner(None);
    let text = result.map_err(voice_error)?;
    Ok(json!({ "text": text }))
}

async fn listen_cancel(state: &Arc<AppState>, who: &str) -> AppResult<Value> {
    if owner().as_deref() != Some(who) {
        return Ok(Value::Null);
    }
    engine(state).await?.cancel().await;
    set_owner(None);
    Ok(Value::Null)
}

/// Lit `text` à voix haute, après avoir coupé la lecture en cours, et attend la fin. `interrupted` : la lecture a
/// été coupée (par une autre, par l’ouverture du micro ou par « Arrêter »).
async fn speak(state: &Arc<AppState>, text: &str) -> AppResult<Value> {
    let text: String = text.chars().take(MAX_SPEECH_CHARS).collect();
    if text.trim().is_empty() {
        return Ok(json!({ "interrupted": false }));
    }
    let engine = engine(state).await?;
    let mut events = engine.subscribe();
    engine.stop_speech();
    engine.speak_delta(&text);
    engine.finish_speech();
    let mut started = false;
    let mut failure = None;
    let waited = tokio::time::timeout(MAX_SPEECH, async {
        loop {
            match events.recv().await {
                Ok(VoiceEvent::SpeechStarted) => started = true,
                Ok(VoiceEvent::Error { message }) if started => failure = Some(message),
                Ok(VoiceEvent::SpeechFinished { interrupted }) if started => return interrupted,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return true,
            }
        }
    })
    .await;
    let interrupted = match waited {
        Ok(interrupted) => interrupted,
        Err(_) => {
            engine.stop_speech();
            true
        }
    };
    match failure {
        Some(message) if !interrupted => {
            Err(AppError::new(format!("Lecture impossible : {message}")))
        }
        _ => Ok(json!({ "interrupted": interrupted })),
    }
}

/// Commence une lecture au fil de l’eau : coupe ce qui se dit et prépare le moteur (chargé au besoin).
async fn stream_begin(state: &Arc<AppState>) -> AppResult<Value> {
    let engine = engine(state).await?;
    engine.stop_speech();
    Ok(Value::Null)
}

/// Ajoute du texte à la lecture en cours ; chaque phrase complète part aussitôt à la synthèse.
async fn stream_delta(text: &str) -> AppResult<Value> {
    if let Some(engine) = voice().engine.lock().await.as_ref() {
        let text: String = text.chars().take(MAX_SPEECH_CHARS).collect();
        engine.speak_delta(&text);
    }
    Ok(Value::Null)
}

/// Fin du texte : la dernière phrase est dite même sans ponctuation finale.
async fn stream_end() -> AppResult<Value> {
    if let Some(engine) = voice().engine.lock().await.as_ref() {
        engine.finish_speech();
    }
    Ok(Value::Null)
}

async fn stop_speaking() -> AppResult<Value> {
    if let Some(engine) = voice().engine.lock().await.as_ref() {
        engine.stop_speech();
    }
    Ok(Value::Null)
}

/// État pour les Réglages et le bouton micro : la dictée est-elle réglée, le serveur est-il trouvé ?
fn status(state: &AppState) -> AppResult<Value> {
    let config = effective_config(state)?;
    let listen = config
        .check()
        .and_then(|_| whisper::find_server(&config).map(|_| ()))
        .err()
        .map(|error| voice_error(error).message);
    let speak = config
        .check_speech()
        .err()
        .map(|error| voice_error(error).message);
    Ok(json!({
        "configured": config.configured(),
        "listenError": listen,
        "speakError": speak,
        "listening": owner().is_some(),
        "readReplies": config.read_replies,
        "enabled": config.enabled,
        "dictation": config.dictation,
        "readNotifications": config.read_notifications,
        "pauseSendMs": config.pause_send_ms,
        "qwenInstalled": qwen_python(state).is_file(),
    }))
}

/// Les niveaux de Whisper, pour Réglages.
fn whisper_levels(state: &AppState) -> AppResult<Value> {
    let config = load_config(state)?;
    Ok(whisper_models::status(
        config.whisper_level.as_deref(),
        &config.whisper_model,
    ))
}

/// Choisit un niveau déjà téléchargé : la dictée s’en sert tout de suite (le moteur est refait).
async fn use_whisper_level(state: &Arc<AppState>, id: &str) -> AppResult<Value> {
    let level = whisper_models::find(id)
        .ok_or_else(|| AppError::new(format!("Niveau de Whisper inconnu : {id}.")))?;
    if level.path().is_none() {
        return Err(AppError::new(format!(
            "Le modèle Whisper {id} n’est pas téléchargé."
        )));
    }
    let mut config = load_config(state)?;
    config.whisper_level = Some(level.id.to_string());
    app_db::set_setting(&*lock_db(state)?, SETTING, &serde_json::to_value(config)?)?;
    reset().await;
    preload(state.clone());
    state.emit(whisper_models::EVENT, Value::Null);
    whisper_levels(state)
}

/// Supprime un niveau téléchargé pour libérer la place. Si c’est celui de la dictée, le moteur est arrêté : la
/// dictée dit alors que le niveau n’est plus téléchargé, jusqu’à ce qu’un autre soit choisi.
async fn remove_whisper_level(state: &Arc<AppState>, id: &str) -> AppResult<Value> {
    let level = whisper_models::find(id)
        .ok_or_else(|| AppError::new(format!("Niveau de Whisper inconnu : {id}.")))?;
    if whisper_models::downloading() == Some(level.id) {
        return Err(AppError::new(format!(
            "Whisper {id} est en cours de téléchargement : attendez la fin pour le supprimer."
        )));
    }
    let in_use = load_config(state)?.whisper_level.as_deref() == Some(level.id);
    if in_use {
        // `whisper-server` lâche le fichier avant qu’il soit effacé.
        reset().await;
    }
    level
        .spec
        .remove_from_cache(&crate::model_files::hub_cache())
        .map_err(|error| AppError::new(format!("Whisper {id} n’a pas pu être supprimé : {error}.")))?;
    state.emit(whisper_models::EVENT, Value::Null);
    whisper_levels(state)
}

/// Télécharge un niveau par la source des modèles ; une fois là, la dictée s’en sert.
fn download_whisper_level(state: &Arc<AppState>, id: &str) -> AppResult<Value> {
    whisper_models::download(state.clone(), id, |state, level| async move {
        if let Err(error) = use_whisper_level(&state, level).await {
            eprintln!("[voix] niveau {level} téléchargé mais pas choisi : {}", error.message);
        }
    })?;
    whisper_levels(state)
}

/// Réglages repris d’Argos : la section `[voice]` de `~/.argos/config.toml` (sous Windows,
/// `%LOCALAPPDATA%\Argos\data\config.toml`). Rien n’est enregistré : les Réglages les montrent d’abord.
fn import_argos() -> AppResult<Value> {
    let candidates = [
        std::env::var_os("HOME").map(|home| {
            std::path::PathBuf::from(home)
                .join(".argos")
                .join("config.toml")
        }),
        std::env::var_os("LOCALAPPDATA").map(|dir| {
            std::path::PathBuf::from(dir)
                .join("Argos")
                .join("data")
                .join("config.toml")
        }),
    ];
    let Some(path) = candidates.into_iter().flatten().find(|path| path.is_file()) else {
        return Err(AppError::new(
            "Argos n’est pas installé sur cet ordinateur : aucun config.toml trouvé.",
        ));
    };
    let text = std::fs::read_to_string(&path).map_err(|error| {
        AppError::new(format!(
            "Lecture de {} impossible : {error}",
            path.display()
        ))
    })?;
    let config = VoiceConfig::from_argos_toml(&text).map_err(voice_error)?;
    Ok(serde_json::to_value(config)?)
}

/// Voix du système, pour les choisir dans les Réglages : `{ id, label, language }`.
async fn system_voices() -> AppResult<Value> {
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("say")
            .args(["-v", "?"])
            .output()
            .await
            .map_err(|error| AppError::new(format!("Liste des voix indisponible : {error}")))?;
        let voices: Vec<Value> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(parse_say_voice)
            .collect();
        Ok(Value::Array(voices))
    }
    #[cfg(windows)]
    {
        const SCRIPT: &str = "Add-Type -AssemblyName System.Speech; \
            (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | \
            ForEach-Object { $v = $_.VoiceInfo; [pscustomobject]@{ id = $v.Name; label = \"$($v.Name) ($($v.Gender), $($v.Age))\"; language = $v.Culture.Name } } | \
            ConvertTo-Json -Compress";
        let output = tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .creation_flags(0x0800_0000)
            .output()
            .await
            .map_err(|error| AppError::new(format!("Liste des voix indisponible : {error}")))?;
        let value: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Array(vec![]));
        Ok(if value.is_object() {
            Value::Array(vec![value])
        } else {
            value
        })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Ok(Value::Array(vec![]))
    }
}

/// Une ligne de `say -v '?'` : « Grandpa (Français (France)) fr_FR    # Bonjour… ».
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_say_voice(line: &str) -> Option<Value> {
    let (head, _) = line.split_once('#')?;
    let head = head.trim_end();
    let (name, language) = head.rsplit_once(char::is_whitespace)?;
    let name = name.trim();
    let valid = language.len() >= 5 && language.as_bytes()[2] == b'_';
    (valid && !name.is_empty())
        .then(|| json!({ "id": name, "label": name, "language": language.replace('_', "-") }))
}

/// Une page de l’espace : le micro demande l’accord de l’utilisateur, une fois.
async fn page_owner(state: &Arc<AppState>, args: &Value, microphone: bool) -> AppResult<String> {
    let subject: Subject = arg(args, "subject")?;
    if subject.kind == "function" {
        return Err(AppError::new(
            "Une fonction ne peut pas utiliser le micro : seule une page le peut.",
        ));
    }
    if microphone {
        // Dictée bloquée : refusée avant même de demander l’accord du micro.
        if !effective_config(state)?.dictation {
            return Err(AppError::new(DICTATION_BLOCKED));
        }
        permissions::ensure(state, &subject, "voice:microphone", "le micro").await?;
    }
    Ok(subject.key())
}

pub async fn handle(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Option<AppResult<Value>> {
    let result = match command {
        "voice.settings.get" => {
            load_config(state).and_then(|config| Ok(serde_json::to_value(config)?))
        }
        "voice.settings.set" => match arg::<VoiceConfig>(args, "config") {
            Ok(config) => {
                let saved = (|| {
                    app_db::set_setting(
                        &*lock_db(state)?,
                        SETTING,
                        &serde_json::to_value(config.expanded())?,
                    )
                })();
                reset().await;
                preload(state.clone());
                saved.and_then(|_| status(state))
            }
            Err(error) => Err(error),
        },
        "voice.enabled.set" => match arg::<bool>(args, "enabled") {
            Ok(enabled) => set_enabled(state, enabled).await,
            Err(error) => Err(error),
        },
        "voice.preferences.set" => set_preferences(state, args).await,
        "voice.status" => status(state),
        "voice.importArgos" => import_argos(),
        "voice.qwen.install" => install_qwen(state).await,
        "voice.whisper.levels" => whisper_levels(state),
        "voice.whisper.use" => match arg::<String>(args, "level") {
            Ok(level) => use_whisper_level(state, &level).await,
            Err(error) => Err(error),
        },
        "voice.whisper.remove" => match arg::<String>(args, "level") {
            Ok(level) => remove_whisper_level(state, &level).await,
            Err(error) => Err(error),
        },
        "voice.whisper.download" => match arg::<String>(args, "level") {
            Ok(level) => download_whisper_level(state, &level),
            Err(error) => Err(error),
        },
        "voice.voices" => system_voices().await,
        "voice.listen.start" => listen_start(state, AGENT_OWNER).await,
        "voice.listen.stop" => listen_stop(state, AGENT_OWNER).await,
        "voice.listen.cancel" => listen_cancel(state, AGENT_OWNER).await,
        "voice.speak" => match arg::<String>(args, "text") {
            Ok(text) => speak(state, &text).await,
            Err(error) => Err(error),
        },
        "voice.speak.stop" => stop_speaking().await,
        // Lecture au fil de l’eau d’une réponse que l’agent est encore en train d’écrire : chaque phrase est
        // dite dès qu’elle est complète, sans attendre la fin de la réponse.
        "voice.stream.begin" => stream_begin(state).await,
        "voice.stream.delta" => match arg::<String>(args, "text") {
            Ok(text) => stream_delta(&text).await,
            Err(error) => Err(error),
        },
        "voice.stream.end" => stream_end().await,
        "frame.voice.listen.start" => match page_owner(state, args, true).await {
            Ok(who) => listen_start(state, &who).await,
            Err(error) => Err(error),
        },
        "frame.voice.listen.stop" => match page_owner(state, args, false).await {
            Ok(who) => listen_stop(state, &who).await,
            Err(error) => Err(error),
        },
        "frame.voice.listen.cancel" => match page_owner(state, args, false).await {
            Ok(who) => listen_cancel(state, &who).await,
            Err(error) => Err(error),
        },
        // Parler n’expose rien : une page ou une fonction lit sans accord.
        "frame.voice.speak" => match arg::<String>(args, "text") {
            Ok(text) => speak(state, &text).await,
            Err(error) => Err(error),
        },
        "frame.voice.speak.stop" => stop_speaking().await,
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un ancien défaut de la voix d’Alfred (PyTorch, MLX pleine, MLX grande en 8 bits) est remplacé par le défaut
    /// actuel ; un modèle choisi à la main est gardé.
    #[test]
    fn an_old_default_model_gives_way_to_the_current_one() {
        let (state, _dir) = crate::clients::testing::test_state();
        for (stored, expected) in [
            (config::MLX_LARGE_QWEN_MODEL, config::DEFAULT_QWEN_MODEL),
            (config::MLX_BF16_QWEN_MODEL, config::DEFAULT_QWEN_MODEL),
            (config::TORCH_QWEN_MODEL, config::DEFAULT_QWEN_MODEL),
            ("mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit", "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit"),
        ] {
            let config = VoiceConfig { qwen_model: stored.into(), ..VoiceConfig::default() };
            app_db::set_setting(&*lock_db(&state).unwrap(), SETTING, &serde_json::to_value(config).unwrap()).unwrap();
            assert_eq!(effective_config(&state).unwrap().qwen_model, expected, "{stored}");
        }
    }

    #[test]
    fn voice_errors_read_as_sentences() {
        let error = voice_error(VoiceError::Config("la voix Kokoro est obligatoire".into()));
        assert_eq!(
            error.message,
            "Réglages vocaux invalides : la voix Kokoro est obligatoire."
        );
    }

    #[test]
    fn say_voices_are_parsed() {
        let voice = parse_say_voice(
            "Grandpa (Français (France)) fr_FR    # Bonjour, je m’appelle Grandpa.",
        )
        .unwrap();
        assert_eq!(voice["id"], "Grandpa (Français (France))");
        assert_eq!(voice["language"], "fr-FR");
        assert_eq!(
            parse_say_voice("Jacques             fr_FR    # Bonjour").unwrap()["id"].clone(),
            json!("Jacques")
        );
        assert!(parse_say_voice("ligne sans dièse").is_none());
    }

    #[test]
    fn owners_are_named_for_the_user() {
        assert_eq!(describe("agent"), "la page Agent");
        assert_eq!(describe("page:notes/liste"), "la page notes/liste");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn settings_round_trip_and_status_explain_what_is_missing() {
        let (state, _dir) = crate::clients::testing::test_state();
        let status = handle(&state, "voice.status", &json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status["configured"], false);
        assert!(status["listenError"]
            .as_str()
            .unwrap()
            .contains("modèle Whisper"));
        // Par défaut, la voix d’Alfred ; tant qu’elle n’est pas installée, Réglages le dit.
        assert!(status["speakError"]
            .as_str()
            .unwrap()
            .contains("pas installée"));
        assert_eq!(status["qwenInstalled"], false);

        let config = VoiceConfig {
            language: "en".into(),
            read_replies: false,
            ..VoiceConfig::default()
        };
        handle(&state, "voice.settings.set", &json!({ "config": config }))
            .await
            .unwrap()
            .unwrap();
        let stored = handle(&state, "voice.settings.get", &json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored["language"], "en");
        assert_eq!(stored["readReplies"], false);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_disabled_voice_neither_speaks_nor_listens() {
        let (state, _dir) = crate::clients::testing::test_state();
        let status = handle(&state, "voice.enabled.set", &json!({ "enabled": false }))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status["enabled"], false);
        let error = handle(&state, "voice.speak", &json!({ "text": "Bonjour." }))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error.message,
            "La voix est désactivée (Réglages, onglet Voix)."
        );
        let error = handle(&state, "voice.listen.start", &json!({}))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error.message,
            "La voix est désactivée (Réglages, onglet Voix)."
        );
        let stored = handle(&state, "voice.settings.get", &json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored["enabled"], false);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn blocked_dictation_keeps_the_microphone_closed() {
        let (state, _dir) = crate::clients::testing::test_state();
        let status = handle(
            &state,
            "voice.preferences.set",
            &json!({ "dictation": false, "readNotifications": true }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(status["dictation"], false);
        assert_eq!(status["readNotifications"], true);
        assert_eq!(
            status["enabled"], true,
            "la voix reste active pour la lecture"
        );
        let error = handle(&state, "voice.listen.start", &json!({}))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.message, DICTATION_BLOCKED);
        let subject = json!({ "kind": "page", "module": "notes", "reference": "notes/dicter" });
        let error = handle(
            &state,
            "frame.voice.listen.start",
            &json!({ "subject": subject }),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(error.message, DICTATION_BLOCKED);
        let stored = handle(&state, "voice.settings.get", &json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored["dictation"], false);
        assert_eq!(stored["readNotifications"], true);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_function_cannot_open_the_microphone() {
        let (state, _dir) = crate::clients::testing::test_state();
        let subject = json!({ "kind": "function", "module": "notes", "reference": "notes/dicter" });
        let error = handle(
            &state,
            "frame.voice.listen.start",
            &json!({ "subject": subject }),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.message.contains("seule une page"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn whisper_levels_are_listed_with_their_size_and_the_advice() {
        let (state, _dir) = crate::clients::testing::test_state();
        let levels = handle(&state, "voice.whisper.levels", &json!({}))
            .await
            .unwrap()
            .unwrap();
        let ids: Vec<&str> = levels["levels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|level| level["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"]);
        assert_eq!(levels["levels"][4]["file"], "ggml-large-v3-turbo.bin");
        assert!(levels["levels"][4]["bytes"].as_u64().unwrap() > 1_000_000_000);
        assert!(["small", "large-v3-turbo"].contains(&levels["recommended"].as_str().unwrap()));
        assert_eq!(levels["current"], Value::Null);
        assert_eq!(levels["custom"], Value::Null);
        let error = handle(&state, "voice.whisper.download", &json!({ "level": "large-v2" }))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.message, "Niveau de Whisper inconnu : large-v2.");
        let error = handle(&state, "voice.whisper.remove", &json!({ "level": "large-v2" }))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.message, "Niveau de Whisper inconnu : large-v2.");
        // Un fichier ggml indiqué à la main reste possible, sans niveau.
        let config = VoiceConfig {
            whisper_model: "/m/ggml.bin".into(),
            ..VoiceConfig::default()
        };
        handle(&state, "voice.settings.set", &json!({ "config": config }))
            .await
            .unwrap()
            .unwrap();
        let levels = handle(&state, "voice.whisper.levels", &json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(levels["custom"], "/m/ggml.bin");
        assert_eq!(levels["current"], Value::Null);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_without_listening_is_explained() {
        let (state, _dir) = crate::clients::testing::test_state();
        let error = handle(&state, "voice.listen.stop", &json!({}))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.message, "Aucune écoute n’est en cours.");
    }
}
