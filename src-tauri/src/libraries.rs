//! Librairies d’un module : des paquets npm qu’une page ou une fonction importe par leur nom
//! (`import { useEditor } from "@tiptap/react"`).
//!
//! L’agent les installe par l’outil `set_libraries`. Alfred demande à esm.sh la version ES de chaque paquet et de ses
//! dépendances, et copie chaque fichier dans `modules/<module>/vendor/`. Les imports de chaque fichier y sont
//! réécrits vers ses voisins, et `vendor/libraries.json` garde les versions et l’empreinte de chaque fichier.
//!
//! Le cadre n’a toujours aucun réseau : il charge ces fichiers comme le reste du module, par la clé du module. React
//! et React DOM ne sont jamais copiés : une librairie se sert de ceux d’Alfred (une seconde copie de React casserait
//! les hooks). Une page importe une librairie par son nom ; la transpilation remplace ce nom par le chemin du
//! fichier d’entrée dans `vendor/`.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::Path;

use oxc::allocator::Allocator;
use oxc::parser::Parser;
use oxc::span::SourceType;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// Dossier des librairies, à la racine du module.
pub const DIR: &str = "vendor";
const LOCK: &str = "libraries.json";
const SOURCE: &str = "https://esm.sh";
const REGISTRY: &str = "https://registry.npmjs.org";
/// Bornes d’une installation : au-delà, la librairie est trop lourde pour une page.
const MAX_FILES: usize = 800;
const MAX_BYTES: usize = 12 * 1024 * 1024;

/// Imports nus qu’un fichier de librairie garde tels quels : la carte d’imports du cadre les résout vers Alfred.
const HOST_IMPORTS: [&str; 4] = ["react", "react-dom", "react/jsx-runtime", "react-dom/client"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Lock {
    pub source: String,
    /// Nom importé (« @tiptap/react », « @tiptap/pm/state ») → version et fichier d’entrée.
    pub libraries: BTreeMap<String, Library>,
    /// Fichier de `vendor/` → empreinte SHA-256.
    pub files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    pub version: String,
    pub entry: String,
}

/// Librairies installées dans un module ; aucune si le fichier manque ou se lit mal.
pub fn lock(module_dir: &Path) -> Lock {
    std::fs::read_to_string(module_dir.join(DIR).join(LOCK))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Nom importé → fichier d’entrée dans `vendor/`, ce que la transpilation d’un fichier du module réécrit.
pub fn entries(module_dir: &Path) -> BTreeMap<String, String> {
    lock(module_dir).libraries.into_iter().map(|(name, library)| (name, library.entry)).collect()
}

/// Vrai si `name` est un fichier de librairie que le cadre peut charger.
pub fn is_vendor_file(name: &str) -> bool {
    name.ends_with(".mjs")
        && !name.contains('/')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Fichiers de `vendor/` dont le contenu ne correspond plus à `libraries.json` (ou absents).
pub fn altered_files(module_dir: &Path) -> Vec<String> {
    let lock = lock(module_dir);
    lock.files
        .iter()
        .filter(|(file, digest)| {
            std::fs::read(module_dir.join(DIR).join(file)).map_or(true, |bytes| &sha256(&bytes) != *digest)
        })
        .map(|(file, _)| file.clone())
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_package(name: &str) -> bool {
    let valid_part = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    };
    match name.strip_prefix('@') {
        Some(scoped) => scoped.split_once('/').is_some_and(|(scope, rest)| valid_part(scope) && valid_part(rest)),
        None => valid_part(name),
    }
}

/// « @scope/paquet/sous/chemin » → (« @scope/paquet », « /sous/chemin »).
pub fn split_name(name: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = name.split('/').collect();
    let count = if name.starts_with('@') { 2 } else { 1 };
    if parts.len() < count {
        return None;
    }
    let package = parts[..count].join("/");
    let rest: Vec<&str> = parts[count..].to_vec();
    let valid_rest = rest.iter().all(|part| {
        !part.is_empty() && *part != ".." && *part != "." && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    });
    if !valid_package(&package) || !valid_rest {
        return None;
    }
    let sub = if rest.is_empty() { String::new() } else { format!("/{}", rest.join("/")) };
    Some((package, sub))
}

fn valid_version(version: &str) -> bool {
    !version.is_empty() && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

/// Paquet et version (ou plage) d’une adresse d’esm.sh : « /@tiptap/pm@2.11.5/es2022/state.mjs » →
/// (« @tiptap/pm », « 2.11.5 », « /es2022/state.mjs »).
fn package_of(path: &str) -> Option<(String, String, String)> {
    let path = path.split('?').next().unwrap_or(path).trim_start_matches('/');
    let mut parts = path.splitn(if path.starts_with('@') { 3 } else { 2 }, '/');
    let (head, tail) = if path.starts_with('@') {
        let scope = parts.next()?;
        let name = parts.next()?;
        (format!("{scope}/{name}"), parts.next().unwrap_or(""))
    } else {
        (parts.next()?.to_string(), parts.next().unwrap_or(""))
    };
    let at = head.rfind('@').filter(|at| *at > 0)?;
    let package = head[..at].to_string();
    let version = head[at + 1..].to_string();
    Some((package, version, if tail.is_empty() { String::new() } else { format!("/{tail}") }))
}

/// Import de React ou de React DOM vu par esm.sh, ramené au nom que la carte d’imports d’Alfred connaît.
fn host_import(path: &str) -> Option<Result<&'static str, String>> {
    let (package, _, rest) = package_of(path)?;
    if package != "react" && package != "react-dom" {
        return None;
    }
    // Forme courte (« /react@^19/jsx-runtime ») ou fichier (« /react@19.2.0/es2022/jsx-runtime.mjs »).
    let leaf = rest.rsplit('/').next().unwrap_or("").trim_end_matches(".mjs").trim_end_matches(".development");
    let name = match (package.as_str(), leaf) {
        ("react", "" | "react") => "react",
        ("react", "jsx-runtime") => "react/jsx-runtime",
        ("react-dom", "" | "react-dom") => "react-dom",
        ("react-dom", "client") => "react-dom/client",
        _ => {
            return Some(Err(format!(
                "La librairie importe « {package}{rest} », qu’Alfred ne fournit pas : seuls {} sont disponibles.",
                HOST_IMPORTS.join(", ")
            )))
        }
    };
    Some(Ok(name))
}

/// Imports d’un fichier ES : leur texte et la place de la chaîne (guillemets compris) dans la source.
fn imports(source: &str) -> Result<Vec<(String, u32, u32)>, String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if parsed.fatal_error {
        return Err(parsed.diagnostics.first().map(|error| error.message.to_string()).unwrap_or_default());
    }
    let record = &parsed.module_record;
    let mut found = Vec::new();
    for (specifier, requests) in &record.requested_modules {
        for request in requests {
            found.push((specifier.to_string(), request.span.start, request.span.end));
        }
    }
    for dynamic in &record.dynamic_imports {
        let text = &source[dynamic.module_request.start as usize..dynamic.module_request.end as usize];
        let quoted = text.len() >= 2
            && matches!(text.as_bytes()[0], b'"' | b'\'')
            && text.as_bytes()[0] == text.as_bytes()[text.len() - 1];
        if quoted {
            found.push((text[1..text.len() - 1].to_string(), dynamic.module_request.start, dynamic.module_request.end));
        }
    }
    found.sort_by_key(|(_, start, _)| *start);
    found.dedup_by_key(|(_, start, _)| *start);
    Ok(found)
}

/// Remplace des chaînes d’import (guillemets compris) par d’autres noms.
fn rewrite(source: &str, replacements: &[(u32, u32, String)]) -> String {
    let mut sorted = replacements.to_vec();
    sorted.sort_by_key(|(start, _, _)| *start);
    let mut out = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for (start, end, value) in sorted {
        out.push_str(&source[cursor..start as usize]);
        out.push_str(&serde_json::to_string(&value).unwrap_or_default());
        cursor = end as usize;
    }
    out.push_str(&source[cursor..]);
    out
}

/// Pour la transpilation d’un fichier du module à `depth` dossiers de sa racine : remplace chaque librairie importée
/// par son nom par le chemin de son fichier d’entrée. Source inchangée s’il n’y a rien à remplacer.
pub fn link(source: &str, source_type: SourceType, depth: usize, libraries: &BTreeMap<String, String>) -> Option<String> {
    if libraries.is_empty() {
        return None;
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    let up = if depth == 0 || depth == usize::MAX { "./".to_string() } else { "../".repeat(depth) };
    let replacements: Vec<(u32, u32, String)> = parsed
        .module_record
        .requested_modules
        .iter()
        .filter_map(|(specifier, requests)| libraries.get(specifier.as_str()).map(|entry| (requests, entry)))
        .flat_map(|(requests, entry)| {
            let target = format!("{up}{DIR}/{entry}");
            requests.iter().map(move |request| (request.span.start, request.span.end, target.clone()))
        })
        .collect();
    (!replacements.is_empty()).then(|| rewrite(source, &replacements))
}

/// Nom de fichier local d’une adresse d’esm.sh : stable, sans dossier, terminé par `.mjs`.
fn local_name(path: &str) -> String {
    let digest = sha256(path.as_bytes());
    let leaf = path.split('?').next().unwrap_or(path).rsplit('/').next().unwrap_or("index");
    let leaf: String = leaf
        .trim_end_matches(".mjs")
        .trim_end_matches(".js")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .take(40)
        .collect();
    format!("{}-{}.mjs", &digest[..10], if leaf.is_empty() { "index" } else { &leaf })
}

/// Résout un import relatif d’un fichier d’esm.sh contre l’adresse de ce fichier.
fn resolve(from: &str, specifier: &str) -> String {
    let base = from.split('?').next().unwrap_or(from);
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for part in specifier.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if joined.starts_with('/') { joined } else { format!("/{joined}") }
}

/// Une librairie voulue : nom importé, version (la dernière si absente).
#[derive(Debug, Clone, Deserialize)]
pub struct Wanted {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub libraries: BTreeMap<String, Library>,
    pub files: usize,
    pub bytes: usize,
    pub warnings: Vec<String>,
}

async fn get(client: &reqwest::Client, url: &str) -> AppResult<String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::new(format!("Téléchargement impossible ({url}) : {error}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail: String = body.chars().take(300).collect();
        return Err(AppError::new(format!("{url} a répondu {status} : {}", detail.trim())));
    }
    response.text().await.map_err(|error| AppError::new(format!("Lecture impossible ({url}) : {error}")))
}

async fn latest(client: &reqwest::Client, package: &str) -> AppResult<String> {
    let text = get(client, &format!("{REGISTRY}/{package}/latest")).await.map_err(|error| {
        AppError::new(format!("Paquet « {package} » introuvable sur npm. {}", error.message))
    })?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| AppError::new(format!("Réponse illisible de npm pour « {package} ».")))?;
    value["version"]
        .as_str()
        .filter(|version| valid_version(version))
        .map(str::to_string)
        .ok_or_else(|| AppError::new(format!("npm ne donne pas de version pour « {package} ».")))
}

/// Remplace les librairies d’un module par `wanted` : télécharge tout, puis remplace `vendor/` d’un coup. Une version
/// absente reprend celle déjà installée, sinon la dernière publiée. Une liste vide retire `vendor/`.
pub async fn install(client: &reqwest::Client, module_dir: &Path, wanted: &[Wanted]) -> AppResult<Report> {
    let vendor = module_dir.join(DIR);
    if wanted.is_empty() {
        if vendor.exists() {
            std::fs::remove_dir_all(&vendor)?;
        }
        return Ok(Report { libraries: BTreeMap::new(), files: 0, bytes: 0, warnings: Vec::new() });
    }
    let installed = lock(module_dir);

    // Une version par paquet, quelle que soit la sous-partie importée.
    let mut versions: BTreeMap<String, String> = BTreeMap::new();
    let mut requested: Vec<(String, String, String)> = Vec::new();
    for item in wanted {
        let name = item.name.trim();
        let (package, sub) = split_name(name)
            .ok_or_else(|| AppError::new(format!("« {name} » n’est pas un nom de paquet npm valide.")))?;
        if package == "react" || package == "react-dom" || name.starts_with("@alfred/") || package == "lucide-react" {
            return Err(AppError::new(format!("« {name} » est déjà fourni par Alfred : l’importer directement.")));
        }
        let version = match item.version.as_deref().map(str::trim).filter(|version| !version.is_empty()) {
            Some(version) if valid_version(version) => Some(version.to_string()),
            Some(version) => {
                return Err(AppError::new(format!("Version « {version} » invalide pour « {name} » : donner une version exacte (2.11.5).")))
            }
            None => installed
                .libraries
                .iter()
                .find(|(other, _)| split_name(other).is_some_and(|(other, _)| other == package))
                .map(|(_, library)| library.version.clone()),
        };
        if let Some(version) = version {
            if let Some(previous) = versions.get(&package).filter(|previous| **previous != version) {
                return Err(AppError::new(format!("« {package} » est demandé en {previous} et en {version} : une seule version par paquet.")));
            }
            versions.insert(package.clone(), version);
        }
        requested.push((name.to_string(), package, sub));
    }
    for (_, package, _) in &requested {
        if !versions.contains_key(package) {
            let version = latest(client, package).await?;
            versions.insert(package.clone(), version);
        }
    }

    // Parcours de toutes les dépendances, chacune une fois.
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut entry_paths: Vec<(String, String)> = Vec::new();
    for (name, package, sub) in &requested {
        let path = format!("/{package}@{}{sub}?target=es2022", versions[package]);
        entry_paths.push((name.clone(), path.clone()));
        queue.push_back(path);
    }
    let mut files: HashMap<String, (String, String)> = HashMap::new();
    let mut bytes = 0usize;
    while let Some(path) = queue.pop_front() {
        if files.contains_key(&path) {
            continue;
        }
        if files.len() >= MAX_FILES {
            return Err(AppError::new(format!("Plus de {MAX_FILES} fichiers : la librairie est trop lourde pour une page.")));
        }
        let source = get(client, &format!("{SOURCE}{path}")).await?;
        bytes += source.len();
        if bytes > MAX_BYTES {
            return Err(AppError::new(format!(
                "Plus de {} Mo : la librairie est trop lourde pour une page.",
                MAX_BYTES / 1024 / 1024
            )));
        }
        let found = imports(&source).map_err(|error| AppError::new(format!("{path} ne se lit pas : {error}")))?;
        let mut replacements = Vec::new();
        for (specifier, start, end) in found {
            let target = if let Some(rest) = specifier.strip_prefix(SOURCE) {
                rest.to_string()
            } else if specifier.starts_with('/') {
                specifier.clone()
            } else if specifier.starts_with("./") || specifier.starts_with("../") {
                resolve(&path, &specifier)
            } else if HOST_IMPORTS.contains(&specifier.as_str()) {
                continue;
            } else {
                return Err(AppError::new(format!(
                    "{path} importe « {specifier} », qu’Alfred ne sait pas fournir à une page."
                )));
            };
            match host_import(&target) {
                Some(Ok(name)) => replacements.push((start, end, name.to_string())),
                Some(Err(message)) => return Err(AppError::new(message)),
                None => {
                    replacements.push((start, end, format!("./{}", local_name(&target))));
                    if !files.contains_key(&target) {
                        queue.push_back(target);
                    }
                }
            }
        }
        files.insert(path.clone(), (local_name(&path), rewrite(&source, &replacements)));
    }

    // Deux versions d’un même paquet : deux copies de son état (ProseMirror, par exemple) qui ne se reconnaissent pas.
    let mut seen: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in files.keys().filter(|path| path.contains("/es20")) {
        if let Some((package, version, _)) = package_of(path) {
            seen.entry(package).or_default().insert(version);
        }
    }
    let mut warnings = Vec::new();
    for (package, found) in seen.iter().filter(|(_, found)| found.len() > 1) {
        let list = found.iter().cloned().collect::<Vec<_>>().join(", ");
        if versions.contains_key(package) {
            return Err(AppError::new(format!(
                "« {package} » arrive en plusieurs versions ({list}) : demander la même version que celle qu’attendent les autres librairies, souvent la plus récente."
            )));
        }
        warnings.push(format!("« {package} » est présent en plusieurs versions ({list})."));
    }

    // Écriture à côté, puis échange : une installation ratée laisse l’ancienne en place.
    let staging = module_dir.join(".vendor-new");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    let written = (|| -> AppResult<Lock> {
        std::fs::create_dir_all(&staging)?;
        let mut lock = Lock { source: SOURCE.to_string(), ..Lock::default() };
        for (name, content) in files.values() {
            std::fs::write(staging.join(name), content)?;
            lock.files.insert(name.clone(), sha256(content.as_bytes()));
        }
        for ((name, path), (_, package, _)) in entry_paths.iter().zip(&requested) {
            lock.libraries.insert(name.clone(), Library { version: versions[package].clone(), entry: local_name(path) });
        }
        std::fs::write(staging.join(LOCK), serde_json::to_string_pretty(&lock).unwrap_or_default())?;
        if vendor.exists() {
            std::fs::remove_dir_all(&vendor)?;
        }
        std::fs::rename(&staging, &vendor)?;
        Ok(lock)
    })();
    let lock = written.inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;
    Ok(Report { libraries: lock.libraries, files: files.len(), bytes, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_package_names_and_esm_addresses() {
        assert_eq!(split_name("@tiptap/pm/state"), Some(("@tiptap/pm".into(), "/state".into())));
        assert_eq!(split_name("lodash-es"), Some(("lodash-es".into(), String::new())));
        assert_eq!(split_name("../x"), None);
        assert_eq!(split_name("@a/../b"), None);
        assert_eq!(split_name("Bad Name"), None);
        assert_eq!(
            package_of("/@tiptap/pm@2.11.5/es2022/state.mjs"),
            Some(("@tiptap/pm".into(), "2.11.5".into(), "/es2022/state.mjs".into()))
        );
        assert_eq!(package_of("/fast-equals@^5.3.3?target=es2022"), Some(("fast-equals".into(), "^5.3.3".into(), String::new())));
        assert_eq!(resolve("/a@1/es2022/x/y.mjs", "../z.mjs"), "/a@1/es2022/z.mjs");
    }

    #[test]
    fn react_stays_the_one_alfred_provides() {
        assert_eq!(host_import("/react@^17.0.0%20||%20^19.0.0?target=es2022"), Some(Ok("react")));
        assert_eq!(host_import("/react@^19/jsx-runtime?target=es2022"), Some(Ok("react/jsx-runtime")));
        assert_eq!(host_import("/react-dom@19.2.0/es2022/client.mjs"), Some(Ok("react-dom/client")));
        assert!(matches!(host_import("/react-dom@19/server?target=es2022"), Some(Err(_))));
        assert_eq!(host_import("/react-redux@9/es2022/x.mjs"), None);
    }

    #[test]
    fn rewrites_every_import_form() {
        let source = r#"import a from"/x@1/a.mjs";export*from"/y@2/b.mjs";const c=import("/z@3/c.mjs");import"react";"#;
        let found = imports(source).unwrap();
        let names: Vec<&str> = found.iter().map(|(name, _, _)| name.as_str()).collect();
        assert_eq!(names, ["/x@1/a.mjs", "/y@2/b.mjs", "/z@3/c.mjs", "react"]);
        let replaced: Vec<(u32, u32, String)> =
            found.iter().take(3).map(|(name, start, end)| (*start, *end, format!("./{}", local_name(name)))).collect();
        let out = rewrite(source, &replaced);
        assert!(!out.contains("/x@1/") && out.contains(&local_name("/z@3/c.mjs")) && out.contains(r#"import"react""#));
    }

    #[test]
    fn a_page_imports_a_library_by_its_name() {
        let libraries = BTreeMap::from([("@tiptap/react".to_string(), "abc-react.mjs".to_string())]);
        let source = "import { useEditor } from \"@tiptap/react\";\nimport { Button } from \"@alfred/ui\";\n";
        let linked = link(source, SourceType::tsx(), 1, &libraries).unwrap();
        assert!(linked.contains("\"../vendor/abc-react.mjs\"") && linked.contains("\"@alfred/ui\""));
        assert!(link("import x from \"react\";", SourceType::tsx(), 1, &libraries).is_none());
        assert!(is_vendor_file("abc-react.mjs") && !is_vendor_file("../x.mjs") && !is_vendor_file("libraries.json"));
    }

    /// Installation réelle depuis esm.sh (réseau) : `cargo test --lib libraries -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn installs_a_rich_text_editor() {
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();
        let wanted: Vec<Wanted> = ["@tiptap/react", "@tiptap/starter-kit", "@tiptap/extension-table"]
            .iter()
            .map(|name| Wanted { name: name.to_string(), version: None })
            .collect();
        let report = install(&client, dir.path(), &wanted).await.unwrap();
        println!("{report:#?}");
        assert!(report.files > 5);
        assert!(altered_files(dir.path()).is_empty());
        for entry in std::fs::read_dir(dir.path().join(DIR)).unwrap().flatten() {
            let text = std::fs::read_to_string(entry.path()).unwrap();
            if entry.file_name() == LOCK {
                continue;
            }
            for (specifier, _, _) in imports(&text).unwrap() {
                assert!(specifier.starts_with("./") || HOST_IMPORTS.contains(&specifier.as_str()), "{specifier}");
            }
        }
    }
}

