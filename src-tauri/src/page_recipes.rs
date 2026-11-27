//! Recettes de pages de socle-ui, telles que l’agent les reçoit : la liste (lue dans la doc de la version installée,
//! `recipes/<Nom>.md`), la recette qu’une page déclare sur sa première ligne (`// Recette : Dashboard`), et la grille
//! d’auto-revue rendue avec chaque capture.
//!
//! Pourquoi : les pages livrées sortaient plates (une carte seule dans un grand vide, un état vide plein écran) parce
//! que l’agent ne partait presque jamais d’une recette, et jugeait ses captures sur la seule mise en page. Déclarer
//! la recette rend ce choix visible et vérifiable ; la capture lui rappelle à quoi comparer et quoi juger.

use serde_json::{json, Value};

/// Une recette de la version installée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipe {
    /// Nom du fichier sans extension : `Dashboard`.
    pub name: &'static str,
    /// Titre de la fiche : « Tableau de bord ».
    pub title: &'static str,
    /// Première ligne de « Quand la prendre ».
    pub when: &'static str,
}

/// Les recettes de la version installée de socle-ui, par ordre alphabétique de nom.
pub fn catalog() -> Vec<Recipe> {
    let mut recipes: Vec<Recipe> = crate::socle_ui::DOCS
        .iter()
        .filter_map(|(path, text)| {
            let name = path.strip_prefix("recipes/")?.strip_suffix(".md")?;
            Some(parse(name, text))
        })
        .collect();
    recipes.sort_by(|left, right| left.name.cmp(right.name));
    recipes
}

fn parse(name: &'static str, text: &'static str) -> Recipe {
    let title = text
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("# Recette :"))
        .map(str::trim)
        .unwrap_or(name);
    let when = text
        .split("## Quand la prendre")
        .nth(1)
        .and_then(|section| section.lines().find_map(|line| line.trim().strip_prefix("- ")))
        .map(str::trim)
        .unwrap_or("");
    Recipe { name, title, when }
}

/// Ce que la page déclare sur sa première ligne de commentaire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Declared {
    /// Une recette connue.
    Recipe(Recipe),
    /// `// Recette : aucune (raison)` : aucune ne convient, la page suit les gabarits.
    None,
    /// Un nom que la version installée ne connaît pas.
    Unknown(String),
}

/// Lit `// Recette : <Nom>` dans les premières lignes de la page. Le nom du fichier (`Dashboard`) ou le titre de la
/// fiche (« Tableau de bord ») sont acceptés, sans casse.
pub fn declared(source: &str) -> Option<Declared> {
    let line = source
        .lines()
        .take(12)
        .map(str::trim)
        .filter(|line| line.starts_with("//"))
        .find_map(|line| {
            let rest = line.trim_start_matches('/').trim();
            let rest = rest.strip_prefix("Recette").or_else(|| rest.strip_prefix("recette"))?;
            Some(rest.trim_start().strip_prefix(':')?.trim().to_string())
        })?;
    // « Dashboard », « Dashboard (vue d’ensemble) » ou « Dashboard — … » : le nom s’arrête au premier séparateur.
    let name = line.split(['(', '—', '–', ',', ';']).next().unwrap_or("").trim().trim_end_matches(" -").trim();
    if name.is_empty() {
        return Some(Declared::Unknown(line));
    }
    let lower = name.to_lowercase();
    if lower == "aucune" || lower == "aucun" {
        return Some(Declared::None);
    }
    Some(
        catalog()
            .into_iter()
            .find(|recipe| recipe.name.to_lowercase() == lower || recipe.title.to_lowercase() == lower)
            .map_or_else(|| Declared::Unknown(name.to_string()), Declared::Recipe),
    )
}

fn names() -> String {
    catalog().iter().map(|recipe| format!("`{}` ({})", recipe.name, recipe.title)).collect::<Vec<_>>().join(", ")
}

/// Avertissement de `check` pour une page de la zone principale : recette absente ou inconnue.
pub fn warning(source: &str) -> Option<String> {
    match declared(source) {
        Some(Declared::Recipe(_)) | Some(Declared::None) => None,
        Some(Declared::Unknown(name)) => Some(format!(
            "Avertissement : recette inconnue « {name} ». Recettes de socle-ui : {}. Ou `// Recette : aucune (raison)` quand aucune ne convient (docs/alfred/guides/page.md, étape 3).",
            names()
        )),
        None => Some(format!(
            "Avertissement : la page ne dit pas de quelle recette elle part. Choisis la plus proche, lis sa fiche et regarde sa capture dans docs/alfred/socle/recipes/, reprends ses zones et ses composants, puis écris-la en première ligne : `// Recette : Dashboard`. Recettes : {}. `// Recette : aucune (raison)` seulement quand aucune ne convient (docs/alfred/guides/page.md, étape 3).",
            names()
        )),
    }
}

/// Liste rendue par `place_page` : de quoi choisir la recette sans chercher.
pub fn listing() -> Value {
    Value::Array(
        catalog()
            .into_iter()
            .map(|recipe| {
                json!({
                    "recipe": recipe.name,
                    "title": recipe.title,
                    "when": recipe.when,
                    "sheet": format!("docs/alfred/socle/recipes/{}.md", recipe.name),
                    "capture": format!("docs/alfred/socle/recipes/{}-clair.png", recipe.name),
                })
            })
            .collect(),
    )
}

/// Les critères de l’auto-revue, à passer sur chaque capture avant de rendre la main (guides/page.md, étape 7 ter).
pub const CRITERIA: [&str; 8] = [
    "Recette : la capture a les mêmes zones et la même densité que la capture de la recette déclarée (ouvre les deux).",
    "Premier coup d’œil : l’essentiel se lit en haut, sans défiler ; une page qui résume montre ses chiffres clés en `Card variant=\"metric\"` dans une `PageGrid`.",
    "Écran rempli : pas de grand vide. Des blocs courts de même rang vont côte à côte (`PageGrid`, `PageSection framed`) ; une collection prend toute la page (`ListPage`).",
    "Données mises en forme : un état est un `Badge` ou une colonne `status` avec son ton, une date, un montant ou une durée suivent leur type (`FormattedValue`, `type` de colonne), une personne a son `Avatar`, un avancement sa `ProgressBar`, un identifiant son `Code`. Pas de `Text` brut pour une valeur typée.",
    "Hiérarchie : chaque bloc a un titre et une description courte ; un seul bouton plein à l’écran ; les actions sont dans l’en-tête, la barre du haut ou la section qu’elles concernent.",
    "UI d’abord : l’interface et les données déjà gardées s’affichent tout de suite ; seul le bloc qui attend montre son attente (`PageSection state=\"loading\"`), jamais tout l’écran.",
    "États soignés : un bloc vide dit pourquoi et propose l’action qui le remplit ; une erreur reste dans son bloc avec « Réessayer ».",
    "Clair et sombre lisibles ; `designWarnings` et `review` de `check` corrigés.",
];

/// Ce que `page_screenshot` rend avec l’image : la grille, et la capture de la recette à comparer.
pub fn self_review(source: &str, examples: bool) -> Value {
    let compare = match declared(source) {
        Some(Declared::Recipe(recipe)) => json!(format!("docs/alfred/socle/recipes/{}-clair.png", recipe.name)),
        _ => Value::Null,
    };
    json!({
        "compareWith": compare,
        "criteria": CRITERIA,
        "examples": if examples {
            Value::Null
        } else {
            json!("Si la page est vide faute de données, recapture avec `examples: true` pour juger la page remplie.")
        },
        "next": "Ouvre la capture (et `compareWith`), réponds oui ou non à chaque critère. Un « non » se corrige, puis recapture. Dans ton compte rendu, dis ce qui reste « non » et pourquoi.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_les_recettes_de_la_version_installee() {
        let recipes = catalog();
        for name in ["Catalog", "Dashboard", "KnowledgeBase", "ListDetail", "TriageQueue"] {
            let recipe = recipes.iter().find(|recipe| recipe.name == name).unwrap_or_else(|| panic!("{name} manque"));
            assert!(!recipe.when.is_empty(), "{name} n’a pas de « Quand la prendre »");
            assert_ne!(recipe.title, name, "{name} : titre de la fiche non lu");
        }
        let listing = listing();
        let first = &listing[0];
        assert!(first["sheet"].as_str().unwrap().starts_with("docs/alfred/socle/recipes/"));
        assert!(first["capture"].as_str().unwrap().ends_with("-clair.png"));
    }

    #[test]
    fn lit_la_recette_declaree() {
        let dashboard = |source: &str| matches!(declared(source), Some(Declared::Recipe(r)) if r.name == "Dashboard");
        assert!(dashboard("// Recette : Dashboard\nimport x from \"y\";"));
        assert!(dashboard("import a from \"b\";\n// Recette : tableau de bord (vue des ventes)\n"));
        assert!(dashboard("// Recette: Dashboard — chiffres clés"));
        assert_eq!(declared("// Recette : aucune (éditeur de règles)"), Some(Declared::None));
        assert_eq!(declared("// Recette : Kanban"), Some(Declared::Unknown("Kanban".into())));
        assert_eq!(declared("import a from \"b\";\nexport default function P() {}"), None);
        // Seules les premières lignes comptent : un commentaire au milieu du code n’est pas une déclaration.
        let late = format!("{}// Recette : Dashboard\n", "const a = 1;\n".repeat(20));
        assert_eq!(declared(&late), None);
    }

    #[test]
    fn avertit_sans_recette_ou_avec_une_inconnue() {
        assert!(warning("// Recette : ListDetail\n").is_none());
        assert!(warning("// Recette : aucune (conversation)\n").is_none());
        let missing = warning("export default function P() {}").unwrap();
        assert!(missing.starts_with("Avertissement"), "{missing}");
        assert!(missing.contains("`Dashboard`") && missing.contains("// Recette :"), "{missing}");
        let unknown = warning("// Recette : Kanban\n").unwrap();
        assert!(unknown.contains("« Kanban »"), "{unknown}");
    }

    #[test]
    fn la_revue_donne_la_capture_a_comparer_et_les_criteres() {
        let review = self_review("// Recette : TriageQueue\n", false);
        assert_eq!(review["compareWith"], "docs/alfred/socle/recipes/TriageQueue-clair.png");
        assert_eq!(review["criteria"].as_array().unwrap().len(), CRITERIA.len());
        assert!(review["examples"].as_str().unwrap().contains("examples: true"));
        let without = self_review("export default function P() {}", true);
        assert!(without["compareWith"].is_null() && without["examples"].is_null());
        assert!(CRITERIA.iter().any(|criterion| criterion.starts_with("UI d’abord")));
    }
}
