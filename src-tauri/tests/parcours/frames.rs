//! Parcours 7 : ce que le protocole `alfred-page` sert aux cadres isolés.

use alfred_lib::testing::page;
use serde_json::json;

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn documents_hotes_modules_transpiles_et_chemins_refuses() {
    let desk = Desk::open("Cadres").await;
    for label in ["Notes", "Banque"] {
        desk.invoke("space.placePage", json!({ "title": "Liste", "target": { "kind": "menu", "label": label } })).await;
    }
    for title in ["Interdit", "Sortant"] {
        desk.invoke("space.placePage", json!({ "title": title, "target": { "kind": "tab", "section": "notes/principal" } })).await;
    }
    desk.write(
        "modules/notes/pages/liste.tsx",
        "import { Page } from \"@alfred/ui\";\nimport { titre } from \"../lib/titre\";\n\nconst taille: number = 2;\n\nexport default function Liste() {\n  return <Page title={titre(taille)} />;\n}\n",
    );
    desk.write("modules/notes/lib/titre.ts", "export function titre(n: number): string {\n  return `Notes (${n})`;\n}\n");
    desk.write("modules/notes/pages/interdit.tsx", "import _ from \"lodash\";\nexport default function Vue() { return null; }\n");
    desk.write("modules/notes/pages/sortant.tsx", "import { secret } from \"../../banque/pages/liste\";\nexport default function Vue() { return secret; }\n");
    desk.write("modules/banque/pages/liste.tsx", "export const secret = \"IBAN\";\nexport default function Vue() { return null; }\n");
    let state = &desk.state;

    // Document hôte d’une page et des fonctions : aucune porte réseau, carte d’imports limitée aux paquets d’Alfred.
    for (path, entry) in [("/host/page", "page-host.js"), ("/host/functions", "function-host.js")] {
        let host = page(state, path);
        assert_eq!((host.status, host.content_type), (200, "text/html; charset=utf-8"));
        assert!(host.body.contains(entry), "{}", host.body);
        let csp = host.csp.expect("politique de sécurité");
        for directive in ["default-src 'none'", "connect-src 'none'", "script-src alfred-page:", "form-action 'none'", "frame-src 'none'", "worker-src 'none'"] {
            assert!(csp.contains(directive), "{directive} absent de {csp}");
        }
        for package in ["\"react\"", "\"@alfred/ui\"", "\"@alfred/sdk\"", "\"lucide-react\""] {
            assert!(host.body.contains(package), "{package} absent de la carte d’imports");
        }
    }
    // L’environnement d’exécution est généré (`pnpm build:runtime`) : vérifié seulement s’il est construit.
    if std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/sdk.js").is_file() {
        let sdk = page(state, "/runtime/sdk.js");
        assert_eq!((sdk.status, sdk.content_type), (200, "text/javascript; charset=utf-8"));
    }
    assert_eq!(page(state, "/runtime/../Cargo.toml").status, 404);

    // Le code d’un module ne sort qu’avec la clé de ce module, que la coquille demande pour son cadre.
    let key = |module: &'static str| {
        let desk = &desk;
        async move { desk.invoke("pages.frameKey", json!({ "module": module })).await["key"].as_str().unwrap().to_string() }
    };
    let (notes, banque) = (key("notes").await, key("banque").await);
    assert_ne!(notes, banque);
    assert_eq!(key("notes").await, notes, "clé stable pendant le lancement");
    let script = page(state, &format!("/m/notes/{notes}/pages/liste.tsx"));
    assert_eq!((script.status, script.content_type), (200, "text/javascript; charset=utf-8"));
    assert!(script.body.contains("export default function Liste"), "{}", script.body);
    assert!(!script.body.contains(": number"), "les types sont retirés : {}", script.body);
    assert!(script.body.contains("../lib/titre"), "l’import relatif est gardé : {}", script.body);
    // L’import relatif se résout sans extension, comme le navigateur le demandera.
    let shared = page(state, &format!("/m/notes/{notes}/lib/titre"));
    assert_eq!(shared.status, 200);
    assert!(shared.body.contains("function titre"));
    for refused in [
        format!("/m/notes/{banque}/pages/liste.tsx"),
        format!("/m/banque/{notes}/pages/liste.tsx"),
        "/m/notes/0000/pages/liste.tsx".to_string(),
        "/m/notes/pages/liste.tsx".to_string(),
    ] {
        assert_eq!(page(state, &refused).status, 404, "{refused}");
    }

    // Import interdit et import qui sort du module : le cadre reçoit l’erreur à afficher, pas le code.
    let forbidden = page(state, &format!("/m/notes/{notes}/pages/interdit.tsx"));
    assert_eq!(forbidden.status, 200);
    assert!(forbidden.body.starts_with("throw "), "{}", forbidden.body);
    assert!(forbidden.body.contains("Import interdit") && forbidden.body.contains("lodash"), "{}", forbidden.body);
    assert!(forbidden.body.contains("notes/pages/interdit.tsx"));
    let outside = page(state, &format!("/m/notes/{notes}/pages/sortant.tsx"));
    assert!(outside.body.contains("sort du module"), "{}", outside.body);
    assert!(!outside.body.contains("IBAN"));
    // Les mêmes erreurs sont dans l’instantané, situées, pour l’agent et l’écran « Cette page ne compile pas ».
    let snapshot = desk.snapshot().await;
    let pages = &section(&snapshot, "notes/principal")["pages"];
    assert_eq!(pages[0]["errors"], json!([]), "l’import de lib/ est permis");
    assert!(pages[1]["errors"][0]["message"].as_str().unwrap().contains("Import interdit"), "{pages}");
    assert_eq!(pages[1]["errors"][0]["line"], json!(1));
    assert!(pages[2]["errors"][0]["message"].as_str().unwrap().contains("sort du module"), "{pages}");

    // Fichiers hors du module, ou qui ne sont pas du code, refusés.
    std::fs::write(desk.space.join("secret.ts"), "export const jeton = \"abc\";\n").unwrap();
    for refused in [
        format!("/m/notes/{notes}/../banque/pages/liste.tsx"),
        format!("/m/notes/{notes}/../../secret.ts"),
        format!("/m/notes/{notes}//etc/passwd"),
        format!("/m/notes/{notes}/module.json"),
        format!("/m/notes/{notes}/migrations"),
        format!("/m/notes/{notes}/pages/absente.tsx"),
    ] {
        let response = page(state, &refused);
        assert_eq!(response.status, 404, "{refused} : {}", response.body);
        assert!(!response.body.contains("IBAN") && !response.body.contains("jeton"));
    }
    let invalid = desk.refused("pages.frameKey", json!({ "module": "../notes" })).await;
    assert_eq!(invalid, "Module inconnu.");
}
