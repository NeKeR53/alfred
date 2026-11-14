//! Parcours 4 : un agent construit un module par les outils du serveur MCP, en HTTP réel avec son jeton.

use serde_json::{json, Value};

use crate::common::*;

/// Client MCP minimal, tel qu’un harnais d’agent l’utilise (JSON-RPC en POST, jeton dans `Authorization`).
struct Agent<'a> {
    desk: &'a Desk,
    token: String,
    http: reqwest::Client,
    next: u64,
}

impl<'a> Agent<'a> {
    fn new(desk: &'a Desk, conversation: &str) -> Self {
        let token = unique("jeton-agent");
        alfred_lib::testing::register_agent(&desk.state, &token, conversation);
        Self { desk, token, http: reqwest::Client::new(), next: 0 }
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let response = self
            .http
            .post(self.desk.url("/mcp"))
            .bearer_auth(&self.token)
            .json(&json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let reply: Value = response.json().await.unwrap();
        assert_eq!(reply["id"], json!(self.next));
        reply
    }

    /// Appelle un outil ; `Ok` porte la réponse (JSON si elle en est), `Err` le texte d’une erreur d’outil.
    async fn tool(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
        let reply = self.rpc("tools/call", json!({ "name": name, "arguments": arguments })).await;
        let result = &reply["result"];
        let text = result["content"][0]["text"].as_str().unwrap_or_default().to_string();
        if result["isError"] == json!(true) {
            return Err(text);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    async fn ok(&mut self, name: &str, arguments: Value) -> Value {
        self.tool(name, arguments.clone()).await.unwrap_or_else(|error| panic!("{name} {arguments} : {error}"))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn un_agent_construit_un_module_jusqu_au_check_vert() {
    let desk = Desk::open("Cuisine").await;
    let remote = Remote::start().await;

    // Sans jeton d’agent connu, le serveur ne répond pas.
    let anonymous = reqwest::Client::new()
        .post(desk.url("/mcp"))
        .bearer_auth("invente")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);

    let mut agent = Agent::new(&desk, "conversation-1");
    let hello = agent.rpc("initialize", json!({ "protocolVersion": "2025-03-26" })).await;
    assert_eq!(hello["result"]["serverInfo"]["name"], json!("alfred"));
    let tools = agent.rpc("tools/list", json!({})).await;
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    for expected in ["space_overview", "place_page", "declare_function", "declare_client", "declare_webhook", "declare_schedule", "check", "db_query", "call_function"] {
        assert!(names.contains(&expected), "{expected} absent de {names:?}");
    }

    let overview = agent.ok("space_overview", json!({})).await;
    assert_eq!((overview["space"]["name"].as_str(), overview["sections"].clone()), (Some("Cuisine"), json!([])));

    // Sans emplacement, la page devient une entrée du menu à son nom : aucune question à l’utilisateur.
    let placed = agent.ok("place_page", json!({ "title": "Liste de courses", "description": "Ce qu’il faut acheter.", "icon": "shopping-cart" })).await;
    assert_eq!(placed["page"], json!("liste-de-courses/liste-de-courses"));
    agent.ok("delete_page", json!({ "page": placed["page"] })).await;
    let placed = agent
        .ok("place_page", json!({ "title": "Liste de courses", "icon": "shopping-cart", "placement": { "kind": "menu", "label": "Courses", "color": "green" } }))
        .await;
    assert_eq!(placed["page"], json!("courses/liste-de-courses"));
    let panel = agent.ok("place_page", json!({ "title": "Article", "placement": { "kind": "panel", "page": "courses/liste-de-courses" } })).await;
    assert!(desk.ui.questions.lock().unwrap().is_empty(), "aucune carte montrée");

    // `check` rouge : pages pas écrites.
    let check = agent.ok("check", json!({})).await;
    assert_eq!(check["ok"], json!(false));
    assert_eq!(check["pages"].as_array().unwrap().len(), 2);

    // L’agent écrit ses fichiers, dont un import interdit, une migration et une fonction offerte comme outil.
    std::fs::write(placed["file"].as_str().unwrap(), "import _ from \"lodash\";\nexport default function Vue() { return null; }\n").unwrap();
    std::fs::write(panel["file"].as_str().unwrap(), PAGE).unwrap();
    desk.write("modules/courses/migrations/0001_articles.sql", "CREATE TABLE courses_articles (id INTEGER PRIMARY KEY, nom TEXT NOT NULL);\n");
    let declared = agent
        .ok(
            "declare_function",
            json!({
                "module": "courses", "id": "ajouter", "description": "Ajoute un article à la liste.",
                "input": { "type": "object", "properties": { "nom": { "type": "string" } }, "required": ["nom"] },
                "output": { "type": "object" }, "tool": true,
            }),
        )
        .await;
    assert_eq!(declared["function"], json!("courses/ajouter"));
    desk.ui.define("courses/ajouter", |frame: Frame, input: Value| async move {
        frame.execute("INSERT INTO courses_articles (nom) VALUES (?1)", json!([input["nom"]])).await?;
        Ok(frame.query("SELECT count(*) AS articles FROM courses_articles", json!([])).await?[0].clone())
    });
    let check = agent.ok("check", json!({ "module": "courses" })).await;
    assert_eq!(check["ok"], json!(false));
    assert!(check["pages"][0]["errors"][0]["message"].as_str().unwrap().contains("Import interdit"), "{check}");
    assert_eq!(check["functions"][0]["function"], json!("courses/ajouter"));
    std::fs::write(declared["file"].as_str().unwrap(), "export default async function ajouter(input: { nom: string }) {\n  return input;\n}\n").unwrap();
    std::fs::write(placed["file"].as_str().unwrap(), PAGE).unwrap();

    // Client, webhook et planification déclarés par l’agent ; l’une d’elles est mal écrite.
    let client = agent
        .ok("declare_client", json!({ "client": { "id": "meteo", "label": "Météo", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "bearer", "secret": "vole" } }, "create": true }))
        .await;
    assert_eq!(client["status"], json!("toValidate"));
    let file = desk.read("clients/meteo.json").unwrap();
    assert!(file.contains("\"vole\""), "l’agent choisit l’entrée du coffre : {file}");
    let hook = agent.ok("declare_webhook", json!({ "module": "courses", "id": "commande", "description": "Le drive confirme.", "function": "enregistrer" })).await;
    assert_eq!(hook["url"], json!(desk.url("/hooks/courses/commande")));
    let invalid = agent.tool("declare_schedule", json!({ "module": "courses", "id": "matin", "description": "Rappel.", "function": "ajouter", "at": "25:00" })).await.unwrap_err();
    assert!(invalid.contains("HH:MM"), "{invalid}");

    // Une page affichée rapporte une erreur d’exécution.
    desk.ui.frame_errors.lock().unwrap().push(json!({ "page": "courses/article", "phase": "render", "file": "pages/article.tsx", "line": 3 }));
    let check = agent.ok("check", json!({})).await;
    assert_eq!(check["ok"], json!(false));
    assert_eq!(check["pages"], json!([]));
    assert_eq!(check["functions"], json!([]));
    assert_eq!(check["webhooks"][0]["hook"], json!("courses/commande"));
    assert!(check["webhooks"][0]["problem"].as_str().unwrap().contains("declare_function"), "{check}");
    assert_eq!(check["runtimeErrors"][0]["page"], json!("courses/article"));
    assert!(check["clients"].to_string().contains("meteo"), "le client à valider est un problème que l’agent règle");
    assert_eq!(check["userActions"], json!([]));

    // L’agent corrige ; l’utilisateur a rechargé la page : `check` passe au vert.
    agent.ok("declare_webhook", json!({ "module": "courses", "id": "commande", "description": "Le drive confirme.", "function": "ajouter" })).await;
    agent.ok("declare_schedule", json!({ "module": "courses", "id": "matin", "description": "Rappel.", "function": "ajouter", "everyMinutes": 60, "input": { "nom": "pain" } })).await;
    desk.ui.frame_errors.lock().unwrap().clear();
    // Le secret va au coffre par une commande dont la sortie n’est jamais renvoyée ; le client est relié et validé.
    let stored = agent.ok("vault_store", json!({ "label": "Jeton météo", "kind": "token", "fromCommand": { "value": "printf jeton-meteo-secret" } })).await;
    assert!(!stored.to_string().contains("jeton-meteo-secret"), "{stored}");
    agent
        .ok("declare_client", json!({ "client": { "id": "meteo", "label": "Météo", "baseUrl": format!("{}/api", remote.origin), "auth": { "type": "bearer", "secret": stored["entry"] } } }))
        .await;
    assert_eq!(agent.ok("validate_client", json!({ "client": "meteo" })).await["status"], json!("ready"));
    agent.ok("grant_access", json!({ "to": "courses/liste-de-courses", "client": "meteo" })).await;
    let check = agent.ok("check", json!({})).await;
    assert_eq!(check["ok"], json!(true), "{check}");

    // Base de données et fonctions depuis l’agent.
    let schema = agent.ok("db_schema", json!({ "module": "courses" })).await.to_string();
    assert!(schema.contains("courses_articles"), "{schema}");
    agent.ok("db_query", json!({ "module": "courses", "sql": "INSERT INTO courses_articles (nom) VALUES (?1)", "params": ["lait"] })).await;
    let called = agent.ok("call_function", json!({ "function": "courses/ajouter", "input": { "nom": "œufs" } })).await;
    assert_eq!(called, json!({ "articles": 2 }));
    let tools = agent.rpc("tools/list", json!({})).await.to_string();
    assert!(tools.contains("fn__courses__ajouter"), "la fonction est offerte comme outil");
    assert_eq!(agent.ok("fn__courses__ajouter", json!({ "nom": "beurre" })).await, json!({ "articles": 3 }));
    let rows = agent.ok("db_query", json!({ "module": "courses", "sql": "SELECT nom FROM courses_articles ORDER BY id" })).await;
    assert_eq!(rows, json!([{ "nom": "lait" }, { "nom": "œufs" }, { "nom": "beurre" }]));
    let outside = agent.tool("db_query", json!({ "module": "courses", "sql": "SELECT * FROM _alfred_migrations" })).await.unwrap_err();
    assert!(outside.contains("Requête refusée"), "{outside}");
    let journal = desk.journal("function").await;
    assert!(journal.iter().all(|line| line["detail"]["caller"] == json!("agent")), "{journal:?}");

    // Une conversation lancée par une page reste dans le module de cette page.
    desk.invoke("space.placePage", json!({ "title": "Coffre", "target": { "kind": "menu", "label": "Banque" } })).await;
    desk.ui.answer_permissions(&[true]);
    desk.invoke(
        "frame.agents.authorize",
        json!({ "subject": { "kind": "page", "module": "banque", "reference": "banque/coffre" }, "conversation": "conversation-2" }),
    )
    .await;
    let mut scoped = Agent::new(&desk, "conversation-2");
    let denied = scoped.tool("call_function", json!({ "function": "courses/ajouter", "input": { "nom": "x" } })).await.unwrap_err();
    assert!(denied.contains("banque"), "{denied}");
    let denied = scoped.tool("place_page", json!({ "title": "Piège", "placement": { "kind": "settings" } })).await.unwrap_err();
    assert!(denied.contains("banque"), "{denied}");
    assert!(desk.journal("agent").await.iter().any(|line| line["subject"] == json!("place_page")), "les refus sont au journal");
}
