//! `opencode serve` privé à Alfred : 127.0.0.1, port libre, mot de passe aléatoire passé par l'environnement (jamais
//! en argument ni dans un journal), appairage dont le jeton reste dans le client Rust. Ce n'est pas le service
//! d'arrière-plan de l'utilisateur. Repris de OneApp (ADR 0022).
use super::generated::Client;
use crate::error::AppError;
use crate::process_tree::OwnedProcess;
use std::io::{BufRead, BufReader};
use std::{path::Path, process::Stdio, time::Duration};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) struct Server {
    pub base_url: String,
    /// Client des requêtes courtes, avec un délai.
    pub api: Client,
    /// Client du flux SSE, sans délai global.
    pub stream: Client,
    process: OwnedProcess,
    exited: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

fn random_secret() -> String {
    // Deux UUID v4 tirés du générateur du système : 244 bits aléatoires.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn free_port() -> Result<u16, AppError> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| AppError::new("Aucun port local n’est disponible."))
}

pub(super) fn unavailable() -> AppError {
    AppError::new("Le serveur OpenCode d’Alfred ne répond pas.")
}

fn http(secret: &str, timeout: Option<Duration>) -> Result<reqwest013::Client, AppError> {
    use base64::Engine;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("opencode:{secret}"));
    let mut value = reqwest013::header::HeaderValue::from_str(&format!("Basic {basic}"))
        .map_err(|_| unavailable())?;
    value.set_sensitive(true);
    let mut headers = reqwest013::header::HeaderMap::new();
    headers.insert(reqwest013::header::AUTHORIZATION, value);
    let mut builder = reqwest013::Client::builder()
        .default_headers(headers)
        .no_proxy()
        .connect_timeout(Duration::from_secs(5));
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|_| unavailable())
}

impl Server {
    /// Lance le serveur avec `env` (configuration de la session) et l'appaire.
    pub async fn start(program: &Path, cwd: &str, env: Vec<(&'static str, String)>) -> Result<Self, AppError> {
        let port = free_port()?;
        let password = random_secret();
        let mut command = crate::agents::command(program, Some(cwd));
        command
            .args(["serve", "--hostname", "127.0.0.1", "--port", &port.to_string()])
            .envs(env)
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let (mut child, process) = crate::process_tree::spawn(&mut command)
            .map_err(|error| AppError::new(format!("Impossible de lancer opencode : {error}")))?;
        let stdout = child.stdout.take().ok_or_else(unavailable)?;
        let (ready_sender, ready) = tokio::sync::oneshot::channel::<bool>();
        // La sortie standard est lue jusqu’au bout, pour que le serveur ne se bloque jamais.
        std::thread::spawn(move || {
            let mut sender = Some(ready_sender);
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.contains("listening") {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(true);
                    }
                }
            }
        });
        let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = exited.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let ready = tokio::time::timeout(STARTUP_TIMEOUT, ready).await.ok().and_then(Result::ok).unwrap_or(false);
        let base_url = format!("http://127.0.0.1:{port}");
        let mut server = Self {
            api: Client::new_with_client(&base_url, http(&password, None)?),
            stream: Client::new_with_client(&base_url, http(&password, None)?),
            base_url,
            process,
            exited,
        };
        if !ready {
            server.stop();
            return Err(AppError::new(
                "OpenCode n’a pas démarré son serveur local. Vérifiez son installation (version 2.1 ou plus).",
            ));
        }
        if let Err(error) = server.pair(&password).await {
            server.stop();
            return Err(error);
        }
        Ok(server)
    }

    /// `POST /api/pair` (mot de passe) puis `GET /auth/connect/{code}` : le jeton de session
    /// rendu remplace le mot de passe dans les clients.
    async fn pair(&mut self, password: &str) -> Result<(), AppError> {
        let authed =
            Client::new_with_client(&self.base_url, http(password, Some(REQUEST_TIMEOUT))?);
        let code = authed
            .server_pair()
            .await
            .map_err(|_| unavailable())?
            .into_inner();
        let mut headers = reqwest013::header::HeaderMap::new();
        headers.insert(
            reqwest013::header::ACCEPT,
            reqwest013::header::HeaderValue::from_static("application/json"),
        );
        let anonymous = reqwest013::Client::builder()
            .default_headers(headers)
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| unavailable())?;
        let session = Client::new_with_client(&self.base_url, anonymous)
            .server_connect(&code.code)
            .await
            .map_err(|_| unavailable())?
            .into_inner();
        self.api =
            Client::new_with_client(&self.base_url, http(&session.token, Some(REQUEST_TIMEOUT))?);
        self.stream = Client::new_with_client(&self.base_url, http(&session.token, None)?);
        Ok(())
    }

    /// Arrête le serveur et tout ce qu'il a lancé (commandes, serveurs MCP).
    pub fn stop(&self) {
        let _ = self.process.terminate();
    }

    pub fn exited(&self) -> bool {
        self.exited.load(std::sync::atomic::Ordering::SeqCst)
    }
}
