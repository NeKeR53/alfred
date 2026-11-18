//! Réglages vocaux d'Alfred, gardés en JSON dans les réglages de l'application (clé `voice`).
//! Ceux d'Argos (section `[voice]` de `~/.argos/config.toml`) peuvent être repris tels quels.

use crate::voice::VoiceError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// En dessous, les requêtes partielles se marchent dessus sans rien apporter.
const MIN_PARTIAL_INTERVAL_MS: u64 = 100;

/// Synthèse : la voix d'Alfred (Qwen3-TTS en local, voix clonée), la voix du système (`say` sur
/// macOS, SAPI sous Windows) ou Kokoro en local.
pub const TTS_QWEN: &str = "qwen";
pub const TTS_SYSTEM: &str = "system";
pub const TTS_KOKORO: &str = "kokoro";

/// Modèle Qwen3-TTS qui clone la voix de référence.
/// Sur Mac Apple Silicon, la petite version (0.6B) MLX compressée en 8 bits, choisie à l'écoute : premier son
/// en moins de 0,2 s, calcul quatre fois plus rapide que la parole, et assez légère pour ne pas pousser le Mac
/// à relire son swap pendant le calcul (ce qui fait grésiller tout le son du système). Ailleurs, la version
/// PyTorch.
pub const DEFAULT_QWEN_MODEL: &str = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    MLX_QWEN_MODEL
} else {
    TORCH_QWEN_MODEL
};
pub const MLX_QWEN_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit";
/// Grande version MLX 8 bits, le défaut précédent : remplacée par la petite.
pub const MLX_LARGE_QWEN_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit";
/// Version MLX pleine (bf16), un défaut plus ancien : remplacée aussi.
pub const MLX_BF16_QWEN_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16";
pub const TORCH_QWEN_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-1.7B-Base";
/// Ce que dit l'échantillon de la voix d'Alfred (`alfred-majordome.wav`).
pub const ALFRED_REFERENCE_TEXT: &str = "Bonsoir, Monsieur. J'ai rangé vos rendez-vous de demain et préparé le résumé de vos messages. Souhaitez-vous que je vous en fasse la lecture ?";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceConfig {
    /// Niveau de Whisper téléchargé par Alfred (`small`, `large-v3-turbo`…). Absent : le fichier `whisper_model`.
    pub whisper_level: Option<String>,
    /// Modèle ggml de Whisper indiqué à la main, pour qui l'a déjà ; vide tant que la voix n'est pas configurée.
    /// `~/` est développé. Avec un niveau choisi, c'est le fichier du niveau (calculé, jamais enregistré).
    pub whisper_model: PathBuf,
    /// Le niveau choisi n'est pas téléchargé (calculé, jamais enregistré).
    #[serde(skip)]
    pub whisper_missing: Option<String>,
    /// Binaire `whisper-server` (whisper.cpp), cherché dans le PATH s'il n'a pas de dossier.
    pub whisper_server: PathBuf,
    pub language: String,
    /// Voix de la synthèse du système (vide : celle par défaut).
    pub voice: String,
    /// Débit de la voix du système, en mots par minute (0 : celui de la voix).
    pub rate: u32,
    pub tts_backend: String,
    pub kokoro_python: Option<PathBuf>,
    pub kokoro_model: Option<PathBuf>,
    pub kokoro_voices: Option<PathBuf>,
    pub kokoro_voice: String,
    /// Python où `qwen-tts` est installé ; absent : celui qu'Alfred installe.
    pub qwen_python: Option<PathBuf>,
    pub qwen_model: String,
    /// Échantillon de la voix à cloner ; absent : la voix d'Alfred, fournie avec l'application.
    pub qwen_reference: Option<PathBuf>,
    /// Texte exact de l'échantillon.
    pub qwen_reference_text: String,
    pub partial_interval_ms: u64,
    /// Lire à voix haute la réponse de l'agent à une demande dictée.
    pub read_replies: bool,
    /// La voix est active : dictée, lecture et voix d'Alfred préchargée au démarrage. Coupée, rien ne
    /// tourne et la mémoire du modèle est rendue.
    pub enabled: bool,
    /// La dictée est permise. Bloquée, le micro ne s'ouvre pour personne (page Agent ou page de l'espace),
    /// même si l'on parle ; la lecture à voix haute reste possible.
    pub dictation: bool,
    /// Lire à voix haute les notifications des pages et des fonctions de l'espace (`shell.notify`).
    pub read_notifications: bool,
    /// Dictée dans la page Agent : un silence de cette durée après avoir parlé termine la dictée et envoie
    /// le message, comme un clic sur le bouton. 0 : jamais, la dictée se termine au clic.
    pub pause_send_ms: u64,
    /// Source, jeton et cache de Hugging Face pour le programme Python de la voix d'Alfred (calculés au lancement,
    /// jamais enregistrés).
    #[serde(skip)]
    pub hub_env: crate::model_files::PythonHubEnv,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            whisper_level: None,
            whisper_model: PathBuf::new(),
            whisper_missing: None,
            whisper_server: PathBuf::from("whisper-server"),
            language: "fr".into(),
            voice: default_voice().into(),
            rate: DEFAULT_RATE,
            tts_backend: TTS_QWEN.into(),
            kokoro_python: None,
            kokoro_model: None,
            kokoro_voices: None,
            kokoro_voice: "ff_siwis".into(),
            qwen_python: None,
            qwen_model: DEFAULT_QWEN_MODEL.into(),
            qwen_reference: None,
            qwen_reference_text: ALFRED_REFERENCE_TEXT.into(),
            partial_interval_ms: 700,
            read_replies: true,
            enabled: true,
            dictation: true,
            read_notifications: false,
            pause_send_ms: 2000,
            hub_env: Default::default(),
        }
    }
}

/// Alfred a une voix d'homme, grave et un peu âgée : sur macOS, « Grandpa » en français de France.
pub fn default_voice() -> &'static str {
    if cfg!(target_os = "macos") {
        "Grandpa (Français (France))"
    } else {
        ""
    }
}

/// Un peu plus lent que la normale (≈ 180 mots par minute) : une diction posée.
pub const DEFAULT_RATE: u32 = 165;

/// La section `[voice]` d'Argos, en snake_case ; `tts_backend = "say"` y désigne la voix du système.
#[derive(Deserialize)]
struct ArgosDocument {
    voice: Option<ArgosVoice>,
}

#[derive(Deserialize)]
struct ArgosVoice {
    whisper_model: Option<PathBuf>,
    whisper_server: Option<PathBuf>,
    language: Option<String>,
    kokoro_python: Option<PathBuf>,
    kokoro_model: Option<PathBuf>,
    kokoro_voices: Option<PathBuf>,
    kokoro_voice: Option<String>,
    partial_interval_ms: Option<u64>,
}

impl VoiceConfig {
    /// Lit la section `[voice]` d'un `config.toml` d'Argos (les autres sections sont ignorées).
    /// La dictée et les fichiers de Kokoro sont repris ; la voix reste celle d'Alfred, car celles
    /// d'Argos (Thomas, ff_siwis) ne sont pas la sienne.
    pub fn from_argos_toml(text: &str) -> Result<Self, VoiceError> {
        let document: ArgosDocument =
            toml::from_str(text).map_err(|error| VoiceError::Config(error.to_string()))?;
        let argos = document
            .voice
            .ok_or_else(|| VoiceError::Config("section [voice] absente".into()))?;
        let defaults = Self::default();
        Ok(Self {
            whisper_level: None,
            whisper_model: argos.whisper_model.unwrap_or_default(),
            whisper_missing: None,
            whisper_server: argos.whisper_server.unwrap_or(defaults.whisper_server),
            language: argos.language.unwrap_or(defaults.language),
            voice: defaults.voice,
            rate: defaults.rate,
            tts_backend: defaults.tts_backend,
            kokoro_python: argos.kokoro_python,
            kokoro_model: argos.kokoro_model,
            kokoro_voices: argos.kokoro_voices,
            kokoro_voice: argos.kokoro_voice.unwrap_or(defaults.kokoro_voice),
            qwen_python: None,
            qwen_model: defaults.qwen_model,
            qwen_reference: None,
            qwen_reference_text: defaults.qwen_reference_text,
            partial_interval_ms: argos
                .partial_interval_ms
                .unwrap_or(defaults.partial_interval_ms),
            read_replies: true,
            enabled: true,
            dictation: true,
            read_notifications: false,
            pause_send_ms: defaults.pause_send_ms,
            hub_env: Default::default(),
        }
        .expanded())
    }

    /// Les chemins avec `~/` développé.
    pub fn expanded(mut self) -> Self {
        self.whisper_model = expand_home(&self.whisper_model);
        self.whisper_server = expand_home(&self.whisper_server);
        self.kokoro_python = self.kokoro_python.map(|p| expand_home(&p));
        self.kokoro_model = self.kokoro_model.map(|p| expand_home(&p));
        self.kokoro_voices = self.kokoro_voices.map(|p| expand_home(&p));
        self.qwen_python = self.qwen_python.map(|p| expand_home(&p));
        self.qwen_reference = self.qwen_reference.map(|p| expand_home(&p));
        self
    }

    /// La transcription est réglée : un modèle Whisper est indiqué.
    pub fn configured(&self) -> bool {
        !self.whisper_model.as_os_str().is_empty()
    }

    /// Vérifie la dictée sans rien lancer : le modèle existe, la cadence est
    /// raisonnable. Le binaire, lui, n'est vérifié qu'au lancement.
    pub fn check(&self) -> Result<(), VoiceError> {
        if let Some(level) = &self.whisper_missing {
            return Err(VoiceError::Config(format!(
                "le modèle Whisper {level} n'est pas téléchargé (Réglages, onglet Voix : Télécharger)"
            )));
        }
        if !self.configured() {
            return Err(VoiceError::Config(
                "aucun modèle Whisper n'est choisi (Réglages, onglet Voix : téléchargez un niveau)".into(),
            ));
        }
        if !self.whisper_model.is_file() {
            return Err(VoiceError::ModelMissing(self.whisper_model.clone()));
        }
        if self.partial_interval_ms < MIN_PARTIAL_INTERVAL_MS {
            return Err(VoiceError::Config(format!(
                "la cadence des transcriptions partielles doit valoir au moins {MIN_PARTIAL_INTERVAL_MS} ms"
            )));
        }
        if self.language.trim().is_empty() {
            return Err(VoiceError::Config("la langue ne peut pas être vide".into()));
        }
        Ok(())
    }

    /// Vérifie la seule synthèse : elle marche sans Whisper.
    pub fn check_speech(&self) -> Result<(), VoiceError> {
        match self.tts_backend.as_str() {
            TTS_SYSTEM => Ok(()),
            TTS_QWEN => {
                if !self.qwen_python.as_ref().is_some_and(|p| p.is_file()) {
                    return Err(VoiceError::Config(
                        "la voix d'Alfred n'est pas installée (Réglages, onglet Voix : Installer)"
                            .into(),
                    ));
                }
                if !self.qwen_reference.as_ref().is_some_and(|p| p.is_file()) {
                    return Err(VoiceError::Config(
                        "l'échantillon de la voix à cloner est introuvable".into(),
                    ));
                }
                if self.qwen_reference_text.trim().is_empty() || self.qwen_model.trim().is_empty() {
                    return Err(VoiceError::Config(
                        "le texte de l'échantillon et le modèle sont obligatoires".into(),
                    ));
                }
                Ok(())
            }
            TTS_KOKORO => {
                for (name, path) in [
                    ("le Python de Kokoro", &self.kokoro_python),
                    ("le modèle Kokoro", &self.kokoro_model),
                    ("le fichier des voix Kokoro", &self.kokoro_voices),
                ] {
                    if !path.as_ref().is_some_and(|p| p.is_file()) {
                        return Err(VoiceError::Config(format!(
                            "{name} est absent ou introuvable"
                        )));
                    }
                }
                if self.kokoro_voice.trim().is_empty() {
                    return Err(VoiceError::Config("la voix Kokoro est obligatoire".into()));
                }
                Ok(())
            }
            other => Err(VoiceError::Config(format!(
                "synthèse inconnue : {other} (qwen, system ou kokoro)"
            ))),
        }
    }

    pub fn partial_interval(&self) -> Duration {
        Duration::from_millis(self.partial_interval_ms.max(MIN_PARTIAL_INTERVAL_MS))
    }
}

fn expand_home(path: &Path) -> PathBuf {
    match (
        path.strip_prefix("~"),
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")),
    ) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argos_settings_are_taken_over() {
        let text = "[api]\nlisten = \"127.0.0.1:1\"\n\n[voice]\nwhisper_model = \"~/m/ggml.bin\"\nlanguage = \"en\"\n\
                    tts_backend = \"kokoro\"\nkokoro_voice = \"ff_siwis\"\npartial_interval_ms = 500\nhands_free = true\n";
        let config = VoiceConfig::from_argos_toml(text).unwrap();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(config.whisper_model, PathBuf::from(home).join("m/ggml.bin"));
        assert_eq!(config.whisper_server, PathBuf::from("whisper-server"));
        assert_eq!(config.language, "en");
        assert_eq!(config.tts_backend, TTS_QWEN, "la voix reste celle d'Alfred");
        assert_eq!(config.voice, default_voice());
        assert_eq!(config.partial_interval_ms, 500);
        assert!(config.read_replies);
    }

    #[test]
    fn say_becomes_the_system_voice_and_a_missing_section_is_reported() {
        let config =
            VoiceConfig::from_argos_toml("[voice]\ntts_backend = \"say\"\nvoice = \"Thomas\"\n")
                .unwrap();
        assert_eq!(config.tts_backend, TTS_QWEN);
        assert_eq!(config.voice, default_voice());
        assert!(!config.configured());
        assert!(matches!(
            VoiceConfig::from_argos_toml("[api]\nlisten = \"x\"\n"),
            Err(VoiceError::Config(_))
        ));
    }

    #[test]
    fn json_settings_fill_missing_fields_with_defaults() {
        let config: VoiceConfig =
            serde_json::from_value(serde_json::json!({ "language": "en" })).unwrap();
        assert_eq!(config.language, "en");
        assert_eq!(config.tts_backend, TTS_QWEN);
        assert_eq!(config.partial_interval_ms, 700);
    }

    #[test]
    fn the_check_explains_what_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = VoiceConfig {
            tts_backend: TTS_SYSTEM.into(),
            ..VoiceConfig::default()
        };
        assert!(config
            .check()
            .unwrap_err()
            .to_string()
            .contains("modèle Whisper"));
        assert!(
            config.check_speech().is_ok(),
            "la voix du système suffit pour parler"
        );
        config.whisper_model = dir.path().join("absent.bin");
        assert!(matches!(config.check(), Err(VoiceError::ModelMissing(_))));
        std::fs::write(dir.path().join("model.bin"), b"ggml").unwrap();
        config.whisper_model = dir.path().join("model.bin");
        assert!(config.check().is_ok());
        config.tts_backend = TTS_KOKORO.into();
        assert!(config
            .check_speech()
            .unwrap_err()
            .to_string()
            .contains("Python de Kokoro"));
        config.tts_backend = TTS_QWEN.into();
        assert!(config
            .check_speech()
            .unwrap_err()
            .to_string()
            .contains("pas installée"));
        config.qwen_python = Some(dir.path().join("model.bin"));
        config.qwen_reference = Some(dir.path().join("model.bin"));
        assert!(config.check_speech().is_ok());
        config.tts_backend = TTS_SYSTEM.into();
        config.partial_interval_ms = 10;
        assert!(matches!(config.check(), Err(VoiceError::Config(_))));
    }

    #[test]
    fn a_chosen_level_not_yet_downloaded_is_named() {
        let config = VoiceConfig {
            whisper_level: Some("small".into()),
            whisper_missing: Some("small".into()),
            ..VoiceConfig::default()
        };
        let message = config.check().unwrap_err().to_string();
        assert!(message.contains("Whisper small n'est pas téléchargé"), "{message}");
        // Le niveau est enregistré, pas ce qui est calculé au lancement.
        let stored = serde_json::to_value(&config).unwrap();
        assert_eq!(stored["whisperLevel"], "small");
        assert!(stored.get("whisperMissing").is_none() && stored.get("hubEnv").is_none());
        let back: VoiceConfig = serde_json::from_value(stored).unwrap();
        assert_eq!(back.whisper_missing, None);
    }

    #[test]
    fn the_home_prefix_is_expanded() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            expand_home(Path::new("~/models/x.bin")),
            PathBuf::from(home).join("models/x.bin")
        );
        assert_eq!(
            expand_home(Path::new("/abs/x.bin")),
            PathBuf::from("/abs/x.bin")
        );
    }
}
