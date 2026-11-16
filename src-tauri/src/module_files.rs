//! Fichiers des modules : pièces jointes, PDF, images. Une page n’a pas de disque ; elle confie ses fichiers à
//! Alfred, qui les range dans `.alfred/files/<module>/<id>/<nom>` avec leurs métadonnées (`meta.json`). Chaque
//! module ne voit que les siens. Les sauvegardes (`backups.rs`) les copient avec la base.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{arg, opt_arg, AppError, AppResult};
use crate::permissions::Subject;
use crate::space::{valid_id, Space};
use crate::state::AppState;

/// Taille maximale d’un fichier confié par une page ou une fonction.
pub const MAX_SIZE: usize = 50 * 1024 * 1024;
/// Au-delà, une image ne passe pas en adresse `data:`.
const MAX_DATA_URL: u64 = 5 * 1024 * 1024;
const META: &str = "meta.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: String,
}

fn module_dir(space: &Space, module: &str) -> AppResult<PathBuf> {
    if !valid_id(module) {
        return Err(AppError::new("Module inconnu."));
    }
    Ok(crate::backups::files_root(space).join(module))
}

fn file_dir(space: &Space, module: &str, id: &str) -> AppResult<PathBuf> {
    let valid = id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit());
    let dir = module_dir(space, module)?.join(id);
    if !valid || !dir.join(META).is_file() {
        return Err(AppError::new(format!("Le fichier « {id} » n’existe pas dans ce module.")));
    }
    Ok(dir)
}

pub fn info(space: &Space, module: &str, id: &str) -> AppResult<FileInfo> {
    let dir = file_dir(space, module, id)?;
    Ok(serde_json::from_str(&std::fs::read_to_string(dir.join(META))?)?)
}

/// Chemin du contenu d’un fichier du module.
pub fn path_of(space: &Space, module: &str, id: &str) -> AppResult<PathBuf> {
    let info = info(space, module, id)?;
    Ok(file_dir(space, module, id)?.join(&info.name))
}

pub fn mime_for(name: &str) -> &'static str {
    let extension = Path::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("txt" | "log") => "text/plain",
        Some("md") => "text/markdown",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("html" | "htm") => "text/html",
        Some("xml") => "application/xml",
        Some("zip") => "application/zip",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("doc") => "application/msword",
        Some("xls") => "application/vnd.ms-excel",
        Some("odt") => "application/vnd.oasis.opendocument.text",
        Some("ods") => "application/vnd.oasis.opendocument.spreadsheet",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("mp4") => "video/mp4",
        Some("eml") => "message/rfc822",
        _ => "application/octet-stream",
    }
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Range un contenu dans les fichiers du module.
pub fn save(space: &Space, module: &str, name: &str, mime: Option<&str>, bytes: &[u8]) -> AppResult<FileInfo> {
    if bytes.len() > MAX_SIZE {
        return Err(AppError::new(format!(
            "Fichier trop gros : {} Mo au plus.",
            MAX_SIZE / 1024 / 1024
        )));
    }
    let name = crate::conversations::safe_name(name);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = module_dir(space, module)?.join(&id);
    std::fs::create_dir_all(&dir)?;
    let info = FileInfo {
        id,
        mime: mime.filter(|mime| !mime.trim().is_empty() && mime.len() < 128).map(str::to_string).unwrap_or_else(|| mime_for(&name).to_string()),
        name,
        size: bytes.len() as u64,
        sha256: digest(bytes),
        created_at: crate::app_db::now(),
    };
    let written = std::fs::write(dir.join(&info.name), bytes)
        .and_then(|()| std::fs::write(dir.join(META), serde_json::to_vec_pretty(&info).unwrap_or_default()));
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error.into());
    }
    Ok(info)
}

/// Fichiers du module, du plus récent au plus ancien ; `prefix` filtre sur le nom.
pub fn list(space: &Space, module: &str, prefix: Option<&str>, limit: usize) -> AppResult<Vec<FileInfo>> {
    let Ok(entries) = std::fs::read_dir(module_dir(space, module)?) else { return Ok(Vec::new()) };
    let mut files: Vec<FileInfo> = entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path().join(META)).ok())
        .filter_map(|text| serde_json::from_str::<FileInfo>(&text).ok())
        .filter(|info| prefix.is_none_or(|prefix| info.name.starts_with(prefix)))
        .collect();
    files.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.name.cmp(&b.name)));
    files.truncate(limit);
    Ok(files)
}

pub fn read(space: &Space, module: &str, id: &str) -> AppResult<(FileInfo, Vec<u8>)> {
    let info = info(space, module, id)?;
    let bytes = std::fs::read(path_of(space, module, id)?)?;
    Ok((info, bytes))
}

pub fn remove(space: &Space, module: &str, id: &str) -> AppResult<()> {
    std::fs::remove_dir_all(file_dir(space, module, id)?)?;
    Ok(())
}

/// Adresse `data:` d’une image, pour l’afficher dans une page (les images extérieures y sont bloquées).
pub fn data_url(space: &Space, module: &str, id: &str) -> AppResult<String> {
    let info = info(space, module, id)?;
    if !info.mime.starts_with("image/") {
        return Err(AppError::new("Seule une image s’affiche par `files.dataUrl` ; ouvrez les autres avec `files.open`."));
    }
    if info.size > MAX_DATA_URL {
        return Err(AppError::new("Image trop grosse pour être affichée dans la page (5 Mo au plus)."));
    }
    let (_, bytes) = read(space, module, id)?;
    Ok(format!("data:{};base64,{}", info.mime, base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Copie dans le module des fichiers que l’utilisateur a choisis sur son disque.
pub fn import_paths(space: &Space, module: &str, paths: &[String]) -> AppResult<Vec<FileInfo>> {
    let mut saved = Vec::new();
    for path in paths {
        let path = Path::new(path);
        let size = std::fs::metadata(path).map_err(|error| AppError::new(format!("{} : {error}", path.display())))?.len();
        if size as usize > MAX_SIZE {
            return Err(AppError::new(format!("« {} » dépasse {} Mo.", path.display(), MAX_SIZE / 1024 / 1024)));
        }
        let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        saved.push(save(space, module, &name, None, &std::fs::read(path)?)?);
    }
    Ok(saved)
}

fn bytes_from(args: &Value) -> AppResult<Vec<u8>> {
    if let Some(text) = opt_arg::<String>(args, "text")? {
        return Ok(text.into_bytes());
    }
    let data: String = arg(args, "data").map_err(|_| AppError::new("Fournir `data` (base64) ou `text`."))?;
    let data = data.split_once(";base64,").map_or(data.as_str(), |(_, rest)| rest);
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| AppError::new("`data` doit être du base64."))
}

/// Un geste de l’utilisateur (ouvrir, choisir, enregistrer) ne se déclenche pas depuis une fonction en arrière-plan.
fn interactive(subject: &Subject) -> AppResult<()> {
    if subject.kind == "function" {
        return Err(AppError::new("Une fonction ne peut pas ouvrir de fenêtre : faites-le depuis une page."));
    }
    Ok(())
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    if !command.starts_with("frame.files.") {
        return None;
    }
    let result = (|| -> AppResult<Value> {
        let subject: Subject = arg(args, "subject")?;
        let module = subject.module.as_str();
        let space = state.space()?;
        Ok(match command {
            "frame.files.save" => {
                let name: String = arg(args, "name")?;
                let mime: Option<String> = opt_arg(args, "mime")?;
                json!(save(&space, module, &name, mime.as_deref(), &bytes_from(args)?)?)
            }
            "frame.files.list" => {
                let prefix: Option<String> = opt_arg(args, "prefix")?;
                let limit: Option<usize> = opt_arg(args, "limit")?;
                json!(list(&space, module, prefix.as_deref(), limit.unwrap_or(500).min(5_000))?)
            }
            "frame.files.get" => json!(info(&space, module, &arg::<String>(args, "id")?)?),
            "frame.files.read" => {
                let (info, bytes) = read(&space, module, &arg::<String>(args, "id")?)?;
                json!({ "info": info, "data": base64::engine::general_purpose::STANDARD.encode(bytes) })
            }
            "frame.files.readText" => {
                let (_, bytes) = read(&space, module, &arg::<String>(args, "id")?)?;
                Value::String(String::from_utf8_lossy(&bytes).to_string())
            }
            "frame.files.remove" => {
                remove(&space, module, &arg::<String>(args, "id")?)?;
                Value::Null
            }
            "frame.files.dataUrl" => Value::String(data_url(&space, module, &arg::<String>(args, "id")?)?),
            "frame.files.open" => {
                interactive(&subject)?;
                // Un fichier qui s’exécuterait est montré dans le Finder (ou l’Explorateur) au lieu d’être ouvert.
                crate::conversations::open_with_system(&path_of(&space, module, &arg::<String>(args, "id")?)?, false)?;
                Value::Null
            }
            // Les deux suivantes ne viennent que de la coquille, après un sélecteur de fichiers montré à l’utilisateur.
            "frame.files.importPaths" => {
                interactive(&subject)?;
                let paths: Vec<String> = arg(args, "paths")?;
                json!(import_paths(&space, module, &paths)?)
            }
            "frame.files.exportTo" => {
                interactive(&subject)?;
                let target: String = arg(args, "path")?;
                std::fs::copy(path_of(&space, module, &arg::<String>(args, "id")?)?, &target)?;
                Value::Null
            }
            _ => return Err(AppError::new(format!("Commande inconnue : {command}"))),
        })
    })();
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_module_keeps_its_files_to_itself() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let saved = save(&space, "notes", "../../facture mars.pdf", None, b"%PDF-1.4").unwrap();
        assert!(!saved.name.contains('/') && saved.name.ends_with("facture mars.pdf"), "{}", saved.name);
        assert_eq!(saved.mime, "application/pdf");
        assert_eq!(saved.size, 8);
        let image = save(&space, "notes", "photo.png", None, &[0x89, b'P', b'N', b'G']).unwrap();

        let listed = list(&space, "notes", None, 10).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(list(&space, "notes", Some("photo"), 10).unwrap(), vec![image.clone()]);
        assert_eq!(read(&space, "notes", &saved.id).unwrap().1, b"%PDF-1.4");
        assert!(data_url(&space, "notes", &image.id).unwrap().starts_with("data:image/png;base64,"));
        assert!(data_url(&space, "notes", &saved.id).is_err(), "pas une image");

        // Un autre module ne voit ni ne lit ces fichiers, et un identifiant forgé ne sort pas du dossier.
        assert!(list(&space, "suivi", None, 10).unwrap().is_empty());
        assert!(read(&space, "suivi", &saved.id).is_err());
        assert!(read(&space, "notes", "../suivi").is_err());
        assert!(module_dir(&space, "../x").is_err());

        remove(&space, "notes", &saved.id).unwrap();
        assert_eq!(list(&space, "notes", None, 10).unwrap(), vec![image]);
        assert!(save(&space, "notes", "gros.bin", None, &vec![0; MAX_SIZE + 1]).is_err());
    }

    #[test]
    fn files_travel_with_backups_and_exports() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        let manifest = crate::space::ModuleManifest { id: "notes".into(), name: "Notes".into(), ..Default::default() };
        space.write_module(&manifest).unwrap();
        let saved = save(&space, "notes", "a.txt", None, b"bonjour").unwrap();
        let backup = crate::backups::create(&space, crate::backups::Reason::Manuelle, None).unwrap();
        assert_eq!(backup.modules[0].files, 1);

        let export = crate::backups::export_module(&space, "notes").unwrap();
        remove(&space, "notes", &saved.id).unwrap();
        crate::backups::import_module(&space, "notes", &export).unwrap();
        assert_eq!(read(&space, "notes", &saved.id).unwrap().1, b"bonjour");

        remove(&space, "notes", &saved.id).unwrap();
        crate::backups::restore_module(&space, &backup.id, "notes").unwrap();
        assert_eq!(info(&space, "notes", &saved.id).unwrap(), saved);
    }
}
