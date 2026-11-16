//! Conversations d’agents et fichiers échangés avec eux. Alfred garde un relevé compact de chaque conversation dans
//! sa propre base ; le détail complet reste dans l’historique du harnais.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::app_db;
use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::state::AppState;

/// Taille maximale d’une conversation enregistrée : au-delà, l’interface doit alléger le relevé.
const MAX_CONVERSATION_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

fn db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state.app_db.lock().map_err(|_| AppError::new("La base d’Alfred est indisponible."))
}

fn space_key(state: &AppState) -> AppResult<String> {
    Ok(state.space()?.root.to_string_lossy().to_string())
}

/// Dossier d’échange d’une conversation : collages longs, images collées, fichiers déposés sans chemin.
fn exchange_dir(state: &AppState, conversation: &str) -> AppResult<PathBuf> {
    if !conversation.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || conversation.is_empty() {
        return Err(AppError::new("Identifiant de conversation invalide."));
    }
    let dir = state.data_dir.join("echanges").join(conversation);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == ' ').to_string();
    if cleaned.is_empty() {
        "fichier".to_string()
    } else if crate::space::windows_reserved(&cleaned) {
        // `CON.txt`, `nul.png`… ne peuvent pas être créés sous Windows.
        format!("_{}", cleaned.chars().take(119).collect::<String>())
    } else {
        cleaned.chars().take(120).collect()
    }
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Extensions qu’ouvrir revient à exécuter : programmes, scripts, paquets d’installation, raccourcis.
const RUNNABLE: [&str; 44] = [
    "app", "command", "tool", "terminal", "sh", "bash", "zsh", "csh", "ksh", "fish", "py", "pl", "rb", "php",
    "scpt", "scptd", "applescript", "workflow", "action", "pkg", "mpkg", "dmg", "jar", "exe", "bat", "cmd", "com",
    "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "lnk", "scr", "url", "webloc", "inetloc", "fileloc",
    "desktop", "appimage", "mobileconfig",
];

/// Ouvrir ce chemin lancerait du code : un lien cité par un agent ne doit pas pouvoir le faire d’un clic.
fn runs_when_opened(path: &Path) -> bool {
    let extension = path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase);
    if extension.as_deref().is_some_and(|extension| {
        RUNNABLE.contains(&extension)
            || matches!(extension, "bundle" | "framework" | "plugin" | "prefpane" | "kext" | "osax" | "qlgenerator")
    }) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(path) {
            return metadata.is_file() && metadata.permissions().mode() & 0o111 != 0;
        }
    }
    false
}

fn open_with_system(path: &Path, reveal: bool) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new(format!("Fichier introuvable : {}", path.display())));
    }
    // Un fichier qui s’exécuterait est montré dans le Finder (ou l’Explorateur) au lieu d’être ouvert.
    let reveal = reveal || runs_when_opened(path);
    // Sous Windows, `explorer "/select,C:\dossier avec espace\a.pdf"` ouvre « Documents » au lieu du fichier, et un
    // chemin à barres obliques échoue : le Shell est appelé directement (SHOpenFolderAndSelectItems, ShellExecuteW).
    #[cfg(target_os = "windows")]
    {
        let opened = if reveal {
            tauri_plugin_opener::reveal_item_in_dir(path)
        } else {
            tauri_plugin_opener::open_path(path, None::<&str>)
        };
        opened.map_err(|error| AppError::new(format!("Impossible d’ouvrir le fichier : {error}")))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command;
        #[cfg(target_os = "macos")]
        {
            command = std::process::Command::new("open");
            if reveal {
                command.arg("-R");
            }
            command.arg(path);
        }
        #[cfg(not(target_os = "macos"))]
        {
            command = std::process::Command::new("xdg-open");
            command.arg(if reveal { path.parent().unwrap_or(path) } else { path });
        }
        command.spawn().map_err(|error| AppError::new(format!("Impossible d’ouvrir le fichier : {error}")))?;
        Ok(())
    }
}

/// Résout un chemin cité par un agent : absolu, `~/…`, `file://…`, ou relatif au dossier de la conversation.
fn resolve_path(reference: &str, base: Option<&str>) -> PathBuf {
    let from_url = file_url_path(reference);
    let reference = from_url.as_deref().unwrap_or(reference);
    // Ancre de ligne (`fichier.rs:12`, `#L12`) retirée pour retrouver le fichier.
    let reference = reference.split("#L").next().unwrap_or(reference);
    let trimmed = match reference.rsplit_once(':') {
        Some((head, tail)) if !head.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) && head.len() > 2 => {
            match head.rsplit_once(':') {
                Some((first, line)) if line.chars().all(|c| c.is_ascii_digit()) && first.len() > 2 => first,
                _ => head,
            }
        }
        _ => reference,
    };
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = crate::dispatch::home_dir() {
            return home.join(rest);
        }
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.map(|base| Path::new(base).join(path)).unwrap_or_else(|| path.to_path_buf())
    }
}

/// Chemin local d’une adresse `file://` : les `%20` sont décodés, `file:///C:/…` devient `C:/…` (sans quoi Windows
/// y voit un chemin relatif) et `file://serveur/partage/…` devient le chemin UNC `//serveur/partage/…`.
fn file_url_path(reference: &str) -> Option<String> {
    let rest = reference.get(..7).filter(|scheme| scheme.eq_ignore_ascii_case("file://")).map(|_| &reference[7..])?;
    let rest = rest.strip_prefix("localhost").filter(|rest| rest.starts_with('/')).unwrap_or(rest);
    let path = percent_decode(rest);
    let bytes = path.as_bytes();
    Some(if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        path[1..].to_string()
    } else if !path.starts_with('/') {
        format!("//{path}")
    } else {
        path
    })
}

/// Décode les `%XX` ; une séquence invalide est gardée telle quelle.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = (bytes[index] == b'%')
            .then(|| bytes.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escaped {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| text.to_string())
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    Some(match command {
        "conversations.list" => (|| {
            let space = space_key(state)?;
            let db = db(state)?;
            // La liste n’a pas besoin des tours : seul l’en-tête de chaque conversation est renvoyé.
            let mut statement = db.prepare(
                "SELECT json_remove(data, '$.turns') FROM conversations WHERE space = ?1 ORDER BY updated_at DESC",
            )?;
            let rows = statement.query_map(params![space], |row| row.get::<_, String>(0))?;
            let list: Vec<Value> =
                rows.filter_map(Result::ok).filter_map(|text| serde_json::from_str(&text).ok()).collect();
            Ok(Value::Array(list))
        })(),
        "conversations.get" => (|| {
            let id: String = arg(args, "id")?;
            let db = db(state)?;
            let text: Option<String> =
                db.query_row("SELECT data FROM conversations WHERE id = ?1", params![id], |row| row.get(0)).optional()?;
            Ok(text.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null))
        })(),
        "conversations.save" => (|| {
            let conversation = args.get("conversation").cloned().unwrap_or(Value::Null);
            let id = conversation
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("Conversation sans identifiant."))?
                .to_string();
            let text = conversation.to_string();
            if text.len() > MAX_CONVERSATION_BYTES {
                return Err(AppError::new("Cette conversation est trop volumineuse pour être enregistrée."));
            }
            let space = space_key(state)?;
            let db = db(state)?;
            db.execute(
                "INSERT INTO conversations (id, space, updated_at, data) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data",
                params![id, space, app_db::now(), text],
            )?;
            Ok(Value::Null)
        })(),
        "conversations.delete" => (|| {
            let id: String = arg(args, "id")?;
            db(state)?.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
            if let Ok(dir) = exchange_dir(state, &id) {
                let _ = std::fs::remove_dir_all(dir);
            }
            Ok(Value::Null)
        })(),

        // Fichiers échangés
        "files.saveExchange" => (|| {
            let conversation: String = arg(args, "conversation")?;
            let name: String = arg(args, "name")?;
            let dir = exchange_dir(state, &conversation)?;
            let bytes = match opt_arg::<String>(args, "base64")? {
                Some(encoded) => base64::engine::general_purpose::STANDARD
                    .decode(encoded.as_bytes())
                    .map_err(|_| AppError::new("Contenu de fichier illisible."))?,
                None => arg::<String>(args, "text")?.into_bytes(),
            };
            if bytes.len() as u64 > MAX_FILE_BYTES {
                return Err(AppError::new("Ce fichier dépasse 20 Mo."));
            }
            let name = safe_name(&name);
            let (stem, extension) = match name.rsplit_once('.') {
                Some((stem, extension)) => (stem.to_string(), format!(".{extension}")),
                None => (name.clone(), String::new()),
            };
            let path = (0..)
                .map(|index| {
                    if index == 0 { dir.join(&name) } else { dir.join(format!("{stem}-{index}{extension}")) }
                })
                .find(|candidate| !candidate.exists())
                .unwrap_or_else(|| dir.join(&name));
            std::fs::write(&path, bytes)?;
            Ok(json!({ "path": path.to_string_lossy(), "name": path.file_name().map(|n| n.to_string_lossy()) }))
        })(),
        "files.stat" => (|| {
            let reference: String = arg(args, "path")?;
            let base: Option<String> = opt_arg(args, "base")?;
            let path = resolve_path(&reference, base.as_deref());
            let metadata = std::fs::metadata(&path).ok();
            Ok(json!({
                "path": path.to_string_lossy(),
                "name": path.file_name().map(|name| name.to_string_lossy()),
                "exists": metadata.is_some(),
                "isDirectory": metadata.as_ref().is_some_and(|m| m.is_dir()),
                "size": metadata.as_ref().map(|m| m.len()),
                "mimeType": mime_of(&path),
            }))
        })(),
        "files.open" | "files.reveal" => (|| {
            let reference: String = arg(args, "path")?;
            let base: Option<String> = opt_arg(args, "base")?;
            open_with_system(&resolve_path(&reference, base.as_deref()), command == "files.reveal")?;
            Ok(Value::Null)
        })(),
        "files.readImage" => (|| {
            let reference: String = arg(args, "path")?;
            let base: Option<String> = opt_arg(args, "base")?;
            let path = resolve_path(&reference, base.as_deref());
            let mime = mime_of(&path);
            if !mime.starts_with("image/") {
                return Err(AppError::new("Ce fichier n’est pas une image affichable."));
            }
            let metadata = std::fs::metadata(&path)
                .map_err(|_| AppError::new(format!("Image introuvable : {}", path.display())))?;
            if metadata.len() > 8 * 1024 * 1024 {
                return Err(AppError::new("Cette image est trop volumineuse pour être affichée."));
            }
            let encoded = base64::engine::general_purpose::STANDARD.encode(std::fs::read(&path)?);
            Ok(json!({ "dataUrl": format!("data:{mime};base64,{encoded}") }))
        })(),
        // Aperçu d’un document cité par l’agent (PDF) : contenu borné à 20 Mo.
        "files.read" => (|| {
            let reference: String = arg(args, "path")?;
            let base: Option<String> = opt_arg(args, "base")?;
            let path = resolve_path(&reference, base.as_deref());
            let bytes = read_bounded(&path)?;
            Ok(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        })(),
        // « Enregistrer une copie » : le fichier cité, ou une image en ligne, écrit à l’emplacement choisi.
        "files.saveCopy" => (|| {
            let destination: String = arg(args, "destination")?;
            let bytes = match opt_arg::<String>(args, "base64")? {
                Some(encoded) => base64::engine::general_purpose::STANDARD
                    .decode(encoded.as_bytes())
                    .map_err(|_| AppError::new("Contenu de fichier illisible."))?,
                None => {
                    let reference: String = arg(args, "path")?;
                    let base: Option<String> = opt_arg(args, "base")?;
                    read_bounded(&resolve_path(&reference, base.as_deref()))?
                }
            };
            save_copy(Path::new(&destination), &bytes)?;
            Ok(Value::Null)
        })(),
        _ => return None,
    })
}

/// Contenu d’un fichier cité, refusé au-delà de 20 Mo ou s’il s’agit d’un dossier.
fn read_bounded(path: &Path) -> AppResult<Vec<u8>> {
    let metadata =
        std::fs::metadata(path).map_err(|_| AppError::new(format!("Fichier introuvable : {}", path.display())))?;
    if metadata.is_dir() {
        return Err(AppError::new("Ce chemin est un dossier."));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(AppError::new("Ce fichier dépasse 20 Mo."));
    }
    Ok(std::fs::read(path)?)
}

/// Écrit la copie choisie par l’utilisateur ; le dossier de destination doit exister.
fn save_copy(destination: &Path, bytes: &[u8]) -> AppResult<()> {
    if !destination.is_absolute() {
        return Err(AppError::new("Emplacement d’enregistrement invalide."));
    }
    if destination.is_dir() {
        return Err(AppError::new("Choisissez un nom de fichier, pas un dossier."));
    }
    std::fs::write(destination, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_paths_agents_cite() {
        let base = Some("/projet");
        assert_eq!(resolve_path("src/main.rs:12:4", base), PathBuf::from("/projet/src/main.rs"));
        assert_eq!(resolve_path("/tmp/rapport final.pdf", base), PathBuf::from("/tmp/rapport final.pdf"));
        assert_eq!(resolve_path("file:///tmp/a.png", base), PathBuf::from("/tmp/a.png"));
        assert_eq!(resolve_path("notes.md#L3", base), PathBuf::from("/projet/notes.md"));
        assert_eq!(resolve_path("file:///tmp/rapport%20final.pdf#L2", base), PathBuf::from("/tmp/rapport final.pdf"));
        assert_eq!(safe_name("../../etc/pass wd?.txt"), "_.._etc_pass wd_.txt");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
    }

    /// Les adresses `file://` d’un agent sous Windows : lettre de lecteur, espaces encodés, partage réseau.
    #[test]
    fn reads_windows_file_urls() {
        assert_eq!(file_url_path("file:///C:/Users/camille/rapport%20final.pdf").as_deref(), Some("C:/Users/camille/rapport final.pdf"));
        assert_eq!(file_url_path("FILE:///d:/projet/a.rs").as_deref(), Some("d:/projet/a.rs"));
        assert_eq!(file_url_path("file://localhost/C:/a.png").as_deref(), Some("C:/a.png"));
        assert_eq!(file_url_path("file://serveur/partage/note%C3%A9.md").as_deref(), Some("//serveur/partage/noteé.md"));
        assert_eq!(file_url_path("file:///tmp/100%.txt").as_deref(), Some("/tmp/100%.txt"));
        assert_eq!(file_url_path("C:\\Users\\a.pdf"), None);
    }

    /// Copie d’un fichier cité : lecture bornée, refus d’un dossier, destination absolue.
    #[test]
    fn saves_a_copy_of_a_cited_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("rapport.pdf");
        std::fs::write(&source, b"%PDF-1.7").unwrap();
        assert_eq!(read_bounded(&source).unwrap(), b"%PDF-1.7");
        assert!(read_bounded(dir.path()).is_err(), "un dossier n’est pas lu");
        assert!(read_bounded(&dir.path().join("absent.pdf")).is_err());
        let copy = dir.path().join("copie.pdf");
        save_copy(&copy, b"%PDF-1.7").unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"%PDF-1.7");
        assert!(save_copy(Path::new("relatif.pdf"), b"x").is_err());
        assert!(save_copy(dir.path(), b"x").is_err());
    }

    /// Un lien d’agent vers un script ou une application ne l’exécute pas : le fichier est seulement montré.
    #[test]
    fn a_cited_file_that_would_run_is_revealed_not_opened() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["outil.command", "Installer.app", "x.sh", "lien.webloc", "a.JS"] {
            assert!(runs_when_opened(&dir.path().join(name)), "{name}");
        }
        let script = dir.path().join("sans-extension");
        std::fs::write(&script, "#!/bin/sh\necho pwned\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(runs_when_opened(&script));
        }
        let report = dir.path().join("rapport.pdf");
        std::fs::write(&report, "%PDF").unwrap();
        assert!(!runs_when_opened(&report));
        assert!(!runs_when_opened(dir.path()), "un dossier ordinaire s’ouvre");
    }
}
