//! Transport des comptes au-delà d’une requête JSON (`clients.rs`) : téléchargement en flux dans les fichiers du
//! module, réponses en continu (SSE, journal suivi, journaux Docker multiplexés) et WebSocket, ces deux derniers
//! remis à la page par un canal (`channels.rs`).
//!
//! Tout passe par `clients::grant_call` (seule une fonction appelle, compte validé et accordé, journal) et
//! `clients::send` (adresse bornée à celle du compte, authentification posée en natif) : le modèle de sécurité est
//! celui d’une requête. Ce qui revient du service est débarrassé des secrets du compte avant d’atteindre le module.

use std::sync::Arc;
use std::time::Instant;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::channels::{self, Outgoing};
use crate::clients::{self, Granted, Profile, Sent};
use crate::error::{opt_arg, AppError, AppResult};
use crate::state::AppState;

/// Corps d’une réponse en échec (statut d’erreur) rendu à la fonction à la place du fichier ou du canal.
const MAX_ERROR_BODY: usize = 1024 * 1024;
/// Plus long événement texte d’un flux : une ligne plus longue est coupée.
const MAX_LINE: usize = 256 * 1024;
/// Plus gros message reçu par un WebSocket.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Masquage des secrets dans un contenu lu en flux
// ---------------------------------------------------------------------------------------------------------------

/// Retire les secrets d’un contenu brut lu morceau par morceau : un secret à cheval sur deux morceaux est reconnu,
/// car les derniers octets de chaque morceau sont gardés jusqu’au suivant.
pub struct Redactor {
    forms: Vec<Vec<u8>>,
    starts: [bool; 256],
    longest: usize,
    carry: Vec<u8>,
}

impl Redactor {
    pub fn new(secrets: &[String]) -> Self {
        let mut forms: Vec<Vec<u8>> = secrets
            .iter()
            .filter(|secret| secret.len() >= 4)
            .flat_map(|secret| clients::written_forms(secret))
            .filter(|form| !form.is_empty())
            .map(String::into_bytes)
            .collect();
        forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
        forms.dedup();
        let mut starts = [false; 256];
        for form in &forms {
            starts[form[0] as usize] = true;
        }
        let longest = forms.first().map_or(0, Vec::len);
        Self { forms, starts, longest, carry: Vec::new() }
    }

    fn scan(&mut self, input: &[u8], last: bool) -> Vec<u8> {
        if self.forms.is_empty() {
            return input.to_vec();
        }
        let mut buffer = std::mem::take(&mut self.carry);
        buffer.extend_from_slice(input);
        let mut out = Vec::with_capacity(buffer.len());
        // Au-delà de `safe`, un secret pourrait continuer dans le morceau suivant.
        let safe = if last { buffer.len() } else { buffer.len().saturating_sub(self.longest - 1) };
        let mut index = 0;
        while index < safe {
            // Les octets qui ne peuvent pas commencer un secret sont recopiés d’un bloc.
            let run = buffer[index..safe].iter().position(|byte| self.starts[*byte as usize]).unwrap_or(safe - index);
            out.extend_from_slice(&buffer[index..index + run]);
            index += run;
            if index >= safe {
                break;
            }
            match self.forms.iter().find(|form| buffer[index..].starts_with(form)) {
                Some(form) => {
                    out.extend_from_slice(clients::MASK.as_bytes());
                    index += form.len();
                }
                None => {
                    out.push(buffer[index]);
                    index += 1;
                }
            }
        }
        // Peut-être le début d’un secret : il attend le morceau suivant.
        self.carry = buffer[index.min(buffer.len())..].to_vec();
        out
    }

    /// Morceau suivant : rend ce qui est sûr, garde la fin pour le morceau d’après.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.scan(chunk, false)
    }

    /// Fin du contenu : rend ce qui restait.
    pub fn finish(&mut self) -> Vec<u8> {
        self.scan(&[], true)
    }

    /// Tout un contenu d’un coup.
    pub fn all(secrets: &[String], bytes: &[u8]) -> Vec<u8> {
        let mut redactor = Self::new(secrets);
        let mut out = redactor.push(bytes);
        out.extend(redactor.finish());
        out
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Réponse en échec
// ---------------------------------------------------------------------------------------------------------------

/// Statut d’erreur : la fonction reçoit le corps (JSON décodé, sinon texte) au lieu d’un fichier ou d’un canal.
async fn failed(sent: Sent, extra: &str) -> AppResult<Value> {
    let Sent { mut response, secrets } = sent;
    let status = response.status();
    let headers = clients::response_headers(&response, &secrets);
    let is_json = headers.get("content-type").and_then(Value::as_str).is_some_and(|kind| kind.contains("json"));
    let bytes = clients::read_limited(&mut response, &secrets, MAX_ERROR_BODY).await.unwrap_or_default();
    let text = clients::redact(&String::from_utf8_lossy(&bytes), &secrets);
    let body = match serde_json::from_str::<Value>(&text) {
        Ok(value) if is_json => value,
        _ => Value::String(text),
    };
    let mut result = json!({ "status": status.as_u16(), "ok": false, "headers": headers, "body": body });
    result[extra] = Value::Null;
    Ok(result)
}

fn journaled(state: &AppState, granted: &Granted, started: Instant, result: &AppResult<Value>, what: &str) {
    let (status, outcome) = clients::outcome_of(result);
    let outcome = match result {
        Ok(value) if value["ok"] == json!(true) => format!("{outcome} ({what})"),
        _ => outcome,
    };
    clients::journal(state, &granted.space, &granted.client, &granted.call, granted.requester(), started, (status, outcome));
}

// ---------------------------------------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------------------------------------

/// Nom donné par `Content-Disposition` (`filename*=UTF-8''…` d’abord, puis `filename="…"`).
pub fn disposition_name(header: &str) -> Option<String> {
    let mut plain = None;
    for part in header.split(';').map(str::trim) {
        let Some((key, value)) = part.split_once('=') else { continue };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if key == "filename*" {
            let encoded = value.splitn(3, '\'').nth(2).unwrap_or(value);
            let decoded: String =
                url::form_urlencoded::parse(format!("x={}", encoded.replace('+', "%2B")).as_bytes()).map(|(_, v)| v.into_owned()).collect();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        } else if key == "filename" {
            plain = Some(value.trim_matches('"').to_string());
        }
    }
    plain.filter(|name| !name.is_empty())
}

/// Nom du fichier téléchargé : celui demandé, sinon celui du service, sinon le dernier segment du chemin.
fn download_name(asked: Option<String>, response: &reqwest::Response, path: &str) -> String {
    asked
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            response.headers().get(CONTENT_DISPOSITION).and_then(|value| value.to_str().ok()).and_then(disposition_name)
        })
        .or_else(|| {
            let segment = path.split('?').next().unwrap_or_default().rsplit('/').next().unwrap_or_default();
            let decoded = url::form_urlencoded::parse(format!("x={segment}").as_bytes()).map(|(_, v)| v.into_owned()).collect::<String>();
            Some(decoded).filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "telechargement".to_string())
}

/// Où va un téléchargement : les fichiers du module, ou un fichier temporaire de l’espace que le code déplace.
struct Target {
    name: Option<String>,
    temporary: bool,
    /// Taille au-delà de laquelle le téléchargement est abandonné (octets) ; à défaut, `MAX_TRANSFER`.
    max_size: u64,
}

impl Target {
    fn of(args: &Value) -> AppResult<Self> {
        let max_size = match opt_arg::<u64>(args, "maxSize")? {
            Some(0) => return Err(AppError::new("`maxSize` vaut au moins 1 octet.")),
            Some(size) => size.min(clients::MAX_TRANSFER),
            None => clients::MAX_TRANSFER,
        };
        Ok(Self { name: opt_arg(args, "name")?, temporary: opt_arg(args, "temporary")?.unwrap_or(false), max_size })
    }

    fn too_large(&self) -> AppError {
        if self.max_size == clients::MAX_TRANSFER {
            AppError::new("Fichier trop gros : 2 Go au plus par téléchargement.")
        } else {
            AppError::new(format!("Fichier trop gros : plus de {} octets (`maxSize`).", self.max_size))
        }
    }
}

/// Dossier des téléchargements temporaires (`temporary: true`), hors des fichiers versionnés de l’espace.
fn temporary_dir(space: &crate::space::Space) -> std::path::PathBuf {
    space.local_dir().join("tmp").join("downloads")
}

/// Durée de vie d’un téléchargement temporaire que le code n’a pas déplacé.
const TEMPORARY_LIFETIME: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// Retire les téléchargements temporaires de plus d’un jour : le code devait les déplacer.
fn sweep_temporary(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > TEMPORARY_LIFETIME);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Fichier en cours d’écriture : retiré s’il n’est pas terminé (échec, abandon, taille dépassée).
struct Partial {
    path: std::path::PathBuf,
    done: bool,
}

impl Drop for Partial {
    fn drop(&mut self) {
        if !self.done {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

async fn receive_file(state: &Arc<AppState>, granted: &Granted, target: Target) -> AppResult<Value> {
    let sent = clients::send(state, &granted.client, &granted.call, Profile::Download).await?;
    if !sent.response.status().is_success() {
        return failed(sent, if target.temporary { "temporary" } else { "file" }).await;
    }
    let Sent { mut response, secrets } = sent;
    let status = response.status();
    let headers = clients::response_headers(&response, &secrets);
    if response.content_length().is_some_and(|length| length > target.max_size) {
        return Err(target.too_large());
    }
    let name = download_name(target.name.clone(), &response, &granted.call.path);
    let mime = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(str::to_string);
    // Fichier du module, ou fichier temporaire `<uuid>-<nom>` que le code déplace (il disparaît après un jour).
    let (incoming, path) = if target.temporary {
        let dir = temporary_dir(&granted.space);
        std::fs::create_dir_all(&dir)?;
        sweep_temporary(&dir);
        let id = uuid::Uuid::new_v4().simple().to_string();
        (None, dir.join(format!("{id}-{}", crate::conversations::safe_name(&name))))
    } else {
        let incoming = crate::module_files::begin(&granted.space, &granted.subject.module, &name, mime.as_deref())?;
        let path = incoming.path.clone();
        (Some(incoming), path)
    };
    let mut partial = Partial { path: path.with_extension("part"), done: false };
    if incoming.is_some() {
        // Le fichier du module se nettoie lui-même (`Incoming`) : il s’écrit à sa place.
        partial.path = path.clone();
        partial.done = true;
    }
    let mut file = tokio::fs::File::create(&partial.path).await?;
    let mut redactor = Redactor::new(&secrets);
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    loop {
        let (bytes, last) = match response.chunk().await.map_err(|error| clients::network_error(error, &secrets))? {
            Some(chunk) => (redactor.push(&chunk), false),
            None => (redactor.finish(), true),
        };
        size += bytes.len() as u64;
        if size > target.max_size {
            return Err(target.too_large());
        }
        hasher.update(&bytes);
        file.write_all(&bytes).await?;
        if last {
            break;
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    match incoming {
        Some(incoming) => {
            let info = incoming.finish(size, digest)?;
            Ok(json!({ "status": status.as_u16(), "ok": true, "headers": headers, "file": info }))
        }
        None => {
            std::fs::rename(&partial.path, &path)?;
            partial.done = true;
            let mime = mime.map(|mime| mime.split(';').next().unwrap_or_default().trim().to_string());
            let temporary = json!({
                "path": path.to_string_lossy(),
                "name": name,
                "mime": mime.filter(|mime| !mime.is_empty()).unwrap_or_else(|| "application/octet-stream".to_string()),
                "size": size,
                "sha256": digest,
            });
            Ok(json!({ "status": status.as_u16(), "ok": true, "headers": headers, "file": null, "temporary": temporary }))
        }
    }
}

/// `client(id).download(path, …)` : le corps va en flux dans les fichiers du module (2 Go au plus), avec son
/// empreinte SHA-256, sans passer par la fonction. `{ status, ok, headers, file }` ; en échec, `file` est nul et
/// `body` porte la réponse du service. Avec `temporary: true`, le corps va dans un fichier temporaire de l’espace
/// (`.alfred/tmp/downloads`) : `temporary` porte `{ path, name, mime, size, sha256 }`, et le code déplace le fichier
/// (il est retiré après un jour). `maxSize` (octets) abandonne un fichier plus gros.
pub async fn download(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let target = Target::of(args)?;
    let granted = clients::grant_call(state, args, None).await?;
    let started = Instant::now();
    let result = receive_file(state, &granted, target).await;
    journaled(state, &granted, started, &result, "fichier");
    result
}

// ---------------------------------------------------------------------------------------------------------------
// Flux
// ---------------------------------------------------------------------------------------------------------------

/// Découpage d’une réponse en continu en événements.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    /// Une ligne de texte par événement (journal suivi, NDJSON).
    Lines,
    /// Server-Sent Events : `data`, `event`, `id`.
    Sse,
    /// Journaux Docker multiplexés (`/containers/{id}/logs` sans TTY) : `stream` vaut `stdout` ou `stderr`.
    Docker,
    /// Morceaux bruts en base64.
    Raw,
}

impl Format {
    fn parse(name: Option<&str>, content_type: &str) -> AppResult<Self> {
        Ok(match name.unwrap_or("auto") {
            "auto" if content_type.contains("text/event-stream") => Self::Sse,
            "auto" if content_type.contains("vnd.docker.multiplexed-stream") => Self::Docker,
            "auto" | "lines" => Self::Lines,
            "sse" => Self::Sse,
            "docker" => Self::Docker,
            "raw" => Self::Raw,
            other => {
                return Err(AppError::new(format!(
                    "`format` « {other} » inconnu : « auto », « lines », « sse », « docker » ou « raw »."
                )))
            }
        })
    }
}

/// Découpe un contenu reçu par morceaux en événements `{ type: "data", data, … }`, secrets masqués.
pub struct Decoder {
    format: Format,
    buffer: Vec<u8>,
    secrets: Vec<String>,
    raw: Redactor,
    /// SSE : événement en cours.
    sse_data: Vec<String>,
    sse_event: Option<String>,
    sse_id: Option<String>,
    /// Docker : le flux n’a pas d’en-têtes (conteneur avec TTY), lu alors en lignes.
    docker_plain: bool,
}

fn text_of(bytes: &[u8], secrets: &[String]) -> String {
    clients::redact(&String::from_utf8_lossy(bytes), secrets)
}

impl Decoder {
    pub fn new(format: Format, secrets: Vec<String>) -> Self {
        Self {
            format,
            buffer: Vec::new(),
            raw: Redactor::new(&secrets),
            secrets,
            sse_data: Vec::new(),
            sse_event: None,
            sse_id: None,
            docker_plain: false,
        }
    }

    fn lines(&mut self, last: bool, mut each: impl FnMut(&mut Self, Vec<u8>)) {
        loop {
            match self.buffer.iter().position(|byte| *byte == b'\n') {
                Some(end) => {
                    let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    each(self, line);
                }
                None if self.buffer.len() > MAX_LINE || last && !self.buffer.is_empty() => {
                    let line = std::mem::take(&mut self.buffer);
                    each(self, line);
                }
                None => break,
            }
        }
    }

    fn sse_line(&mut self, line: Vec<u8>, events: &mut Vec<Value>) {
        let line = String::from_utf8_lossy(&line).to_string();
        if line.is_empty() {
            if !self.sse_data.is_empty() {
                let mut event = json!({ "type": "data", "data": clients::redact(&self.sse_data.join("\n"), &self.secrets) });
                if let Some(name) = self.sse_event.take() {
                    event["event"] = json!(clients::redact(&name, &self.secrets));
                }
                if let Some(id) = &self.sse_id {
                    event["id"] = json!(clients::redact(id, &self.secrets));
                }
                events.push(event);
            }
            self.sse_data.clear();
            self.sse_event = None;
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = line.split_once(':').map_or((line.as_str(), ""), |(field, value)| (field, value));
        let value = value.strip_prefix(' ').unwrap_or(value).to_string();
        match field {
            "data" => self.sse_data.push(value),
            "event" => self.sse_event = Some(value),
            "id" => self.sse_id = Some(value),
            _ => {}
        }
    }

    fn docker(&mut self, events: &mut Vec<Value>) {
        loop {
            if !self.docker_plain && !self.buffer.is_empty() && self.buffer[0] > 2 {
                // Pas d’en-tête de multiplexage : conteneur avec TTY, le flux est du texte.
                self.docker_plain = true;
            }
            if self.docker_plain || self.buffer.len() < 8 {
                return;
            }
            let size = u32::from_be_bytes([self.buffer[4], self.buffer[5], self.buffer[6], self.buffer[7]]) as usize;
            if self.buffer.len() < 8 + size {
                return;
            }
            let stream = match self.buffer[0] {
                2 => "stderr",
                0 => "stdin",
                _ => "stdout",
            };
            let frame: Vec<u8> = self.buffer.drain(..8 + size).skip(8).collect();
            let text = text_of(&frame, &self.secrets);
            for line in text.trim_end_matches('\n').split('\n') {
                events.push(json!({ "type": "data", "stream": stream, "data": line.trim_end_matches('\r') }));
            }
        }
    }

    /// Événements tirés d’un morceau ; `last` : fin du contenu, ce qui reste est rendu.
    pub fn feed(&mut self, chunk: &[u8], last: bool) -> Vec<Value> {
        let mut events = Vec::new();
        match self.format {
            Format::Raw => {
                let mut bytes = self.raw.push(chunk);
                if last {
                    bytes.extend(self.raw.finish());
                }
                if !bytes.is_empty() {
                    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                    events.push(json!({ "type": "data", "data": data, "base64": true }));
                }
            }
            Format::Lines => {
                self.buffer.extend_from_slice(chunk);
                self.lines(last, |decoder, line| {
                    events.push(json!({ "type": "data", "data": text_of(&line, &decoder.secrets) }));
                });
            }
            Format::Sse => {
                self.buffer.extend_from_slice(chunk);
                let mut lines = Vec::new();
                self.lines(last, |_, line| lines.push(line));
                for line in lines {
                    self.sse_line(line, &mut events);
                }
                if last {
                    self.sse_line(Vec::new(), &mut events);
                }
            }
            Format::Docker => {
                self.buffer.extend_from_slice(chunk);
                self.docker(&mut events);
                if self.docker_plain {
                    self.lines(last, |decoder, line| {
                        events.push(json!({ "type": "data", "stream": "stdout", "data": text_of(&line, &decoder.secrets) }));
                    });
                }
            }
        }
        events
    }
}

async fn pump_stream(id: String, mut response: reqwest::Response, mut decoder: Decoder, secrets: Vec<String>) {
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                for event in decoder.feed(&chunk, false) {
                    if !channels::push(&id, event) {
                        return;
                    }
                }
            }
            Ok(None) => {
                for event in decoder.feed(&[], true) {
                    channels::push(&id, event);
                }
                channels::finish(&id, "fin du flux", false);
                return;
            }
            Err(error) => {
                for event in decoder.feed(&[], true) {
                    channels::push(&id, event);
                }
                channels::finish(&id, &clients::network_error(error, &secrets).message, true);
                return;
            }
        }
    }
}

async fn open_stream(state: &Arc<AppState>, granted: &Granted, format: Option<String>) -> AppResult<Value> {
    let sent = clients::send(state, &granted.client, &granted.call, Profile::Stream).await?;
    if !sent.response.status().is_success() {
        return failed(sent, "channel").await;
    }
    let Sent { response, secrets } = sent;
    let status = response.status();
    let headers = clients::response_headers(&response, &secrets);
    let content_type = headers.get("content-type").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    let format = Format::parse(format.as_deref(), &content_type)?;
    let space = granted.space.root.to_string_lossy().to_string();
    let id = channels::open(&space, &granted.subject.module, &granted.client.id, "stream", None)?;
    let decoder = Decoder::new(format, secrets.clone());
    let task = tokio::spawn(pump_stream(id.clone(), response, decoder, secrets));
    channels::attach(&id, task.abort_handle());
    Ok(json!({ "status": status.as_u16(), "ok": true, "headers": headers, "channel": id, "format": format!("{format:?}").to_lowercase() }))
}

/// `client(id).stream(path, …)` : ouvre une réponse en continu et rend `{ status, ok, headers, channel }` ; la page
/// lit le canal par `channels.read`. En échec, `channel` est nul et `body` porte la réponse du service.
pub async fn stream(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let granted = clients::grant_call(state, args, None).await?;
    let started = Instant::now();
    let result = open_stream(state, &granted, opt_arg(args, "format")?).await;
    journaled(state, &granted, started, &result, "flux ouvert");
    result
}

// ---------------------------------------------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------------------------------------------

async fn pump_socket<S>(
    id: String,
    socket: tokio_tungstenite::WebSocketStream<S>,
    mut outgoing: mpsc::Receiver<Outgoing>,
    secrets: Vec<String>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio_tungstenite::tungstenite::Message;
    let (mut sink, mut incoming) = socket.split();
    loop {
        tokio::select! {
            received = incoming.next() => match received {
                Some(Ok(Message::Text(text))) => {
                    if !channels::push(&id, json!({ "type": "data", "data": clients::redact(text.as_str(), &secrets) })) {
                        return;
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(Redactor::all(&secrets, &bytes));
                    if !channels::push(&id, json!({ "type": "data", "data": data, "base64": true })) {
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let reason = frame
                        .map(|frame| format!("fermé par le service ({}{})", u16::from(frame.code), if frame.reason.is_empty() { String::new() } else { format!(" : {}", clients::redact(frame.reason.as_str(), &secrets)) }))
                        .unwrap_or_else(|| "fermé par le service".to_string());
                    channels::finish(&id, &reason, false);
                    return;
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    channels::finish(&id, &clients::redact(&format!("connexion interrompue : {error}"), &secrets), true);
                    return;
                }
                None => {
                    channels::finish(&id, "fermé par le service", false);
                    return;
                }
            },
            sent = outgoing.recv() => {
                let message = match sent {
                    Some(Outgoing::Text(text)) => Message::text(text),
                    Some(Outgoing::Binary(bytes)) => Message::binary(bytes),
                    Some(Outgoing::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        let _ = sink.close().await;
                        return;
                    }
                };
                if let Err(error) = sink.send(message).await {
                    channels::finish(&id, &clients::redact(&format!("envoi impossible : {error}"), &secrets), true);
                    return;
                }
            }
        }
    }
}

async fn open_socket(state: &Arc<AppState>, granted: &Granted) -> AppResult<Value> {
    use tokio_tungstenite::tungstenite::handshake::{client::generate_key, derive_accept_key};
    use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
    let key = generate_key();
    let call = clients::Call {
        method: Method::GET,
        path: granted.call.path.clone(),
        query: granted.call.query.clone(),
        headers: granted.call.headers.clone(),
        payload: clients::Payload::None,
        response_type: clients::ResponseType::Auto,
        handshake: Some(key.clone()),
        sealed: Default::default(),
    };
    let sent = clients::send(state, &granted.client, &call, Profile::Stream).await?;
    if sent.response.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS {
        return failed(sent, "channel").await;
    }
    let Sent { response, secrets } = sent;
    let status = response.status();
    let headers = clients::response_headers(&response, &secrets);
    let accept = response.headers().get("sec-websocket-accept").and_then(|value| value.to_str().ok()).unwrap_or_default();
    if accept != derive_accept_key(key.as_bytes()) {
        return Err(AppError::new("Le service n’a pas accepté le WebSocket comme le veut le protocole (réponse « Sec-WebSocket-Accept » inattendue)."));
    }
    let protocol = headers.get("sec-websocket-protocol").cloned().unwrap_or(Value::Null);
    let upgraded = response.upgrade().await.map_err(|error| clients::network_error(error, &secrets))?;
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
    let socket = tokio_tungstenite::WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await;
    let (sender, receiver) = mpsc::channel(64);
    let space = granted.space.root.to_string_lossy().to_string();
    let id = channels::open(&space, &granted.subject.module, &granted.client.id, "socket", Some(sender))?;
    let task = tokio::spawn(pump_socket(id.clone(), socket, receiver, secrets));
    channels::attach(&id, task.abort_handle());
    Ok(json!({ "status": status.as_u16(), "ok": true, "headers": headers, "channel": id, "protocol": protocol }))
}

/// `client(id).socket(path, …)` : ouvre un WebSocket vers le compte (`wss://` pour une adresse `https://`) et rend
/// `{ status: 101, ok, headers, channel, protocol }` ; la page lit et écrit le canal. En échec (pas de passage au
/// WebSocket), `channel` est nul et `body` porte la réponse du service.
pub async fn socket(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let mut granted = clients::grant_call(state, args, Some(Method::GET)).await?;
    granted.call.handshake = Some(String::new());
    let started = Instant::now();
    let result = open_socket(state, &granted).await;
    journaled(state, &granted, started, &result, "WebSocket ouvert");
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::clients::testing::{function_subject, grant, invoke, page_subject, test_state, unique};
    use axum::body::Body;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{any, get};
    use axum::Router;
    use std::sync::Mutex;

    const TOKEN: &str = "j3t0n-tr4nsp0rt-XYZ";

    #[derive(Default)]
    struct Seen {
        uploads: Mutex<Vec<(HeaderMap, Vec<u8>)>>,
    }

    /// Artefact de 3 Mo, dont le milieu renvoie l’en-tête d’authentification reçu (un service qui fait écho).
    fn artifact(authorization: &str) -> Vec<u8> {
        let mut bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|index| (index % 251) as u8).collect();
        let at = 1024 * 1024 - 5;
        bytes.splice(at..at, authorization.bytes());
        bytes
    }

    fn frame(stream: u8, text: &str) -> Vec<u8> {
        let mut bytes = vec![stream, 0, 0, 0];
        bytes.extend((text.len() as u32).to_be_bytes());
        bytes.extend(text.as_bytes());
        bytes
    }

    /// Réponse en continu : chaque morceau arrive après un court délai, et le dernier ne vient jamais si `endless`.
    fn slow(chunks: Vec<Vec<u8>>, endless: bool, kind: &'static str) -> axum::response::Response {
        let stream = futures_util::stream::unfold((chunks.into_iter(), endless), |(mut chunks, endless)| async move {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            match chunks.next() {
                Some(chunk) => Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk)), (chunks, endless))),
                None if endless => {
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    None
                }
                None => None,
            }
        });
        axum::response::Response::builder().header("content-type", kind).body(Body::from_stream(stream)).unwrap()
    }

    async fn service() -> (String, Arc<Seen>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Seen::default());
        let uploads = seen.clone();
        let router = Router::new()
            .route(
                "/api/artefacts/{name}",
                get(|headers: HeaderMap| async move {
                    let authorization = headers.get("authorization").unwrap().to_str().unwrap().to_string();
                    ([("content-type", "application/octet-stream"), ("content-disposition", "attachment; filename=\"build-42.zip\"")], artifact(&authorization))
                }),
            )
            .route("/api/absent", get(|| async { (StatusCode::NOT_FOUND, axum::Json(json!({ "error": "introuvable" }))) }))
            .route(
                "/api/icone",
                get(|headers: HeaderMap| async move {
                    let mut bytes = vec![0x89, b'P', b'N', b'G', 0, 1, 2, 255];
                    bytes.extend(headers.get("authorization").unwrap().as_bytes());
                    ([("content-type", "image/png")], bytes)
                }),
            )
            .route(
                "/api/envoi",
                any(move |headers: HeaderMap, body: axum::body::Bytes| {
                    let uploads = uploads.clone();
                    async move {
                        uploads.uploads.lock().unwrap().push((headers, body.to_vec()));
                        axum::Json(json!({ "recu": true }))
                    }
                }),
            )
            .route(
                "/api/journal",
                get(|headers: HeaderMap| async move {
                    let authorization = headers.get("authorization").unwrap().to_str().unwrap().to_string();
                    let chunks = vec![b"demarrage\nprem".to_vec(), format!("iere etape {authorization}\n").into_bytes(), b"fin\n".to_vec()];
                    slow(chunks, false, "text/plain")
                }),
            )
            .route(
                "/api/evenements",
                get(|| async {
                    let chunks = vec![b"event: etat\ndata: {\"run\":1}\n\n".to_vec(), b"data: en cours\n\n".to_vec()];
                    slow(chunks, true, "text/event-stream")
                }),
            )
            .route(
                "/api/conteneurs/web/logs",
                get(|| async {
                    let chunks = vec![frame(1, "nginx prêt\n"), frame(2, "avertissement\n")];
                    slow(chunks, false, "application/vnd.docker.multiplexed-stream")
                }),
            );
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    /// Console d’écho en WebSocket : renvoie chaque message, et dit d’abord l’authentification reçue.
    async fn console() -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
                    use tokio_tungstenite::tungstenite::Message;
                    let mut authorization = String::new();
                    let mut path = String::new();
                    // Signature imposée par tungstenite (son erreur est une réponse HTTP entière).
                    #[allow(clippy::result_large_err)]
                    let callback = |request: &Request, response: Response| {
                        authorization = request.headers().get("authorization").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
                        path = request.uri().to_string();
                        Ok(response)
                    };
                    let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
                    let _ = socket.send(Message::text(format!("connecté à {path} avec {authorization}"))).await;
                    while let Some(Ok(message)) = socket.next().await {
                        match message {
                            Message::Text(text) => {
                                let _ = socket.send(Message::text(format!("écho : {text}"))).await;
                            }
                            Message::Binary(bytes) => {
                                let _ = socket.send(Message::binary(bytes)).await;
                            }
                            Message::Close(_) => return,
                            _ => {}
                        }
                    }
                });
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    async fn account(state: &Arc<AppState>, id: &str, base: &str) {
        let secret = unique("transport");
        invoke(state, "vault.save", json!({ "id": secret, "label": "Jeton", "kind": "token", "secrets": { "value": TOKEN } }))
            .await
            .unwrap();
        let client = json!({ "id": id, "label": id, "baseUrl": base, "auth": { "type": "bearer", "secret": secret } });
        let saved = invoke(state, "clients.save", json!({ "client": client })).await.unwrap();
        assert_eq!(saved["status"], json!("ready"));
        grant(state, &function_subject("ci"), id);
    }

    async fn call(state: &Arc<AppState>, command: &str, client: &str, mut args: Value) -> AppResult<Value> {
        args["subject"] = serde_json::to_value(function_subject("ci")).unwrap();
        args["client"] = json!(client);
        invoke(state, command, args).await
    }

    async fn read_until_closed(state: &Arc<AppState>, channel: &str, page: &crate::permissions::Subject) -> Vec<Value> {
        let mut events = Vec::new();
        let mut after = 0;
        for _ in 0..50 {
            let read = invoke(state, "frame.channels.read", json!({ "subject": page, "channel": channel, "after": after, "wait": 2 }))
                .await
                .unwrap();
            events.extend(read["events"].as_array().unwrap().iter().cloned());
            after = read["next"].as_u64().unwrap();
            if read["closed"] == json!(true) {
                break;
            }
        }
        events
    }

    #[tokio::test]
    async fn an_artifact_is_downloaded_into_the_module_files_without_its_secret() {
        let (state, _dir) = test_state();
        let (base, _) = service().await;
        account(&state, "artifactory", &format!("{base}/api")).await;

        let downloaded = call(&state, "frame.clients.download", "artifactory", json!({ "path": "/artefacts/build-42" })).await.unwrap();
        assert_eq!(downloaded["ok"], true, "{downloaded}");
        let file = &downloaded["file"];
        assert_eq!(file["name"], "build-42.zip", "nom donné par le service");
        assert_eq!(file["mime"], "application/zip", "type déduit du nom quand le service dit octet-stream");
        let space = state.space().unwrap();
        let (info, bytes) = crate::module_files::read(&space, "ci", file["id"].as_str().unwrap()).unwrap();
        let expected = Redactor::all(&[TOKEN.to_string()], &artifact(&format!("Bearer {TOKEN}")));
        assert_eq!(bytes.len(), expected.len());
        assert!(bytes == expected, "contenu intact, secret masqué");
        assert!(!bytes.windows(TOKEN.len()).any(|window| window == TOKEN.as_bytes()));
        let digest: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(info.sha256, digest);
        assert_eq!(info.size, bytes.len() as u64);

        // Un nom demandé l’emporte ; une erreur du service ne laisse aucun fichier.
        let named = call(&state, "frame.clients.download", "artifactory", json!({ "path": "/artefacts/x", "name": "dernier.zip" })).await.unwrap();
        assert_eq!(named["file"]["name"], "dernier.zip");
        let missing = call(&state, "frame.clients.download", "artifactory", json!({ "path": "/absent" })).await.unwrap();
        assert_eq!((missing["ok"].clone(), missing["status"].clone(), missing["file"].clone()), (json!(false), json!(404), Value::Null));
        assert_eq!(missing["body"]["error"], "introuvable");
        assert_eq!(crate::module_files::list(&space, "ci", None, 10).unwrap().len(), 2);

        // Toujours sous l’adresse du compte, toujours depuis une fonction.
        assert!(call(&state, "frame.clients.download", "artifactory", json!({ "path": "/../prive" })).await.is_err());
        let page = invoke(&state, "frame.clients.download", json!({ "subject": page_subject("ci"), "client": "artifactory", "path": "/artefacts/a" })).await;
        assert!(page.is_err());

        // Petit binaire en base64, secret masqué dans les octets.
        let icon = call(&state, "frame.clients.request", "artifactory", json!({ "path": "/icone", "responseType": "base64" })).await.unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(icon["body"].as_str().unwrap()).unwrap();
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0, 1, 2, 255]);
        assert!(String::from_utf8_lossy(&bytes[8..]).contains(crate::clients::MASK));
    }

    #[tokio::test]
    async fn files_of_the_module_are_sent_as_multipart_or_raw_body() {
        let (state, _dir) = test_state();
        let (base, seen) = service().await;
        account(&state, "jira", &format!("{base}/api")).await;
        let space = state.space().unwrap();
        let file = crate::module_files::save(&space, "ci", "capture.png", None, &[0x89, b'P', b'N', b'G', 0, 7]).unwrap();
        let other = crate::module_files::save(&space, "autre", "secret.txt", None, b"a moi").unwrap();

        let sent = call(
            &state,
            "frame.clients.request",
            "jira",
            json!({ "method": "POST", "path": "/envoi", "headers": { "Content-Type": "application/json" }, "multipart": [{ "name": "comment", "value": "voir pièce" }, { "name": "file", "file": file.id, "filename": "écran.png" }] }),
        )
        .await
        .unwrap();
        assert_eq!(sent["body"]["recu"], true);
        let (headers, body) = seen.uploads.lock().unwrap().last().cloned().unwrap();
        let kind = headers.get("content-type").unwrap().to_str().unwrap().to_string();
        assert!(kind.starts_with("multipart/form-data; boundary="), "{kind}");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"comment\"") && text.contains("voir pièce"), "{text}");
        assert!(text.contains("filename=\"écran.png\"") && text.contains("image/png"), "{text}");
        assert!(body.windows(6).any(|window| window == [0x89, b'P', b'N', b'G', 0, 7]));
        assert_eq!(headers.get("authorization").unwrap(), &format!("Bearer {TOKEN}"));

        // Dépôt brut (Artifactory) : le fichier tel quel, sa longueur et son type.
        call(&state, "frame.clients.request", "jira", json!({ "method": "PUT", "path": "/envoi", "file": file.id })).await.unwrap();
        let (headers, body) = seen.uploads.lock().unwrap().last().cloned().unwrap();
        assert_eq!(body, vec![0x89, b'P', b'N', b'G', 0, 7]);
        assert_eq!(headers.get("content-length").unwrap(), "6");
        assert_eq!(headers.get("content-type").unwrap(), "image/png");

        // Formulaire simple.
        call(&state, "frame.clients.request", "jira", json!({ "method": "POST", "path": "/envoi", "form": { "a": "b c", "n": 2 } })).await.unwrap();
        let (headers, body) = seen.uploads.lock().unwrap().last().cloned().unwrap();
        assert_eq!(headers.get("content-type").unwrap(), "application/x-www-form-urlencoded");
        assert_eq!(String::from_utf8(body).unwrap(), "a=b+c&n=2");

        // Le fichier d’un autre module, ou deux corps à la fois : refusés avant tout envoi.
        let count = seen.uploads.lock().unwrap().len();
        let foreign = call(&state, "frame.clients.request", "jira", json!({ "method": "PUT", "path": "/envoi", "file": other.id })).await;
        assert!(foreign.is_err());
        let both = call(&state, "frame.clients.request", "jira", json!({ "method": "POST", "path": "/envoi", "body": {}, "file": file.id })).await;
        assert!(both.unwrap_err().message.contains("Un seul corps"));
        assert_eq!(seen.uploads.lock().unwrap().len(), count);
    }

    #[tokio::test]
    async fn a_page_follows_a_log_stream_opened_by_the_connector() {
        let (state, _dir) = test_state();
        let (base, _) = service().await;
        account(&state, "portainer", &format!("{base}/api")).await;
        let page = page_subject("ci");

        let opened = call(&state, "frame.clients.stream", "portainer", json!({ "path": "/journal" })).await.unwrap();
        assert_eq!((opened["ok"].clone(), opened["format"].clone()), (json!(true), json!("lines")));
        let channel = opened["channel"].as_str().unwrap().to_string();
        let events = read_until_closed(&state, &channel, &page).await;
        let lines: Vec<&str> = events.iter().filter(|event| event["type"] == "data").map(|event| event["data"].as_str().unwrap()).collect();
        assert_eq!(lines, ["demarrage", &format!("premiere etape Bearer {}", crate::clients::MASK), "fin"]);
        assert_eq!(events.last().unwrap()["type"], "close");
        // Un autre module ne lit pas ce canal.
        let foreign = invoke(&state, "frame.channels.read", json!({ "subject": page_subject("autre"), "channel": channel })).await;
        assert!(foreign.is_err());

        // Journaux Docker multiplexés, reconnus à leur type.
        let logs = call(&state, "frame.clients.stream", "portainer", json!({ "path": "/conteneurs/web/logs", "query": { "follow": true } })).await.unwrap();
        assert_eq!(logs["format"], "docker");
        let events = read_until_closed(&state, logs["channel"].as_str().unwrap(), &page).await;
        assert_eq!(events[0]["stream"], "stdout");
        assert_eq!(events[0]["data"], "nginx prêt");
        assert_eq!(events[1]["stream"], "stderr");

        // SSE sans fin : la page lit les événements, puis ferme le canal en partant.
        let sse = call(&state, "frame.clients.stream", "portainer", json!({ "path": "/evenements" })).await.unwrap();
        let channel = sse["channel"].as_str().unwrap().to_string();
        let mut events = Vec::new();
        let mut after = 0;
        while events.len() < 2 {
            let read = invoke(&state, "frame.channels.read", json!({ "subject": page, "channel": channel, "after": after, "wait": 2 })).await.unwrap();
            events.extend(read["events"].as_array().unwrap().iter().cloned());
            after = read["next"].as_u64().unwrap();
        }
        assert_eq!((events[0]["event"].as_str(), events[0]["data"].as_str()), (Some("etat"), Some("{\"run\":1}")));
        assert_eq!(events[1]["data"], "en cours");
        let released = invoke(&state, "frame.channels.release", json!({ "subject": page })).await.unwrap();
        assert_eq!(released["closed"], 1);
        let end = invoke(&state, "frame.channels.read", json!({ "subject": page, "channel": channel, "after": after })).await.unwrap();
        assert_eq!(end["closed"], true);
    }

    #[tokio::test]
    async fn a_container_console_talks_through_a_websocket_channel() {
        let (state, _dir) = test_state();
        let base = console().await;
        account(&state, "console", &format!("{base}/api")).await;
        let page = page_subject("ci");

        let opened = call(&state, "frame.clients.socket", "console", json!({ "path": "/websocket/exec", "query": { "id": "abc" } })).await.unwrap();
        assert_eq!((opened["ok"].clone(), opened["status"].clone()), (json!(true), json!(101)), "{opened}");
        let channel = opened["channel"].as_str().unwrap().to_string();

        let read = |after: u64| {
            let state = state.clone();
            let (page, channel) = (page.clone(), channel.clone());
            async move {
                invoke(&state, "frame.channels.read", json!({ "subject": page, "channel": channel, "after": after, "wait": 3 })).await.unwrap()
            }
        };
        let first = read(0).await;
        let hello = first["events"][0]["data"].as_str().unwrap().to_string();
        assert_eq!(hello, format!("connecté à /api/websocket/exec?id=abc avec Bearer {}", crate::clients::MASK));
        let after = first["next"].as_u64().unwrap();

        invoke(&state, "frame.channels.write", json!({ "subject": page, "channel": channel, "text": "ls -la\n" })).await.unwrap();
        let echoed = read(after).await;
        assert_eq!(echoed["events"][0]["data"], "écho : ls -la\n");
        let after = echoed["next"].as_u64().unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        invoke(&state, "frame.channels.write", json!({ "subject": page, "channel": channel, "data": data })).await.unwrap();
        let binary = read(after).await;
        assert_eq!((binary["events"][0]["data"].as_str(), binary["events"][0]["base64"].as_bool()), (Some(data.as_str()), Some(true)));

        // Trop long, ou d’un autre module : refusé.
        let long = "x".repeat(crate::channels::MAX_WRITE + 1);
        assert!(invoke(&state, "frame.channels.write", json!({ "subject": page, "channel": channel, "text": long })).await.is_err());
        assert!(invoke(&state, "frame.channels.write", json!({ "subject": page_subject("autre"), "channel": channel, "text": "x" })).await.is_err());

        invoke(&state, "frame.channels.close", json!({ "subject": page, "channel": channel })).await.unwrap();
        let closed = invoke(&state, "frame.channels.read", json!({ "subject": page, "channel": channel, "after": binary["next"] })).await.unwrap();
        assert_eq!(closed["closed"], true);
        assert!(invoke(&state, "frame.channels.write", json!({ "subject": page, "channel": channel, "text": "x" })).await.is_err());

        // Un service qui ne passe pas au WebSocket : pas de canal, sa réponse.
        let (http, _) = service().await;
        account(&state, "pas-ws", &format!("{http}/api")).await;
        let refused = call(&state, "frame.clients.socket", "pas-ws", json!({ "path": "/absent" })).await.unwrap();
        assert_eq!((refused["ok"].clone(), refused["channel"].clone(), refused["status"].clone()), (json!(false), Value::Null, json!(404)));
    }

    #[test]
    fn a_secret_cut_between_two_chunks_is_still_masked() {
        let secrets = vec!["jeton-tres-secret".to_string()];
        let mut redactor = Redactor::new(&secrets);
        let mut out = redactor.push(b"debut jeton-tr");
        out.extend(redactor.push(b"es-secret fin"));
        out.extend(redactor.finish());
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text, format!("debut {} fin", clients::MASK));
        assert_eq!(Redactor::all(&[], b"\x00\x01binaire"), b"\x00\x01binaire");
    }

    #[test]
    fn streams_are_cut_into_lines_sse_events_and_docker_frames() {
        let mut lines = Decoder::new(Format::Lines, vec!["motdepasse".into()]);
        let mut events = lines.feed(b"premiere\r\ndeux", false);
        events.extend(lines.feed(b"ieme motdepasse\ntrois", false));
        events.extend(lines.feed(b"", true));
        let data: Vec<&str> = events.iter().map(|event| event["data"].as_str().unwrap()).collect();
        assert_eq!(data, ["premiere", &format!("deuxieme {}", clients::MASK), "trois"]);

        let mut sse = Decoder::new(Format::Sse, vec![]);
        let events = sse.feed(b": commentaire\nevent: etat\nid: 7\ndata: {\"a\":1}\ndata: suite\n\ndata: seul\n\n", false);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event"], "etat");
        assert_eq!(events[0]["id"], "7");
        assert_eq!(events[0]["data"], "{\"a\":1}\nsuite");
        assert_eq!(events[1]["data"], "seul");
        assert!(events[1].get("event").is_none());

        let frame = |stream: u8, text: &str| {
            let mut bytes = vec![stream, 0, 0, 0];
            bytes.extend((text.len() as u32).to_be_bytes());
            bytes.extend(text.as_bytes());
            bytes
        };
        let mut docker = Decoder::new(Format::Docker, vec![]);
        let mut all = frame(1, "démarré\n");
        all.extend(frame(2, "attention\n"));
        let (first, second) = all.split_at(5);
        let mut events = docker.feed(first, false);
        events.extend(docker.feed(second, false));
        assert_eq!(events.len(), 2);
        assert_eq!((events[0]["stream"].as_str(), events[0]["data"].as_str()), (Some("stdout"), Some("démarré")));
        assert_eq!((events[1]["stream"].as_str(), events[1]["data"].as_str()), (Some("stderr"), Some("attention")));
        // Conteneur avec TTY : pas d’en-tête, du texte.
        let mut tty = Decoder::new(Format::Docker, vec![]);
        let events = tty.feed(b"ligne tty\n", false);
        assert_eq!(events[0]["data"], "ligne tty");
    }

    #[test]
    fn the_downloaded_file_is_named_by_the_service_when_not_asked() {
        assert_eq!(disposition_name("attachment; filename=\"rapport.pdf\"").as_deref(), Some("rapport.pdf"));
        assert_eq!(
            disposition_name("attachment; filename=\"a.zip\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20final.zip").as_deref(),
            Some("résumé final.zip")
        );
        assert_eq!(disposition_name("inline"), None);
    }

    /// Hébergeur de fichiers sur un autre hôte (`localhost`) : il note les en-têtes reçus.
    async fn cdn() -> (u16, Arc<Mutex<Vec<HeaderMap>>>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<HeaderMap>>> = Arc::default();
        let noted = seen.clone();
        let router = Router::new()
            .route(
                "/media/{name}",
                get(move |headers: HeaderMap| {
                    let noted = noted.clone();
                    async move {
                        noted.lock().unwrap().push(headers);
                        ([("content-type", "audio/mpeg")], b"ID3-episode-complet".to_vec())
                    }
                }),
            )
            // Une seconde redirection, sur le même hôte : suivie d’office.
            .route("/relais", get(move || async move { axum::response::Redirect::temporary("/media/relaye.mp3") }));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (port, seen)
    }

    /// Service qui renvoie ses fichiers vers `cdn` (sur `localhost`) ou vers une autre origine non déclarée.
    async fn redirecting(cdn: u16) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let to = |target: String| move || async move { axum::response::Redirect::temporary(&target) };
        let router = Router::new()
            .route("/api/episode", get(to(format!("http://localhost:{cdn}/media/episode.mp3"))))
            .route("/api/relais", get(to(format!("http://localhost:{cdn}/relais"))))
            .route("/api/fuite", get(to(format!("http://localhost:{cdn}/media/x.mp3?cle={TOKEN}"))))
            .route("/api/ailleurs", get(to(format!("http://127.0.0.1:{cdn}/media/ailleurs.mp3"))))
            .route("/api/ecrire", any(to(format!("http://localhost:{cdn}/media/ecrit.mp3"))));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://127.0.0.1:{port}/api")
    }

    #[tokio::test]
    async fn a_redirect_to_a_declared_host_is_followed_bare_and_a_temporary_download_returns_a_path() {
        let (state, _dir) = test_state();
        let (port, seen) = cdn().await;
        let base = redirecting(port).await;
        let secret = unique("redirection");
        invoke(&state, "vault.save", json!({ "id": secret, "label": "Jeton", "kind": "token", "secrets": { "value": TOKEN } }))
            .await
            .unwrap();
        let client = json!({ "id": "podcast", "label": "Podcast", "baseUrl": base, "auth": { "type": "bearer", "secret": secret },
            "headers": { "X-Client": "alfred" }, "redirectHosts": [" LocalHost "] });
        let saved = invoke(&state, "clients.save", json!({ "client": client })).await.unwrap();
        assert_eq!(saved["status"], json!("ready"), "{saved}");
        grant(&state, &function_subject("ci"), "podcast");

        // Fichier temporaire : le chemin, la taille et l’empreinte ; la requête suivie part sans en-tête du compte.
        let downloaded = call(&state, "frame.clients.download", "podcast", json!({ "path": "/episode", "temporary": true })).await.unwrap();
        assert_eq!((downloaded["ok"].clone(), downloaded["file"].clone()), (json!(true), Value::Null), "{downloaded}");
        let temporary = &downloaded["temporary"];
        let path = std::path::PathBuf::from(temporary["path"].as_str().unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"ID3-episode-complet");
        assert!(path.starts_with(temporary_dir(&state.space().unwrap())), "{}", path.display());
        assert_eq!((temporary["name"].clone(), temporary["mime"].clone(), temporary["size"].clone()), (json!("episode"), json!("audio/mpeg"), json!(19)));
        let digest: String = Sha256::digest(b"ID3-episode-complet").iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(temporary["sha256"], json!(digest));
        let headers = seen.lock().unwrap().last().cloned().unwrap();
        assert!(headers.get("authorization").is_none() && headers.get("x-client").is_none(), "{headers:?}");

        // Une redirection de plus sur le même hôte ; une requête ordinaire en base64 suit aussi.
        let relayed = call(&state, "frame.clients.download", "podcast", json!({ "path": "/relais", "name": "relaye.mp3" })).await.unwrap();
        assert_eq!(relayed["file"]["name"], json!("relaye.mp3"), "{relayed}");
        let small = call(&state, "frame.clients.request", "podcast", json!({ "path": "/episode", "responseType": "base64" })).await.unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(small["body"].as_str().unwrap()).unwrap(), b"ID3-episode-complet");

        // Rendue telle quelle : un hôte non déclaré, une adresse qui porte le secret, une écriture.
        let before = seen.lock().unwrap().len();
        for (method, path) in [("GET", "/ailleurs"), ("GET", "/fuite"), ("POST", "/ecrire")] {
            let response = call(&state, "frame.clients.request", "podcast", json!({ "method": method, "path": path })).await.unwrap();
            assert_eq!(response["status"], json!(307), "{path} : {response}");
        }
        assert_eq!(seen.lock().unwrap().len(), before, "aucune de ces redirections n’est suivie");

        // `maxSize` : un fichier plus gros est abandonné, sans rien laisser.
        let error = call(&state, "frame.clients.download", "podcast", json!({ "path": "/episode", "temporary": true, "maxSize": 5 })).await.unwrap_err();
        assert!(error.message.contains("maxSize"), "{}", error.message);
        let left: Vec<_> = std::fs::read_dir(temporary_dir(&state.space().unwrap())).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(left.len(), 1, "seul le premier téléchargement reste : {left:?}");
    }

    #[tokio::test]
    async fn redirect_hosts_are_validated_and_part_of_the_validated_fingerprint() {
        let (state, _dir) = test_state();
        for wrong in ["https://cdn.exemple.com", "cdn.exemple.com:443", "*.com", "*", "cdn exemple", "cdn.exemple.com/media"] {
            let client = json!({ "id": "cdn", "label": "CDN", "baseUrl": "https://api.exemple.com", "auth": { "type": "none" }, "redirectHosts": [wrong] });
            let error = invoke(&state, "clients.save", json!({ "client": client })).await.unwrap_err();
            assert!(error.message.contains("Hôte de redirection invalide"), "{wrong} : {}", error.message);
        }
        let hosts = ["media.exemple.com".to_string(), "*.cdn.exemple.com".to_string()];
        let from = url::Url::parse("https://api.exemple.com/").unwrap();
        let allowed = |target: &str| clients::redirect_allowed(&hosts, &from, &url::Url::parse(target).unwrap());
        assert!(allowed("https://media.exemple.com/a.mp3") && allowed("https://s0.cdn.exemple.com/a"));
        assert!(!allowed("https://cdn.exemple.com/a"), "`*.` ne vaut que pour les sous-domaines");
        assert!(!allowed("http://media.exemple.com/a"), "pas de HTTPS vers HTTP");
        assert!(!allowed("https://media.exemple.com.pirate.net/a") && !allowed("https://user@media.exemple.com/a"));

        let mut client = clients::Client { id: "cdn".into(), label: "CDN".into(), base_url: "https://api.exemple.com".into(), ..Default::default() };
        let before = clients::fingerprint(&client);
        assert!(before.get("redirectHosts").is_none(), "absente sans hôte : les validations déjà données tiennent");
        client.redirect_hosts = hosts.to_vec();
        assert_eq!(clients::fingerprint(&client)["redirectHosts"], json!("media.exemple.com, *.cdn.exemple.com"));
    }
}
