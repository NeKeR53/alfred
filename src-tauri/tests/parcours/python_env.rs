//! Paquets Python d’un module : déclarés dans `module.json`, installés avec uv au premier appel d’une fonction
//! Python, visibles dans les Réglages (`python.envs`), réinstallables. Sauté sans uv ou sans réseau.

use serde_json::json;

use crate::common::Desk;

const MANIFEST: &str = r#"{
  "id": "analyse",
  "name": "Analyse",
  "version": "0.1.0",
  "python": { "requirements": ["six==1.16.0"] },
  "functions": [{ "id": "version", "description": "Version de six.", "runtime": "python" }]
}"#;

const SCRIPT: &str = "import alfred, json, six, sys\njson.load(sys.stdin)\nprint(json.dumps({\"six\": six.__version__, \"python\": sys.executable}))\n";

#[tokio::test]
async fn un_module_declare_ses_paquets_et_les_trouve_au_premier_appel() {
    let desk = Desk::open("Labo").await;
    desk.write("modules/analyse/module.json", MANIFEST);
    desk.write("modules/analyse/functions/version.py", SCRIPT);

    let envs = desk.invoke("python.envs", json!({})).await;
    if envs["uv"] != json!(true) {
        eprintln!("uv absent : parcours sauté");
        return;
    }
    assert_eq!(envs["envs"][0]["module"], json!("analyse"));
    assert_eq!(envs["envs"][0]["status"], json!("pending"));

    let output = match desk.try_invoke("functions.call", json!({ "function": "analyse/version", "input": {} })).await {
        Ok(output) => output,
        Err(error) if error.contains("sans réseau") => {
            eprintln!("hors ligne : parcours sauté ({error})");
            return;
        }
        Err(error) => panic!("{error}"),
    };
    assert_eq!(output["six"], json!("1.16.0"));
    let python = output["python"].as_str().unwrap();
    assert!(python.contains(".alfred/python/analyse"), "l’interpréteur de l’environnement du module : {python}");

    let envs = desk.invoke("python.envs", json!({})).await;
    assert_eq!(envs["envs"][0]["status"], json!("ready"), "{envs}");
    // Le dossier de l’environnement n’est pas suivi par git.
    let ignore = desk.read(".gitignore").unwrap_or_default();
    assert!(ignore.contains(".alfred/"), "{ignore}");

    // Une déclaration fautive est signalée dans la vue de l’espace, sans casser le module.
    desk.write("modules/analyse/module.json", &MANIFEST.replace("\"requirements\"", "\"requirement\""));
    let snapshot = desk.snapshot().await.to_string();
    assert!(snapshot.contains("Champ inconnu dans `python`"), "{snapshot}");
    desk.write("modules/analyse/module.json", MANIFEST);

    // « Réinstaller » refait l’environnement en arrière-plan.
    desk.invoke("python.reinstall", json!({ "module": "analyse" })).await;
    for _ in 0..600 {
        let envs = desk.invoke("python.envs", json!({})).await;
        if envs["envs"][0]["status"] == json!("ready") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("la réinstallation n’a pas fini en une minute");
}
