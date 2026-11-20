//! Références de secrets : les valeurs qu’un service rend et qu’aucune fonction ni page ne doit lire (valeurs d’un
//! coffre OpenBao, secret d’un client Keycloak, jeton émis) sont remplacées par une référence opaque
//! (`alfred-secret-ref:v1:<nonce>`). La valeur reste dans la mémoire d’Alfred, cinq minutes au plus, pour le module
//! qui l’a lue ; elle n’est jamais écrite sur le disque, dans un journal ni dans une réponse.
//!
//! Une référence ne se résout que de trois façons :
//! - `secrets.reveal` : la coquille l’affiche dans sa propre boîte, après un clic de l’utilisateur ; la page ne
//!   reçoit jamais la valeur ;
//! - `secrets.writeEnvFile` : un fichier `.env` écrit à l’endroit que l’utilisateur a choisi ;
//! - une requête `sealed: true` d’une fonction vers un chemin scellé **du même service** (recopie d’un coffre vers
//!   un autre compte) : la valeur est replacée en natif dans le corps envoyé.
//!
//! Partout ailleurs, une référence est refusée (paramètre, en-tête, corps d’une requête ordinaire) : elle n’est
//! jamais remplacée en silence.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Method;
use serde_json::{json, Map, Value};

use crate::app_db::{self, JournalEntry};
use crate::clients::{Client, SealedRule};
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::state::AppState;

pub const PREFIX: &str = "alfred-secret-ref:v1:";
/// Longueur du nonce : 32 octets aléatoires en base64 sans remplissage.
const NONCE_LENGTH: usize = 43;
/// Durée de vie d’une référence.
pub const TTL: Duration = Duration::from_secs(5 * 60);
/// Au-delà, les références les plus anciennes sont oubliées : une fonction qui lit un très gros coffre en boucle ne
/// fait pas grossir la mémoire sans fin.
const MAX_REFERENCES: usize = 4096;

/// Usage des références dans une requête d’une fonction : son module, et l’accord explicite (`sealed: true`) pour
/// que les références de son corps soient remplacées par leurs valeurs.
#[derive(Debug, Clone, Default)]
pub struct SealedUse {
    pub module: String,
    pub substitute: bool,
}

/// Valeur scellée et ce à quoi elle appartient.
#[derive(Clone)]
struct Sealed {
    value: Value,
    module: String,
    client: String,
    instance: String,
    created: Instant,
}

fn references() -> MutexGuard<'static, HashMap<String, Sealed>> {
    static REFERENCES: OnceLock<Mutex<HashMap<String, Sealed>>> = OnceLock::new();
    REFERENCES.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn denied() -> AppError {
    AppError::with_detail(
        "Cette référence de secret n’est pas (ou plus) valable ici : elle a expiré (cinq minutes), ou elle appartient à un autre module ou à un autre service. Relire la valeur.",
        json!({ "reason": "secretRef" }),
    )
}

/// Le texte est-il une référence complète ?
pub fn is_reference(text: &str) -> bool {
    text.strip_prefix(PREFIX).is_some_and(|nonce| {
        nonce.len() == NONCE_LENGTH && nonce.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

/// Références contenues dans un texte, dans leur ordre d’apparition.
fn find_references(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(PREFIX) {
        let candidate: String = rest[start..].chars().take(PREFIX.len() + NONCE_LENGTH).collect();
        if is_reference(&candidate) {
            found.push(candidate.clone());
            rest = &rest[start + candidate.len()..];
        } else {
            rest = &rest[start + PREFIX.len()..];
        }
    }
    found
}

pub fn contains_reference(text: &str) -> bool {
    text.contains(PREFIX)
}

/// Texte d’une valeur scellée : une chaîne telle quelle, toute autre valeur en JSON.
pub fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Scelle une valeur pour ce module, ce service et ce compte ; rend sa référence.
fn issue(value: Value, module: &str, client: &Client) -> String {
    let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let mut all = references();
    all.retain(|_, sealed| sealed.created.elapsed() < TTL);
    if all.len() >= MAX_REFERENCES {
        if let Some(oldest) = all.iter().min_by_key(|(_, sealed)| sealed.created).map(|(key, _)| key.clone()) {
            all.remove(&oldest);
        }
    }
    all.insert(
        nonce.clone(),
        Sealed {
            value,
            module: module.to_string(),
            client: client.id.clone(),
            instance: client.instance.clone(),
            created: Instant::now(),
        },
    );
    format!("{PREFIX}{nonce}")
}

/// Valeur d’une référence encore valable pour ce module (et, si nommé, ce service).
fn lookup(reference: &str, module: &str, client: Option<&str>) -> AppResult<Sealed> {
    let nonce = reference.strip_prefix(PREFIX).filter(|_| is_reference(reference)).ok_or_else(denied)?;
    let all = references();
    match all.get(nonce) {
        Some(sealed)
            if sealed.created.elapsed() < TTL
                && sealed.module == module
                && client.is_none_or(|client| client == sealed.client) =>
        {
            Ok(sealed.clone())
        }
        _ => Err(denied()),
    }
}

/// Valeur qu’une page ou un panneau du module `module` peut afficher ou écrire dans un `.env` : scellée par ce
/// module, ou par un module dont il dépend (`depends`). Un module qui se sert d’un connecteur à part (la page
/// Secrets d’Atom et le connecteur `openbao`) reçoit les références que les fonctions du connecteur ont lues.
fn lookup_shown(reference: &str, module: &str, depends: impl Fn(&str) -> bool) -> AppResult<Sealed> {
    let nonce = reference.strip_prefix(PREFIX).filter(|_| is_reference(reference)).ok_or_else(denied)?;
    let sealed = references().get(nonce).filter(|sealed| sealed.created.elapsed() < TTL).cloned().ok_or_else(denied)?;
    if sealed.module == module || depends(&sealed.module) {
        Ok(sealed)
    } else {
        Err(denied())
    }
}

/// `lookup_shown` d’après les `requires` du module dans l’espace ouvert.
fn shown_value(state: &AppState, reference: &str, module: &str) -> AppResult<Sealed> {
    lookup_shown(reference, module, |owner| {
        state.try_space().and_then(|space| space.module(module).ok()).is_some_and(|manifest| manifest.requires_module(owner))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Règles
// ---------------------------------------------------------------------------------------------------------------

/// Vérifie les règles `sealed` d’un client.
pub fn validate_rules(rules: &[SealedRule]) -> AppResult<()> {
    for rule in rules {
        if !rule.path.starts_with('/') || rule.path.contains(['?', '#']) {
            return Err(AppError::new(format!(
                "Règle scellée invalide : « {} ». Le chemin commence par « / », sans paramètres (`*` vaut un segment, `**` la suite).",
                rule.path
            )));
        }
        for method in &rule.methods {
            if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD") {
                return Err(AppError::new(format!("Règle scellée « {} » : méthode inconnue « {method} ».", rule.path)));
            }
        }
        for field in &rule.fields {
            if field.split('.').any(str::is_empty) {
                return Err(AppError::new(format!(
                    "Règle scellée « {} » : champ invalide « {field} » (chemin pointé, `*` pour tous).",
                    rule.path
                )));
            }
        }
    }
    Ok(())
}

/// Résumé lisible des règles, pour l’empreinte que l’utilisateur valide.
pub fn describe_rules(rules: &[SealedRule]) -> String {
    rules
        .iter()
        .map(|rule| {
            let methods = if rule.methods.is_empty() { "*".to_string() } else { rule.methods.join(",") };
            let fields = if rule.fields.is_empty() { "toute la réponse".to_string() } else { rule.fields.join(", ") };
            format!("{methods} {} : {fields}", rule.path)
        })
        .collect::<Vec<_>>()
        .join(" ; ")
}

fn decode(segment: &str) -> String {
    url::form_urlencoded::parse(format!("v={}", segment.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

fn segments_match(pattern: &[&str], path: &[&str], client: &Client) -> bool {
    match (pattern.first(), path.first()) {
        (None, None) => true,
        (Some(&"**"), _) => (0..=path.len()).any(|skip| segments_match(&pattern[1..], &path[skip..], client)),
        (Some(expected), Some(actual)) => {
            let fits = if *expected == "*" {
                true
            } else if let Some(name) = expected.strip_prefix('{').and_then(|name| name.strip_suffix('}')) {
                // Un paramètre du compte vaut sa valeur ; sans valeur, un segment quelconque.
                client.params.get(name).is_none_or(|value| *value == decode(actual))
            } else {
                decode(expected) == decode(actual)
            };
            fits && segments_match(&pattern[1..], &path[1..], client)
        }
        _ => false,
    }
}

/// Règle scellée qui couvre cette requête du compte, s’il y en a une. Le chemin est jugé décodé, sans ses
/// paramètres, comme le serveur le lira.
pub fn matching_rule<'a>(client: &'a Client, method: &Method, path: &str) -> Option<&'a SealedRule> {
    let path = path.split('?').next().unwrap_or_default();
    let actual: Vec<&str> = path.trim_start_matches('/').split('/').filter(|segment| !segment.is_empty()).collect();
    client.sealed.iter().find(|rule| {
        let expected: Vec<&str> =
            rule.path.trim_start_matches('/').split('/').filter(|segment| !segment.is_empty()).collect();
        (rule.methods.is_empty() || rule.methods.iter().any(|known| known == method.as_str()))
            && segments_match(&expected, &actual, client)
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Scellement d’une réponse
// ---------------------------------------------------------------------------------------------------------------

fn seal_at(value: &mut Value, path: &[&str], module: &str, client: &Client, values: &mut Vec<String>) {
    let Some((first, rest)) = path.split_first() else {
        if !value.is_null() && !(value.as_str().is_some_and(is_reference)) {
            values.push(value_text(value));
            let sealed = std::mem::take(value);
            *value = Value::String(issue(sealed, module, client));
        }
        return;
    };
    match value {
        Value::Object(fields) if *first == "*" => {
            for child in fields.values_mut() {
                seal_at(child, rest, module, client, values);
            }
        }
        Value::Array(items) if *first == "*" => {
            for child in items {
                seal_at(child, rest, module, client, values);
            }
        }
        Value::Object(fields) => {
            if let Some(child) = fields.get_mut(*first) {
                seal_at(child, rest, module, client, values);
            }
        }
        Value::Array(items) => {
            if let Some(child) = first.parse::<usize>().ok().and_then(|index| items.get_mut(index)) {
                seal_at(child, rest, module, client, values);
            }
        }
        _ => {}
    }
}

/// Remplace dans le corps d’une réponse les champs de la règle par des références ; rend aussi les valeurs scellées,
/// à masquer partout ailleurs dans la réponse (en-têtes, champs non déclarés qui les répéteraient). Un corps qui
/// n’est pas du JSON, ou une règle sans champ, est scellé en entier.
pub fn seal_body(body: Value, rule: &SealedRule, module: &str, client: &Client) -> (Value, Vec<String>) {
    let mut values = Vec::new();
    let structured = matches!(body, Value::Object(_) | Value::Array(_));
    if rule.fields.is_empty() || !structured {
        if body.is_null() || body.as_str().is_some_and(str::is_empty) {
            return (body, values);
        }
        values.push(value_text(&body));
        return (Value::String(issue(body, module, client)), values);
    }
    let mut body = body;
    for field in &rule.fields {
        let path: Vec<&str> = field.split('.').collect();
        seal_at(&mut body, &path, module, client, &mut values);
    }
    (body, values)
}

// ---------------------------------------------------------------------------------------------------------------
// Références dans une requête sortante
// ---------------------------------------------------------------------------------------------------------------

/// Une référence n’a rien à faire dans le chemin, les paramètres ou les en-têtes : elle n’y est jamais remplacée.
pub fn refuse_outside_body(path: &str, query: Option<&Map<String, Value>>, headers: Option<&Map<String, Value>>) -> AppResult<()> {
    let found = contains_reference(path)
        || query.is_some_and(|query| query.values().any(|value| contains_reference(&value_text(value))))
        || headers.is_some_and(|headers| headers.values().any(|value| contains_reference(&value_text(value))));
    if found {
        return Err(AppError::new(
            "Une référence de secret ne se place ni dans le chemin, ni dans les paramètres, ni dans les en-têtes d’une requête : Alfred ne la remplace que dans le corps d’une requête `sealed: true` vers un chemin scellé du même service.",
        ));
    }
    Ok(())
}

fn refused_in_body() -> AppError {
    AppError::new(
        "Le corps contient une référence de secret : Alfred ne la remplace que pour une requête `sealed: true` vers un chemin que le service déclare scellé (`sealed` dans son client). Ailleurs, elle n’est jamais remplacée.",
    )
}

fn substitute_value(value: &mut Value, module: &str, client: &str, used: &mut Vec<String>) -> AppResult<()> {
    match value {
        Value::String(text) if is_reference(text) => {
            let sealed = lookup(text, module, Some(client))?;
            used.push(value_text(&sealed.value));
            *value = sealed.value;
        }
        Value::String(text) if contains_reference(text) => {
            *text = substitute_text(text, module, client, used)?;
        }
        Value::Array(items) => {
            for item in items {
                substitute_value(item, module, client, used)?;
            }
        }
        Value::Object(fields) => {
            for child in fields.values_mut() {
                substitute_value(child, module, client, used)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn substitute_text(text: &str, module: &str, client: &str, used: &mut Vec<String>) -> AppResult<String> {
    let mut result = text.to_string();
    for reference in find_references(text) {
        let sealed = lookup(&reference, module, Some(client))?;
        let value = value_text(&sealed.value);
        result = result.replace(&reference, &value);
        used.push(value);
    }
    Ok(result)
}

/// Corps JSON ou texte d’une requête : sans références, rien à faire (`None`). Avec, elles sont refusées sauf accord
/// explicite (`sealed: true`) vers un chemin scellé, et remplacées par leurs valeurs de ce module et de ce service ;
/// rend aussi les valeurs placées, à masquer dans la réponse.
pub fn substitute_body(
    bytes: &[u8],
    json_body: bool,
    sealed: &SealedUse,
    rule: Option<&SealedRule>,
    client: &Client,
) -> AppResult<Option<(Vec<u8>, Vec<String>)>> {
    let text = String::from_utf8_lossy(bytes);
    if !contains_reference(&text) {
        return Ok(None);
    }
    if !sealed.substitute || rule.is_none() {
        return Err(refused_in_body());
    }
    let mut used = Vec::new();
    let out = if json_body {
        let mut value: Value = serde_json::from_slice(bytes).map_err(|_| refused_in_body())?;
        substitute_value(&mut value, &sealed.module, &client.id, &mut used)?;
        serde_json::to_vec(&value)?
    } else {
        substitute_text(&text, &sealed.module, &client.id, &mut used)?.into_bytes()
    };
    Ok(Some((out, used)))
}

/// Paires d’un formulaire : même règle que pour un corps.
/// Paires remplacées et valeurs placées.
type SubstitutedPairs = (Vec<(String, String)>, Vec<String>);

pub fn substitute_pairs(
    pairs: &[(String, String)],
    sealed: &SealedUse,
    rule: Option<&SealedRule>,
    client: &Client,
) -> AppResult<Option<SubstitutedPairs>> {
    if !pairs.iter().any(|(name, value)| contains_reference(name) || contains_reference(value)) {
        return Ok(None);
    }
    if !sealed.substitute || rule.is_none() || pairs.iter().any(|(name, _)| contains_reference(name)) {
        return Err(refused_in_body());
    }
    let mut used = Vec::new();
    let mut out = Vec::new();
    for (name, value) in pairs {
        out.push((name.clone(), substitute_text(value, &sealed.module, &client.id, &mut used)?));
    }
    Ok(Some((out, used)))
}

/// Toute autre forme de corps (fichier, multipart) n’accepte pas de référence.
pub fn refuse_in_text(text: &str) -> AppResult<()> {
    if contains_reference(text) {
        return Err(refused_in_body());
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes de la coquille
// ---------------------------------------------------------------------------------------------------------------

/// Même échappement que le `.env` de OneApp (`save_environment_file`), entre guillemets doubles.
pub fn dotenv_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\r', "\\r").replace('\n', "\\n").replace('"', "\\\"").replace('$', "\\$")
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Seules une page et un panneau, par la coquille, résolvent une référence pour l’utilisateur : jamais une fonction.
fn shown_subject(args: &Value) -> AppResult<Subject> {
    let subject: Subject = arg(args, "subject")?;
    if !matches!(subject.kind.as_str(), "page" | "panel") {
        return Err(AppError::new(
            "Une valeur scellée ne s’affiche et ne s’enregistre que depuis une page ou un panneau, sur un geste de l’utilisateur : jamais depuis une fonction.",
        ));
    }
    Ok(subject)
}

fn journal(state: &AppState, subject: &Subject, summary: &str) {
    let Some(space) = state.try_space() else { return };
    let root = space.root.to_string_lossy();
    let detail = json!({ "requester": subject.reference, "requesterKind": subject.kind });
    let entry = JournalEntry {
        space: &root,
        kind: "secret",
        subject: &subject.reference,
        status: "ok",
        duration_ms: None,
        summary,
        detail: Some(&detail),
    };
    let recorded =
        state.app_db.lock().map_err(|_| ()).and_then(|db| app_db::record_journal(&db, &entry).map_err(|_| ()));
    if recorded.is_err() {
        log::warn!("journal indisponible pour un secret affiché par {}", subject.reference);
    }
}

/// Libellé donné par la page à la valeur, borné (il va au journal).
fn label_of(args: &Value) -> AppResult<String> {
    Ok(opt_arg::<String>(args, "label")?
        .map(|label| label.trim().chars().take(80).collect::<String>())
        .filter(|label| !label.is_empty() && !contains_reference(label))
        .unwrap_or_else(|| "sans nom".to_string()))
}

/// `secrets.reveal` : la boîte de la coquille demande la valeur, après le clic de l’utilisateur sur « Afficher ».
fn reveal(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject = shown_subject(args)?;
    let reference: String = arg(args, "reference")?;
    let sealed = shown_value(state, reference.trim(), &subject.module)?;
    journal(state, &subject, &format!("Valeur « {} » affichée (compte {}/{})", label_of(args)?, sealed.client, sealed.instance));
    Ok(json!({ "value": value_text(&sealed.value) }))
}

/// `secrets.describe` : ce que la boîte montre avant tout clic, sans la valeur.
fn describe(state: &AppState, args: &Value) -> AppResult<Value> {
    let subject = shown_subject(args)?;
    let reference: String = arg(args, "reference")?;
    let sealed = shown_value(state, reference.trim(), &subject.module)?;
    let remaining = TTL.saturating_sub(sealed.created.elapsed()).as_secs();
    Ok(json!({ "client": sealed.client, "instance": sealed.instance, "expiresIn": remaining }))
}

/// `secrets.writeEnvFile` : écrit un `.env` au chemin choisi par l’utilisateur dans la boîte d’enregistrement de la
/// coquille. Chaque ligne vient d’une référence (`ref`) ou d’une valeur ordinaire (`value`).
fn write_env_file(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let subject = shown_subject(args)?;
    let path = std::path::PathBuf::from(arg::<String>(args, "path")?);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(AppError::new("Choisir où enregistrer le fichier .env."));
    }
    let entries: Vec<Value> = arg(args, "entries")?;
    if entries.is_empty() {
        return Err(AppError::new("Le fichier .env n’a aucune variable."));
    }
    let mut contents = String::new();
    let mut names = Vec::new();
    for entry in &entries {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or_default().trim();
        if !valid_env_name(name) {
            return Err(AppError::new(format!(
                "Nom de variable invalide : « {name} » (lettres, chiffres et _, sans commencer par un chiffre)."
            )));
        }
        let value = match (entry.get("ref").and_then(Value::as_str), entry.get("value")) {
            (Some(reference), _) => value_text(&shown_value(state, reference.trim(), &subject.module)?.value),
            (None, Some(Value::Null) | None) => String::new(),
            (None, Some(value)) => {
                let text = value_text(value);
                // Une référence glissée comme valeur ordinaire n’est pas remplacée : elle va dans `ref`.
                refuse_in_text(&text)?;
                text
            }
        };
        contents.push_str(&format!("{name}=\"{}\"\n", dotenv_escape(&value)));
        names.push(name.to_string());
    }
    write_private(&path, contents.as_bytes())?;
    let file = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    journal(state, &subject, &format!("Fichier {file} enregistré ({})", names.join(", ")));
    Ok(json!({ "written": names.len(), "name": file }))
}

/// Fichier lisible du seul utilisateur, écrit d’un bloc.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
    use std::io::Write;
    let fail = |error: std::io::Error| AppError::new(format!("Le fichier n’a pas pu être enregistré ({}).", error.kind()));
    let temporary = path.with_extension("alfred-tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temporary).map_err(fail)?;
    file.write_all(bytes).map_err(fail)?;
    file.sync_all().map_err(fail)?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        fail(error)
    })
}

/// Commandes réservées à la coquille (jamais `frame.*`, jamais au pont des scripts ni aux outils de l’agent) :
/// une page les obtient seulement par la boîte que la coquille affiche.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    let result = match command {
        "secrets.reveal" => reveal(state, args),
        "secrets.describe" => describe(state, args),
        "secrets.writeEnvFile" => {
            let (state, args) = (state.clone(), args.clone());
            crate::vault::blocking(move || write_env_file(&state, &args)).await
        }
        _ => return None,
    };
    Some(result)
}

/// Fait vieillir une référence au-delà de sa durée de vie (les tests partagent la mémoire du processus : seule
/// celle nommée est touchée).
#[cfg(test)]
pub fn expire(reference: &str) {
    let mut all = references();
    if let Some(sealed) = reference.strip_prefix(PREFIX).and_then(|nonce| all.get_mut(nonce)) {
        sealed.created = sealed.created.checked_sub(TTL).unwrap_or(sealed.created);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(params: &[(&str, &str)], rules: Vec<SealedRule>) -> Client {
        Client {
            id: "coffre".to_string(),
            instance: "prod".to_string(),
            params: params.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
            sealed: rules,
            ..Client::default()
        }
    }

    fn rule(path: &str, fields: &[&str]) -> SealedRule {
        SealedRule { path: path.to_string(), methods: Vec::new(), fields: fields.iter().map(|f| f.to_string()).collect() }
    }

    #[test]
    fn paths_match_wildcards_and_account_parameters() {
        let with_mount = client(&[("mount", "kv")], vec![rule("/v1/{mount}/data/**", &["data.data.*"])]);
        assert!(matching_rule(&with_mount, &Method::GET, "/v1/kv/data/app/prod").is_some());
        assert!(matching_rule(&with_mount, &Method::GET, "/v1/kv/data/app?version=2").is_some());
        assert!(matching_rule(&with_mount, &Method::GET, "/v1/%6bv/data/app").is_some(), "jugé décodé");
        assert!(matching_rule(&with_mount, &Method::GET, "/v1/autre/data/app").is_none(), "un autre montage");
        assert!(matching_rule(&with_mount, &Method::GET, "/v1/kv/metadata/app").is_none());
        let any_mount = client(&[], vec![rule("/v1/{mount}/data/*", &[])]);
        assert!(matching_rule(&any_mount, &Method::GET, "/v1/n-importe/data/app").is_some());
        assert!(matching_rule(&any_mount, &Method::GET, "/v1/n-importe/data/app/plus").is_none());
        let only_get = client(&[], vec![SealedRule { methods: vec!["GET".into()], ..rule("/secret", &[]) }]);
        assert!(matching_rule(&only_get, &Method::POST, "/secret").is_none());
        assert!(validate_rules(&[rule("relatif", &[])]).is_err());
        assert!(validate_rules(&[rule("/x", &["a..b"])]).is_err());
    }

    #[test]
    fn a_response_is_sealed_field_by_field_and_references_stay_in_their_module() {
        let account = client(&[], vec![]);
        let body = json!({ "data": { "data": { "DB_PASSWORD": "v4l3ur-s3cr3t3", "PORT": 5432 }, "metadata": { "version": 3 } } });
        let (sealed, values) = seal_body(body, &rule("/x", &["data.data.*"]), "coffre", &account);
        assert_eq!(values.len(), 2);
        let reference = sealed["data"]["data"]["DB_PASSWORD"].as_str().unwrap().to_string();
        assert!(is_reference(&reference));
        assert_eq!(sealed["data"]["metadata"]["version"], json!(3), "un champ non déclaré reste lisible");
        assert!(!sealed.to_string().contains("v4l3ur"));
        assert_eq!(value_text(&lookup(&reference, "coffre", None).unwrap().value), "v4l3ur-s3cr3t3");
        assert!(lookup(&reference, "autre", None).is_err(), "un autre module ne la résout pas");
        assert!(lookup(&reference, "coffre", Some("autre-service")).is_err());
        let port = sealed["data"]["data"]["PORT"].as_str().unwrap();
        assert_eq!(lookup(port, "coffre", None).unwrap().value, json!(5432), "le type est gardé");

        // Un texte, ou une règle sans champ : toute la réponse.
        let (whole, _) = seal_body(json!("BEGIN:VCALENDAR"), &rule("/x", &["a"]), "coffre", &account);
        assert!(is_reference(whole.as_str().unwrap()));
        assert_eq!(find_references(&format!("a {reference} b {port}")).len(), 2);
    }

    #[test]
    fn a_reference_is_substituted_only_with_consent_on_a_sealed_path() {
        let account = client(&[], vec![rule("/v1/kv/data/**", &["data.data.*"])]);
        let (sealed, _) = seal_body(json!({ "k": "c0p13-s3cr3t3" }), &rule("/x", &["k"]), "coffre", &account);
        let reference = sealed["k"].as_str().unwrap().to_string();
        let body = serde_json::to_vec(&json!({ "data": { "K": reference, "note": format!("x{reference}") } })).unwrap();
        let path_rule = matching_rule(&account, &Method::POST, "/v1/kv/data/app");
        let consent = SealedUse { module: "coffre".into(), substitute: true };
        let plain = SealedUse { module: "coffre".into(), substitute: false };
        assert!(substitute_body(&body, true, &plain, path_rule, &account).is_err(), "sans accord");
        assert!(substitute_body(&body, true, &consent, None, &account).is_err(), "hors d’un chemin scellé");
        let other_module = SealedUse { module: "autre".into(), substitute: true };
        assert!(substitute_body(&body, true, &other_module, path_rule, &account).is_err());
        let (out, used) = substitute_body(&body, true, &consent, path_rule, &account).unwrap().unwrap();
        let out: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(out["data"]["K"], json!("c0p13-s3cr3t3"));
        assert_eq!(out["data"]["note"], json!("xc0p13-s3cr3t3"));
        assert_eq!(used.len(), 2);
        assert!(substitute_body(b"{\"a\":1}", true, &plain, None, &account).unwrap().is_none());
        assert!(refuse_outside_body(&format!("/x/{reference}"), None, None).is_err());
        let query: Map<String, Value> = [("q".to_string(), json!(reference))].into_iter().collect();
        assert!(refuse_outside_body("/x", Some(&query), None).is_err());

        expire(&reference);
        assert!(substitute_body(&body, true, &consent, path_rule, &account).is_err(), "expirée");
    }

    #[test]
    fn a_page_shows_a_reference_sealed_by_a_module_it_depends_on() {
        let account = client(&[], vec![]);
        let (sealed, _) = seal_body(json!({ "k": "d3p3nd4nc3" }), &rule("/x", &["k"]), "openbao", &account);
        let reference = sealed["k"].as_str().unwrap().to_string();
        let shown = lookup_shown(&reference, "atom", |owner| owner == "openbao").unwrap();
        assert_eq!(value_text(&shown.value), "d3p3nd4nc3", "une page d’atom, qui dépend d’openbao");
        assert!(lookup_shown(&reference, "openbao", |_| false).is_ok(), "le module qui l’a lue");
        assert!(lookup_shown(&reference, "voisin", |owner| owner == "autre").is_err(), "un module sans cette dépendance");
        assert!(lookup(&reference, "atom", None).is_err(), "une requête d’atom ne la recopie toujours pas");
        expire(&reference);
        assert!(lookup_shown(&reference, "atom", |owner| owner == "openbao").is_err(), "expirée");
    }

    #[test]
    fn dotenv_values_are_escaped_like_oneapp() {
        assert_eq!(dotenv_escape("a\"b$c\\d\r\ne"), "a\\\"b\\$c\\\\d\\r\\ne");
        assert!(valid_env_name("DB_PASSWORD") && !valid_env_name("1A") && !valid_env_name("A-B"));
    }
}
