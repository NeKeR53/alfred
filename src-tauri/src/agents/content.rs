//! Images et documents d’un contenu d’agent (blocs MCP d’un outil, contenu d’un outil OpenCode) : ils s’affichent
//! sous l’activité, et le contenu montré remplace leurs données binaires par un repère, sans base64.

use serde_json::Value;

/// Taille maximale d’une image `data:` relayée à l’interface (comme `maxImagePreviewLength`).
pub const MAX_IMAGE_DATA_URL: usize = 2 * 1024 * 1024;
const MAX_FILES: usize = 8;
const IMAGE_PLACEHOLDER: &str = "[image affichée ci-dessous]";
const FILE_PLACEHOLDER: &str = "[fichier affiché ci-dessous]";

/// Documents montrés en carte sous un message : ce que l’utilisateur ouvre ou enregistre, pas le code source.
const DOCUMENTS: &[&str] = &[
    "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf", "csv", "tsv", "zip", "epub", "html",
    "svg", "mp4", "webm", "mp3", "wav",
];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif"];

fn extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default()
}

pub fn is_document(path: &str) -> bool {
    DOCUMENTS.contains(&extension(path).as_str())
}

pub fn is_image(path: &str) -> bool {
    IMAGES.contains(&extension(path).as_str())
}

/// Image `data:` acceptée par l’interface : type connu, base64 seul, taille bornée.
pub fn image_data_url(mime: &str, data: &str) -> Option<String> {
    let mime_ok = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].contains(&mime);
    let data_ok = !data.is_empty()
        && data.trim_end_matches('=').chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/');
    let url = format!("data:{mime};base64,{data}");
    (mime_ok && data_ok && url.len() <= MAX_IMAGE_DATA_URL).then_some(url)
}

/// Chemin local d’une adresse `file://` ou d’un chemin brut ; une autre adresse n’en est pas un.
pub fn local_path(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() > 7 && text[..7].eq_ignore_ascii_case("file://") {
        return url::Url::parse(text).ok()?.to_file_path().ok().map(|path| path.to_string_lossy().into_owned());
    }
    let windows_drive = text.len() > 2 && text.as_bytes()[1] == b':' && matches!(text.as_bytes()[2], b'\\' | b'/');
    let scheme = text
        .split_once(':')
        .is_some_and(|(scheme, _)| !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)));
    (!scheme || windows_drive).then(|| text.to_owned())
}

#[derive(Default, Debug, PartialEq)]
pub struct Found {
    pub images: Vec<String>,
    pub files: Vec<String>,
    /// Contenu sans données binaires.
    pub content: Value,
}

impl Found {
    fn add(list: &mut Vec<String>, value: Option<String>) {
        if let Some(value) = value {
            if !list.contains(&value) && list.len() < MAX_FILES {
                list.push(value);
            }
        }
    }

    fn image_path(value: &Value) -> Option<String> {
        value.as_str().and_then(local_path).filter(|path| is_image(path))
    }

    fn document_path(value: &Value) -> Option<String> {
        value.as_str().and_then(local_path).filter(|path| is_document(path))
    }

    fn strip(&mut self, value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|item| self.strip(item)).collect()),
            Value::Object(block) => {
                let kind = block.get("type").and_then(Value::as_str).unwrap_or_default();
                let mime = block.get("mimeType").or(block.get("mime")).and_then(Value::as_str).unwrap_or_default();
                match kind {
                    "image" => {
                        let image = block
                            .get("data")
                            .and_then(Value::as_str)
                            .and_then(|data| image_data_url(mime, data))
                            .or_else(|| block.get("uri").and_then(Self::image_path));
                        let found = image.is_some();
                        Self::add(&mut self.images, image);
                        if found {
                            return Value::from(IMAGE_PLACEHOLDER);
                        }
                        value.clone()
                    }
                    "resource_link" => {
                        let uri = block.get("uri").unwrap_or(&Value::Null);
                        Self::add(&mut self.images, Self::image_path(uri));
                        Self::add(&mut self.files, Self::document_path(uri));
                        value.clone()
                    }
                    "resource" => {
                        let resource = block.get("resource").unwrap_or(&Value::Null);
                        let inline = resource["blob"]
                            .as_str()
                            .zip(resource["mimeType"].as_str())
                            .and_then(|(blob, mime)| image_data_url(mime, blob));
                        if let Some(inline) = inline {
                            Self::add(&mut self.images, Some(inline));
                            return Value::from(IMAGE_PLACEHOLDER);
                        }
                        let image = Self::image_path(&resource["uri"]);
                        let file = Self::document_path(&resource["uri"]);
                        let (has_image, has_file) = (image.is_some(), file.is_some());
                        Self::add(&mut self.images, image);
                        Self::add(&mut self.files, file);
                        if has_image {
                            Value::from(IMAGE_PLACEHOLDER)
                        } else if has_file {
                            Value::from(FILE_PLACEHOLDER)
                        } else {
                            value.clone()
                        }
                    }
                    _ => match block.get("content") {
                        Some(inner @ (Value::Array(_) | Value::Object(_))) => {
                            let mut copy = block.clone();
                            copy.insert("content".into(), self.strip(inner));
                            Value::Object(copy)
                        }
                        _ => value.clone(),
                    },
                }
            }
            _ => value.clone(),
        }
    }
}

/// Images, documents et contenu sans binaire d’un contenu d’agent.
pub fn content_files(content: &Value) -> Found {
    let mut found = Found::default();
    found.content = found.strip(content);
    found
}

/// Texte lisible d’un contenu : les blocs texte joints, sinon le JSON indenté.
pub fn readable(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let texts: Vec<&str> = items.iter().filter_map(|item| item["text"].as_str()).collect();
            if !texts.is_empty() && texts.len() == items.len() {
                Some(texts.join("\n"))
            } else {
                serde_json::to_string_pretty(value).ok()
            }
        }
        _ => serde_json::to_string_pretty(value).ok(),
    }
}

/// JSON indenté d’une valeur, ou rien pour un objet vide.
pub fn pretty(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Object(map) if map.is_empty() => None,
        Value::String(text) => Some(text.clone()),
        _ => serde_json::to_string_pretty(value).ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn binary_content_becomes_a_placeholder() {
        let found = content_files(&json!([
            { "type": "text", "text": "Voici" },
            { "type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png" },
            { "type": "resource_link", "uri": "file:///tmp/rapport.pdf", "name": "rapport.pdf" },
            { "type": "resource", "resource": { "uri": "file:///tmp/capture.png" } },
        ]));
        assert_eq!(found.images, vec!["data:image/png;base64,iVBORw0KGgo=".to_string(), "/tmp/capture.png".into()]);
        assert_eq!(found.files, vec!["/tmp/rapport.pdf".to_string()]);
        assert_eq!(found.content[1], IMAGE_PLACEHOLDER);
        assert_eq!(found.content[3], IMAGE_PLACEHOLDER);
        assert_eq!(local_path("https://exemple.fr/a.png"), None);
        assert_eq!(local_path("C:\\Users\\a.pdf").as_deref(), Some("C:\\Users\\a.pdf"));
        assert!(image_data_url("image/png", "<script>").is_none());
    }
}
