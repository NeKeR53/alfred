//! Synthèse vocale en streaming : une file qui reçoit le texte par fragments, prononce
//! chaque phrase dès qu'elle est complète, et se coupe net au barge-in.

use crate::voice::engine::VoiceEvent;
use crate::voice::sentences::SentenceSplitter;
use crate::voice::stt::BoxFuture;
use crate::voice::VoiceError;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};

/// Un backend de synthèse : `say` en local, ou plus tard une API.
pub trait Speaker: Send + Sync {
    /// Prononce `text` ; le futur se termine quand la phrase est dite. Lâcher le futur
    /// doit couper le son immédiatement : c'est ainsi que la file interrompt.
    fn speak(&self, text: String) -> BoxFuture<'static, Result<(), VoiceError>>;

    /// Phrase qui sera dite ensuite : un moteur lent la calcule d'avance, pendant que la
    /// précédente est dite. Sans effet par défaut.
    fn prepare(&self, _text: &str) {}
}

/// La voix du système : `say` sur macOS, SAPI (PowerShell) sous Windows, `spd-say` ailleurs.
/// Un processus par phrase ; le tuer coupe le son.
#[derive(Debug, Clone)]
pub struct SystemSpeaker {
    voice: String,
    /// Mots par minute ; 0 : le débit de la voix.
    rate: u32,
}

impl SystemSpeaker {
    pub fn new(voice: &str, rate: u32) -> Self {
        Self {
            voice: voice.trim().to_string(),
            rate,
        }
    }

    fn command(&self, text: &str) -> (String, Command) {
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("say");
            if !self.voice.is_empty() {
                command.args(["-v", &self.voice]);
            }
            if self.rate > 0 {
                command.args(["-r", &self.rate.to_string()]);
            }
            // `--` : un texte qui commence par un tiret n'est pas pris pour une option.
            command.args(["--", text]);
            ("say".into(), command)
        }
        #[cfg(windows)]
        {
            // Texte et voix passent par l'environnement : rien n'est interprété par PowerShell.
            const SCRIPT: &str = "Add-Type -AssemblyName System.Speech; \
                $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
                if ($env:ALFRED_VOICE) { $s.SelectVoice($env:ALFRED_VOICE) } \
                else { try { $s.SelectVoiceByHints('Male', 'Senior') } catch {} }; \
                if ($env:ALFRED_RATE) { $s.Rate = [int]$env:ALFRED_RATE }; \
                $s.Speak($env:ALFRED_SPEECH)";
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
                .env("ALFRED_SPEECH", text)
                .env("ALFRED_VOICE", &self.voice)
                // SAPI : de -10 à 10, 0 valant environ 180 mots par minute.
                .env(
                    "ALFRED_RATE",
                    if self.rate > 0 {
                        ((self.rate as i32 - 180) / 20).clamp(-10, 10).to_string()
                    } else {
                        String::new()
                    },
                )
                .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            ("powershell.exe".into(), command)
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let mut command = Command::new("spd-say");
            command.arg("--wait");
            if self.rate > 0 {
                command.args([
                    "--rate",
                    &((self.rate as i32 - 180) / 2).clamp(-100, 100).to_string(),
                ]);
            }
            if !self.voice.is_empty() {
                command.args(["--synthesis-voice", &self.voice]);
            }
            command.args(["--", text]);
            ("spd-say".into(), command)
        }
    }
}

impl Speaker for SystemSpeaker {
    fn speak(&self, text: String) -> BoxFuture<'static, Result<(), VoiceError>> {
        let (program, mut command) = self.command(&text);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            // Le futur lâché tue le processus : le son s'arrête aussitôt.
            .kill_on_drop(true);
        Box::pin(async move {
            let output = command.output().await.map_err(|source| VoiceError::Spawn {
                program: program.clone(),
                source,
            })?;
            if output.status.success() {
                Ok(())
            } else {
                Err(VoiceError::Speech(format!(
                    "{program} a échoué ({}) : {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                )))
            }
        })
    }
}

/// Kokoro ONNX local. Un seul processus Python sert toute la session : le modèle de
/// 325 Mo n'est chargé qu'une fois, et chaque phrase lui est envoyée sur stdin. Lâcher le
/// futur d'une phrase coupe le processus (barge-in) ; la phrase suivante en relance un.
#[derive(Debug, Clone)]
pub struct KokoroSpeaker {
    python: PathBuf,
    model: PathBuf,
    voices: PathBuf,
    voice: String,
    /// Le processus entre deux phrases. Pris le temps d'une phrase, il est rendu ensuite.
    worker: Arc<StdMutex<Option<KokoroWorker>>>,
}

impl KokoroSpeaker {
    pub fn new(python: PathBuf, model: PathBuf, voices: PathBuf, voice: String) -> Self {
        Self {
            python,
            model,
            voices,
            voice,
            worker: Arc::new(StdMutex::new(None)),
        }
    }
}

/// Le processus Python de Kokoro et ses tubes.
pub struct KokoroWorker {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl std::fmt::Debug for KokoroWorker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KokoroWorker")
            .field("pid", &self.child.id())
            .finish()
    }
}

impl KokoroWorker {
    async fn start(speaker: &KokoroSpeaker) -> Result<Self, VoiceError> {
        let program = speaker.python.display().to_string();
        let mut command = Command::new(&speaker.python);
        command
            // Mode UTF-8 : sous Windows, stdin et stdout suivraient sinon la page de code
            // locale (cp1252) — accents écorchés à l'aller, réponses non UTF-8 au retour.
            .args(["-X", "utf8", "-c"])
            .arg(include_str!("kokoro_worker.py"))
            .arg(&speaker.model)
            .arg(&speaker.voices)
            .arg(&speaker.voice)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Les traces de Kokoro (chargement, erreurs) restent visibles dans le terminal.
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command
            .spawn()
            .map_err(|source| VoiceError::Spawn { program, source })?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| VoiceError::Speech("entrée Kokoro indisponible".into()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| VoiceError::Speech("sortie Kokoro indisponible".into()))?;
        Ok(Self {
            child,
            input,
            output: BufReader::new(output).lines(),
        })
    }

    /// Envoie une phrase et attend qu'elle soit dite. `Ok(Err(message))` : Kokoro n'a pas pu
    /// la dire, mais le processus reste utilisable. `Err` : le processus est à reprendre.
    async fn say(&mut self, sentence: &str) -> Result<Result<(), String>, VoiceError> {
        let io = |error: std::io::Error| VoiceError::Speech(format!("Kokoro : {error}"));
        // Une phrase tient sur une ligne : les retours à la ligne deviennent des espaces.
        let line = serde_json::to_string(&sentence.replace(['\n', '\r'], " "))
            .map_err(|e| VoiceError::Speech(e.to_string()))?;
        self.input
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(io)?;
        self.input.flush().await.map_err(io)?;
        let reply = self
            .output
            .next_line()
            .await
            .map_err(io)?
            .ok_or_else(|| VoiceError::Speech("Kokoro s'est arrêté".into()))?;
        Ok(match reply.strip_prefix("erreur ") {
            Some(message) => Err(message.to_string()),
            None if reply == "ok" => Ok(()),
            None => Err(format!("réponse inattendue : {reply}")),
        })
    }
}

impl Speaker for KokoroSpeaker {
    fn speak(&self, text: String) -> BoxFuture<'static, Result<(), VoiceError>> {
        let speaker = self.clone();
        Box::pin(async move {
            // Repris le temps de la phrase : si ce futur est lâché, le processus part avec.
            let taken = speaker
                .worker
                .lock()
                .expect("verrou Kokoro empoisonné")
                .take();
            // Un processus resté en réserve a pu mourir pendant la pause : la phrase est
            // alors redite par un neuf plutôt que perdue.
            let reused = match taken {
                Some(mut worker) => match worker.say(&text).await {
                    Ok(reply) => Some((worker, reply)),
                    Err(_) => None,
                },
                None => None,
            };
            let (worker, reply) = match reused {
                Some(done) => done,
                None => {
                    let mut fresh = KokoroWorker::start(&speaker).await?;
                    let reply = fresh.say(&text).await?;
                    (fresh, reply)
                }
            };
            match reply {
                Ok(()) => {
                    *speaker.worker.lock().expect("verrou Kokoro empoisonné") = Some(worker);
                    Ok(())
                }
                Err(message) => {
                    // Le processus est sain : il reste pour la phrase suivante.
                    *speaker.worker.lock().expect("verrou Kokoro empoisonné") = Some(worker);
                    Err(VoiceError::Speech(format!("Kokoro : {message}")))
                }
            }
        })
    }
}

/// Qwen3-TTS en local, avec une voix clonée d'un échantillon : la voix d'Alfred. Un seul
/// processus Python garde le modèle chargé ; il calcule les phrases préparées pendant que la
/// précédente est dite. Couper (lâcher le futur d'une phrase) envoie `stop` au processus,
/// qui reste chargé.
#[derive(Clone)]
pub struct QwenSpeaker {
    commands: mpsc::UnboundedSender<QwenCommand>,
}

enum QwenCommand {
    Prepare(String),
    Say(String, tokio::sync::oneshot::Sender<Result<(), VoiceError>>),
    Stop,
}

/// Ce qu'il faut pour lancer le processus.
#[derive(Debug, Clone)]
pub struct QwenSettings {
    pub python: PathBuf,
    pub model: String,
    pub reference: PathBuf,
    pub reference_text: String,
    /// Langue au sens de Qwen : « French », « English »…
    pub language: String,
    /// `HF_ENDPOINT`, `HF_TOKEN`, `HF_HOME` : le modèle se télécharge par la source des modèles d'Alfred.
    pub hub_env: crate::model_files::PythonHubEnv,
}

impl QwenSpeaker {
    /// À appeler depuis un runtime tokio. Le processus démarre à la première commande.
    pub fn new(settings: QwenSettings) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        tokio::spawn(run_qwen(settings, receiver));
        Self { commands }
    }

    /// Lance le processus et le chargement du modèle sans rien dire.
    pub fn warm_up(&self) {
        let _ = self.commands.send(QwenCommand::Prepare(String::new()));
    }
}

/// Envoie `stop` si la phrase est lâchée avant d'avoir été dite.
struct StopOnDrop {
    commands: mpsc::UnboundedSender<QwenCommand>,
    armed: bool,
}

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.commands.send(QwenCommand::Stop);
        }
    }
}

impl Speaker for QwenSpeaker {
    fn speak(&self, text: String) -> BoxFuture<'static, Result<(), VoiceError>> {
        let commands = self.commands.clone();
        Box::pin(async move {
            let (done, result) = tokio::sync::oneshot::channel();
            commands
                .send(QwenCommand::Say(text, done))
                .map_err(|_| VoiceError::Closed)?;
            let mut guard = StopOnDrop {
                commands,
                armed: true,
            };
            let outcome = result.await.unwrap_or(Err(VoiceError::Closed));
            guard.armed = false;
            outcome
        })
    }

    fn prepare(&self, text: &str) {
        let _ = self.commands.send(QwenCommand::Prepare(text.to_string()));
    }
}

type Waiting = Arc<
    StdMutex<std::collections::HashMap<u64, tokio::sync::oneshot::Sender<Result<(), VoiceError>>>>,
>;

/// Le processus Qwen et ses tubes ; refait s'il meurt.
struct QwenProcess {
    _child: Child,
    input: ChildStdin,
    /// Phrases envoyées à ce processus-ci et pas encore dites.
    waiting: Waiting,
}

/// L'erreur du programme Qwen, lisible : un certificat refusé par Python (miroir des modèles derrière l'autorité
/// d'une entreprise) est dit en français, avec l'hôte, plutôt que la trace de requests ou d'httpx.
fn qwen_message(raw: &str) -> String {
    let lower = raw.to_lowercase();
    // requests et urllib3 (CERTIFICATE_VERIFY_FAILED), truststore (« certificate is not trusted » sur Mac,
    // CERT_E_UNTRUSTEDROOT sous Windows), et la cause qu'en retrouve le programme (« certificate refused »).
    if ["certificate_verify_failed", "certificate verify failed", "certificate refused", "certificate is not trusted", "cert_e_"]
        .iter()
        .any(|sign| lower.contains(sign))
    {
        let host = ["host='", "host=\"", "https://"]
            .iter()
            .find_map(|start| {
                let rest = &raw[raw.find(start)? + start.len()..];
                let end = rest.find(['\'', '"', '/', ':', ' ', ')']).unwrap_or(rest.len());
                Some(&rest[..end]).filter(|host| !host.is_empty())
            })
            .unwrap_or("la source des modèles");
        let reason = lower
            .find("certificate verify failed: ")
            .map(|at| &raw[at + "certificate verify failed: ".len()..])
            .and_then(|rest| rest.split(['(', ')', '\'', '"']).next())
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .map(|reason| format!(" (Python : {reason})"))
            .unwrap_or_default();
        return format!(
            "Qwen : le certificat de {host} n'est pas reconnu{reason}. Le modèle de la voix d'Alfred n'a pas pu être \
téléchargé : vérifiez que le certificat de l'entreprise est installé dans le trousseau (Mac) ou le magasin de \
certificats (Windows), puis réessayez"
        );
    }
    format!("Qwen : {raw}")
}

impl QwenProcess {
    fn start(settings: &QwenSettings) -> Result<Self, VoiceError> {
        let waiting: Waiting = Arc::default();
        let reader_waiting = Arc::clone(&waiting);
        let program = settings.python.display().to_string();
        let mut command = Command::new(&settings.python);
        command
            .args(["-X", "utf8", "-c"])
            .arg(include_str!("qwen_worker.py"))
            .arg(&settings.model)
            .arg(&settings.reference)
            .arg(&settings.reference_text)
            .arg(&settings.language)
            // Pas de télémétrie ni de vérification de version à chaque lancement.
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("TOKENIZERS_PARALLELISM", "false")
            .envs(settings.hub_env.0.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command
            .spawn()
            .map_err(|source| VoiceError::Spawn { program, source })?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| VoiceError::Speech("entrée de Qwen indisponible".into()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| VoiceError::Speech("sortie de Qwen indisponible".into()))?;
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            let mut load_error: Option<String> = None;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if message.get("ready").is_some() {
                    load_error = message
                        .get("error")
                        .and_then(|e| e.as_str())
                        .map(str::to_string);
                    continue;
                }
                let Some(id) = message.get("id").and_then(|id| id.as_u64()) else {
                    continue;
                };
                let result = match message.get("error").and_then(|e| e.as_str()) {
                    Some(error) => Err(VoiceError::Speech(qwen_message(error))),
                    None => Ok(()),
                };
                if let Some(done) = reader_waiting.lock().expect("verrou Qwen").remove(&id) {
                    let _ = done.send(result);
                }
            }
            // Processus terminé : les phrases en attente échouent, la suivante le relance.
            let message = load_error.unwrap_or_else(|| "le processus s'est arrêté".into());
            for (_, done) in reader_waiting.lock().expect("verrou Qwen").drain() {
                let _ = done.send(Err(VoiceError::Speech(qwen_message(&message))));
            }
        });
        Ok(Self {
            _child: child,
            input,
            waiting,
        })
    }

    async fn send(&mut self, message: serde_json::Value) -> std::io::Result<()> {
        self.input
            .write_all(format!("{message}\n").as_bytes())
            .await?;
        self.input.flush().await
    }
}

async fn run_qwen(settings: QwenSettings, mut commands: mpsc::UnboundedReceiver<QwenCommand>) {
    let mut process: Option<QwenProcess> = None;
    let mut next_id = 0u64;
    while let Some(command) = commands.recv().await {
        let (message, done) = match command {
            QwenCommand::Prepare(text) => {
                (serde_json::json!({ "op": "prepare", "text": text }), None)
            }
            QwenCommand::Stop => {
                if process.is_none() {
                    continue;
                }
                (serde_json::json!({ "op": "stop" }), None)
            }
            QwenCommand::Say(text, done) => {
                next_id += 1;
                (
                    serde_json::json!({ "op": "say", "id": next_id, "text": text }),
                    Some((next_id, done)),
                )
            }
        };
        let mut done = done;
        // Un processus mort (tube rompu) est relancé une fois pour cette commande.
        let mut failure = None;
        for _ in 0..2 {
            if process.is_none() {
                match QwenProcess::start(&settings) {
                    Ok(started) => process = Some(started),
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            let running = process.as_mut().expect("lancé ci-dessus");
            if let Some((id, sender)) = done.take() {
                running
                    .waiting
                    .lock()
                    .expect("verrou Qwen")
                    .insert(id, sender);
                done = None;
                failure = None;
                if let Err(error) = running.send(message.clone()).await {
                    // Repris du processus mort pour le confier au suivant.
                    let sender = running.waiting.lock().expect("verrou Qwen").remove(&id);
                    process = None;
                    failure = Some(VoiceError::Speech(format!("Qwen : {error}")));
                    done = sender.map(|sender| (id, sender));
                    continue;
                }
                break;
            }
            match running.send(message.clone()).await {
                Ok(()) => {
                    failure = None;
                    break;
                }
                Err(error) => {
                    process = None;
                    failure = Some(VoiceError::Speech(format!("Qwen : {error}")));
                }
            }
        }
        if let (Some(error), Some((_, sender))) = (failure, done) {
            let _ = sender.send(Err(error));
        }
    }
}

enum SpeechCommand {
    Delta(String),
    Finish,
    Stop,
}

/// Poignée de la file de parole ; la tâche qui la sert s'arrête quand on lâche la
/// dernière copie.
#[derive(Clone)]
pub(crate) struct SpeechQueue {
    commands: mpsc::UnboundedSender<SpeechCommand>,
}

impl SpeechQueue {
    /// Démarre la tâche de la file ; à appeler depuis un runtime tokio.
    pub fn spawn(speaker: Arc<dyn Speaker>, events: broadcast::Sender<VoiceEvent>) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        tokio::spawn(run(speaker, events, receiver));
        Self { commands }
    }

    pub fn delta(&self, text: &str) {
        let _ = self.commands.send(SpeechCommand::Delta(text.to_string()));
    }

    pub fn finish(&self) {
        let _ = self.commands.send(SpeechCommand::Finish);
    }

    pub fn stop(&self) {
        let _ = self.commands.send(SpeechCommand::Stop);
    }
}

/// Boucle de la file. Les commandes sont traitées dans l'ordre d'envoi : un `stop()`
/// suivi de nouveaux fragments coupe l'ancien discours puis prononce le nouveau.
async fn run(
    speaker: Arc<dyn Speaker>,
    events: broadcast::Sender<VoiceEvent>,
    mut commands: mpsc::UnboundedReceiver<SpeechCommand>,
) {
    let emit = |event| {
        let _ = events.send(event);
    };
    let mut splitter = SentenceSplitter::new();
    let mut pending: VecDeque<String> = VecDeque::new();
    let mut current: Option<BoxFuture<'static, Result<(), VoiceError>>> = None;
    // Un discours est en cours depuis SpeechStarted, jusqu'à SpeechFinished.
    let mut speaking = false;
    // Le flux de texte est terminé : plus rien n'arrivera pour ce discours.
    let mut finished = false;
    loop {
        if current.is_none() {
            if let Some(sentence) = pending.pop_front() {
                if !speaking {
                    speaking = true;
                    emit(VoiceEvent::SpeechStarted);
                }
                // Le texte exact de la phrase lancée : la GUI en tire l'animation de la bouche.
                emit(VoiceEvent::Utterance {
                    text: sentence.clone(),
                });
                current = Some(speaker.speak(sentence));
            } else if speaking && finished {
                speaking = false;
                finished = false;
                emit(VoiceEvent::SpeechFinished { interrupted: false });
            }
        }
        tokio::select! {
            result = async { current.as_mut().expect("gardé par la condition").await },
                if current.is_some() =>
            {
                current = None;
                if let Err(error) = result {
                    emit(VoiceEvent::Error { message: error.to_string() });
                }
            }
            command = commands.recv() => match command {
                // Moteur lâché : `current` part avec la tâche, et `say` avec lui.
                None => return,
                Some(SpeechCommand::Delta(text)) => {
                    finished = false;
                    let sentences = splitter.push(&text);
                    for sentence in &sentences {
                        speaker.prepare(sentence);
                    }
                    pending.extend(sentences);
                }
                Some(SpeechCommand::Finish) => {
                    let rest = splitter.finish();
                    if let Some(sentence) = &rest {
                        speaker.prepare(sentence);
                    }
                    pending.extend(rest);
                    finished = true;
                }
                Some(SpeechCommand::Stop) => {
                    // Lâcher le futur tue la phrase en cours.
                    current = None;
                    pending.clear();
                    splitter.clear();
                    finished = false;
                    if speaking {
                        speaking = false;
                        emit(VoiceEvent::SpeechFinished { interrupted: true });
                    }
                }
            },
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    /// Ce qui est arrivé à une phrase confiée au faux parleur.
    #[derive(Debug, Clone, PartialEq)]
    pub enum Spoken {
        Started(String),
        Done(String),
        Cut(String),
    }

    /// Faux parleur : chaque phrase « dure » `per_char` par caractère, et l'on note si
    /// elle est allée au bout ou a été coupée.
    pub struct FakeSpeaker {
        pub per_char: Duration,
        pub log: Arc<Mutex<Vec<Spoken>>>,
    }

    impl FakeSpeaker {
        pub fn new(per_char: Duration) -> Self {
            Self {
                per_char,
                log: Arc::default(),
            }
        }

        pub fn log(&self) -> Vec<Spoken> {
            self.log.lock().unwrap().clone()
        }
    }

    /// Note `Cut` si la phrase est lâchée avant la fin.
    struct Guard {
        text: String,
        log: Arc<Mutex<Vec<Spoken>>>,
        done: bool,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let entry = if self.done {
                Spoken::Done(self.text.clone())
            } else {
                Spoken::Cut(self.text.clone())
            };
            self.log.lock().unwrap().push(entry);
        }
    }

    impl Speaker for FakeSpeaker {
        fn speak(&self, text: String) -> BoxFuture<'static, Result<(), VoiceError>> {
            let log = Arc::clone(&self.log);
            let duration = self.per_char * text.chars().count() as u32;
            Box::pin(async move {
                log.lock().unwrap().push(Spoken::Started(text.clone()));
                let mut guard = Guard {
                    text,
                    log,
                    done: false,
                };
                tokio::time::sleep(duration).await;
                guard.done = true;
                Ok(())
            })
        }
    }

    fn drain(rx: &mut broadcast::Receiver<VoiceEvent>) -> Vec<VoiceEvent> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn utterance(text: &str) -> VoiceEvent {
        VoiceEvent::Utterance { text: text.into() }
    }

    #[tokio::test(start_paused = true)]
    async fn each_sentence_announces_its_exact_text_when_it_starts() {
        let speaker = Arc::new(FakeSpeaker::new(ms(10)));
        let (events, mut rx) = broadcast::channel(64);
        let queue = SpeechQueue::spawn(speaker.clone(), events);
        queue.delta("Première phrase. Seconde ");
        tokio::time::sleep(ms(1)).await;
        // La seconde n'est pas encore lancée : son texte n'est pas encore annoncé.
        assert_eq!(
            drain(&mut rx),
            vec![VoiceEvent::SpeechStarted, utterance("Première phrase.")]
        );
        queue.delta("phrase.");
        queue.finish();
        tokio::time::sleep(ms(1_000)).await;
        assert_eq!(
            drain(&mut rx),
            vec![
                utterance("Seconde phrase."),
                VoiceEvent::SpeechFinished { interrupted: false }
            ]
        );
        // L'annonce correspond à ce que le parleur a reçu, mot pour mot.
        assert_eq!(speaker.log()[2], Spoken::Started("Seconde phrase.".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn sentences_are_spoken_as_soon_as_complete_then_the_rest_at_the_end() {
        let speaker = Arc::new(FakeSpeaker::new(ms(10)));
        let (events, mut rx) = broadcast::channel(64);
        let queue = SpeechQueue::spawn(speaker.clone(), events);

        queue.delta("Bonjour ");
        queue.delta("à toi. Je");
        tokio::time::sleep(ms(5)).await;
        // La première phrase part avant la fin du flux.
        assert_eq!(
            speaker.log(),
            vec![Spoken::Started("Bonjour à toi.".into())]
        );
        assert_eq!(
            drain(&mut rx),
            vec![VoiceEvent::SpeechStarted, utterance("Bonjour à toi.")]
        );

        queue.delta(" regarde tes mails");
        queue.finish();
        tokio::time::sleep(ms(1_000)).await;
        assert_eq!(
            speaker.log(),
            vec![
                Spoken::Started("Bonjour à toi.".into()),
                Spoken::Done("Bonjour à toi.".into()),
                Spoken::Started("Je regarde tes mails".into()),
                Spoken::Done("Je regarde tes mails".into()),
            ]
        );
        assert_eq!(
            drain(&mut rx),
            vec![
                utterance("Je regarde tes mails"),
                VoiceEvent::SpeechFinished { interrupted: false }
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_queue_waits_for_more_text_until_finish() {
        let speaker = Arc::new(FakeSpeaker::new(ms(1)));
        let (events, mut rx) = broadcast::channel(64);
        let queue = SpeechQueue::spawn(speaker.clone(), events);
        queue.delta("Une phrase. ");
        tokio::time::sleep(ms(500)).await;
        // Phrase dite, mais le flux continue : le discours n'est pas fini.
        assert_eq!(
            drain(&mut rx),
            vec![VoiceEvent::SpeechStarted, utterance("Une phrase.")]
        );
        queue.delta("Une autre.");
        queue.finish();
        tokio::time::sleep(ms(500)).await;
        assert_eq!(
            drain(&mut rx),
            vec![
                utterance("Une autre."),
                VoiceEvent::SpeechFinished { interrupted: false }
            ]
        );
        assert_eq!(speaker.log().len(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_cuts_the_current_sentence_and_empties_the_queue() {
        let speaker = Arc::new(FakeSpeaker::new(ms(50)));
        let (events, mut rx) = broadcast::channel(64);
        let queue = SpeechQueue::spawn(speaker.clone(), events);
        queue.delta("Première phrase assez longue. Deuxième phrase. Troisième");
        tokio::time::sleep(ms(200)).await;
        queue.stop();
        tokio::time::sleep(ms(1)).await;
        assert_eq!(
            speaker.log(),
            vec![
                Spoken::Started("Première phrase assez longue.".into()),
                Spoken::Cut("Première phrase assez longue.".into()),
            ]
        );
        assert_eq!(
            drain(&mut rx),
            vec![
                VoiceEvent::SpeechStarted,
                utterance("Première phrase assez longue."),
                VoiceEvent::SpeechFinished { interrupted: true }
            ]
        );
        // Rien de l'ancien discours ne ressort, même à la fin du flux.
        queue.finish();
        tokio::time::sleep(ms(5_000)).await;
        assert_eq!(speaker.log().len(), 2);
        assert!(drain(&mut rx).is_empty());

        // Un nouveau discours repart normalement après le barge-in.
        queue.delta("Nouveau départ.");
        queue.finish();
        tokio::time::sleep(ms(5_000)).await;
        assert_eq!(
            speaker.log()[2..],
            [
                Spoken::Started("Nouveau départ.".into()),
                Spoken::Done("Nouveau départ.".into()),
            ]
        );
        assert_eq!(
            drain(&mut rx),
            vec![
                VoiceEvent::SpeechStarted,
                utterance("Nouveau départ."),
                VoiceEvent::SpeechFinished { interrupted: false }
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_kokoro_worker_that_died_while_idle_is_replaced_without_losing_the_sentence() {
        use std::os::unix::fs::PermissionsExt;
        // Faux Python : exige le mode UTF-8, puis répond « ok » à chaque phrase comme le vrai worker.
        let dir = tempfile::tempdir().unwrap();
        let python = dir.path().join("python");
        std::fs::write(
            &python,
            "#!/bin/sh\n[ \"$1 $2\" = \"-X utf8\" ] || exit 1\nwhile read -r line; do echo ok; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let speaker = KokoroSpeaker::new(python, "m".into(), "v".into(), "ff_siwis".into());

        speaker.speak("Première.".into()).await.unwrap();
        // Le processus en réserve meurt pendant la pause.
        let mut idle = speaker.worker.lock().unwrap().take().unwrap();
        idle.child.kill().await.unwrap();
        *speaker.worker.lock().unwrap() = Some(idle);

        speaker.speak("Après la pause.".into()).await.unwrap();
        let worker = speaker.worker.lock().unwrap().take().unwrap();
        assert!(
            worker.child.id().is_some(),
            "un processus neuf a pris le relais"
        );
    }

    /// Faux Python du worker Qwen : journalise chaque commande dans `log`, répond « ok » à
    /// chaque « say » (sauf « lent », gardé jusqu'au « stop » qui le dit coupé), et meurt sur
    /// « plante ».
    #[cfg(unix)]
    fn fake_qwen(dir: &std::path::Path) -> (QwenSettings, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("log");
        let python = dir.join("python");
        let script = format!(
            r#"#!/bin/sh
[ "$1 $2" = "-X utf8" ] || exit 1
echo "HF_ENDPOINT=$HF_ENDPOINT HF_TOKEN=$HF_TOKEN HF_HOME=$HF_HOME" > {log}.env
echo '{{"ready": true}}'
held=""
while read -r line; do
  echo "$line" >> {log}
  id=$(echo "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"op":"say"'*'plante'*) exit 3 ;;
    *'"op":"say"'*'lent'*) held=$id ;;
    *'"op":"say"'*) echo "{{\"id\": $id, \"ok\": true}}" ;;
    *'"op":"stop"'*) [ -n "$held" ] && echo "{{\"id\": $held, \"interrupted\": true}}"; held="" ;;
  esac
done
"#,
            log = log.display()
        );
        std::fs::write(&python, script).unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let settings = QwenSettings {
            python,
            model: "Qwen/Qwen3-TTS-12Hz-1.7B-Base".into(),
            reference: dir.join("voix.wav"),
            reference_text: "Bonsoir.".into(),
            language: "French".into(),
            hub_env: Default::default(),
        };
        (settings, log)
    }

    #[cfg(unix)]
    fn logged(log: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .map(|line| {
                let value: serde_json::Value = serde_json::from_str(line).unwrap();
                format!(
                    "{} {}",
                    value["op"].as_str().unwrap(),
                    value["text"].as_str().unwrap_or("")
                )
                .trim()
                .to_string()
            })
            .collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn qwen_prepares_ahead_says_in_order_and_stops_a_dropped_sentence() {
        let dir = tempfile::tempdir().unwrap();
        let (settings, log) = fake_qwen(dir.path());
        let speaker = QwenSpeaker::new(settings);
        speaker.warm_up();
        speaker.prepare("Deuxième phrase.");
        speaker.speak("Première phrase.".into()).await.unwrap();
        speaker.speak("Deuxième phrase.".into()).await.unwrap();

        // Une phrase lâchée en cours de route : le processus reçoit « stop » et reste chargé.
        let slow = speaker.speak("Une phrase lente.".into());
        assert!(tokio::time::timeout(Duration::from_millis(200), slow)
            .await
            .is_err());
        speaker.speak("Après.".into()).await.unwrap();
        assert_eq!(
            logged(&log),
            vec![
                "prepare",
                "prepare Deuxième phrase.",
                "say Première phrase.",
                "say Deuxième phrase.",
                "say Une phrase lente.",
                "stop",
                "say Après.",
            ]
        );
    }

    /// Le modèle de la voix d'Alfred se télécharge par la source des modèles : le processus Python reçoit
    /// l'adresse du miroir, le jeton et le cache d'Alfred.
    #[cfg(unix)]
    #[tokio::test]
    async fn qwen_is_started_with_the_model_source() {
        let dir = tempfile::tempdir().unwrap();
        let (mut settings, log) = fake_qwen(dir.path());
        settings.hub_env = crate::model_files::PythonHubEnv(vec![
            ("HF_ENDPOINT".into(), "http://127.0.0.1:9/miroir".into()),
            ("HF_TOKEN".into(), "jeton-secret".into()),
            ("HF_HOME".into(), "/cache/huggingface".into()),
        ]);
        let speaker = QwenSpeaker::new(settings);
        speaker.speak("Bonjour.".into()).await.unwrap();
        let env = std::fs::read_to_string(log.with_extension("env")).unwrap();
        assert_eq!(
            env.trim(),
            "HF_ENDPOINT=http://127.0.0.1:9/miroir HF_TOKEN=jeton-secret HF_HOME=/cache/huggingface"
        );
    }

    #[test]
    fn a_refused_certificate_is_explained_in_french() {
        let raw = "(MaxRetryError(\"HTTPSConnectionPool(host='miroir.exemple.fr', port=443): Max retries exceeded with url: /artifactory/api/huggingfaceml/huggingface/Qwen/Qwen3-TTS-12Hz-1.7B-Base/resolve/main/config.json (Caused by SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)')))\"), '(Request ID: 1)')";
        assert_eq!(
            qwen_message(raw),
            "Qwen : le certificat de miroir.exemple.fr n'est pas reconnu (Python : self-signed certificate in \
certificate chain). Le modèle de la voix d'Alfred n'a pas pu être téléchargé : vérifiez que le certificat de \
l'entreprise est installé dans le trousseau (Mac) ou le magasin de certificats (Windows), puis réessayez"
        );
        // httpx : l'adresse plutôt que host='…'.
        let httpx = "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1010) https://autre.exemple.fr/api/models";
        assert!(qwen_message(httpx).starts_with("Qwen : le certificat de autre.exemple.fr n'est pas reconnu (Python : unable to get local issuer certificate)."));
        // truststore sur Mac, cause retrouvée par le programme sous l'erreur vague de huggingface_hub.
        let truststore = "certificate refused: ('“miroir.exemple.fr” certificate is not trusted',) (host='miroir.exemple.fr')";
        assert!(qwen_message(truststore).starts_with("Qwen : le certificat de miroir.exemple.fr n'est pas reconnu. "));
        assert_eq!(qwen_message("le modèle est introuvable"), "Qwen : le modèle est introuvable");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_crashed_qwen_worker_fails_its_sentence_and_the_next_one_restarts_it() {
        let dir = tempfile::tempdir().unwrap();
        let (settings, _log) = fake_qwen(dir.path());
        let speaker = QwenSpeaker::new(settings);
        let error = speaker.speak("Ceci plante.".into()).await.unwrap_err();
        assert!(error.to_string().contains("Qwen"), "{error}");
        speaker.speak("Et ceci passe.".into()).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn stop_when_silent_emits_nothing() {
        let speaker = Arc::new(FakeSpeaker::new(ms(1)));
        let (events, mut rx) = broadcast::channel(64);
        let queue = SpeechQueue::spawn(speaker.clone(), events);
        queue.stop();
        queue.finish();
        tokio::time::sleep(ms(100)).await;
        assert!(drain(&mut rx).is_empty());
        assert!(speaker.log().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_queue_cuts_the_speech() {
        let speaker = Arc::new(FakeSpeaker::new(ms(100)));
        let (events, _rx) = broadcast::channel(64);
        let queue = SpeechQueue::spawn(speaker.clone(), events);
        queue.delta("Une phrase qui ne finira pas. ");
        tokio::time::sleep(ms(10)).await;
        drop(queue);
        tokio::time::sleep(ms(10)).await;
        assert!(matches!(speaker.log().last(), Some(Spoken::Cut(_))));
    }
}
