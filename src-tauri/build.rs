fn main() {
    socle_ui::generate();
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows_msvc {
        tauri_build::build();
        return;
    }
    // Tauri n’embarque son manifeste (Common Controls v6) que dans l’exécutable : un binaire de test qui lie Tauri
    // ne démarrerait pas (STATUS_ENTRYPOINT_NOT_FOUND). Le même manifeste est donc passé à l’éditeur de liens pour
    // toutes les cibles, application et tests compris.
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build");
}

/// Ce qu’Alfred sait de la version installée de socle-ui, lu dans `node_modules/socle-ui` au moment du build : sa
/// version, ses exports (contrôle `check` : nom inconnu), ses anciens noms (`AI.md`, « Anciens noms ») et sa doc pour
/// l’IA (`ai/` : textes, et captures des recettes de pages), recopiée dans chaque espace (`docs/alfred/socle/`). Sans
/// `node_modules`, les listes sont vides et les contrôles qui en dépendent se taisent.
mod socle_ui {
    use std::fmt::Write as _;
    use std::fs;
    use std::path::{Path, PathBuf};

    pub fn generate() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/socle-ui");
        let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("socle_ui.rs");
        let ai = root.join("ai");
        let dist = root.join("dist");
        for watched in [ai.clone(), dist.join("index.d.ts"), dist.join("entries"), root.join("package.json")] {
            println!("cargo:rerun-if-changed={}", watched.display());
        }

        let version = fs::read_to_string(root.join("package.json"))
            .ok()
            .and_then(|text| {
                let start = text.find("\"version\"")?;
                let rest = &text[start + 9..];
                let open = rest.find('"')? + 1;
                let close = rest[open..].find('"')? + open;
                Some(rest[open..close].to_string())
            })
            .unwrap_or_default();
        if version.is_empty() {
            println!("cargo:warning=socle-ui introuvable dans node_modules : `check` ne contrôle ni les anciens noms ni les exports.");
        }

        let exports = |file: &Path| fs::read_to_string(file).map(|text| exported_names(&text)).unwrap_or_default();
        let main = exports(&dist.join("index.d.ts"));
        let markdown = exports(&dist.join("entries/markdown.d.ts"));
        let editor = exports(&dist.join("entries/markdown-editor.d.ts"));
        let deprecated = fs::read_to_string(ai.join("AI.md")).map(|text| deprecated_names(&text)).unwrap_or_default();

        let mut docs = Vec::new();
        let mut images = Vec::new();
        collect_docs(&ai, &ai, &mut docs, &mut images);
        docs.sort();
        images.sort();

        let mut code = String::new();
        writeln!(code, "/// Version de socle-ui installée au build.").unwrap();
        writeln!(code, "pub const VERSION: &str = {version:?};").unwrap();
        for (name, list) in [("EXPORTS", &main), ("MARKDOWN_EXPORTS", &markdown), ("MARKDOWN_EDITOR_EXPORTS", &editor)] {
            writeln!(code, "pub const {name}: &[&str] = &{list:?};").unwrap();
        }
        writeln!(code, "/// Anciens noms (dépréciés) et leur nom actuel, d’après `AI.md`.").unwrap();
        writeln!(code, "pub const DEPRECATED: &[(&str, &str)] = &{deprecated:?};").unwrap();
        writeln!(code, "/// Doc pour l’IA livrée avec socle-ui : chemin relatif à `ai/`, contenu.").unwrap();
        writeln!(code, "pub const DOCS: &[(&str, &str)] = &[").unwrap();
        for (relative, absolute) in &docs {
            writeln!(code, "    ({relative:?}, include_str!({absolute:?})),").unwrap();
        }
        writeln!(code, "];").unwrap();
        writeln!(code, "/// Captures livrées avec la doc (recettes de pages, `ai/recipes/*.png`) : chemin relatif à `ai/`, octets.").unwrap();
        writeln!(code, "pub const IMAGES: &[(&str, &[u8])] = &[").unwrap();
        for (relative, absolute) in &images {
            writeln!(code, "    ({relative:?}, include_bytes!({absolute:?})),").unwrap();
        }
        writeln!(code, "];").unwrap();
        fs::write(out, code).expect("socle_ui.rs");
    }

    /// Noms exportés d’un fichier de déclarations : `export { A, B as C } from`, `export type { … }`,
    /// `export declare const X`, `export declare function X`, `export type X =`, `export interface X`.
    fn exported_names(text: &str) -> Vec<String> {
        let mut names = Vec::new();
        let mut rest = text;
        while let Some(start) = rest.find("export ") {
            rest = &rest[start + 7..];
            let after = rest.trim_start_matches("type ").trim_start();
            if let Some(list) = after.strip_prefix('{') {
                let Some(end) = list.find('}') else { break };
                for item in list[..end].split(',') {
                    let item = item.trim().trim_start_matches("type ").trim();
                    let name = item.rsplit(" as ").next().unwrap_or(item).trim();
                    if is_identifier(name) {
                        names.push(name.to_string());
                    }
                }
                continue;
            }
            for prefix in ["declare const ", "declare function ", "declare class ", "declare enum ", "interface ", "const ", "function "] {
                if let Some(tail) = after.strip_prefix(prefix) {
                    let name: String = tail.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$').collect();
                    if is_identifier(&name) {
                        names.push(name);
                    }
                }
            }
            // `export type X = …` : `after` a perdu « type », le nom suit directement.
            if rest.starts_with("type ") && !after.starts_with('{') {
                let name: String = after.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$').collect();
                if is_identifier(&name) && after[name.len()..].trim_start().starts_with(['=', '<']) {
                    names.push(name);
                }
            }
        }
        names.sort();
        names.dedup();
        names
    }

    fn is_identifier(name: &str) -> bool {
        !name.is_empty()
            && name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
            && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
    }

    /// Lignes « - `Ancien` → `Nouveau` » de la section « Anciens noms » de `AI.md`.
    fn deprecated_names(text: &str) -> Vec<(String, String)> {
        let Some(start) = text.find("## Anciens noms") else { return Vec::new() };
        let section = &text[start..];
        let section = &section[..section[3..].find("\n## ").map_or(section.len(), |end| end + 3)];
        section
            .lines()
            .filter_map(|line| {
                let (old, new) = line.strip_prefix("- `")?.split_once("` → `")?;
                let new = new.strip_suffix('`').unwrap_or(new);
                (is_identifier(old) && is_identifier(new)).then(|| (old.to_string(), new.to_string()))
            })
            .collect()
    }

    /// Textes (`.md`) et captures (`.png`) de la doc pour l’IA, chemins relatifs à `base`.
    fn collect_docs(base: &Path, dir: &Path, docs: &mut Vec<(String, String)>, images: &mut Vec<(String, String)>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_docs(base, &path, docs, images);
                continue;
            }
            let list = match path.extension().and_then(|extension| extension.to_str()) {
                Some("md") => &mut *docs,
                Some("png") => &mut *images,
                _ => continue,
            };
            let relative = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            let absolute = fs::canonicalize(&path).unwrap_or(path).to_string_lossy().into_owned();
            list.push((relative, absolute));
        }
    }
}
