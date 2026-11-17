//! Icône image d’une entrée du menu : le logo d’un service (Jira, Gmail…) à la place d’une icône Lucide. L’image est
//! un fichier du module (`modules/<module>/icons/<section>.svg`), versionné avec lui, que la coquille affiche par
//! une adresse `data:`, sans jamais charger d’image distante. L’agent la fait poser par `set_section_icon` : Alfred
//! la télécharge lui-même (HTTPS, 256 Ko au plus, avec un délai), vérifie son format réel, nettoie un SVG et réduit
//! une image trop grande, puis l’enregistre dans le module.

use std::borrow::Cow;
use std::io::Cursor;
use std::path::{Component, Path};
use std::time::Duration;

use base64::Engine;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer, XmlVersion};

use crate::error::{AppError, AppResult};

/// Taille maximale d’une icône, téléchargée ou lue dans le module.
pub const MAX_BYTES: usize = 256 * 1024;
/// Délai d’un téléchargement, de la connexion à la fin du contenu.
const TIMEOUT: Duration = Duration::from_secs(10);
/// Au-delà de ce côté, une image matricielle est réduite…
const MAX_SIDE: u32 = 256;
/// … à ce côté-ci : largement de quoi tenir à 16 px sur un écran très dense.
const REDUCED_SIDE: u32 = 128;
/// Dossier des icônes dans un module.
pub const ICONS_DIR: &str = "icons";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Svg,
    Png,
    Webp,
    Ico,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Svg => "svg",
            Format::Png => "png",
            Format::Webp => "webp",
            Format::Ico => "ico",
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Format::Svg => "image/svg+xml",
            Format::Png => "image/png",
            Format::Webp => "image/webp",
            Format::Ico => "image/x-icon",
        }
    }

    fn from_extension(extension: &str) -> Option<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "svg" => Some(Format::Svg),
            "png" => Some(Format::Png),
            "webp" => Some(Format::Webp),
            "ico" => Some(Format::Ico),
            _ => None,
        }
    }
}

/// Une icône de section désigne un fichier du module (`icons/jira.svg`) plutôt qu’un nom Lucide (`list-checks`),
/// qui n’a jamais de point.
pub fn is_image(icon: &str) -> bool {
    icon.contains('.') || icon.contains('/')
}

/// Format réel d’un contenu, d’après ses premiers octets (et, pour un SVG, son élément racine).
pub fn detect(bytes: &[u8]) -> Option<Format> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(Format::Png);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(Format::Webp);
    }
    if bytes.len() >= 6 && bytes[..4] == [0, 0, 1, 0] && bytes[4..6] != [0, 0] {
        return Some(Format::Ico);
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut reader = Reader::from_str(text.trim_start_matches('\u{feff}'));
    loop {
        match reader.read_event().ok()? {
            Event::Start(element) | Event::Empty(element) => {
                return (element.local_name().as_ref() == "svg").then_some(Format::Svg);
            }
            Event::Eof => return None,
            Event::Text(text) if !text.trim().is_empty() => return None,
            _ => {}
        }
    }
}

/// Ce que le contenu semble être, pour dire à l’agent pourquoi il est refusé.
fn describe(bytes: &[u8]) -> &'static str {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "une image JPEG"
    } else if bytes.starts_with(b"GIF8") {
        "une image GIF"
    } else if head.contains("<html") || head.contains("<!doctype html") {
        "une page HTML"
    } else if head.trim_start().starts_with('{') || head.trim_start().starts_with('[') {
        "du JSON"
    } else {
        "un contenu inconnu"
    }
}

/// Éléments retirés d’un SVG avec tout ce qu’ils contiennent : du script, du HTML embarqué, des médias, et les
/// animations, qui peuvent réécrire un lien après coup.
const DROPPED_ELEMENTS: [&str; 14] = [
    "script",
    "foreignobject",
    "iframe",
    "embed",
    "object",
    "audio",
    "video",
    "canvas",
    "set",
    "animate",
    "animatemotion",
    "animatetransform",
    "discard",
    "handler",
];

/// Une valeur CSS ou d’attribut ne vise que le document lui-même : chaque `url(…)` pointe vers `#…`, sans
/// `@import` ni `expression(`.
fn local_references_only(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("@import") || lower.contains("expression(") || lower.contains("javascript:") {
        return false;
    }
    let mut rest = lower.as_str();
    while let Some(at) = rest.find("url(") {
        rest = &rest[at + 4..];
        let target = rest.trim_start().trim_start_matches(['"', '\'']).trim_start();
        if !target.starts_with('#') {
            return false;
        }
    }
    true
}

/// Recopie l’élément sans ses attributs dangereux : gestionnaires `on…`, liens vers l’extérieur (seul `#…` reste),
/// `xml:base` et toute valeur qui charge une ressource externe.
fn clean_element(element: &BytesStart) -> AppResult<BytesStart<'static>> {
    let name = element.name().as_ref().to_string();
    let mut clean = BytesStart::new(name);
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| AppError::new("Le SVG est mal formé (attribut illisible)."))?;
        let key = attribute.key.as_ref().to_ascii_lowercase();
        let local = attribute.key.local_name().as_ref().to_ascii_lowercase();
        let Ok(value) = attribute.normalized_value(XmlVersion::Implicit1_0) else { continue };
        let keep = !local.starts_with("on")
            && key != "xml:base"
            && ((local != "href" && local != "src") || value.trim().starts_with('#'))
            && local_references_only(&value);
        if keep {
            clean.push_attribute(attribute);
        }
    }
    Ok(clean.into_owned())
}

/// SVG nettoyé : sans script, sans gestionnaire `on…`, sans `foreignObject`, sans référence externe, sans DTD ni
/// instruction de traitement. Un `<style>` qui importe ou charge une ressource externe disparaît en entier.
pub fn sanitize_svg(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let malformed = || AppError::new("Le SVG est mal formé : ce n’est pas un document XML lisible.");
    let text = std::str::from_utf8(bytes).map_err(|_| malformed())?.trim_start_matches('\u{feff}');
    let mut reader = Reader::from_str(text);
    let mut writer = Writer::new(Vec::new());
    // Profondeur dans un élément retiré : tant qu’elle est positive, rien n’est recopié.
    let mut skipping = 0usize;
    // Contenu d’un `<style>` en cours, gardé de côté jusqu’à sa fin pour être vérifié d’un bloc.
    let mut style: Option<Vec<Event<'static>>> = None;
    let mut root_seen = false;
    loop {
        let event = reader.read_event().map_err(|_| malformed())?;
        if skipping > 0 {
            match event {
                Event::Start(_) => skipping += 1,
                Event::End(_) => skipping -= 1,
                Event::Eof => return Err(malformed()),
                _ => {}
            }
            continue;
        }
        let output: Option<Event<'static>> = match event {
            Event::Eof => break,
            Event::Start(ref element) | Event::Empty(ref element)
                if !root_seen && element.local_name().as_ref() != "svg" =>
            {
                return Err(AppError::new("Le document n’a pas d’élément racine <svg>."));
            }
            Event::Start(element) => {
                root_seen = true;
                let local = element.local_name().as_ref().to_ascii_lowercase();
                if DROPPED_ELEMENTS.contains(&local.as_str()) {
                    skipping = 1;
                    None
                } else if local == "style" {
                    style = Some(vec![Event::Start(clean_element(&element)?)]);
                    continue;
                } else {
                    Some(Event::Start(clean_element(&element)?))
                }
            }
            Event::Empty(element) => {
                root_seen = true;
                let local = element.local_name().as_ref().to_ascii_lowercase();
                if DROPPED_ELEMENTS.contains(&local.as_str()) {
                    None
                } else {
                    Some(Event::Empty(clean_element(&element)?))
                }
            }
            Event::End(end) => {
                if let Some(mut pending) = style.take() {
                    pending.push(Event::End(end.into_owned()));
                    let css: String = pending
                        .iter()
                        .filter_map(|event| match event {
                            Event::Text(text) => Some(text.to_string()),
                            Event::CData(data) => Some(data.to_string()),
                            Event::GeneralRef(reference) => Some(format!("&{};", &**reference)),
                            _ => None,
                        })
                        .collect();
                    if local_references_only(&css) && !css.contains('&') {
                        for event in pending {
                            writer.write_event(event).map_err(|_| malformed())?;
                        }
                    }
                    continue;
                }
                Some(Event::End(end.into_owned()))
            }
            Event::Text(text) => Some(Event::Text(text.into_owned())),
            Event::CData(data) => Some(Event::CData(data.into_owned())),
            // Seules les entités prédéfinies et les caractères numériques restent : sans DTD, les autres n’existent pas.
            Event::GeneralRef(reference) => {
                let known = reference.is_char_ref()
                    || matches!(&*reference, "amp" | "lt" | "gt" | "quot" | "apos");
                known.then(|| Event::GeneralRef(reference.into_owned()))
            }
            Event::Decl(declaration) => Some(Event::Decl(declaration.into_owned())),
            Event::Comment(_) | Event::PI(_) | Event::DocType(_) => None,
        };
        if let Some(event) = output {
            match style.as_mut() {
                Some(pending) => pending.push(event),
                None => writer.write_event(event).map_err(|_| malformed())?,
            }
        }
    }
    if !root_seen || style.is_some() {
        return Err(malformed());
    }
    Ok(writer.into_inner())
}

/// Image matricielle décodée (le format est vérifié en la lisant), réduite si elle est très grande. Une icône ICO
/// devient un PNG : son plus grand dessin, que toutes les vues affichent.
fn prepare_raster(bytes: &[u8], format: Format) -> AppResult<(Vec<u8>, Format)> {
    let image_format = match format {
        Format::Png => image::ImageFormat::Png,
        Format::Webp => image::ImageFormat::WebP,
        Format::Ico => image::ImageFormat::Ico,
        Format::Svg => unreachable!("un SVG n’est pas une image matricielle"),
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image_format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|error| {
        AppError::new(format!("L’image {} est illisible : {error}.", format.extension().to_uppercase()))
    })?;
    if decoded.width().max(decoded.height()) <= MAX_SIDE && format != Format::Ico {
        return Ok((bytes.to_vec(), format));
    }
    let reduced = if decoded.width().max(decoded.height()) > REDUCED_SIDE {
        decoded.resize(REDUCED_SIDE, REDUCED_SIDE, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    let mut out = Cursor::new(Vec::new());
    reduced
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|error| AppError::new(format!("L’image n’a pas pu être réduite : {error}.")))?;
    Ok((out.into_inner(), Format::Png))
}

/// Contenu prêt à ranger dans le module : format vérifié, SVG nettoyé, image matricielle réduite au besoin.
pub fn prepare(bytes: &[u8]) -> AppResult<(Vec<u8>, Format)> {
    if bytes.is_empty() {
        return Err(AppError::new("Le contenu reçu est vide."));
    }
    if bytes.len() > MAX_BYTES {
        return Err(AppError::new(format!("L’image dépasse {} Ko.", MAX_BYTES / 1024)));
    }
    let Some(format) = detect(bytes) else {
        return Err(AppError::new(format!(
            "Le contenu reçu est {}, pas une image SVG, PNG, WebP ou ICO. Donner l’adresse du fichier image lui-même.",
            describe(bytes)
        )));
    };
    match format {
        Format::Svg => Ok((sanitize_svg(bytes)?, Format::Svg)),
        raster => prepare_raster(bytes, raster),
    }
}

/// Télécharge une icône : HTTPS seulement (les redirections aussi), `MAX_BYTES` au plus, dans le délai. `https_only`
/// n’est faux que pour les tests, servis par un serveur local en HTTP.
pub async fn download(address: &str, https_only: bool) -> AppResult<Vec<u8>> {
    let parsed = url::Url::parse(address.trim())
        .map_err(|_| AppError::new(format!("Adresse invalide : « {address} ».")))?;
    if parsed.scheme() != "https" && (https_only || parsed.scheme() != "http") {
        return Err(AppError::new("Seules les adresses https:// sont acceptées pour une icône."));
    }
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("trop de redirections")
        } else if https_only && attempt.url().scheme() != "https" {
            attempt.error("redirection vers une adresse qui n’est pas en https://")
        } else {
            attempt.follow()
        }
    });
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(TIMEOUT)
        .redirect(policy)
        .user_agent(concat!("Alfred/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| AppError::new(format!("Téléchargement impossible : {error}.")))?;
    let mut response = client
        .get(parsed)
        .header(reqwest::header::ACCEPT, "image/svg+xml,image/png,image/webp,image/x-icon;q=0.9,*/*;q=0.5")
        .send()
        .await
        .map_err(|error| {
            AppError::new(if error.is_timeout() {
                format!("Le téléchargement a dépassé {} secondes.", TIMEOUT.as_secs())
            } else {
                format!("Téléchargement impossible : {error}.")
            })
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(format!("Le serveur a répondu {} pour cette adresse.", response.status())));
    }
    let too_big = || AppError::new(format!("L’image dépasse {} Ko.", MAX_BYTES / 1024));
    if response.content_length().is_some_and(|length| length > MAX_BYTES as u64) {
        return Err(too_big());
    }
    let mut body = Vec::new();
    loop {
        let chunk = response.chunk().await.map_err(|error| {
            AppError::new(if error.is_timeout() {
                format!("Le téléchargement a dépassé {} secondes.", TIMEOUT.as_secs())
            } else {
                format!("Téléchargement interrompu : {error}.")
            })
        })?;
        let Some(chunk) = chunk else { break };
        if body.len() + chunk.len() > MAX_BYTES {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Chemin d’icône acceptable dans un module : relatif, sans `..`, d’une extension d’image connue.
fn checked_relative(icon: &str) -> Result<(&Path, Format), String> {
    let path = Path::new(icon);
    let inside = path.components().all(|component| matches!(component, Component::Normal(_)));
    if !inside || icon.contains('\\') {
        return Err(format!("l’icône « {icon} » doit être un chemin relatif au dossier du module, sans « .. »"));
    }
    let format = path
        .extension()
        .and_then(|extension| extension.to_str())
        .and_then(Format::from_extension)
        .ok_or_else(|| format!("l’icône « {icon} » n’est ni un SVG, ni un PNG, ni un WebP, ni un ICO"))?;
    Ok((path, format))
}

/// Adresse `data:` d’une icône image du module, ou ce qui l’en empêche (fichier absent, trop gros, d’un autre
/// format que son extension, SVG mal formé). Le SVG est nettoyé à nouveau : un fichier écrit à la main passe par
/// les mêmes règles que celui qu’Alfred a téléchargé.
pub fn data_url(module_dir: &Path, icon: &str) -> Result<String, String> {
    let (relative, declared) = checked_relative(icon)?;
    let path = module_dir.join(relative);
    let metadata = std::fs::metadata(&path).map_err(|_| format!("le fichier d’icône « {icon} » est introuvable"))?;
    if metadata.len() > MAX_BYTES as u64 {
        return Err(format!("le fichier d’icône « {icon} » dépasse {} Ko", MAX_BYTES / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|_| format!("le fichier d’icône « {icon} » est illisible"))?;
    let actual = detect(&bytes);
    if actual != Some(declared) {
        return Err(format!("le fichier d’icône « {icon} » n’est pas un {} valide", declared.extension().to_uppercase()));
    }
    let content: Cow<[u8]> = match declared {
        Format::Svg => Cow::Owned(sanitize_svg(&bytes).map_err(|error| format!("« {icon} » : {}", error.message))?),
        _ => Cow::Borrowed(&bytes),
    };
    Ok(format!("data:{};base64,{}", declared.mime(), base64::engine::general_purpose::STANDARD.encode(content)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const JIRA: &str = r##"<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#0052CC"><title>Jira</title><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005z"/></svg>"##;

    fn tiny_png(side: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(side, side, image::Rgba([0, 82, 204, 255]));
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn tells_an_image_path_from_a_lucide_name() {
        assert!(is_image("icons/jira.svg"));
        assert!(!is_image("list-checks"));
    }

    #[test]
    fn detects_the_real_format_of_the_content() {
        assert_eq!(detect(JIRA.as_bytes()), Some(Format::Svg));
        assert_eq!(detect(format!("<?xml version=\"1.0\"?>\n<!-- logo -->\n{JIRA}").as_bytes()), Some(Format::Svg));
        assert_eq!(detect(&tiny_png(4)), Some(Format::Png));
        assert_eq!(detect(b"RIFF\0\0\0\0WEBPVP8 "), Some(Format::Webp));
        assert_eq!(detect(&[0, 0, 1, 0, 1, 0]), Some(Format::Ico));
        assert_eq!(detect(b"<!doctype html><html><body>404</body></html>"), None);
        assert_eq!(detect(&[0xff, 0xd8, 0xff, 0xe0]), None);
        assert_eq!(detect(b"<html><svg/></html>"), None);
    }

    #[test]
    fn sanitizing_a_svg_removes_scripts_handlers_foreign_objects_and_external_references() {
        let dirty = r##"<?xml version="1.0"?>
<!DOCTYPE svg [<!ENTITY boom "boom">]>
<?xml-stylesheet href="https://evil.example/x.css"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" onload="alert(1)">
  <script>alert(2)</script>
  <svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(3)</svg:script>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"/></div></foreignObject>
  <style>@import url(https://evil.example/a.css); .a { fill: red }</style>
  <style>.b { fill: #0052CC }</style>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
  <image href="https://evil.example/track.png" width="1" height="1"/>
  <use xlink:href="#g"/>
  <a href="javascript:alert(4)"><path d="M0 0h1v1z" fill="url(#g)" ONCLICK="alert(5)"/></a>
  <rect style="fill: url(https://evil.example/p.svg)" width="2" height="2"/>
  <set attributeName="href" to="javascript:alert(6)"/>
  <text>&boom; &amp; &#65;</text>
</svg>"##;
        let clean = String::from_utf8(sanitize_svg(dirty.as_bytes()).unwrap()).unwrap();
        for forbidden in
            ["alert", "script", "foreignObject", "iframe", "evil.example", "javascript:", "DOCTYPE", "boom", "<set"]
        {
            assert!(!clean.to_lowercase().contains(&forbidden.to_lowercase()), "« {forbidden} » reste dans :\n{clean}");
        }
        for kept in [".b { fill: #0052CC }", "xlink:href=\"#g\"", "fill=\"url(#g)\"", "&amp; &#65;", "viewBox"] {
            assert!(clean.contains(kept), "« {kept} » a disparu de :\n{clean}");
        }
        assert_eq!(detect(clean.as_bytes()), Some(Format::Svg), "le résultat reste un SVG lisible");
    }

    #[test]
    fn a_document_that_is_not_a_svg_is_refused() {
        assert!(sanitize_svg(b"<html><body/></html>").is_err());
        assert!(sanitize_svg(b"<svg><g></svg>").is_err(), "un SVG mal formé est refusé");
        assert!(prepare(b"<!doctype html><html></html>").unwrap_err().message.contains("une page HTML"));
        assert!(prepare(&[0xff, 0xd8, 0xff, 0xe0, 0, 0]).unwrap_err().message.contains("JPEG"));
        assert!(prepare(&vec![b' '; MAX_BYTES + 1]).unwrap_err().message.contains("256 Ko"));
    }

    #[test]
    fn a_large_raster_is_reduced_and_a_small_one_kept() {
        let small = tiny_png(64);
        assert_eq!(prepare(&small).unwrap(), (small.clone(), Format::Png), "une petite image est gardée telle quelle");
        let (reduced, format) = prepare(&tiny_png(1024)).unwrap();
        assert_eq!(format, Format::Png);
        let decoded = image::load_from_memory(&reduced).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (REDUCED_SIDE, REDUCED_SIDE));
        let broken = [&small[..20], &[0u8; 30]].concat();
        assert!(prepare(&broken).unwrap_err().message.contains("illisible"), "un PNG tronqué est refusé");
    }

    #[test]
    fn the_data_url_of_a_module_icon_checks_its_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("icons")).unwrap();
        std::fs::write(dir.path().join("icons/jira.svg"), JIRA).unwrap();
        std::fs::write(dir.path().join("icons/faux.png"), JIRA).unwrap();
        let url = data_url(dir.path(), "icons/jira.svg").unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"));
        assert!(data_url(dir.path(), "icons/absent.svg").unwrap_err().contains("introuvable"));
        assert!(data_url(dir.path(), "icons/faux.png").unwrap_err().contains("pas un PNG"));
        assert!(data_url(dir.path(), "../jira.svg").unwrap_err().contains(".."));
        assert!(data_url(dir.path(), "icons/jira.gif").is_err());
    }
}
