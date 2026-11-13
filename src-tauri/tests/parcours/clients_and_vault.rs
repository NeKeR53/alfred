//! Parcours 3 : coffre et clients HTTP, chaque type d’authentification contre un vrai service local.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::common::*;

const TOKEN: &str = "t0k3n-b34r3r-AAA";
const API_KEY: &str = "k3y-4p1-BBB";
const PASSWORD: &str = "p4ssw0rd-CCC";
/// `lea:p4ssw0rd-CCC` en Base64 : la forme sous laquelle le mot de passe part.
const BASIC: &str = "bGVhOnA0c3N3MHJkLUNDQw==";
const SECRETS: [&str; 5] = [TOKEN, API_KEY, PASSWORD, BASIC, REMOTE_CLIENT_SECRET];

fn status_of(list: &Value, id: &str) -> String {
    let client = list["clients"].as_array().unwrap().iter().find(|client| client["id"] == json!(id)).unwrap();
    client["status"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn chaque_authentification_valide_accordee_sans_fuite() {
    let desk = Desk::open("Bureau").await;
    let remote = Remote::start().await;
    let base = format!("{}/api", remote.origin);
    desk.invoke("space.placePage", json!({ "title": "Contacts", "target": { "kind": "menu", "label": "CRM" } })).await;
    desk.write("modules/crm/pages/contacts.tsx", PAGE);
    let page = Frame::page(&desk, "crm/contacts");
    let mut outputs: Vec<String> = Vec::new();

    // Coffre : les secrets partent dans le trousseau (ici en mémoire), la liste n’en dit que la présence.
    let (token, key, account, machine, sso) = (unique("jeton"), unique("cle"), unique("compte"), unique("machine"), unique("sso"));
    for entry in [
        json!({ "id": token, "label": "Jeton", "kind": "token", "secrets": { "value": TOKEN } }),
        json!({ "id": key, "label": "Clé", "kind": "token", "secrets": { "value": API_KEY } }),
        json!({ "id": account, "label": "Compte", "kind": "basic", "meta": { "username": "lea" }, "secrets": { "password": PASSWORD } }),
        json!({ "id": machine, "label": "Machine", "kind": "clientCredentials", "meta": { "clientId": REMOTE_CLIENT_ID }, "secrets": { "clientSecret": REMOTE_CLIENT_SECRET } }),
        json!({ "id": sso, "label": "SSO", "kind": "oauth2", "meta": { "clientId": REMOTE_CLIENT_ID } }),
    ] {
        outputs.push(desk.invoke("vault.save", entry).await.to_string());
    }
    let vault = desk.invoke("vault.list", json!({})).await;
    let listed = vault.as_array().unwrap().iter().find(|entry| entry["id"] == json!(account)).unwrap();
    assert_eq!((listed["hasSecret"].as_bool(), listed["meta"]["username"].as_str()), (Some(true), Some("lea")));
    outputs.push(vault.to_string());
    let stored: Vec<String> =
        memory_keyring().lock().unwrap().values().map(|value| String::from_utf8_lossy(value).into_owned()).collect();
    assert!(stored.iter().any(|value| value.contains(PASSWORD)), "le secret est bien dans le trousseau de test");

    // Clients enregistrés dans les Réglages : validés d’emblée ; l’OAuth attend la connexion.
    let token_url = format!("{}/token", remote.origin);
    for client in [
        json!({ "id": "public", "label": "Public", "baseUrl": base, "auth": { "type": "none" }, "headers": { "Accept": "application/json" } }),
        json!({ "id": "porteur", "label": "Porteur", "baseUrl": base, "auth": { "type": "bearer", "secret": token } }),
        json!({ "id": "entete", "label": "En-tête", "baseUrl": base, "auth": { "type": "apiKey", "secret": key, "header": "X-Api-Key", "prefix": "Token " } }),
        json!({ "id": "parametre", "label": "Paramètre", "baseUrl": base, "auth": { "type": "apiKey", "secret": key, "queryParam": "api_key" } }),
        json!({ "id": "basique", "label": "Basique", "baseUrl": base, "auth": { "type": "basic", "secret": account } }),
        json!({ "id": "machine", "label": "Machine", "baseUrl": base, "auth": { "type": "clientCredentials", "secret": machine, "tokenUrl": token_url, "scopes": ["lecture"] } }),
        json!({ "id": "portail", "label": "Portail", "baseUrl": base, "auth": { "type": "oauth2", "secret": sso, "authorizationUrl": format!("{}/authorize", remote.origin), "tokenUrl": token_url, "scopes": ["lire"] } }),
    ] {
        outputs.push(desk.invoke("clients.save", json!({ "client": client })).await.to_string());
    }
    let list = desk.invoke("clients.list", json!({})).await;
    for id in ["public", "porteur", "entete", "parametre", "basique", "machine"] {
        assert_eq!(status_of(&list, id), "ready", "{id}");
    }
    assert_eq!(status_of(&list, "portail"), "toConnect");

    // Premier usage par la page : l’utilisateur accorde chaque client une fois.
    desk.ui.answer_permissions(&[true; 8]);
    let call = |path: &str| json!({ "method": "POST", "path": path, "query": { "page": 2 }, "body": { "nom": "Durand" } });
    let response = page.request("public", call("/echo/contacts")).await.unwrap();
    assert_eq!((response["status"].as_u64(), response["body"]["path"].as_str()), (Some(200), Some("/api/echo/contacts")));
    let seen = remote.last();
    assert_eq!((seen.method.as_str(), seen.query.as_str()), ("POST", "page=2"));
    assert_eq!(seen.headers["accept"], "application/json");
    assert!(seen.body.contains("Durand") && !seen.headers.contains_key("authorization"));

    type Check = fn(&Seen) -> bool;
    let expectations: [(&str, Check); 5] = [
        ("porteur", |seen| seen.headers.get("authorization").map(String::as_str) == Some("Bearer t0k3n-b34r3r-AAA")),
        ("entete", |seen| seen.headers.get("x-api-key").map(String::as_str) == Some("Token k3y-4p1-BBB")),
        ("parametre", |seen| seen.query.contains("api_key=k3y-4p1-BBB")),
        ("basique", |seen| seen.headers.get("authorization").map(String::as_str) == Some("Basic bGVhOnA0c3N3MHJkLUNDQw==")),
        ("machine", |seen| seen.headers.get("authorization").is_some_and(|value| value.starts_with("Bearer acc3ss-t0k3n"))),
    ];
    for (client, check) in expectations {
        let response = page.request(client, json!({ "path": "/echo" })).await.unwrap();
        assert!(check(&remote.last()), "{client} : {:?}", remote.last());
        // Le service renvoie la requête en écho : le secret est masqué avant d’arriver à la page.
        outputs.push(response.to_string());
    }
    let grants = remote.state.token_requests.lock().unwrap().clone();
    assert_eq!(grants[0]["grant_type"], "client_credentials");
    assert_eq!(grants[0]["scope"], "lecture");
    let asked = desk.ui.asked_resources();
    assert_eq!(asked.len(), 6);
    assert!(asked.iter().all(|asked| asked.starts_with("crm/contacts → client:")));
    assert!(desk.ui.asked.lock().unwrap()[1].label.contains("Porteur"));
    // Accord mémorisé : la même page ne redemande pas.
    page.request("porteur", json!({ "path": "/echo" })).await.unwrap();
    assert_eq!(desk.ui.asked_resources().len(), 6);

    // OAuth 2 (PKCE) : la page reçoit une consigne, l’utilisateur se connecte chez le fournisseur, puis la page passe.
    let not_connected = page.request("portail", json!({ "path": "/protege" })).await.unwrap_err();
    assert!(not_connected.contains("Se connecter"), "{not_connected}");
    let started = desk.invoke("clients.connect", json!({ "id": "portail" })).await;
    let authorization = query_of(started["authorizationUrl"].as_str().unwrap());
    assert_eq!((authorization["client_id"].as_str(), authorization["code_challenge_method"].as_str()), (REMOTE_CLIENT_ID, "S256"));
    let callback = format!("{}?code={}&state={}", desk.url("/oauth/callback"), remote.issue_code(), authorization["state"]);
    let page_html = reqwest::get(&callback).await.unwrap();
    assert_eq!(page_html.status(), 200);
    assert!(page_html.text().await.unwrap().contains("Connexion réussie"));
    assert_eq!(status_of(&desk.invoke("clients.list", json!({})).await, "portail"), "ready");
    let protected = page.request("portail", json!({ "path": "/protege" })).await.unwrap();
    assert_eq!(protected["body"], json!({ "utilisateur": "lea" }));
    let exchange = remote.state.token_requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(exchange["grant_type"], "authorization_code");
    assert!(!exchange.contains_key("client_secret"), "application publique : aucun secret client");

    // Un client créé hors des Réglages (par l’agent) est « à valider » et refusé avant même la question d’accord.
    let declared = desk
        .invoke(
            "clients.declare",
            json!({ "client": { "id": "agenda", "label": "Agenda", "baseUrl": base, "auth": { "type": "bearer", "secret": token } }, "create": true }),
        )
        .await;
    assert_eq!(declared["status"], json!("toValidate"));
    let asked_before = desk.ui.asked_resources().len();
    let refused = page.request("agenda", json!({ "path": "/echo" })).await.unwrap_err();
    assert!(refused.contains("valider"), "{refused}");
    assert_eq!(desk.ui.asked_resources().len(), asked_before, "pas d’accord demandé pour un client non validé");
    let requests_before = remote.requests();

    // L’utilisateur le valide sur ce que la liste lui a montré ; une valeur changée entre-temps n’est pas validée.
    let list = desk.invoke("clients.list", json!({})).await;
    let agenda = list["clients"].as_array().unwrap().iter().find(|client| client["id"] == json!("agenda")).unwrap();
    let fingerprint = agenda["validation"]["fingerprint"].clone();
    let stale = desk.refused("clients.validate", json!({ "id": "agenda", "fingerprint": { "baseUrl": "x" } })).await;
    assert!(stale.contains("a changé"), "{stale}");
    desk.invoke("clients.validate", json!({ "id": "agenda", "fingerprint": fingerprint })).await;
    page.request("agenda", json!({ "path": "/echo" })).await.unwrap();
    assert_eq!(remote.requests(), requests_before + 1);
    assert!(desk.ui.asked_resources().last().unwrap().ends_with("client:agenda"));

    // L’agent réécrit le fichier pour envoyer le secret ailleurs : le client redevient « à valider ».
    let file = desk.read("clients/agenda.json").unwrap();
    desk.write("clients/agenda.json", &file.replace("/api", "/ailleurs"));
    assert_eq!(status_of(&desk.invoke("clients.list", json!({})).await, "agenda"), "toValidate");
    assert!(page.request("agenda", json!({ "path": "/echo" })).await.unwrap_err().contains("valider"));
    assert_eq!(remote.requests(), requests_before + 1, "rien n’est parti vers la nouvelle adresse");

    // Une page ne sort pas de l’adresse de base du client.
    let escape = page.request("porteur", json!({ "path": "/../token" })).await;
    assert!(escape.is_err(), "{escape:?}");

    // Le secret n’est jamais renvoyé : ni par les commandes, ni dans les réponses, ni au journal, ni dans l’espace.
    outputs.push(desk.invoke("clients.list", json!({})).await.to_string());
    outputs.push(desk.invoke("vault.list", json!({})).await.to_string());
    outputs.push(Value::Array(desk.journal("client").await).to_string());
    assert!(desk.journal("client").await.iter().any(|line| line["status"] == json!("error")), "refus inscrits au journal");
    for output in &outputs {
        assert_no_leak("sortie d’une commande", output, &SECRETS);
    }
    desk.invoke("space.commit", json!({ "message": "Clients" })).await;
    let mut files: HashMap<String, String> = HashMap::new();
    for entry in std::fs::read_dir(desk.space.join("clients")).unwrap() {
        let path = entry.unwrap().path();
        files.insert(path.display().to_string(), std::fs::read_to_string(&path).unwrap());
    }
    for (path, content) in &files {
        assert_no_leak(path, content, &SECRETS);
    }
    let history = git(&desk.space, &["log", "-p", "--all"]);
    assert_no_leak("historique git de l’espace", &history, &SECRETS);
}
