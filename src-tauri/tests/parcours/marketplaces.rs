//! Parcours 6 : un module publié par un poste, installé par un autre, mis à jour, détaché puis désinstallé.

use serde_json::{json, Value};

use crate::common::*;

async fn tables(desk: &Desk, module: &str) -> String {
    desk.invoke("db.schema", json!({ "module": module })).await.to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn publier_installer_mettre_a_jour_detacher_desinstaller() {
    let root = tempfile::tempdir().unwrap();
    let remote = root.path().join("marketplace.git");
    std::fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "--bare", "-q", "-b", "main"]);
    let remote = remote.to_string_lossy().to_string();

    // Poste de l’auteur : un module avec page, table et fonction, publié en 1.0.0.
    let author = Desk::open_in(root.path(), "auteur").await;
    author.invoke("space.placePage", json!({ "title": "Carnet", "target": { "kind": "menu", "label": "Recettes", "icon": "chef-hat" } })).await;
    author.write("modules/recettes/pages/carnet.tsx", PAGE);
    author.write("modules/recettes/migrations/0001_plats.sql", "CREATE TABLE recettes_plats (id INTEGER PRIMARY KEY, nom TEXT NOT NULL);\n");
    author.invoke("functions.declare", json!({ "module": "recettes", "id": "compter", "description": "Compte les plats.", "tool": true })).await;
    author.write("modules/recettes/functions/compter.ts", "export default async function compter() { return 0; }\n");
    author.invoke("space.commit", json!({ "message": "Module de recettes" })).await;
    let added = author.invoke("marketplace.add", json!({ "url": remote, "name": "Équipe" })).await;
    assert_eq!(added["id"], json!("equipe"));
    let published = author
        .invoke("marketplace.publish", json!({ "module": "recettes", "marketplace": "equipe", "version": "1.0.0", "notes": "Première version." }))
        .await;
    assert_eq!(published["version"], json!("1.0.0"));
    assert_eq!(git(std::path::Path::new(&remote), &["log", "--format=%s", "main"]), "Publication du module Recettes v1.0.0");

    // Poste du lecteur : il branche le marketplace et installe le module.
    let reader = Desk::open_in(root.path(), "lecteur").await;
    let marketplace = reader.invoke("marketplace.add", json!({ "url": remote })).await["id"].as_str().unwrap().to_string();
    let catalog = reader.invoke("marketplace.modules", json!({ "id": marketplace })).await;
    assert_eq!((catalog[0]["id"].as_str(), catalog[0]["version"].as_str()), (Some("recettes"), Some("1.0.0")));
    assert_eq!(catalog[0]["notes"], json!("Première version."));
    reader.invoke("marketplace.install", json!({ "marketplace": marketplace, "module": "recettes" })).await;
    assert_eq!(reader.history().await[0], "Import du module Recettes v1.0.0");
    let snapshot = reader.snapshot().await;
    let installed = &section(&snapshot, "recettes/principal")["pages"][0];
    assert_eq!((installed["reference"].as_str(), installed["readOnly"].as_bool()), (Some("recettes/carnet"), Some(true)));
    let module = snapshot["modules"].as_array().unwrap().iter().find(|module| module["id"] == json!("recettes")).unwrap();
    assert_eq!((module["readOnly"].as_bool(), module["origin"]["version"].as_str()), (Some(true), Some("1.0.0")));

    // Ses tables naissent au premier usage, et ses pages s’en servent.
    let carnet = Frame::page(&reader, "recettes/carnet");
    carnet.execute("INSERT INTO recettes_plats (nom) VALUES (?1)", json!(["Ratatouille"])).await.unwrap();
    assert!(tables(&reader, "recettes").await.contains("recettes_plats"));

    // Lecture seule : ni suppression de page, ni fonction ajoutée, ni publication.
    let refused = reader.refused("space.deletePage", json!({ "reference": "recettes/carnet" })).await;
    assert!(refused.contains("marketplace") || refused.contains("lecture seule"), "{refused}");
    assert!(reader.refused("functions.declare", json!({ "module": "recettes", "id": "autre" })).await.contains("edit_module"));
    let republish = reader
        .refused("marketplace.publish", json!({ "module": "recettes", "marketplace": marketplace, "version": "9.0.0" }))
        .await;
    assert!(republish.contains("Modifier sur place"), "{republish}");
    // Un onglet ajouté à la section installée va dans le module d’ajouts, qui lit les tables sans y écrire.
    let addition = reader
        .invoke("space.placePage", json!({ "title": "Favoris", "target": { "kind": "tab", "section": "recettes/principal" } }))
        .await;
    assert_eq!(addition["reference"], json!("recettes-ajouts/favoris"));
    reader.write("modules/recettes-ajouts/pages/favoris.tsx", PAGE);
    let favoris = Frame::page(&reader, "recettes-ajouts/favoris");
    assert_eq!(favoris.query("SELECT nom FROM recettes_plats", json!([])).await.unwrap(), json!([{ "nom": "Ratatouille" }]));
    assert!(favoris.execute("DELETE FROM recettes_plats", json!([])).await.unwrap_err().contains("Requête refusée"));
    assert_eq!(
        references(&section(&reader.snapshot().await, "recettes/principal")["pages"]),
        ["recettes/carnet", "recettes-ajouts/favoris"]
    );

    // L’auteur publie 1.1.0 avec une table de plus.
    author.write("modules/recettes/migrations/0002_ingredients.sql", "CREATE TABLE recettes_ingredients (id INTEGER PRIMARY KEY, plat INTEGER REFERENCES recettes_plats(id));\n");
    author
        .invoke("marketplace.publish", json!({ "module": "recettes", "marketplace": "equipe", "version": "1.1.0", "notes": "Ingrédients." }))
        .await;

    // Le lecteur voit la mise à jour après rafraîchissement, puis l’applique ; ses données restent.
    assert_eq!(reader.invoke("marketplace.updates", json!({})).await[0]["available"], Value::Null);
    let updates = reader.invoke("marketplace.updates", json!({ "refresh": true })).await;
    assert_eq!((updates[0]["current"].as_str(), updates[0]["available"].as_str()), (Some("1.0.0"), Some("1.1.0")));
    assert_eq!(updates[0]["notes"], json!("Ingrédients."));
    let updated = reader.invoke("marketplace.update", json!({ "module": "recettes" })).await;
    assert_eq!((updated["from"].as_str(), updated["to"].as_str()), (Some("1.0.0"), Some("1.1.0")));
    assert_eq!(reader.history().await[0], "Mise à jour du module Recettes v1.0.0 → v1.1.0");
    assert_eq!(reader.invoke("db.applyMigrations", json!({})).await, json!([]));
    assert!(tables(&reader, "recettes").await.contains("recettes_ingredients"));
    assert_eq!(carnet.query("SELECT nom FROM recettes_plats", json!([])).await.unwrap(), json!([{ "nom": "Ratatouille" }]));
    assert_eq!(reader.invoke("marketplace.updates", json!({})).await[0]["available"], Value::Null);

    // Détaché : modifiable, plus de mise à jour.
    reader.invoke("marketplace.detach", json!({ "module": "recettes" })).await;
    reader.invoke("functions.declare", json!({ "module": "recettes", "id": "autre", "description": "Ajout local." })).await;
    assert_eq!(reader.invoke("marketplace.updates", json!({})).await, json!([]));
    let module = reader.snapshot().await["modules"].as_array().unwrap().iter().find(|module| module["id"] == json!("recettes")).cloned().unwrap();
    assert_eq!((module["readOnly"].as_bool(), module["origin"]["detached"].as_bool()), (Some(false), Some(true)));

    // La page du module installé a reçu l’accord d’appeler une fonction d’un autre module.
    reader.invoke("space.placePage", json!({ "title": "Menu", "target": { "kind": "menu", "label": "Semaine" } })).await;
    reader.invoke("functions.declare", json!({ "module": "semaine", "id": "lister", "description": "Menus." })).await;
    reader.ui.define("semaine/lister", |_frame: Frame, _input: Value| async move { Ok(json!(["lundi"])) });
    reader.ui.answer_permissions(&[true]);
    assert_eq!(carnet.call("semaine/lister", json!({})).await.unwrap(), json!(["lundi"]));
    assert_eq!(reader.ui.asked_resources(), ["recettes/carnet → function:semaine/lister"]);
    reader.invoke("space.commit", json!({ "message": "Semaine" })).await;

    // Désinstallé avec ses données : dossier, navigation, tables et accords partent ; l’annulation reste possible.
    let uninstalled = reader.invoke("marketplace.uninstall", json!({ "module": "recettes", "deleteData": true })).await;
    assert!(uninstalled["commit"].is_string());
    assert!(!reader.space.join("modules/recettes").exists());
    let snapshot = reader.snapshot().await;
    assert!(!snapshot["sections"].to_string().contains("recettes/principal"));
    assert!(snapshot["problems"].to_string().contains("recettes-ajouts/favoris"), "l’onglet d’ajout signale sa section absente");
    eventually("les tables du module désinstallé sont supprimées", || async {
        !tables(&reader, "recettes").await.contains("recettes_plats")
    })
    .await;
    assert!(!tables(&reader, "recettes").await.contains("recettes_ingredients"));
    assert_eq!(reader.invoke("grants.list", json!({})).await, json!([]), "les accords du module sont oubliés");
    assert!(reader.ui.event_names().contains(&"module:uninstalled".to_string()));
    assert_eq!(reader.history().await[0], "Retrait du module Recettes");
}

/// À la désinstallation, les accords donnés à d’autres pages sur les fonctions du module sont oubliés : un module
/// créé ensuite sous le même identifiant n’en hérite pas, et l’utilisateur est de nouveau consulté.
#[tokio::test(flavor = "multi_thread")]
async fn uninstalling_a_module_forgets_the_grants_on_its_functions() {
    let root = tempfile::tempdir().unwrap();
    let remote = root.path().join("marketplace.git");
    std::fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "--bare", "-q", "-b", "main"]);
    let remote = remote.to_string_lossy().to_string();
    let author = Desk::open_in(root.path(), "auteur").await;
    author.invoke("space.placePage", json!({ "title": "Carnet", "target": { "kind": "menu", "label": "Recettes" } })).await;
    author.write("modules/recettes/pages/carnet.tsx", PAGE);
    author.invoke("functions.declare", json!({ "module": "recettes", "id": "compter", "description": "Compte." })).await;
    author.write("modules/recettes/functions/compter.ts", "export default async function compter() { return 1; }\n");
    author.invoke("marketplace.add", json!({ "url": remote, "name": "Équipe" })).await;
    author.invoke("marketplace.publish", json!({ "module": "recettes", "marketplace": "equipe", "version": "1.0.0" })).await;

    // Le lecteur installe le module ; sa page « Menu » est autorisée à appeler recettes/compter.
    let reader = Desk::open_in(root.path(), "lecteur").await;
    let marketplace = reader.invoke("marketplace.add", json!({ "url": remote })).await["id"].as_str().unwrap().to_string();
    reader.invoke("marketplace.install", json!({ "marketplace": marketplace, "module": "recettes" })).await;
    reader.invoke("space.placePage", json!({ "title": "Menu", "target": { "kind": "menu", "label": "Semaine" } })).await;
    reader.ui.define("recettes/compter", |_frame: Frame, _input: Value| async move { Ok(json!(1)) });
    reader.ui.answer_permissions(&[true]);
    let menu = Frame::page(&reader, "semaine/menu");
    menu.call("recettes/compter", json!({})).await.unwrap();
    reader.invoke("marketplace.uninstall", json!({ "module": "recettes", "deleteData": true })).await;

    // Un tout autre module prend l’identifiant libéré, avec une fonction du même nom.
    let local = reader.invoke("space.placePage", json!({ "title": "Coffre", "target": { "kind": "menu", "label": "Recettes" } })).await;
    assert_eq!(local["module"], json!("recettes"));
    reader.invoke("functions.declare", json!({ "module": "recettes", "id": "compter", "description": "Autre chose." })).await;
    reader.ui.define("recettes/compter", |_frame: Frame, _input: Value| async move { Ok(json!("données du nouveau module")) });
    reader.ui.answer_permissions(&[false]);
    let result = menu.call("recettes/compter", json!({})).await;
    assert_eq!(reader.ui.asked_resources().len(), 2, "accord hérité : la page appelle le nouveau module sans question ({result:?})");
}

/// Un service appartient aux modules qui s’en servent : supprimer un module emporte les services qu’il était seul
/// à utiliser, avec leurs comptes, et garde ceux qu’un autre module utilise encore.
#[tokio::test(flavor = "multi_thread")]
async fn removing_a_module_takes_its_own_services_with_it() {
    let desk = Desk::open("services-du-module").await;
    for (label, module_clients) in [("Ventes", json!([{ "id": "partage" }, { "id": "facturation" }])), ("Achats", json!([{ "id": "partage" }]))] {
        let placed = desk.invoke("space.placePage", json!({ "title": "Accueil", "target": { "kind": "menu", "label": label } })).await;
        let module = placed["module"].as_str().unwrap().to_string();
        let path = format!("modules/{module}/module.json");
        let mut manifest: Value = serde_json::from_str(&desk.read(&path).unwrap()).unwrap();
        manifest["clients"] = module_clients;
        desk.write(&path, &serde_json::to_string_pretty(&manifest).unwrap());
    }
    for id in ["partage", "facturation"] {
        desk.write(&format!("clients/{id}.json"), &json!({ "label": id, "baseUrl": format!("https://{id}.exemple.com"), "auth": { "type": "none" } }).to_string());
    }
    desk.invoke("space.commit", json!({ "message": "Deux modules et leurs services" })).await;

    desk.invoke("marketplace.uninstall", json!({ "module": "ventes", "deleteData": true })).await;
    let ids: Vec<String> = desk.invoke("clients.list", json!({})).await["clients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|client| client["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["partage".to_string()], "seul le service encore utilisé par Achats reste");
    assert!(desk.read("clients/facturation.json").is_none());

    desk.invoke("marketplace.uninstall", json!({ "module": "achats", "deleteData": true })).await;
    assert_eq!(desk.invoke("clients.list", json!({})).await["clients"], json!([]));
}
