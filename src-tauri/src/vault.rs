//! Coffre : un seul pour l’installation d’Alfred. Les valeurs secrètes vivent dans le trousseau du système ;
//! l’inventaire (libellé, type, champs non secrets) vit dans la base d’Alfred, hors de l’espace, pour que l’agent ne
//! puisse ni le lire ni le réécrire en éditant un fichier. Aucune commande ne renvoie jamais une valeur secrète :
//! l’interface ne reçoit que la présence d’un secret.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::app_db;
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::space::{slug, valid_id};
use crate::state::AppState;

/// Nom de service sous lequel Alfred range ses secrets dans le trousseau.
pub const SERVICE: &str = "app.alfred.desktop";

pub const KIND_TOKEN: &str = "token";
pub const KIND_BASIC: &str = "basic";
pub const KIND_OAUTH2: &str = "oauth2";
pub const KIND_CLIENT_CREDENTIALS: &str = "clientCredentials";

/// Champs gérés par Alfred lui-même (jetons obtenus) : jamais saisis ni lus par l’interface.
pub const TOKEN_FIELDS: [&str; 3] = ["accessToken", "refreshToken", "expiresAt"];

// ---------------------------------------------------------------------------------------------------------------
// Trousseau
// ---------------------------------------------------------------------------------------------------------------

/// Stockage des valeurs secrètes. Abstrait pour que les tests n’écrivent jamais dans le trousseau du poste.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> AppResult<Option<String>>;
    fn set(&self, account: &str, value: &str) -> AppResult<()>;
    fn delete(&self, account: &str) -> AppResult<()>;
}

/// Trousseau du système (Trousseau d’accès de macOS, Gestionnaire d’identification de Windows).
struct KeyringStore;

/// Les messages de `keyring` sont repris sans leurs données attachées : `BadEncoding` porte les octets du secret.
fn keyring_error(error: keyring::Error) -> AppError {
    let reason = match error {
        keyring::Error::NoStorageAccess(cause) => format!("accès refusé ou trousseau verrouillé ({cause})"),
        keyring::Error::PlatformFailure(cause) => format!("erreur du système ({cause})"),
        keyring::Error::BadEncoding(_) => "la valeur enregistrée est illisible".to_string(),
        keyring::Error::TooLong(_, limit) => format!("valeur trop longue (limite du système : {limit} caractères)"),
        keyring::Error::Ambiguous(_) => "plusieurs entrées du trousseau portent ce nom".to_string(),
        _ => "opération refusée".to_string(),
    };
    AppError::new(format!("Le trousseau du système n’a pas pu être utilisé : {reason}."))
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keyring_error(error)),
        }
    }

    fn set(&self, account: &str, value: &str) -> AppResult<()> {
        keyring::Entry::new(SERVICE, account).and_then(|entry| entry.set_password(value)).map_err(keyring_error)
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keyring_error(error)),
        }
    }
}

/// Trousseau en mémoire, pour les tests.
#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, String>>);

impl MemoryStore {
    fn entries(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, String>>> {
        self.0.lock().map_err(|_| AppError::new("Le coffre est indisponible."))
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        Ok(self.entries()?.get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> AppResult<()> {
        self.entries()?.insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        self.entries()?.remove(account);
        Ok(())
    }
}

/// Windows refuse une valeur de plus de 2 560 octets (1 280 unités UTF-16), et des jetons OAuth la dépassent
/// couramment. Une valeur trop longue est donc répartie sur plusieurs entrées : l’entrée principale n’en garde
/// que le nombre.
struct Chunked<Store> {
    inner: Store,
    /// Longueur maximale d’une entrée, en unités UTF-16.
    limit: usize,
}

const CHUNK_MARK: &str = "alfred-chunks:";
const WINDOWS_LIMIT: usize = 1_200;

fn part(account: &str, index: usize) -> String {
    // « # » n’est pas permis dans un identifiant d’entrée : aucune collision possible avec une autre entrée.
    format!("{account}#{index}")
}

fn split_utf16(value: &str, limit: usize) -> Vec<&str> {
    let mut chunks = Vec::new();
    let (mut start, mut units) = (0, 0);
    for (offset, character) in value.char_indices() {
        if units + character.len_utf16() > limit {
            chunks.push(&value[start..offset]);
            (start, units) = (offset, 0);
        }
        units += character.len_utf16();
    }
    chunks.push(&value[start..]);
    chunks
}

impl<Store: SecretStore> Chunked<Store> {
    fn part_count(&self, account: &str) -> AppResult<usize> {
        Ok(self
            .inner
            .get(account)?
            .and_then(|head| head.strip_prefix(CHUNK_MARK).and_then(|count| count.parse().ok()))
            .unwrap_or(0))
    }
}

impl<Store: SecretStore> SecretStore for Chunked<Store> {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        let Some(head) = self.inner.get(account)? else { return Ok(None) };
        let Some(count) = head.strip_prefix(CHUNK_MARK).and_then(|count| count.parse::<usize>().ok()) else {
            return Ok(Some(head));
        };
        let mut value = String::new();
        for index in 1..=count {
            match self.inner.get(&part(account, index))? {
                Some(chunk) => value.push_str(&chunk),
                None => {
                    return Err(AppError::new(format!(
                        "Le secret « {account} » est incomplet dans le trousseau du système. Le saisir à nouveau."
                    )))
                }
            }
        }
        Ok(Some(value))
    }

    fn set(&self, account: &str, value: &str) -> AppResult<()> {
        let previous = self.part_count(account)?;
        let chunks = split_utf16(value, self.limit);
        let count = if chunks.len() > 1 { chunks.len() } else { 0 };
        if count == 0 {
            self.inner.set(account, value)?;
        } else {
            for (index, chunk) in chunks.iter().enumerate() {
                self.inner.set(&part(account, index + 1), chunk)?;
            }
            self.inner.set(account, &format!("{CHUNK_MARK}{count}"))?;
        }
        // Une valeur devenue plus courte ne laisse pas d’anciens morceaux derrière elle.
        for index in count + 1..=previous {
            self.inner.delete(&part(account, index))?;
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        for index in 1..=self.part_count(account)? {
            self.inner.delete(&part(account, index))?;
        }
        self.inner.delete(account)
    }
}

/// Coffre de développement : un fichier JSON lisible du seul utilisateur, dans le dossier de données d’Alfred.
///
/// Sous macOS, le trousseau range chaque entrée dans une partition liée à l’équipe du certificat de signature. Un
/// certificat local (« Alfred Dev ») n’a pas d’équipe : la partition retombe sur l’empreinte du binaire, qui change à
/// chaque build, et macOS redemande l’accès à chaque `tauri dev`. Les builds de développement gardent donc leurs
/// secrets hors du trousseau ; `ALFRED_DEV_KEYCHAIN=1` rétablit le trousseau pour l’éprouver.
struct FileStore {
    path: std::path::PathBuf,
    lock: Mutex<()>,
}

impl FileStore {
    fn read_all(&self) -> AppResult<Map<String, Value>> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|_| AppError::new("Le coffre de développement est illisible : supprimer dev-secrets.json.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(error) => Err(AppError::new(format!("Le coffre de développement est inaccessible ({error})."))),
        }
    }

    fn write_all(&self, entries: &Map<String, Value>) -> AppResult<()> {
        use std::io::Write;
        let fail = |error: std::io::Error| AppError::new(format!("Le coffre de développement n’a pas pu être écrit ({error})."));
        let temporary = self.path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary).map_err(fail)?;
        file.write_all(Value::Object(entries.clone()).to_string().as_bytes()).map_err(fail)?;
        file.sync_all().map_err(fail)?;
        std::fs::rename(&temporary, &self.path).map_err(fail)
    }

    fn guard(&self) -> AppResult<std::sync::MutexGuard<'_, ()>> {
        self.lock.lock().map_err(|_| AppError::new("Le coffre est indisponible."))
    }
}

impl SecretStore for FileStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        let _guard = self.guard()?;
        Ok(self.read_all()?.get(account).and_then(Value::as_str).map(str::to_string))
    }

    fn set(&self, account: &str, value: &str) -> AppResult<()> {
        let _guard = self.guard()?;
        let mut entries = self.read_all()?;
        entries.insert(account.to_string(), Value::String(value.to_string()));
        self.write_all(&entries)
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        let _guard = self.guard()?;
        let mut entries = self.read_all()?;
        if entries.remove(account).is_some() {
            self.write_all(&entries)?;
        }
        Ok(())
    }
}

static DEV_FILE: OnceLock<std::path::PathBuf> = OnceLock::new();

/// À appeler au démarrage, avant tout accès au coffre : un build de développement macOS range alors ses secrets
/// dans `dev-secrets.json` plutôt que dans le trousseau. Sans effet dans un build publié.
pub fn init(data_dir: &std::path::Path) {
    let keychain_forced = std::env::var("ALFRED_DEV_KEYCHAIN").is_ok_and(|value| value == "1");
    if cfg!(all(debug_assertions, target_os = "macos")) && !keychain_forced {
        let _ = DEV_FILE.set(data_dir.join("dev-secrets.json"));
    }
}

fn store() -> &'static dyn SecretStore {
    static STORE: OnceLock<Box<dyn SecretStore>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            if let (false, Some(path)) = (cfg!(test), DEV_FILE.get()) {
                Box::new(FileStore { path: path.clone(), lock: Mutex::new(()) })
            } else if cfg!(test) {
                // Les tests ne touchent jamais le trousseau du poste ; ils gardent la limite de Windows pour
                // exercer le découpage.
                Box::new(Chunked { inner: MemoryStore::default(), limit: WINDOWS_LIMIT })
            } else {
                Box::new(Chunked { inner: KeyringStore, limit: if cfg!(windows) { WINDOWS_LIMIT } else { usize::MAX } })
            }
        })
        .as_ref()
}

/// Champs secrets d’une entrée (objet JSON), ou `None` si rien n’est enregistré. Réservé au code Rust : la valeur
/// ne doit jamais partir vers l’interface, un journal ou un message d’erreur.
pub fn read_secret(id: &str) -> AppResult<Option<Value>> {
    match store().get(id)? {
        None => Ok(None),
        Some(text) => serde_json::from_str(&text).map(Some).map_err(|_| {
            AppError::new(format!(
                "Le secret « {id} » est illisible dans le trousseau du système. Le saisir à nouveau."
            ))
        }),
    }
}

pub fn write_secret(id: &str, value: &Value) -> AppResult<()> {
    store().set(id, &value.to_string())
}

pub fn delete_secret(id: &str) -> AppResult<()> {
    store().delete(id)
}

/// Le trousseau peut bloquer (le système demande parfois l’accord de l’utilisateur) : ses appels sortent des fils
/// asynchrones pour ne pas figer le reste d’Alfred pendant ce temps.
pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(work).await.unwrap_or_else(|_| Err(AppError::new("Le coffre n’a pas répondu.")))
}

pub async fn read_secret_async(id: &str) -> AppResult<Option<Value>> {
    let id = id.to_string();
    blocking(move || read_secret(&id)).await
}

pub async fn write_secret_async(id: &str, value: Value) -> AppResult<()> {
    let id = id.to_string();
    blocking(move || write_secret(&id, &value)).await
}

/// Champ texte non vide d’un secret.
pub fn field<'a>(secret: Option<&'a Value>, name: &str) -> Option<&'a str> {
    secret?.get(name)?.as_str().filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------------------------------------------
// Inventaire
// ---------------------------------------------------------------------------------------------------------------

/// Entrée du coffre telle que l’inventaire la connaît : aucun secret.
#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub meta: Value,
    pub updated_at: String,
}

impl Entry {
    pub fn meta_text(&self, name: &str) -> Option<&str> {
        self.meta.get(name)?.as_str().filter(|value| !value.is_empty())
    }
}

/// Champs attendus pour un type d’entrée : ceux de `meta` (non secrets, obligatoires) et les champs secrets saisis
/// par l’utilisateur, avec leur caractère obligatoire.
struct KindFields {
    meta: &'static [&'static str],
    secrets: &'static [(&'static str, bool)],
}

fn kind_fields(kind: &str) -> AppResult<KindFields> {
    Ok(match kind {
        KIND_TOKEN => KindFields { meta: &[], secrets: &[("value", true)] },
        KIND_BASIC => KindFields { meta: &["username"], secrets: &[("password", true)] },
        KIND_OAUTH2 => KindFields { meta: &["clientId"], secrets: &[("clientSecret", false)] },
        KIND_CLIENT_CREDENTIALS => KindFields { meta: &["clientId"], secrets: &[("clientSecret", true)] },
        _ => return Err(AppError::new(format!("Type d’entrée du coffre inconnu : « {kind} »."))),
    })
}

fn field_label(name: &str) -> &str {
    match name {
        "value" => "la valeur",
        "username" => "l’identifiant",
        "password" => "le mot de passe",
        "clientId" => "l’identifiant client",
        "clientSecret" => "le secret client",
        other => other,
    }
}

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    let db = state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))?;
    // La table est créée au premier usage : le coffre n’impose aucune migration au reste de la base.
    db.execute(
        "CREATE TABLE IF NOT EXISTS vault_entries (id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, meta TEXT NOT NULL, updated_at TEXT NOT NULL)",
        [],
    )?;
    Ok(db)
}

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let meta: String = row.get(3)?;
    Ok(Entry {
        id: row.get(0)?,
        label: row.get(1)?,
        kind: row.get(2)?,
        meta: serde_json::from_str(&meta).unwrap_or_else(|_| json!({})),
        updated_at: row.get(4)?,
    })
}

pub fn entries(state: &AppState) -> AppResult<Vec<Entry>> {
    let db = lock_db(state)?;
    let mut statement =
        db.prepare("SELECT id, label, kind, meta, updated_at FROM vault_entries ORDER BY label COLLATE NOCASE, id")?;
    let rows = statement.query_map([], entry_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn entry(state: &AppState, id: &str) -> AppResult<Option<Entry>> {
    let db = lock_db(state)?;
    Ok(db
        .query_row(
            "SELECT id, label, kind, meta, updated_at FROM vault_entries WHERE id = ?1",
            params![id],
            entry_from_row,
        )
        .optional()?)
}

/// État d’une entrée sans rien révéler : le secret saisi est-il présent, et (OAuth 2) des jetons ont-ils été obtenus.
pub struct SecretState {
    pub has_secret: bool,
    pub connected: bool,
}

pub fn secret_state(entry: &Entry) -> AppResult<SecretState> {
    let secret = read_secret(&entry.id)?;
    let secret = secret.as_ref();
    let fields = kind_fields(&entry.kind)?;
    Ok(SecretState {
        has_secret: fields.secrets.iter().all(|(name, _)| field(secret, name).is_some()),
        connected: field(secret, "accessToken").is_some() || field(secret, "refreshToken").is_some(),
    })
}

/// Ce que l’interface voit d’une entrée.
fn describe(entry: &Entry) -> Value {
    let mut item = json!({
        "id": entry.id,
        "label": entry.label,
        "kind": entry.kind,
        "meta": entry.meta,
        "updatedAt": entry.updated_at,
    });
    match secret_state(entry) {
        Ok(state) => {
            item["hasSecret"] = json!(state.has_secret);
            if entry.kind == KIND_OAUTH2 {
                item["connected"] = json!(state.connected);
            }
        }
        // Un trousseau verrouillé ne doit pas vider la liste : l’entrée reste visible, avec la raison.
        Err(error) => {
            item["hasSecret"] = json!(false);
            item["problem"] = json!(error.message);
        }
    }
    item
}

// ---------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------

/// Traite les commandes de ce module ; `None` quand la commande ne le concerne pas.
pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    // Références de secrets (valeurs scellées) : commandes de la coquille seulement.
    if let Some(result) = crate::secret_refs::handle(state, command, args).await {
        return Some(result);
    }
    if !matches!(command, "vault.list" | "vault.save" | "vault.delete") {
        return None;
    }
    let (state, command, args) = (state.clone(), command.to_string(), args.clone());
    Some(
        blocking(move || match command.as_str() {
            "vault.list" => Ok(Value::Array(entries(&state)?.iter().map(describe).collect())),
            "vault.save" => save(&state, &args),
            _ => delete(&state, &args),
        })
        .await,
    )
}

fn text_fields(args: &Value, name: &str) -> AppResult<Map<String, Value>> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(fields)) => Ok(fields.clone()),
        Some(_) => Err(AppError::new(format!("Argument « {name} » invalide : un objet est attendu."))),
    }
}

fn save(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let label = arg::<String>(args, "label")?.trim().to_string();
    if label.is_empty() {
        return Err(AppError::new("L’entrée du coffre doit avoir un libellé."));
    }
    let kind: String = arg(args, "kind")?;
    let fields = kind_fields(&kind)?;
    let requested = opt_arg::<String>(args, "id")?.map(|id| id.trim().to_string()).filter(|id| !id.is_empty());
    let existing = match &requested {
        Some(id) => {
            if !valid_id(id) {
                return Err(AppError::new(format!(
                    "Identifiant d’entrée invalide : « {id} ». Utiliser des minuscules, des chiffres et des tirets."
                )));
            }
            entry(state, id)?
        }
        None => None,
    };
    if let Some(existing) = &existing {
        // Les clients choisissent une entrée d’après son type : le changer casserait ceux qui l’utilisent.
        if existing.kind != kind {
            return Err(AppError::new(
                "Le type d’une entrée du coffre ne se change pas. Créer une nouvelle entrée du type voulu.",
            ));
        }
    }
    let id = match requested {
        Some(id) => id,
        None => {
            let base = slug(&label);
            let taken: Vec<String> = entries(state)?.into_iter().map(|entry| entry.id).collect();
            std::iter::once(base.clone())
                .chain((2..).map(|index| format!("{base}-{index}")))
                .find(|candidate| !taken.contains(candidate))
                .unwrap_or(base)
        }
    };

    // `meta` ne garde que les champs non secrets connus du type : rien de sensible ne peut s’y glisser par erreur.
    let given_meta = text_fields(args, "meta")?;
    let mut meta = Map::new();
    for name in fields.meta {
        let value = given_meta.get(*name).and_then(Value::as_str).map(str::trim).unwrap_or_default();
        if value.is_empty() {
            return Err(AppError::new(format!("Saisir {}.", field_label(name))));
        }
        meta.insert((*name).to_string(), Value::String(value.to_string()));
    }

    let given_secrets = text_fields(args, "secrets")?;
    if let Some(unknown) = given_secrets.keys().find(|name| !fields.secrets.iter().any(|(known, _)| known == name)) {
        return Err(AppError::new(format!("Champ secret inconnu pour ce type d’entrée : « {unknown} ».")));
    }
    let previous = read_secret(&id)?;
    let mut secret = previous.clone().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let mut secret_changed = false;
    for (name, required) in fields.secrets {
        // Un champ absent ou vide conserve la valeur enregistrée : l’interface ne la connaît pas et ne peut donc
        // pas la renvoyer.
        match given_secrets.get(*name).and_then(Value::as_str).filter(|value| !value.is_empty()) {
            Some(value) => {
                secret_changed |= field(Some(&secret), name) != Some(value);
                secret[*name] = Value::String(value.to_string());
            }
            None if *required && field(Some(&secret), name).is_none() => {
                return Err(AppError::new(format!("Saisir {}.", field_label(name))));
            }
            None => {}
        }
    }
    // Des jetons obtenus pour une autre application cliente ne valent plus rien : on repart sans eux.
    let client_changed =
        existing.as_ref().is_some_and(|existing| existing.meta.get("clientId") != meta.get("clientId"));
    if client_changed || (secret_changed && kind == KIND_CLIENT_CREDENTIALS) {
        if let Some(object) = secret.as_object_mut() {
            for name in TOKEN_FIELDS {
                object.remove(name);
            }
        }
    }
    // Un jeton de session (méthode `session`) a été obtenu avec l’ancien identifiant ou l’ancien mot de passe : il
    // ne vaut plus pour ce compte.
    let user_changed =
        existing.as_ref().is_some_and(|existing| existing.meta.get("username") != meta.get("username"));
    if kind == KIND_BASIC && (secret_changed || user_changed) {
        crate::sessions::clear(&mut secret);
    }
    if previous.as_ref() != Some(&secret) {
        write_secret(&id, &secret)?;
    }

    let saved = Entry { id, label, kind, meta: Value::Object(meta), updated_at: app_db::now() };
    {
        let db = lock_db(state)?;
        db.execute(
            "INSERT INTO vault_entries (id, label, kind, meta, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET label = excluded.label, meta = excluded.meta, updated_at = excluded.updated_at",
            params![saved.id, saved.label, saved.kind, saved.meta.to_string(), saved.updated_at],
        )?;
    }
    state.emit("vault:changed", json!({ "id": saved.id }));
    Ok(describe(&saved))
}

fn delete(state: &Arc<AppState>, args: &Value) -> AppResult<Value> {
    let id: String = arg(args, "id")?;
    if entry(state, &id)?.is_none() {
        return Err(AppError::new("Cette entrée du coffre n’existe pas."));
    }
    if let Some(space) = state.try_space() {
        let users = crate::clients::using_secret(&space, &id);
        if !users.is_empty() {
            return Err(AppError::new(format!(
                "Cette entrée est utilisée par {} : {}. Choisir une autre entrée pour {} avant de la supprimer.",
                if users.len() > 1 { "les clients" } else { "le client" },
                users.join(", "),
                if users.len() > 1 { "ces clients" } else { "ce client" },
            )));
        }
    }
    delete_secret(&id)?;
    {
        let db = lock_db(state)?;
        db.execute("DELETE FROM vault_entries WHERE id = ?1", params![id])?;
    }
    state.emit("vault:changed", json!({ "id": id }));
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::testing::{invoke, test_state, unique};

    #[test]
    fn dev_file_store_keeps_secrets_private_and_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dev-secrets.json");
        let store = FileStore { path: path.clone(), lock: Mutex::new(()) };
        assert_eq!(store.get("a").unwrap(), None);
        store.set("a", "un").unwrap();
        store.set("b", "deux").unwrap();
        store.delete("b").unwrap();
        store.delete("absent").unwrap();
        let reopened = FileStore { path: path.clone(), lock: Mutex::new(()) };
        assert_eq!(reopened.get("a").unwrap().as_deref(), Some("un"));
        assert_eq!(reopened.get("b").unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn long_values_are_split_and_cleaned_up() {
        let store = Chunked { inner: MemoryStore::default(), limit: 8 };
        let long = "0123456789abcdefghij-é😀-fin";
        store.set("entry", long).unwrap();
        assert_eq!(store.get("entry").unwrap().as_deref(), Some(long));
        let parts = store.inner.entries().unwrap().len();
        assert!(parts > 3, "la valeur doit être répartie, {parts} entrée(s)");
        let within_limit =
            |(account, chunk): (&String, &String)| !account.contains('#') || chunk.encode_utf16().count() <= 8;
        assert!(store.inner.entries().unwrap().iter().all(within_limit));

        // Une valeur plus courte remplace la longue sans laisser de morceaux.
        store.set("entry", "court").unwrap();
        assert_eq!(store.get("entry").unwrap().as_deref(), Some("court"));
        assert_eq!(store.inner.entries().unwrap().len(), 1);

        store.set("entry", long).unwrap();
        store.delete("entry").unwrap();
        assert!(store.inner.entries().unwrap().is_empty());
        assert_eq!(store.get("entry").unwrap(), None);
    }

    #[tokio::test]
    async fn vault_journey_never_returns_a_secret() {
        let (state, _dir) = test_state();
        let token_id = unique("jeton-jira");
        let mut outputs: Vec<Value> = Vec::new();

        // Création : l’identifiant est celui demandé, le secret part au trousseau et n’en revient pas.
        let created = invoke(
            &state,
            "vault.save",
            json!({ "id": token_id, "label": "Jeton Jira", "kind": "token", "secrets": { "value": "s3cr3t-jira-AAA" } }),
        )
        .await
        .unwrap();
        assert_eq!(created["id"], json!(token_id));
        assert_eq!(created["hasSecret"], json!(true));
        assert_eq!(read_secret(&token_id).unwrap().unwrap()["value"], json!("s3cr3t-jira-AAA"));
        outputs.push(created);

        // Édition sans ressaisir le secret : il est conservé ; avec une nouvelle valeur : il est remplacé.
        let renamed = invoke(
            &state,
            "vault.save",
            json!({ "id": token_id, "label": "Jeton Jira (prod)", "kind": "token", "secrets": { "value": "" } }),
        )
        .await
        .unwrap();
        assert_eq!(renamed["label"], json!("Jeton Jira (prod)"));
        assert_eq!(read_secret(&token_id).unwrap().unwrap()["value"], json!("s3cr3t-jira-AAA"));
        outputs.push(renamed);
        invoke(
            &state,
            "vault.save",
            json!({ "id": token_id, "label": "Jeton Jira (prod)", "kind": "token", "secrets": { "value": "s3cr3t-jira-BBB" } }),
        )
        .await
        .unwrap();
        assert_eq!(read_secret(&token_id).unwrap().unwrap()["value"], json!("s3cr3t-jira-BBB"));

        // Les autres types : champs non secrets dans `meta`, secret obligatoire ou non selon le type.
        let basic_id = unique("compte");
        let basic = invoke(
            &state,
            "vault.save",
            json!({ "id": basic_id, "label": "Compte", "kind": "basic", "meta": { "username": "alice", "password": "glissé-par-erreur" }, "secrets": { "password": "p4ss-w0rd-CCC" } }),
        )
        .await
        .unwrap();
        assert_eq!(basic["meta"], json!({ "username": "alice" }));
        outputs.push(basic);
        let oauth_id = unique("sso");
        let oauth = invoke(
            &state,
            "vault.save",
            json!({ "id": oauth_id, "label": "SSO", "kind": "oauth2", "meta": { "clientId": "alfred-app" } }),
        )
        .await
        .unwrap();
        assert_eq!(oauth["connected"], json!(false));
        outputs.push(oauth);
        // Un secret très long (jetons OAuth) passe par le découpage du trousseau.
        let long = "j".repeat(5_000);
        write_secret(&oauth_id, &json!({ "accessToken": long, "refreshToken": "r3fr3sh-DDD" })).unwrap();
        assert_eq!(read_secret(&oauth_id).unwrap().unwrap()["accessToken"], json!(long));

        // Sans identifiant, il est déduit du libellé et reste unique.
        let first = invoke(
            &state,
            "vault.save",
            json!({ "label": "Clé Météo", "kind": "token", "secrets": { "value": "k-EEE-1" } }),
        )
        .await
        .unwrap();
        let second = invoke(
            &state,
            "vault.save",
            json!({ "label": "Clé Météo", "kind": "token", "secrets": { "value": "k-EEE-2" } }),
        )
        .await
        .unwrap();
        assert_eq!(first["id"], json!("cle-meteo"));
        assert_eq!(second["id"], json!("cle-meteo-2"));

        // Refus explicites.
        let errors = [
            invoke(&state, "vault.save", json!({ "label": "Vide", "kind": "token" })).await.unwrap_err(),
            invoke(
                &state,
                "vault.save",
                json!({ "label": "Sans nom", "kind": "basic", "secrets": { "password": "x-FFF" } }),
            )
            .await
            .unwrap_err(),
            invoke(
                &state,
                "vault.save",
                json!({ "id": token_id, "label": "Jira", "kind": "basic", "meta": { "username": "a" } }),
            )
            .await
            .unwrap_err(),
            invoke(
                &state,
                "vault.save",
                json!({ "label": "Jira", "kind": "token", "secrets": { "accessToken": "forgé-GGG" } }),
            )
            .await
            .unwrap_err(),
            invoke(
                &state,
                "vault.save",
                json!({ "id": "Pas Valide", "label": "x", "kind": "token", "secrets": { "value": "y-HHH" } }),
            )
            .await
            .unwrap_err(),
        ];
        assert!(errors[0].message.contains("Saisir la valeur"));
        assert!(errors[1].message.contains("Saisir l’identifiant"));
        assert!(errors[2].message.contains("ne se change pas"));
        assert!(errors[3].message.contains("Champ secret inconnu"));
        assert!(errors[4].message.contains("Identifiant d’entrée invalide"));

        let list = invoke(&state, "vault.list", json!({})).await.unwrap();
        assert_eq!(list.as_array().unwrap().len(), 5);
        let listed = list.as_array().unwrap().iter().find(|item| item["id"] == json!(oauth_id)).unwrap();
        assert_eq!(listed["connected"], json!(true));
        assert_eq!(listed["hasSecret"], json!(false));
        outputs.push(list);

        // Suppression refusée tant qu’un client de l’espace s’en sert, en le nommant.
        invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "jira", "label": "Jira", "baseUrl": "https://jira.exemple.com", "auth": { "type": "bearer", "secret": token_id } } }),
        )
        .await
        .unwrap();
        let refused = invoke(&state, "vault.delete", json!({ "id": token_id })).await.unwrap_err();
        assert!(refused.message.contains("Jira"), "{}", refused.message);
        assert!(read_secret(&token_id).unwrap().is_some());
        invoke(&state, "clients.delete", json!({ "id": "jira" })).await.unwrap();
        invoke(&state, "vault.delete", json!({ "id": token_id })).await.unwrap();
        assert_eq!(read_secret(&token_id).unwrap(), None);
        assert!(invoke(&state, "vault.delete", json!({ "id": token_id })).await.is_err());
        outputs.push(invoke(&state, "vault.list", json!({})).await.unwrap());

        let everything = format!("{} {}", Value::Array(outputs), errors.map(|error| error.message).join(" "));
        for secret in ["s3cr3t-jira", "p4ss-w0rd", "r3fr3sh", "k-EEE", "glissé", "forgé", "jjjjj", "x-FFF", "y-HHH"] {
            assert!(!everything.contains(secret), "« {secret} » a fui dans une réponse");
        }
    }
}
