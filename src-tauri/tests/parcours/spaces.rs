//! Parcours 8 : plusieurs espaces sur un poste, gérés depuis les Réglages. On passe de l’un à l’autre, on renomme
//! l’ouvert et un autre sans l’ouvrir, un espace disparu n’est jamais recréé depuis la liste, et la corbeille refuse
//! l’espace ouvert comme un dossier ordinaire.

use std::time::Duration;

use serde_json::json;

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn passer_d_un_espace_a_l_autre_renommer_et_proteger_la_corbeille() {
    let desk = Desk::open("poste").await;
    let atelier = desk.space.clone();
    let perso = atelier.with_file_name("perso");

    // Un deuxième espace : l’ouvrir annonce le changement, et les fenêtres de page de l’espace quitté se ferment.
    desk.invoke("space.open", json!({ "path": perso.to_string_lossy(), "name": "Perso" })).await;
    assert_eq!(desk.snapshot().await["name"], json!("Perso"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(desk.ui.event_names().iter().any(|name| name == "space:switched"), "{:?}", desk.ui.event_names());

    // Renommer l’espace ouvert : le nom seul change, le menu le relit.
    let renamed = desk.invoke("spaces.rename", json!({ "path": perso.to_string_lossy(), "name": " Perso 2 " })).await;
    assert_eq!(renamed["name"], json!("Perso 2"));
    assert_eq!(desk.snapshot().await["name"], json!("Perso 2"));
    assert_eq!(desk.snapshot().await["path"], json!(perso.to_string_lossy()));

    // Renommer un autre espace sans l’ouvrir.
    desk.invoke("spaces.rename", json!({ "path": atelier.to_string_lossy(), "name": "Atelier" })).await;
    let manifest = std::fs::read_to_string(atelier.join("alfred.json")).unwrap();
    assert!(manifest.contains("\"Atelier\""), "{manifest}");
    assert_eq!(desk.snapshot().await["name"], json!("Perso 2"), "l’espace ouvert ne change pas");

    // Un espace de la liste dont le dossier a disparu n’est pas recréé vide.
    let gone = atelier.with_file_name("disparu");
    let refusal = desk.refused("space.open", json!({ "path": gone.to_string_lossy(), "existing": true })).await;
    assert!(refusal.contains("n’est plus un espace de travail"), "{refusal}");
    assert!(!gone.exists());
    assert_eq!(desk.snapshot().await["name"], json!("Perso 2"));

    // La corbeille refuse l’espace ouvert et un dossier qui n’est pas un espace.
    let refusal = desk.refused("spaces.trash", json!({ "path": perso.to_string_lossy() })).await;
    assert!(refusal.contains("ouvert"), "{refusal}");
    let plain = atelier.with_file_name("photos");
    std::fs::create_dir_all(&plain).unwrap();
    desk.refused("spaces.trash", json!({ "path": plain.to_string_lossy() })).await;
    assert!(perso.join("alfred.json").is_file() && plain.is_dir());

    // Revenir au premier : il garde son nouveau nom.
    desk.invoke("space.open", json!({ "path": atelier.to_string_lossy(), "existing": true })).await;
    assert_eq!(desk.snapshot().await["name"], json!("Atelier"));
}
