//! Examen de la capture de chaque page, rapporté par `check`. L’interface charge la page dans deux cadres
//! invisibles, à la taille de sa zone dans une fenêtre de 1440 × 900 (panneau ouvert si la page en a un : 928 ×
//! 862 px, sinon 1200 × 862 px) puis dans une fenêtre de 1024 de large (784 × 862 px). Elle mesure le document rendu
//! (`src/runtime/reviewPage.ts`) : ce qui commence sous la ligne de flottaison, la largeur occupée, les bandes vides,
//! les textes coupés, ce qui déborde en largeur, les boutons pleins, et le contraste des textes en clair et en sombre.
//! Ce module en tire les remarques, avec leurs seuils, et garde le résultat d’une page tant que les fichiers de son
//! module ne changent pas.
//!
//! Des mesures et pas l’analyse de l’image : le document donne la place exacte de chaque texte, de chaque contrôle et
//! de chaque cadre, alors qu’une image se lit mal (anticrénelage, ombres, traits fins). Reste hors de portée : le
//! contenu d’un graphique dessiné dans un `canvas` ou d’une image.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use crate::state::AppState;

/// Pages examinées au plus par `check` : les plus récemment modifiées d’abord, les autres au `check` suivant.
pub const MAX_PAGES: usize = 6;
/// Délai de l’interface par page (deux cadres chargés en même temps, données comprises), puis en plus.
const PER_PAGE: Duration = Duration::from_secs(14);
const BASE: Duration = Duration::from_secs(8);
/// Part de la largeur sous laquelle le contenu laisse les côtés vides.
const MIN_COVERAGE: f64 = 0.66;
/// Le contenu doit occuper ce rapport de la hauteur pour que sa largeur soit jugée (un état vide est étroit et court).
const MIN_COVERED_HEIGHT: f64 = 0.4;
/// Bande vide qui se voit entre deux blocs : bien plus que l’écart de 24 px de `Page`.
const MIN_GAP: f64 = 120.0;
/// Écrans de hauteur à partir desquels la page se dit longue.
const LONG_PAGE: f64 = 1.5;

/// Une page à examiner.
pub struct Candidate {
    /// `module/page`.
    pub reference: String,
    pub file: PathBuf,
    pub module_dir: PathBuf,
    /// Un texte à lire ou une conversation : ni sa hauteur ni sa largeur ne se jugent.
    pub reading: bool,
    /// La page a un panneau de droite : elle se mesure panneau ouvert.
    pub panel: bool,
    /// La page attend un compte : elle se mesure avec les données d’exemple de son module.
    pub examples: bool,
}

fn cache() -> &'static Mutex<HashMap<String, (u64, Value)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(root: &Path, reference: &str) -> String {
    format!("{}\u{0}{reference}", root.display())
}

/// Empreinte de ce qui fait le rendu de la page : les fichiers `.ts` et `.tsx` de son module, sa façon d’être
/// mesurée et la version de socle-ui.
fn fingerprint(candidate: &Candidate) -> u64 {
    let mut hasher = DefaultHasher::new();
    crate::socle_ui::VERSION.hash(&mut hasher);
    (candidate.panel, candidate.examples, candidate.reading).hash(&mut hasher);
    let mut files = Vec::new();
    collect_sources(&candidate.module_dir, 0, &mut files);
    files.sort();
    for file in files {
        file.hash(&mut hasher);
        std::fs::read(&file).unwrap_or_default().hash(&mut hasher);
    }
    hasher.finish()
}

fn collect_sources(dir: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            // Le code d’une librairie installée (`vendor`) ne change qu’avec `set_libraries`, qui touche `module.json`.
            if depth < 6 && !name.starts_with('.') && name != "vendor" && name != "node_modules" {
                collect_sources(&path, depth + 1, files);
            }
        } else if name.ends_with(".ts") || name.ends_with(".tsx") || name == "module.json" {
            files.push(path);
        }
    }
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn quoted(value: &Value) -> String {
    let text = text(value);
    if text.is_empty() {
        "sans titre".to_string()
    } else {
        format!("« {text} »")
    }
}

fn percent(value: f64) -> String {
    format!("{} %", (value * 100.0).round() as i64)
}

/// Remarques sur les mesures d’une page (`viewports` : la première dans la fenêtre de 1440 × 900, la seconde dans
/// celle de 1024 de large). Chaque remarque dit quoi écrire à la place.
pub fn findings(viewports: &[Value], reading: bool) -> Vec<String> {
    let mut found = Vec::new();
    let Some(wide) = viewports.first() else { return found };
    let window = text(&wide["window"]);
    let layout = &wide["layout"];
    let (width, height) = (number(&layout["width"]), number(&layout["height"]));
    if layout["busy"] == json!(true) {
        found.push(format!(
            "La page chargeait encore après plusieurs secondes (fenêtre de {window}) : sa mise en page n’est pas jugée. Lire `page_logs` : une donnée qui n’arrive pas laisse la page en chargement."
        ));
    } else if height > 0.0 && width > 0.0 {
        let bottom = number(&layout["contentBottom"]);
        let top = number(&layout["contentTop"]);
        let blocks: Vec<String> = layout["belowFold"]
            .as_array()
            .into_iter()
            .flatten()
            .take(4)
            .map(|block| {
                let kind = match block["kind"].as_str() {
                    Some("collection") => "liste",
                    Some("alert") => "alerte",
                    Some("action") => "bouton plein",
                    _ => "titre",
                };
                format!("{} ({kind}, à {} px)", quoted(&block["text"]), number(&block["top"]).round())
            })
            .collect();
        if !blocks.is_empty() && !reading {
            let screens = bottom / height;
            let length = if screens >= LONG_PAGE {
                let unit = if screens >= 2.0 { "écrans" } else { "écran" };
                format!(" ; la page fait {} px, soit {:.1} {unit}", bottom.round(), screens).replace('.', ",")
            } else {
                String::new()
            };
            found.push(format!(
                "Sous la ligne de flottaison (fenêtre de {window}) : {} commencent sous les {} px visibles{length}. Mettre les informations clés dans le premier écran : un usage par onglet, les blocs courts côte à côte (`PageGrid`), l’élément choisi au panneau de droite, les exemples dans l’état vide (DESIGN.md, règle 11 et section 2).",
                blocks.join(", "),
                height.round()
            ));
        }
        let covered = number(&layout["contentRight"]) - number(&layout["contentLeft"]);
        if !reading && covered > 0.0 && covered / width < MIN_COVERAGE && (bottom - top) >= MIN_COVERED_HEIGHT * height {
            found.push(format!(
                "Zone vide (fenêtre de {window}) : le contenu n’occupe que {} px des {} px de la page ({}), les côtés restent vides. Le contenu prend toute la largeur : retirer `width=\"text\"` de `Page`, ranger les blocs courts côte à côte (`PageGrid`) (DESIGN.md, règle 11).",
                covered.round(),
                width.round(),
                percent(covered / width)
            ));
        }
        for gap in layout["gaps"].as_array().into_iter().flatten() {
            if number(&gap["height"]) >= MIN_GAP {
                found.push(format!(
                    "Bande vide de {} px (fenêtre de {window}) entre {} et {} : un bloc vide, une hauteur fixe ou un état vide trop grand. La retirer, ou ranger les blocs voisins côte à côte (`PageGrid`).",
                    number(&gap["height"]).round(),
                    quoted(&gap["above"]),
                    quoted(&gap["below"])
                ));
            }
        }
        let filled: Vec<String> = layout["filledButtons"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|button| number(&button["top"]) < height)
            .map(|button| quoted(&button["text"]))
            .collect();
        if filled.len() > 1 {
            found.push(format!(
                "{} boutons pleins dans le premier écran ({}) : un seul bouton plein par écran (D-220 ; DESIGN.md, section 4). Garder `primary` sur l’action attendue, le retirer des autres.",
                filled.len(),
                filled.join(", ")
            ));
        }
    }

    // Textes coupés et débordement : à chaque largeur.
    let mut cut: Vec<(String, usize, Vec<String>)> = Vec::new();
    for viewport in viewports {
        let layout = &viewport["layout"];
        let count = number(&layout["truncatedCount"]) as usize;
        if count > 0 {
            let examples = layout["truncated"]
                .as_array()
                .into_iter()
                .flatten()
                .take(3)
                .map(|item| format!("{} ({} visible)", quoted(&item["text"]), percent(number(&item["shown"]))))
                .collect();
            cut.push((text(&viewport["window"]), count, examples));
        }
        for overflow in layout["overflow"].as_array().into_iter().flatten() {
            let hidden = number(&overflow["hidden"]).round();
            let window = text(&viewport["window"]);
            if overflow["kind"] == json!("page") {
                found.push(format!(
                    "La page déborde en largeur (fenêtre de {window}) : {hidden} px sont cachés à droite. Un bloc a une largeur fixe ou une ligne trop longue : laisser les composants prendre la largeur de la page (`PageGrid` passe d’elle-même à moins de colonnes)."
                ));
            } else {
                found.push(format!(
                    "Le tableau {} défile en largeur (fenêtre de {window}) : {hidden} px de colonnes sont cachés. Garder les colonnes utiles à la décision, le reste va au panneau de droite.",
                    quoted(&overflow["text"])
                ));
            }
        }
    }
    if let Some((window, count, examples)) = cut.iter().max_by_key(|(_, count, _)| *count) {
        let widths: Vec<&str> = cut.iter().map(|(window, _, _)| window.as_str()).collect();
        found.push(format!(
            "{count} texte{} coupé{} (fenêtre de {}) : {}. Une information se lit sans survol : raccourcir le texte, lui donner plus de place (colonne plus large, `PageGrid` de moins de colonnes) ou la mettre au panneau de droite.",
            if *count > 1 { "s" } else { "" },
            if *count > 1 { "s" } else { "" },
            if widths.len() > 1 { widths.join(" et de ") } else { window.clone() },
            examples.join(", ")
        ));
    }

    // Contraste, en clair et en sombre.
    for measure in wide["contrast"].as_array().into_iter().flatten() {
        let count = number(&measure["count"]) as usize;
        if count == 0 {
            continue;
        }
        let theme = if measure["theme"] == json!("dark") { "en sombre" } else { "en clair" };
        let examples: Vec<String> = measure["items"]
            .as_array()
            .into_iter()
            .flatten()
            .take(3)
            .map(|item| format!("{} ({}:1)", quoted(&item["text"]), format!("{:.1}", number(&item["ratio"])).replace('.', ",")))
            .collect();
        found.push(format!(
            "Texte peu lisible {theme} : {count} texte{} sous un contraste de 3:1, dont {}. La couleur vient de la page ou d’une librairie : passer par les tokens de socle-ui (`var(--fg)`, `var(--fg-2)`) et le `tone` des composants (DESIGN.md, règle 5).",
            if count > 1 { "s" } else { "" },
            examples.join(", ")
        ));
    }
    found
}

fn modified(path: &Path) -> SystemTime {
    std::fs::metadata(path).and_then(|meta| meta.modified()).unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Examine les pages, ou rend l’examen gardé d’une page dont les fichiers n’ont pas changé. Rend `pages` (une entrée
/// par page qui a des remarques ou n’a pas pu être examinée) et `pending` (pages examinées au prochain `check`).
pub async fn review(state: &AppState, root: &Path, candidates: Vec<Candidate>) -> Value {
    let mut pages = Vec::new();
    let mut fresh = Vec::new();
    for candidate in candidates {
        let print = fingerprint(&candidate);
        let known = cache().lock().ok().and_then(|cache| cache.get(&key(root, &candidate.reference)).cloned());
        match known {
            Some((kept, entry)) if kept == print => {
                if entry["findings"].as_array().is_some_and(|found| !found.is_empty()) {
                    pages.push(entry);
                }
            }
            _ => fresh.push((print, candidate)),
        }
    }
    fresh.sort_by_key(|(_, candidate)| std::cmp::Reverse(modified(&candidate.file)));
    let pending: Vec<String> = fresh.iter().skip(MAX_PAGES).map(|(_, candidate)| candidate.reference.clone()).collect();
    fresh.truncate(MAX_PAGES);
    if fresh.is_empty() {
        return json!({ "pages": pages, "pending": pending });
    }
    let asked: Vec<Value> = fresh
        .iter()
        .map(|(_, candidate)| json!({ "page": candidate.reference, "panel": candidate.panel, "examples": candidate.examples }))
        .collect();
    let timeout = BASE + PER_PAGE * fresh.len() as u32;
    let answers = match state.ask_ui("agent:pageReview", json!({ "pages": asked }), timeout).await {
        Ok(Value::Array(answers)) => answers,
        Ok(_) => Vec::new(),
        Err(error) => {
            return json!({
                "pages": pages,
                "pending": fresh.iter().map(|(_, candidate)| candidate.reference.clone()).chain(pending).collect::<Vec<_>>(),
                "unavailable": error.message,
            });
        }
    };
    let mut pending = pending;
    for (print, candidate) in fresh {
        let answer = answers.iter().find(|answer| answer["page"].as_str() == Some(candidate.reference.as_str()));
        let Some(answer) = answer else {
            pending.push(candidate.reference);
            continue;
        };
        if let Some(error) = answer["error"].as_str() {
            // Une page qui ne s’est pas chargée se réexamine au prochain `check`.
            pages.push(json!({ "page": candidate.reference, "error": error }));
            continue;
        }
        let viewports = answer["viewports"].as_array().cloned().unwrap_or_default();
        let entry = json!({ "page": candidate.reference, "findings": findings(&viewports, candidate.reading) });
        if let Ok(mut cache) = cache().lock() {
            cache.insert(key(root, &candidate.reference), (print, entry.clone()));
        }
        if entry["findings"].as_array().is_some_and(|found| !found.is_empty()) {
            pages.push(entry);
        }
    }
    json!({ "pages": pages, "pending": pending })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport(window: &str, layout: Value, contrast: Value) -> Value {
        json!({ "window": window, "layout": layout, "contrast": contrast })
    }

    #[test]
    fn la_page_empilee_de_la_demo_recoit_ses_remarques() {
        // Mesures de la base documentaire : une colonne de 760 px, la liste des documents à 1 184 px.
        let wide = viewport(
            "1440 × 900",
            json!({
                "width": 1200, "height": 862, "busy": false,
                "contentTop": 12, "contentBottom": 1650, "contentLeft": 220, "contentRight": 980,
                "belowFold": [
                    { "kind": "heading", "text": "Ajouter des PDF", "top": 940 },
                    { "kind": "collection", "text": "Documents indexés", "top": 1184 },
                ],
                "gaps": [{ "top": 600, "height": 180, "above": "Peut-on poser l’applique ?", "below": "Ajouter des PDF" }, { "top": 100, "height": 80, "above": "a", "below": "b" }],
                "truncated": [], "truncatedCount": 0, "overflow": [],
                "filledButtons": [{ "text": "Poser la question", "top": 120 }, { "text": "Ajouter les documents d’exemple", "top": 1240 }],
            }),
            json!([{ "theme": "light", "count": 0, "items": [] }, { "theme": "dark", "count": 2, "items": [{ "text": "Indexé", "ratio": 1.8 }] }]),
        );
        let narrow = viewport(
            "1024 × 900",
            json!({
                "width": 784, "height": 862, "busy": false,
                "contentTop": 12, "contentBottom": 1900, "contentLeft": 12, "contentRight": 772,
                "belowFold": [], "gaps": [],
                "truncated": [{ "text": "Fiche technique Halo, révision de mars", "shown": 0.62 }], "truncatedCount": 3,
                "overflow": [{ "kind": "page", "text": "", "hidden": 180 }, { "kind": "table", "text": "Documents", "hidden": 240 }],
                "filledButtons": [],
            }),
            json!([]),
        );
        let found = findings(&[wide.clone(), narrow], false);
        let all = found.join("\n");
        assert!(found[0].starts_with("Sous la ligne de flottaison (fenêtre de 1440 × 900) : « Ajouter des PDF » (titre, à 940 px), « Documents indexés » (liste, à 1184 px) commencent sous les 862 px visibles ; la page fait 1650 px, soit 1,9 écran"), "{all}");
        assert!(all.contains("Zone vide (fenêtre de 1440 × 900) : le contenu n’occupe que 760 px des 1200 px de la page (63 %)"), "{all}");
        assert!(all.contains("Bande vide de 180 px (fenêtre de 1440 × 900) entre « Peut-on poser l’applique ? » et « Ajouter des PDF »"), "{all}");
        assert!(!all.contains("Bande vide de 80 px"), "sous le seuil : {all}");
        assert!(!all.contains("2 boutons pleins"), "le second est sous la ligne de flottaison : {all}");
        assert!(all.contains("3 textes coupés (fenêtre de 1024 × 900) : « Fiche technique Halo, révision de mars » (62 % visible)"), "{all}");
        assert!(all.contains("La page déborde en largeur (fenêtre de 1024 × 900) : 180 px"), "{all}");
        assert!(all.contains("Le tableau « Documents » défile en largeur (fenêtre de 1024 × 900) : 240 px"), "{all}");
        assert!(all.contains("Texte peu lisible en sombre : 2 textes sous un contraste de 3:1, dont « Indexé » (1,8:1)"), "{all}");
        assert!(!all.contains("en clair"), "{all}");

        // Un texte à lire : ni sa hauteur ni sa largeur ne se jugent.
        let reading = findings(&[wide], true).join("\n");
        assert!(!reading.contains("Sous la ligne") && !reading.contains("Zone vide"), "{reading}");
        assert!(reading.contains("Texte peu lisible"), "{reading}");
    }

    #[test]
    fn une_page_qui_tient_sur_un_ecran_ne_recoit_rien() {
        let wide = viewport(
            "1440 × 900, panneau ouvert",
            json!({
                "width": 928, "height": 862, "busy": false,
                "contentTop": 12, "contentBottom": 640, "contentLeft": 12, "contentRight": 916,
                "belowFold": [], "gaps": [], "truncated": [], "truncatedCount": 0, "overflow": [],
                "filledButtons": [{ "text": "Nouvelle tâche", "top": 6 }],
            }),
            json!([{ "theme": "light", "count": 0, "items": [] }, { "theme": "dark", "count": 0, "items": [] }]),
        );
        assert!(findings(&[wide], false).is_empty());

        // Un état vide centré est étroit et court : sa largeur ne se juge pas. Deux boutons pleins se voient.
        let vide = viewport(
            "1440 × 900",
            json!({
                "width": 1200, "height": 862, "busy": false,
                "contentTop": 300, "contentBottom": 520, "contentLeft": 390, "contentRight": 810,
                "belowFold": [], "gaps": [], "truncated": [], "truncatedCount": 0, "overflow": [],
                "filledButtons": [{ "text": "Créer", "top": 480 }, { "text": "Importer", "top": 20 }],
            }),
            json!([]),
        );
        let found = findings(&[vide], false);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].starts_with("2 boutons pleins dans le premier écran (« Créer », « Importer »)"), "{found:?}");

        // Une page encore en chargement : sa mise en page n’est pas jugée.
        let charge = viewport("1440 × 900", json!({ "width": 1200, "height": 862, "busy": true, "belowFold": [{ "kind": "heading", "text": "A", "top": 900 }] }), json!([]));
        let found = findings(&[charge], false);
        assert!(found.len() == 1 && found[0].contains("chargeait encore") && found[0].contains("page_logs"), "{found:?}");
    }

    #[test]
    fn l_empreinte_suit_les_fichiers_du_module() {
        let dir = tempfile::tempdir().unwrap();
        let module = dir.path().join("documentation");
        std::fs::create_dir_all(module.join("pages")).unwrap();
        std::fs::create_dir_all(module.join("vendor")).unwrap();
        std::fs::write(module.join("pages/documents.tsx"), "export default function P() { return null; }").unwrap();
        std::fs::write(module.join("vendor/gros.ts"), "x").unwrap();
        let candidate = Candidate {
            reference: "documentation/documents".to_string(),
            file: module.join("pages/documents.tsx"),
            module_dir: module.clone(),
            reading: false,
            panel: false,
            examples: false,
        };
        let first = fingerprint(&candidate);
        std::fs::write(module.join("vendor/gros.ts"), "y").unwrap();
        assert_eq!(fingerprint(&candidate), first, "une librairie installée ne compte pas");
        std::fs::create_dir_all(module.join("lib")).unwrap();
        std::fs::write(module.join("lib/questions.ts"), "export const a = 1;").unwrap();
        let with_lib = fingerprint(&candidate);
        assert_ne!(with_lib, first, "un fichier du module change le rendu");
        let panneau = Candidate { panel: true, ..candidate };
        assert_ne!(fingerprint(&panneau), with_lib, "panneau ouvert : une autre mesure");
    }
}
