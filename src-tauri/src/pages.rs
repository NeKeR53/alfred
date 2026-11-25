//! Sert le contenu des cadres isolés : le document hôte, l’environnement d’exécution embarqué, et les fichiers des
//! modules transpilés à la demande. Le même code répond au protocole `alfred-page` et, en développement, au pont
//! HTTP du navigateur de test.

use std::path::{Component, Path, PathBuf};

use crate::state::AppState;
use crate::transpile;

pub struct PageResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub csp: Option<String>,
}

impl PageResponse {
    fn new(status: u16, content_type: &'static str, body: impl Into<Vec<u8>>) -> Self {
        Self { status, content_type, body: body.into(), csp: None }
    }

    fn not_found() -> Self {
        Self::new(404, "text/plain; charset=utf-8", "Introuvable")
    }
}

#[cfg(not(debug_assertions))]
static RUNTIME: include_dir::Dir<'static> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/runtime");

/// En développement l’environnement d’exécution est relu sur le disque : le reconstruire ne demande pas de
/// recompiler Rust.
fn runtime_file(path: &str) -> Option<Vec<u8>> {
    #[cfg(debug_assertions)]
    {
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime").join(path)).ok()
    }
    #[cfg(not(debug_assertions))]
    {
        RUNTIME.get_file(path).map(|file| file.contents().to_vec())
    }
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Document hôte d’une page ou des fonctions d’un module. Sa politique de sécurité coupe tout accès réseau : le
/// cadre ne charge que des scripts d’Alfred et ne parle qu’à la coquille, par messages.
fn host_document(entry: &str, prefix: &str, origin: &str) -> PageResponse {
    let html = format!(
        r#"<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="x-dns-prefetch-control" content="off">
<link rel="stylesheet" href="{prefix}/runtime/alfred.css">
<script type="importmap">{{"imports":{{"react":"{prefix}/runtime/react.js","react-dom":"{prefix}/runtime/react-dom.js","react-dom/client":"{prefix}/runtime/react-dom-client.js","react/jsx-runtime":"{prefix}/runtime/jsx-runtime.js","lucide-react":"{prefix}/runtime/lucide.js","socle-ui":"{prefix}/runtime/socle.js","socle-ui/markdown":"{prefix}/runtime/socle-markdown.js","socle-ui/markdown-editor":"{prefix}/runtime/socle-markdown-editor.js","@alfred/sdk":"{prefix}/runtime/sdk.js","@alfred/kit":"{prefix}/runtime/kit.js"}}}}</script>
</head>
<body class="alfred-frame">
<div id="root"></div>
<script type="module" src="{prefix}/runtime/{entry}.js"></script>
</body>
</html>"#
    );
    let mut response = PageResponse::new(200, "text/html; charset=utf-8", html);
    response.csp = Some(format!(
        "default-src 'none'; script-src {origin} 'unsafe-inline'; style-src {origin} 'unsafe-inline'; \
         img-src {origin} data: blob:; font-src {origin} data:; connect-src 'none'; form-action 'none'; \
         base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; webrtc 'block'"
    ));
    response
}

/// Résout un chemin relatif à un module sans jamais en sortir.
fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return None;
    }
    Some(root.join(relative))
}

fn module_script(state: &AppState, module: &str, rest: &str) -> PageResponse {
    let Some(space) = state.try_space() else { return PageResponse::not_found() };
    if !crate::space::valid_id(module) {
        return PageResponse::not_found();
    }
    let root = space.module_dir(module);
    // Fichier d’une librairie (`vendor/….mjs`) : déjà en JavaScript, servi tel quel.
    if let Some(file) = rest.strip_prefix(&format!("{}/", crate::libraries::DIR)) {
        if !crate::libraries::is_vendor_file(file) {
            return PageResponse::not_found();
        }
        return match std::fs::read(root.join(crate::libraries::DIR).join(file)) {
            Ok(body) => PageResponse::new(200, "text/javascript; charset=utf-8", body),
            Err(_) => PageResponse::not_found(),
        };
    }
    let Some(base) = safe_join(&root, rest) else { return PageResponse::not_found() };
    let candidates = [
        base.clone(),
        base.with_extension("tsx"),
        base.with_extension("ts"),
        base.join("index.tsx"),
        base.join("index.ts"),
    ];
    let Some(file) = candidates.iter().find(|candidate| candidate.is_file()) else {
        return PageResponse::not_found();
    };
    let name = file.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    if !(name.ends_with(".ts") || name.ends_with(".tsx")) {
        return PageResponse::not_found();
    }
    let Ok(source) = std::fs::read_to_string(file) else { return PageResponse::not_found() };
    let depth = rest.matches('/').count();
    let script = match transpile::transpile_in(&source, &name, depth, &crate::libraries::entries(&root)) {
        Ok(code) => code,
        // Le cadre affiche l’erreur à la place de la page, et la coquille la transmet à l’agent.
        Err(diagnostics) => format!(
            "throw Object.assign(new Error(\"Erreur de compilation\"), {{ alfredDiagnostics: {}, alfredFile: {} }});",
            serde_json::to_string(&diagnostics).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&format!("{module}/{rest}")).unwrap_or_else(|_| "\"\"".to_string()),
        ),
    };
    PageResponse::new(200, "text/javascript; charset=utf-8", script)
}

/// `path` est le chemin de la requête, sans le préfixe du pont de développement.
pub fn respond(state: &AppState, path: &str, prefix: &str, origin: &str) -> PageResponse {
    let path = path.split('?').next().unwrap_or(path);
    if let Some(file) = path.strip_prefix("/runtime/") {
        if file.contains("..") {
            return PageResponse::not_found();
        }
        return match runtime_file(file) {
            Some(body) => PageResponse::new(200, content_type(file), body),
            None => PageResponse::not_found(),
        };
    }
    match path {
        "/host/page" => return host_document("page-host", prefix, origin),
        "/host/functions" => return host_document("function-host", prefix, origin),
        _ => {}
    }
    // `/code/<clé>/<exécution>` : le code d’une exécution de Code Mode, pour son seul cadre (`code_mode.rs`).
    if let Some(rest) = path.strip_prefix("/code/") {
        if let Some((key, run)) = rest.split_once('/') {
            if crate::webhooks::same(key.as_bytes(), crate::code_mode::frame_key(state).as_bytes()) {
                if let Some(js) = crate::code_mode::script(run) {
                    return PageResponse::new(200, "text/javascript; charset=utf-8", js);
                }
            }
        }
        return PageResponse::not_found();
    }
    // `/m/<module>/<clé>/<fichier>` : sans la clé de ce module, pas de code. Tous les cadres ont la même origine
    // opaque, le serveur ne sait pas lequel demande ; seule la coquille connaît les clés, et ne remet à chaque cadre
    // que celle de son module. Une page ne charge donc pas le code d’un autre module.
    if let Some(rest) = path.strip_prefix("/m/") {
        if let Some((module, rest)) = rest.split_once('/') {
            if let Some((key, file)) = rest.split_once('/') {
                if crate::webhooks::same(key.as_bytes(), frame_key(state, module).as_bytes()) {
                    return module_script(state, module, file);
                }
            }
        }
    }
    PageResponse::not_found()
}

/// Clé qui ouvre le code d’un module à son cadre : signée par le secret du lancement, inconnue des pages.
pub fn frame_key(state: &AppState, module: &str) -> String {
    let mac = crate::webhooks::hmac_sha256(&state.frame_secret, format!("cadre:{module}").as_bytes());
    mac[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `pages.frameKey` : la coquille demande la clé du module d’un cadre qu’elle va créer.
pub async fn handle(state: &std::sync::Arc<AppState>, command: &str, args: &serde_json::Value) -> Option<crate::error::AppResult<serde_json::Value>> {
    if command != "pages.frameKey" {
        return None;
    }
    Some((|| {
        let module: String = crate::error::arg(args, "module")?;
        if !crate::space::valid_id(&module) {
            return Err(crate::error::AppError::new("Module inconnu."));
        }
        if let Ok(space) = state.space() {
            crate::decisions::warm_for_module(state, space.module_dir(&module));
        }
        Ok(serde_json::json!({ "key": frame_key(state, &module) }))
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Le document hôte coupe aussi ce que `connect-src` ne couvre pas : WebRTC, prélecture DNS, cadres et workers.
    #[test]
    fn the_host_document_shuts_every_network_door_it_can() {
        let page = host_document("page-host", "", "alfred-page:");
        let csp = page.csp.unwrap();
        for directive in ["connect-src 'none'", "webrtc 'block'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'"] {
            assert!(csp.contains(directive), "{directive} absent de {csp}");
        }
        assert!(String::from_utf8(page.body).unwrap().contains(r#"x-dns-prefetch-control" content="off""#));
    }

    /// La carte d’imports relie chaque paquet admis par le transpileur à son fichier du runtime, et plus `@alfred/ui`.
    #[test]
    fn the_import_map_serves_socle_ui_and_every_allowed_package() {
        let body = String::from_utf8(host_document("page-host", "", "alfred-page:").body).unwrap();
        for package in crate::transpile::ALLOWED_IMPORTS {
            assert!(body.contains(&format!("\"{package}\":")), "{package} absent de la carte d’imports");
        }
        assert!(body.contains(r#""socle-ui":"/runtime/socle.js""#), "{body}");
        assert!(!body.contains("@alfred/ui"), "{body}");
    }

    /// Une librairie installée se charge par la clé du module, et une page l’importe par son nom.
    #[test]
    fn a_page_loads_the_libraries_of_its_module() {
        let (state, _dir) = crate::clients::testing::test_state();
        let space = state.space().unwrap();
        space
            .place_page("Notes", None, "", &crate::space::PlaceTarget::Menu { label: "Notes".into(), icon: None, color: None }, None)
            .unwrap();
        let root = space.module_dir("notes");
        std::fs::write(
            root.join("pages/notes.tsx"),
            "import { make } from \"petit-editeur\";\nexport default function Page() { return make(); }",
        )
        .unwrap();
        let get = |path: String| respond(&state, &path, "", "alfred-page:");
        let key = frame_key(&state, "notes");
        // Sans librairie installée, l’import est refusé à la compilation.
        let refused = String::from_utf8(get(format!("/m/notes/{key}/pages/notes")).body).unwrap();
        assert!(refused.contains("Import interdit"), "{refused}");

        std::fs::create_dir_all(root.join("vendor")).unwrap();
        std::fs::write(root.join("vendor/abc-editeur.mjs"), "export const make = () => null;").unwrap();
        std::fs::write(
            root.join("vendor/libraries.json"),
            r#"{"source":"https://esm.sh","libraries":{"petit-editeur":{"version":"1.0.0","entry":"abc-editeur.mjs"}},"files":{}}"#,
        )
        .unwrap();
        let page = String::from_utf8(get(format!("/m/notes/{key}/pages/notes")).body).unwrap();
        assert!(page.contains("\"../vendor/abc-editeur.mjs\""), "{page}");
        let library = get(format!("/m/notes/{key}/vendor/abc-editeur.mjs"));
        assert_eq!((library.status, library.content_type), (200, "text/javascript; charset=utf-8"));
        assert_eq!(get(format!("/m/notes/{key}/vendor/libraries.json")).status, 404);
        assert_eq!(get("/m/notes/vendor/abc-editeur.mjs".into()).status, 404);
    }

    /// Le code d’un module ne sort que par la clé de ce module : une page ne charge pas celui d’un autre.
    #[test]
    fn a_frame_loads_only_the_code_of_its_own_module() {
        let (state, _dir) = crate::clients::testing::test_state();
        let space = state.space().unwrap();
        for (module, title) in [("notes", "Notes"), ("banque", "Banque")] {
            space
                .place_page("Liste", None, "", &crate::space::PlaceTarget::Menu { label: title.into(), icon: None, color: None }, None)
                .unwrap();
            std::fs::write(space.module_dir(module).join("pages/liste.tsx"), "export default function Page() { return null; }").unwrap();
        }
        let get = |path: String| respond(&state, &path, "", "alfred-page:").status;
        let notes = frame_key(&state, "notes");
        let banque = frame_key(&state, "banque");
        assert_ne!(notes, banque);
        assert_eq!(get(format!("/m/notes/{notes}/pages/liste")), 200);
        assert_eq!(get(format!("/m/banque/{banque}/pages/liste")), 200);
        // Sans clé (l’ancienne adresse), avec la clé d’un autre module ou une clé inventée : rien.
        assert_eq!(get("/m/banque/pages/liste".into()), 404);
        assert_eq!(get(format!("/m/banque/{notes}/pages/liste")), 404);
        assert_eq!(get(format!("/m/banque/{}/pages/liste", "0".repeat(32))), 404);
        // Un autre lancement d’Alfred tire un autre secret.
        let (other, _other_dir) = crate::clients::testing::test_state();
        assert_ne!(frame_key(&other, "notes"), notes);
    }
}
