//! Parcours 2 : tables d’un module, lecture et écriture par une page, cloisonnement, fonctions et accords.

use serde_json::{json, Value};

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn donnees_cloisonnees_fonctions_et_accords() {
    let desk = Desk::open("Maison").await;
    for (title, label) in [("Carnet", "Notes"), ("Comptes", "Banque")] {
        desk.invoke("space.placePage", json!({ "title": title, "target": { "kind": "menu", "label": label } })).await;
    }
    desk.write("modules/notes/pages/carnet.tsx", PAGE);
    desk.write("modules/banque/pages/comptes.tsx", PAGE);

    // Migrations : chaque module crée ses tables, préfixées par son identifiant.
    desk.write(
        "modules/notes/migrations/0001_notes.sql",
        "CREATE TABLE notes_items (id INTEGER PRIMARY KEY, texte TEXT NOT NULL, fait INTEGER NOT NULL DEFAULT 0);\n",
    );
    desk.write("modules/banque/migrations/0001_comptes.sql", "CREATE TABLE banque_comptes (id INTEGER PRIMARY KEY, solde REAL);\n");
    desk.write("modules/notes/migrations/0002_hors_module.sql", "CREATE TABLE banque_piege (id INTEGER);\n");
    let problems = desk.invoke("db.applyMigrations", json!({})).await;
    let problems = problems.as_array().unwrap();
    assert_eq!(problems.len(), 1, "seule la migration qui sort du module échoue : {problems:?}");
    assert_eq!(problems[0]["file"], json!("0002_hors_module.sql"));
    std::fs::remove_file(desk.space.join("modules/notes/migrations/0002_hors_module.sql")).unwrap();
    assert_eq!(desk.invoke("db.applyMigrations", json!({})).await, json!([]));
    let schema = desk.invoke("db.schema", json!({ "module": "notes" })).await.to_string();
    assert!(schema.contains("notes_items") && !schema.contains("banque_comptes"), "{schema}");

    // Une page écrit et relit ses lignes.
    let carnet = Frame::page(&desk, "notes/carnet");
    for texte in ["Acheter du pain", "Appeler le plombier"] {
        let written = carnet.execute("INSERT INTO notes_items (texte) VALUES (?1)", json!([texte])).await.unwrap();
        assert_eq!(written["changes"], json!(1));
    }
    carnet.execute("UPDATE notes_items SET fait = 1 WHERE texte = ?1", json!(["Acheter du pain"])).await.unwrap();
    let rows = carnet.query("SELECT texte, fait FROM notes_items ORDER BY id", json!([])).await.unwrap();
    assert_eq!(rows, json!([{ "texte": "Acheter du pain", "fait": 1 }, { "texte": "Appeler le plombier", "fait": 0 }]));
    let refused = carnet.query("DELETE FROM notes_items", json!([])).await.unwrap_err();
    assert!(refused.contains("db.execute"), "une lecture n’écrit pas : {refused}");

    // Cloisonnement : la page de la banque ne lit ni n’écrit les notes, et aucune page ne touche à la structure.
    let comptes = Frame::page(&desk, "banque/comptes");
    for attempt in [
        comptes.query("SELECT * FROM notes_items", json!([])).await,
        comptes.execute("DELETE FROM notes_items", json!([])).await,
        comptes.query("SELECT name FROM sqlite_master", json!([])).await,
        carnet.execute("DROP TABLE notes_items", json!([])).await,
        carnet.execute("CREATE TABLE notes_autre (id INTEGER)", json!([])).await,
    ] {
        let error = attempt.unwrap_err();
        assert!(error.contains("Requête refusée"), "{error}");
    }
    assert_eq!(carnet.query("SELECT count(*) AS n FROM notes_items", json!([])).await.unwrap()[0]["n"], json!(2));

    // Une fonction déclarée, écrite, puis appelée par l’interface (« Essayer la fonction » des Réglages).
    let declared = desk
        .invoke(
            "functions.declare",
            json!({
                "module": "notes", "id": "compter", "description": "Compte les notes restantes.",
                "input": { "type": "object", "properties": { "fait": { "type": "boolean" } } },
                "output": { "type": "object", "properties": { "total": { "type": "integer" } } },
            }),
        )
        .await;
    assert_eq!(declared["reference"], json!("notes/compter"));
    let function = desk.snapshot().await["functions"][0].clone();
    assert_eq!((function["reference"].as_str(), function["missing"].as_bool()), (Some("notes/compter"), Some(true)));
    desk.write(
        "modules/notes/functions/compter.ts",
        "import { db } from \"@alfred/sdk\";\n\nexport default async function compter(input: { fait?: boolean }) {\n  const [row] = await db.query(\"SELECT count(*) AS total FROM notes_items WHERE fait = ?\", [input.fait ? 1 : 0]);\n  return row;\n}\n",
    );
    desk.ui.define("notes/compter", |frame: Frame, input: Value| async move {
        let fait = i64::from(input["fait"].as_bool().unwrap_or(false));
        let rows = frame.query("SELECT count(*) AS total FROM notes_items WHERE fait = ?1", json!([fait])).await?;
        Ok(rows[0].clone())
    });
    let function = desk.snapshot().await["functions"][0].clone();
    assert_eq!((function["missing"].as_bool(), function["errors"].clone()), (Some(false), json!([])));
    let output = desk.invoke("functions.call", json!({ "function": "notes/compter", "input": { "fait": false } })).await;
    assert_eq!(output, json!({ "total": 1 }));
    let unknown = desk.refused("functions.call", json!({ "function": "notes/inconnue" })).await;
    assert!(unknown.contains("pas déclarée"), "{unknown}");

    // Une fonction en échec est appelée de même, et son erreur arrive au journal.
    desk.invoke("functions.declare", json!({ "module": "notes", "id": "casser", "description": "Échoue." })).await;
    desk.ui.define("notes/casser", |_frame: Frame, _input: Value| async move { Err("table absente".to_string()) });
    let failure = desk.refused("functions.call", json!({ "function": "notes/casser" })).await;
    assert_eq!(failure, "table absente");
    let journal = desk.journal("function").await;
    assert_eq!(journal.len(), 2);
    assert_eq!((journal[0]["subject"].as_str(), journal[0]["status"].as_str()), (Some("notes/casser"), Some("error")));
    assert_eq!((journal[1]["subject"].as_str(), journal[1]["status"].as_str()), (Some("notes/compter"), Some("ok")));
    assert_eq!(journal[1]["summary"], json!("Appelée par interface"));

    // Une page du même module appelle la fonction sans rien demander à l’utilisateur.
    assert_eq!(carnet.call("compter", json!({ "fait": true })).await.unwrap(), json!({ "total": 1 }));
    assert!(desk.ui.asked_resources().is_empty());

    // La page de la banque doit obtenir l’accord ; il est mémorisé, puis retiré dans les Réglages.
    desk.ui.answer_permissions(&[true]);
    assert_eq!(comptes.call("notes/compter", json!({})).await.unwrap(), json!({ "total": 1 }));
    assert_eq!(desk.ui.asked_resources(), ["banque/comptes → function:notes/compter"]);
    assert_eq!(desk.ui.asked.lock().unwrap()[0].label, "la fonction notes/compter");
    assert_eq!(comptes.call("notes/compter", json!({})).await.unwrap(), json!({ "total": 1 }));
    assert_eq!(desk.ui.asked_resources().len(), 1, "accord mémorisé : pas de seconde question");
    let grants = desk.invoke("grants.list", json!({})).await;
    assert!(
        grants.as_array().unwrap().iter().any(|grant| grant["subject"] == json!("page:banque/comptes")
            && grant["resource"] == json!("function:notes/compter")),
        "{grants}"
    );
    desk.invoke("grants.revoke", json!({ "subject": "page:banque/comptes", "resource": "function:notes/compter" })).await;
    assert_eq!(desk.invoke("grants.list", json!({})).await, json!([]));
    desk.ui.answer_permissions(&[false]);
    let denied = comptes.call("notes/compter", json!({})).await.unwrap_err();
    assert!(denied.starts_with("Accès refusé"), "{denied}");
    assert_eq!(desk.ui.asked_resources().len(), 2, "l’accord retiré est redemandé");

    // Les fonctions de la banque ont leurs propres accords, distincts de ceux de ses pages.
    desk.invoke("functions.declare", json!({ "module": "banque", "id": "resumer", "description": "Résumé." })).await;
    desk.ui.define("banque/resumer", |frame: Frame, _input: Value| async move { frame.call("notes/compter", json!({})).await });
    desk.ui.answer_permissions(&[true]);
    assert_eq!(desk.invoke("functions.call", json!({ "function": "banque/resumer" })).await, json!({ "total": 1 }));
    assert_eq!(desk.ui.asked_resources()[2], "banque/* → function:notes/compter");

    // Tout ce qui a été écrit est dans la base de l’espace, et la structure dans des fichiers versionnés.
    desk.invoke("space.commit", json!({ "message": "Tour : données" })).await;
    let tracked = git(&desk.space, &["ls-files"]);
    assert!(tracked.contains("modules/notes/migrations/0001_notes.sql"));
    assert!(!tracked.contains(".alfred/"), "la base de l’espace n’est pas versionnée : {tracked}");
}
