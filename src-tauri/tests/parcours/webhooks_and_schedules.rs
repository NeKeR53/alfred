//! Parcours 5 : un service appelle un webhook en HTTP réel, la planification lance une fonction due.

use hmac_free::signature;
use serde_json::{json, Value};

use crate::common::*;

/// HMAC-SHA256 écrit à la main (RFC 2104), comme le calculerait le service qui signe ses appels.
mod hmac_free {
    use sha2::{Digest, Sha256};

    pub fn signature(key: &[u8], message: &[u8]) -> String {
        let mut block = [0u8; 64];
        if key.len() > 64 {
            block[..32].copy_from_slice(&Sha256::digest(key));
        } else {
            block[..key.len()].copy_from_slice(key);
        }
        let pad = |byte: u8| block.iter().map(|value| value ^ byte).collect::<Vec<u8>>();
        let inner = Sha256::digest([pad(0x36), message.to_vec()].concat());
        let outer = Sha256::digest([pad(0x5c), inner.to_vec()].concat());
        outer.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn webhook_prouve_puis_planification_due() {
    let desk = Desk::open("Boutique").await;
    desk.invoke("space.placePage", json!({ "title": "Commandes", "target": { "kind": "menu", "label": "Ventes" } })).await;
    desk.write("modules/ventes/pages/commandes.tsx", PAGE);
    desk.write("modules/ventes/migrations/0001_commandes.sql", "CREATE TABLE ventes_commandes (id INTEGER PRIMARY KEY, source TEXT, contenu TEXT);\n");
    desk.invoke("db.applyMigrations", json!({})).await;
    for id in ["recevoir", "relancer"] {
        desk.invoke("functions.declare", json!({ "module": "ventes", "id": id, "description": id })).await;
        desk.write(&format!("modules/ventes/functions/{id}.ts"), "export default async function (input: unknown) { return input; }\n");
    }
    // La fonction du webhook enregistre l’appel et dit ce qu’elle a vu des en-têtes.
    desk.ui.define("ventes/recevoir", |frame: Frame, input: Value| async move {
        let contenu = input["body"].as_str().unwrap_or_default().to_string();
        frame.execute("INSERT INTO ventes_commandes (source, contenu) VALUES ('webhook', ?1)", json!([contenu])).await?;
        if contenu == "échec" {
            return Err("commande illisible".to_string());
        }
        let headers: Vec<String> = input["headers"].as_object().unwrap().keys().cloned().collect();
        Ok(json!({ "enregistree": true, "query": input["query"], "headers": headers, "method": input["method"] }))
    });
    desk.ui.define("ventes/relancer", |frame: Frame, input: Value| async move {
        frame.execute("INSERT INTO ventes_commandes (source, contenu) VALUES ('planification', ?1)", json!([input["client"]])).await?;
        Ok(json!({ "relance": input["client"] }))
    });

    let declared = desk.invoke("webhooks.declare", json!({ "module": "ventes", "id": "commande", "description": "Nouvelle commande.", "function": "recevoir" })).await;
    let url = declared["url"].as_str().unwrap().to_string();
    assert_eq!(url, desk.url("/hooks/ventes/commande"));
    let other_module = desk.refused("webhooks.declare", json!({ "module": "ventes", "id": "x", "function": "banque/payer" })).await;
    assert!(other_module.contains("propre module"), "{other_module}");
    let http = reqwest::Client::new();

    // Tant que l’utilisateur n’a pas lu le secret, aucun appel ne passe.
    assert_eq!(http.post(&url).header("X-Alfred-Secret", "devine").body("a").send().await.unwrap().status(), 401);
    let secret = desk.invoke("webhooks.secret", json!({ "hook": "ventes/commande" })).await["secret"].as_str().unwrap().to_string();
    let listed = desk.invoke("webhooks.list", json!({})).await;
    assert_eq!((listed[0]["functionExists"].as_bool(), listed[0]["lastReceivedAt"].clone()), (Some(true), Value::Null));
    assert!(!listed.to_string().contains(&secret), "la liste ne montre pas le secret");

    // Refus : sans preuve, avec un mauvais secret, une signature fausse, un module ou un webhook inconnu.
    assert_eq!(http.post(&url).body("sans preuve").send().await.unwrap().status(), 401);
    assert_eq!(http.post(&url).header("X-Alfred-Secret", "faux").send().await.unwrap().status(), 401);
    assert_eq!(http.post(&url).header("X-Hub-Signature-256", "sha256=00").body("x").send().await.unwrap().status(), 401);
    assert_eq!(http.post(desk.url("/hooks/ventes/inconnu")).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 404);
    assert_eq!(http.post(desk.url("/hooks/autre/commande")).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 404);

    // Chaque preuve admise : en-tête du secret, jeton porteur, paramètre d’URL, signature HMAC (deux en-têtes).
    let body = "commande 42";
    let signed = signature(secret.as_bytes(), body.as_bytes());
    let proven = [
        http.post(&url).header("X-Alfred-Secret", &secret),
        http.post(&url).bearer_auth(&secret),
        http.post(format!("{url}?secret={secret}&source=test")),
        http.post(&url).header("X-Hub-Signature-256", format!("sha256={signed}")),
        http.get(&url).header("X-Alfred-Signature", &signed),
    ];
    for (index, request) in proven.into_iter().enumerate() {
        let response = request.header("Cookie", "session=1").header("X-Commande", "42").body(body).send().await.unwrap();
        assert_eq!(response.status(), 200, "preuve n° {index}");
        let output: Value = response.json().await.unwrap();
        assert_eq!(output["enregistree"], json!(true));
        let headers = output["headers"].to_string();
        assert!(headers.contains("x-commande"), "{headers}");
        for hidden in ["authorization", "cookie", "x-alfred-secret", "x-hub-signature-256", "x-alfred-signature"] {
            assert!(!headers.contains(hidden), "la fonction ne voit pas « {hidden} » : {headers}");
        }
        assert!(!output["query"].to_string().contains(&secret), "le secret d’URL n’est pas transmis");
    }
    // Une fonction qui échoue : l’émetteur reçoit une erreur, sans détail.
    let failed = http.post(&url).header("X-Alfred-Secret", &secret).body("échec").send().await.unwrap();
    assert_eq!(failed.status(), 500);
    assert!(!failed.text().await.unwrap().contains("illisible"));

    let rows = Frame::page(&desk, "ventes/commandes").query("SELECT source FROM ventes_commandes", json!([])).await.unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 6, "cinq appels prouvés et l’échec ont exécuté la fonction");
    let journal = desk.journal("webhook").await;
    let refusals = journal.iter().filter(|line| line["summary"].as_str().unwrap().starts_with("refusé")).count();
    assert_eq!(refusals, 4, "les refus du webhook déclaré sont au journal (les adresses inconnues n’y sont pas)");
    assert_eq!(journal.iter().filter(|line| line["status"] == json!("ok")).count(), 5);
    assert_eq!(journal[0]["status"], json!("error"));
    assert!(desk.journal("function").await.iter().all(|line| line["detail"]["caller"] == json!("webhook")));
    assert!(desk.invoke("webhooks.list", json!({})).await[0]["lastReceivedAt"].is_string());

    // Nouveau secret : l’ancien ne passe plus. Webhook retiré : 404.
    let rotated = desk.invoke("webhooks.rotate", json!({ "hook": "ventes/commande" })).await["secret"].as_str().unwrap().to_string();
    assert_ne!(rotated, secret);
    assert_eq!(http.post(&url).header("X-Alfred-Secret", &secret).send().await.unwrap().status(), 401);
    desk.invoke("webhooks.remove", json!({ "hook": "ventes/commande" })).await;
    assert_eq!(http.post(&url).header("X-Alfred-Secret", &rotated).send().await.unwrap().status(), 404);

    // Planification : une due (jamais lancée), une suspendue. Au démarrage de la boucle, seule la première part.
    desk.invoke("schedules.declare", json!({ "module": "ventes", "id": "relance", "description": "Relance.", "function": "relancer", "everyMinutes": 30, "input": { "client": "Durand" } })).await;
    desk.invoke("schedules.declare", json!({ "module": "ventes", "id": "pause", "description": "En pause.", "function": "relancer", "everyMinutes": 1, "input": { "client": "Martin" } })).await;
    desk.invoke("schedules.setEnabled", json!({ "schedule": "ventes/pause", "enabled": false })).await;
    let both_conditions = desk.refused("schedules.declare", json!({ "module": "ventes", "id": "x", "function": "relancer", "everyMinutes": 5, "at": "08:00" })).await;
    assert!(!both_conditions.is_empty());
    let before = desk.invoke("schedules.list", json!({})).await;
    let relance = before.as_array().unwrap().iter().find(|item| item["id"] == json!("relance")).unwrap().clone();
    assert_eq!((relance["lastRunAt"].clone(), relance["enabled"].as_bool()), (Value::Null, Some(true)));
    alfred_lib::testing::start_schedules(&desk.state);
    eventually("la planification due s’exécute", || async {
        let list = desk.invoke("schedules.list", json!({})).await;
        list.as_array().unwrap().iter().any(|item| item["id"] == json!("relance") && item["lastStatus"] == json!("ok"))
    })
    .await;
    let list = desk.invoke("schedules.list", json!({})).await;
    let relance = list.as_array().unwrap().iter().find(|item| item["id"] == json!("relance")).unwrap();
    assert!(relance["lastRunAt"].is_string());
    assert!(relance["nextRunAt"].as_str().unwrap() > relance["lastRunAt"].as_str().unwrap(), "prochaine dans 30 minutes");
    let pause = list.as_array().unwrap().iter().find(|item| item["id"] == json!("pause")).unwrap();
    assert_eq!((pause["lastRunAt"].clone(), pause["nextRunAt"].clone()), (Value::Null, Value::Null));
    let journal = desk.journal("schedule").await;
    assert_eq!(journal.len(), 1);
    assert_eq!((journal[0]["subject"].as_str(), journal[0]["summary"].as_str()), (Some("ventes/relance"), Some("planification → fonction ventes/relancer")));

    // Lancée à la main depuis les Réglages, même suspendue.
    let manual = desk.invoke("schedules.runNow", json!({ "schedule": "ventes/pause" })).await;
    assert_eq!(manual, json!({ "ok": true, "output": { "relance": "Martin" } }));
    let rows = Frame::page(&desk, "ventes/commandes")
        .query("SELECT contenu FROM ventes_commandes WHERE source = 'planification' ORDER BY id", json!([]))
        .await
        .unwrap();
    assert_eq!(rows, json!([{ "contenu": "Durand" }, { "contenu": "Martin" }]));
    assert_eq!(desk.journal("schedule").await[0]["summary"], json!("exécution manuelle → fonction ventes/relancer"));
}
