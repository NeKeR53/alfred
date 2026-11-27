//! Parcours 1 : construire une application, la réorganiser, puis revenir en arrière.

use serde_json::json;

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn construire_reorganiser_supprimer_puis_annuler() {
    let desk = Desk::open("Atelier").await;

    // Ouverture : un espace vide, versionné, avec le guide de l’agent.
    let snapshot = desk.snapshot().await;
    assert_eq!(snapshot["name"], json!("Atelier"));
    assert_eq!(snapshot["sections"], json!([]));
    assert!(desk.read("AGENTS.md").is_some_and(|guide| guide.contains("Guide de l’espace de travail Alfred")));
    assert!(desk.read("docs/alfred/SDK.md").is_some());
    assert_eq!(desk.history().await, ["Ouverture de l’espace de travail"]);

    // Une page par menu (nouveau module), un onglet, un panneau de droite et une page des Réglages.
    let menu = json!({ "kind": "menu", "label": "Suivi", "icon": "list-checks", "color": "blue" });
    let taches = desk.invoke("space.placePage", json!({ "title": "Tâches", "icon": "list-checks", "target": menu })).await;
    assert_eq!((taches["module"].as_str(), taches["reference"].as_str()), (Some("suivi"), Some("suivi/taches")));
    // Chemin natif (des `\\` sous Windows) : on compare ses composants, pas son texte.
    assert!(std::path::Path::new(taches["file"].as_str().unwrap()).ends_with("modules/suivi/pages/taches.tsx"));
    let tab = json!({ "kind": "tab", "section": "suivi/principal" });
    let echeances = desk.invoke("space.placePage", json!({ "title": "Échéances", "target": tab })).await;
    assert_eq!(echeances["reference"], json!("suivi/echeances"));
    let panel = json!({ "kind": "panel", "page": "suivi/taches" });
    let detail = desk.invoke("space.placePage", json!({ "title": "Détail", "target": panel })).await;
    let settings = json!({ "kind": "settings" });
    desk.invoke("space.placePage", json!({ "title": "Préférences", "target": settings, "module": "suivi" })).await;
    let second = desk.refused("space.placePage", json!({ "title": "Autre détail", "target": panel })).await;
    assert!(second.contains("déjà un panneau"), "{second}");
    let absent = desk.refused("space.placePage", json!({ "title": "X", "target": { "kind": "tab", "section": "suivi/inconnue" } })).await;
    assert!(absent.contains("n’existe pas"), "{absent}");

    // Avant que l’agent écrive les fichiers, les pages sont signalées « en cours d’écriture ».
    let snapshot = desk.snapshot().await;
    let suivi = section(&snapshot, "suivi/principal");
    assert!(suivi["pages"].as_array().unwrap().iter().all(|page| page["missing"] == json!(true)));

    // L’agent écrit les pages ; l’une ne compile pas.
    desk.write("modules/suivi/pages/taches.tsx", PAGE);
    desk.write("modules/suivi/pages/detail.tsx", PAGE);
    desk.write("modules/suivi/pages/preferences.tsx", PAGE);
    desk.write("modules/suivi/pages/echeances.tsx", "export default function Vue() {\n  return <div>;\n}\n");
    let first_turn = desk.invoke("space.commit", json!({ "message": "Tour 1 : module de suivi" })).await;
    assert!(first_turn["commit"].is_string());

    let snapshot = desk.snapshot().await;
    let suivi = section(&snapshot, "suivi/principal");
    assert_eq!((suivi["label"].as_str(), suivi["color"].as_str()), (Some("Suivi"), Some("blue")));
    assert_eq!(references(&suivi["pages"]), ["suivi/taches", "suivi/echeances"]);
    let page_taches = &suivi["pages"][0];
    assert_eq!((page_taches["missing"].as_bool(), page_taches["errors"].clone()), (Some(false), json!([])));
    assert_eq!(page_taches["panel"]["reference"], detail["reference"]);
    let broken = &suivi["pages"][1];
    assert_eq!(broken["title"], json!("Échéances"));
    let error = &broken["errors"][0];
    assert!(error["line"].as_u64().is_some_and(|line| line >= 2), "erreur située : {error}");
    assert_eq!(references(&snapshot["settingsPages"]), ["suivi/preferences"]);
    assert_eq!(snapshot["problems"], json!([]));

    // Un second module, pour réorganiser entre sections.
    let notes = desk
        .invoke("space.placePage", json!({ "title": "Carnet", "target": { "kind": "menu", "label": "Notes" } }))
        .await;
    desk.write("modules/notes/pages/carnet.tsx", PAGE);
    desk.invoke("space.commit", json!({ "message": "Tour 2 : carnet" })).await;
    let before_layout = desk.snapshot().await;
    let order: Vec<&str> = before_layout["sections"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(order, ["notes/principal", "suivi/principal"], "ordre par défaut : celui des dossiers");

    // Réorganiser, renommer, masquer et déplacer par le `layout` que renvoie l’interface.
    let layout = json!({
        "sections": ["suivi/principal", "notes/principal"],
        "tabs": { "suivi/principal": ["suivi/echeances", "suivi/carnet-inexistant", "notes/carnet", "suivi/taches"] },
        "overrides": {
            "section:suivi/principal": { "label": "Projets", "color": "green" },
            "page:suivi/echeances": { "hidden": true },
            "page:suivi/taches": { "label": "Mes tâches", "icon": "check" },
            "page:notes/carnet": { "placement": { "kind": "tab", "section": "suivi/principal" } },
        },
    });
    let reorganized = desk.invoke("space.updateLayout", json!({ "layout": layout, "message": "Réorganisation" })).await;
    let order: Vec<&str> = reorganized["sections"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(order, ["suivi/principal", "notes/principal"]);
    let projets = section(&reorganized, "suivi/principal");
    assert_eq!((projets["label"].as_str(), projets["color"].as_str()), (Some("Projets"), Some("green")));
    assert_eq!(references(&projets["pages"]), ["suivi/echeances", "notes/carnet", "suivi/taches"]);
    assert_eq!(projets["pages"][0]["hidden"], json!(true));
    assert_eq!((projets["pages"][2]["title"].as_str(), projets["pages"][2]["icon"].as_str()), (Some("Mes tâches"), Some("check")));
    assert_eq!(section(&reorganized, "notes/principal")["pages"], json!([]), "le carnet a quitté sa section");
    // La réorganisation vit dans alfred.json, jamais dans les manifestes des modules.
    assert!(desk.read("alfred.json").unwrap().contains("Projets"));
    assert!(!desk.read("modules/suivi/module.json").unwrap().contains("Projets"));
    let layout_commit = desk.last_commit().await;

    // Annuler la réorganisation rétablit l’ordre, les libellés et l’emplacement d’origine.
    desk.invoke("space.undo", json!({ "commit": layout_commit })).await;
    let undone = desk.snapshot().await;
    let order: Vec<&str> = undone["sections"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(order, ["notes/principal", "suivi/principal"]);
    let suivi = section(&undone, "suivi/principal");
    assert_eq!(suivi["label"], json!("Suivi"));
    assert_eq!(references(&suivi["pages"]), ["suivi/taches", "suivi/echeances"]);
    assert_eq!(suivi["pages"][0]["title"], json!("Tâches"));
    assert!(suivi["pages"].as_array().unwrap().iter().all(|page| page["hidden"] == json!(false)));
    assert_eq!(references(&section(&undone, "notes/principal")["pages"]), ["notes/carnet"]);
    assert!(desk.history().await[0].starts_with("Revert"), "l’annulation est elle-même un commit");

    desk.invoke("space.updateLayout", json!({ "name": "Atelier de Léa" })).await;
    assert_eq!(desk.snapshot().await["name"], json!("Atelier de Léa"));

    // Supprimer une page : fichier, manifeste et réorganisation nettoyés, dans un commit.
    desk.invoke("space.deletePage", json!({ "reference": "suivi/echeances" })).await;
    assert!(desk.read("modules/suivi/pages/echeances.tsx").is_none());
    let after_delete = desk.snapshot().await;
    assert_eq!(references(&section(&after_delete, "suivi/principal")["pages"]), ["suivi/taches"]);
    assert!(!after_delete["layout"].to_string().contains("suivi/echeances"));
    let deletion = desk.last_commit().await;
    // Le module resté sans page disparaît avec son dossier.
    desk.invoke("space.deletePage", json!({ "reference": notes["reference"] })).await;
    assert!(!desk.space.join("modules/notes").exists());

    assert_eq!(
        desk.history().await,
        [
            "Suppression de la page notes/carnet",
            "Suppression de la page suivi/echeances",
            "Réorganisation de la navigation",
            "Revert \"Réorganisation\"",
            "Réorganisation",
            "Tour 2 : carnet",
            "Tour 1 : module de suivi",
            "Ouverture de l’espace de travail",
        ]
    );

    // Annuler la suppression rétablit le fichier et la page, à sa place.
    desk.invoke("space.undo", json!({ "commit": deletion })).await;
    assert_eq!(desk.read("modules/suivi/pages/echeances.tsx").as_deref(), Some("export default function Vue() {\n  return <div>;\n}\n"));
    let restored = desk.snapshot().await;
    assert!(references(&section(&restored, "suivi/principal")["pages"]).contains(&"suivi/echeances".to_string()));

    assert_eq!(git(&desk.space, &["status", "--porcelain"]), "", "rien ne reste hors d’un commit");
}
