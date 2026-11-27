//! Documents de référence qu’Alfred dépose dans l’espace pour les agents. Ils appartiennent à Alfred : réécrits à
//! chaque ouverture, donc toujours à la version de l’application. La doc de socle-ui (`docs/alfred/socle/`) est celle
//! de la version installée au build (`socle_ui::DOCS`, et les captures des recettes de pages, `socle_ui::IMAGES`) :
//! un fichier qui n’en fait plus partie est retiré.

use std::fs;
use std::path::Path;

use crate::error::AppResult;
use crate::space::Space;

const DESIGN: &str = include_str!("../../DESIGN.md");
const PLACEMENT: &str = include_str!("../../docs/espace/PLACEMENT.md");
const GUIDE: &str = include_str!("../../docs/espace/AGENTS.md");
const SDK: &str = include_str!("../../docs/espace/SDK.md");
/// Parties du guide lues à la demande : `AGENTS.md`, chargé d’office par chaque harnais, reste court et y renvoie.
const GUIDES: [(&str, &str); 6] = [
    ("page.md", include_str!("../../docs/espace/guides/page.md")),
    ("service.md", include_str!("../../docs/espace/guides/service.md")),
    ("fonction.md", include_str!("../../docs/espace/guides/fonction.md")),
    ("donnees.md", include_str!("../../docs/espace/guides/donnees.md")),
    ("module-json.md", include_str!("../../docs/espace/guides/module-json.md")),
    ("conversations.md", include_str!("../../docs/espace/guides/conversations.md")),
];

fn write_if_changed(path: &Path, content: impl AsRef<[u8]>) -> AppResult<()> {
    let content = content.as_ref();
    if fs::read(path).is_ok_and(|current| current == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

/// Retire de `dir` les fichiers que la version courante ne livre plus (`keep` : chemins relatifs à `base`).
fn remove_stale(base: &Path, dir: &Path, keep: &[&str]) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            remove_stale(base, &path, keep);
            let _ = fs::remove_dir(&path); // seulement s’il est vide
        } else if let Ok(relative) = path.strip_prefix(base) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if !keep.contains(&relative.as_str()) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

pub fn materialize(space: &Space) -> AppResult<()> {
    write_if_changed(&space.root.join("AGENTS.md"), GUIDE)?;
    // Claude Code lit CLAUDE.md : il renvoie vers le même guide.
    write_if_changed(&space.root.join("CLAUDE.md"), "@AGENTS.md\n")?;
    write_if_changed(&space.root.join("docs/alfred/PLACEMENT.md"), PLACEMENT)?;
    write_if_changed(&space.root.join("docs/alfred/DESIGN.md"), DESIGN)?;
    write_if_changed(&space.root.join("docs/alfred/SDK.md"), SDK)?;
    let guides = space.root.join("docs/alfred/guides");
    for (name, content) in GUIDES {
        write_if_changed(&guides.join(name), content)?;
    }
    let names: Vec<&str> = GUIDES.iter().map(|(name, _)| *name).collect();
    remove_stale(&guides, &guides, &names);
    let socle = space.root.join("docs/alfred/socle");
    for (relative, content) in crate::socle_ui::DOCS {
        write_if_changed(&socle.join(relative), content)?;
    }
    // Les recettes de pages citent leurs captures, rangées à côté d’elles (`recipes/<Nom>-clair.png`).
    for (relative, bytes) in crate::socle_ui::IMAGES {
        write_if_changed(&socle.join(relative), bytes)?;
    }
    let keep: Vec<&str> = crate::socle_ui::DOCS
        .iter()
        .map(|(relative, _)| *relative)
        .chain(crate::socle_ui::IMAGES.iter().map(|(relative, _)| *relative))
        .collect();
    remove_stale(&socle, &socle, &keep);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_doc_de_socle_suit_la_version_installee() {
        let root = tempfile::tempdir().unwrap();
        let socle = root.path().join("docs/alfred/socle");
        fs::create_dir_all(socle.join("specs")).unwrap();
        fs::write(socle.join("specs/Ancien.md"), "retiré").unwrap();
        for (relative, content) in crate::socle_ui::DOCS {
            write_if_changed(&socle.join(relative), content).unwrap();
        }
        let keep: Vec<&str> = crate::socle_ui::DOCS.iter().map(|(relative, _)| *relative).collect();
        remove_stale(&socle, &socle, &keep);
        assert!(!socle.join("specs/Ancien.md").exists());
        assert!(socle.join("AI.md").exists());
        assert!(socle.join("specs/Drawer.md").exists());
        assert!(socle.join("docs/layout-rules.md").exists());
    }

    #[test]
    fn les_recettes_de_pages_et_leurs_captures_partent_dans_l_espace() {
        let root = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(&root.path().join("espace"), Some("Essai")).unwrap();
        materialize(&space).unwrap();
        let recipes = space.root.join("docs/alfred/socle/recipes");
        let names: Vec<&str> = crate::socle_ui::DOCS
            .iter()
            .filter_map(|(relative, _)| relative.strip_prefix("recipes/")?.strip_suffix(".md"))
            .collect();
        for name in ["KnowledgeBase", "Dashboard", "TriageQueue", "ListDetail", "Catalog"] {
            assert!(names.contains(&name), "recette {name} absente de socle-ui {}", crate::socle_ui::VERSION);
        }
        for name in names {
            let text = fs::read_to_string(recipes.join(format!("{name}.md"))).unwrap();
            // Chaque zone dit sa responsabilité, quand la prendre et pourquoi (socle-ui 1.21.1, D-417).
            assert!(text.contains("| Zone | Sa responsabilité ici | Composant | Quand, pourquoi |"), "{name}.md n’explique pas ses zones");
            for suffix in ["clair", "sombre"] {
                let capture = format!("{name}-{suffix}.png");
                assert!(text.contains(&capture), "{name}.md ne cite pas {capture}");
                let bytes = fs::read(recipes.join(&capture)).unwrap();
                assert!(bytes.starts_with(b"\x89PNG"), "{capture} n’est pas une image PNG");
            }
        }
        // Une capture qui n’est plus livrée est retirée, comme un texte.
        fs::write(recipes.join("Ancienne-clair.png"), b"retiree").unwrap();
        materialize(&space).unwrap();
        assert!(!recipes.join("Ancienne-clair.png").exists());
        // Les guides envoient l’agent vers les recettes avant d’écrire une page.
        let page = GUIDES.iter().find(|(name, _)| *name == "page.md").map(|(_, text)| *text).unwrap();
        for text in [DESIGN, page] {
            assert!(text.contains("docs/alfred/socle/recipes/"), "un guide ne cite pas les recettes");
        }
        assert!(DESIGN.contains("### Partir d’une recette"));
    }

    #[test]
    fn les_guides_demandent_une_recette_du_relief_et_une_auto_revue() {
        // Les pages livrées sortaient plates : l’agent ne partait presque jamais d’une recette et jugeait ses
        // captures sur la seule mise en page. Le guide toujours chargé, le guide d’une page et le guide de placement
        // portent désormais la recette déclarée, les composants riches, l’UI d’abord, l’auto-revue et la proposition.
        for expected in ["**Une page réussie**", "`// Recette : Dashboard`", "UI d’abord", "`selfReview`", "une seule question"] {
            assert!(GUIDE.contains(expected), "AGENTS.md n’a pas « {expected} »");
        }
        let page = GUIDES.iter().find(|(name, _)| *name == "page.md").map(|(_, text)| *text).unwrap();
        for expected in [
            "**Pars de la recette la plus proche.**",
            "`// Recette : Dashboard`",
            "**UI d’abord.**",
            "## Des pages qui ont du relief",
            "`PageSection framed`",
            "`Card variant=\"metric\"`",
            "7 bis. **Auto-revue visuelle, obligatoire avant de rendre la main.**",
            "`examples: true`",
            "`compareWith`",
            "**Zones strictes, refusées par `check`**",
            "**Le panneau de droite n’existe que s’il y a une sélection.**",
        ] {
            assert!(page.contains(expected), "page.md n’a pas « {expected} »");
        }
        for expected in [
            "## 10. Le parcours de création d’une page",
            "**questions, proposition, puis construction**",
            "| La fraîcheur |",
            "**Un défaut raisonnable.**",
            "jamais plus de deux",
            "\"why\":",
            "Par défaut, il n’existe pas",
        ] {
            assert!(PLACEMENT.contains(expected), "PLACEMENT.md n’a pas « {expected} »");
        }
        // Les composants cités existent dans la version installée.
        for name in ["Card", "PageGrid", "PageSection", "Badge", "Avatar", "ProgressBar", "FormattedValue", "LogViewer", "PropertyRow"] {
            assert!(crate::socle_ui::EXPORTS.contains(&name), "socle-ui {} n’exporte pas {name}", crate::socle_ui::VERSION);
        }
        assert!(crate::socle_ui::DOCS.iter().any(|(path, text)| *path == "specs/Page.md" && text.contains("framed")));
    }

    #[test]
    fn chaque_guide_pose_l_ordre_de_priorite_en_tete() {
        // Voulu par l’utilisateur, appliqué à chaque décision : l’interface, puis une donnée juste (ou son âge),
        // puis le moins d’appels au service. AGENTS.md le pose avant tout le reste ; chaque guide le rappelle en tête.
        let order = ["(1) l’interface s’affiche tout de suite", "(2) la donnée affichée est juste, ou son âge est visible", "(3) le moins d’appels au service possible"];
        let rules = GUIDE.find("## L’ordre de priorité").expect("AGENTS.md sans ordre de priorité");
        assert!(rules < GUIDE.find("## Ta façon de parler").unwrap(), "l’ordre de priorité vient en tête d’AGENTS.md");
        for expected in ["1. **L’interface s’affiche tout de suite.**", "2. **La donnée affichée est juste, ou son âge est visible.**", "3. **Le moins d’appels au service possible.**"] {
            assert!(GUIDE.contains(expected), "AGENTS.md n’a pas « {expected} »");
        }
        let page = GUIDES.iter().find(|(name, _)| *name == "page.md").map(|(_, text)| *text).unwrap();
        for (name, text) in [("page.md", page), ("PLACEMENT.md", PLACEMENT), ("SDK.md", SDK), ("DESIGN.md", DESIGN)] {
            let head = &text[..text.find("(3) le moins d’appels").unwrap_or_else(|| panic!("{name} sans l’ordre de priorité"))];
            assert!(order[..2].iter().all(|step| head.contains(step)), "{name} : ordre incomplet");
        }
        // Ce qui contredisait l’ordre a disparu des exemples.
        for (name, text) in [("PLACEMENT.md", PLACEMENT), ("SDK.md", SDK), ("DESIGN.md", DESIGN), ("page.md", page)] {
            assert!(!text.contains("emptyMessage=\"Sélectionnez"), "{name} : texte d’attente dans un panneau");
            assert!(!text.contains("<Page state={…}"), "{name} : page entière en chargement");
            assert!(!text.contains("useAsync(() => functions.call(\""), "{name} : fonction appelée au montage");
            assert!(!text.contains("hasError={Boolean(tickets.error) && !tickets.data}"), "{name} : échec caché avec des données");
        }
    }

    #[test]
    fn les_guides_renvoient_au_guide_de_placement() {
        assert!(GUIDE.contains("docs/alfred/PLACEMENT.md"));
        assert!(DESIGN.contains("PLACEMENT.md"));
        assert!(SDK.contains("PLACEMENT.md"));
        assert!(PLACEMENT.contains("alfred-question"));
    }

    #[test]
    fn les_guides_demandent_une_vue_d_ensemble_et_non_une_pile() {
        // DESIGN.md : répartir dans les zones avant de composer ; blocs côte à côte ; plus de page qui empile.
        for expected in [
            "**Une vue d’ensemble, pas une pile.**",
            "11. **Vue d’ensemble d’abord.**",
            "### Répartir avant de composer",
            "**Exemple : une base documentaire**",
            "`PageGrid` : `columns`",
            "**`ChatPage`** : un échange de questions et de réponses",
        ] {
            assert!(DESIGN.contains(expected), "DESIGN.md n’a pas « {expected} »");
        }
        assert!(!DESIGN.contains("`Page` et `PageSection` seulement quand aucun gabarit ne convient"));
        assert!(!DESIGN.contains("<Row gap="), "un exemple de DESIGN.md range encore des blocs avec `Row`");
        // Le guide d’une page : répartir dès le placement, puis juger l’écran avant de rendre compte.
        let page = GUIDES.iter().find(|(name, _)| *name == "page.md").map(|(_, text)| *text).unwrap();
        for expected in [
            "**Répartis d’abord la demande.** Une zone de l’écran porte une responsabilité, et une seule",
            "7 ter. **Juge l’écran critère par critère.**",
            "`Page` avec `PageGrid`",
        ] {
            assert!(page.contains(expected), "page.md n’a pas « {expected} »");
        }
        // PLACEMENT.md : une zone, une responsabilité, avec le pourquoi et le quand de chaque zone.
        for expected in [
            "4. **Une zone, une responsabilité.**",
            "### Pourquoi et quand prendre chaque zone",
            "| Zone | Sa responsabilité | Quand la prendre | Pourquoi |",
            "### 11.4 Une base documentaire",
        ] {
            assert!(PLACEMENT.contains(expected), "PLACEMENT.md n’a pas « {expected} »");
        }
        assert!(DESIGN.contains("Une zone de l’écran, une responsabilité."));
        assert!(!PLACEMENT.contains("<Row gap="), "un exemple de PLACEMENT.md range encore des blocs avec `Row`");
        // Les guides citent `PageGrid` : la version de socle-ui installée au build doit l’exporter (1.20.0 au moins).
        assert!(crate::socle_ui::EXPORTS.contains(&"PageGrid"), "socle-ui {} n’exporte pas PageGrid", crate::socle_ui::VERSION);
        assert!(crate::socle_ui::DOCS.iter().any(|(path, text)| *path == "docs/layout-rules.md" && text.contains("Vue d'ensemble d'abord")));
        // Des fichiers à ajouter : ajout par l’en-tête ou dépôt sur la page (`useFileDrop`), jamais un bloc de dépôt.
        assert!(DESIGN.contains("| Des fichiers à importer | Ajout par l’en-tête ou dépôt sur la page"));
        assert!(PLACEMENT.contains("Ajout par l’en-tête ou dépôt sur la page"));
        assert!(PLACEMENT.contains("| Toute la page (`useFileDrop`) | Recevoir les fichiers glissés depuis le Finder"));
        assert!(SDK.contains("### Fichiers déposés sur la page : `useFileDrop`"));
        for (name, text) in [("DESIGN.md", DESIGN), ("PLACEMENT.md", PLACEMENT)] {
            assert!(!text.contains("n’a pas de disque (SDK.md"), "{name} dit encore qu’une page ne reçoit pas de dépôt");
        }
        // Les gabarits cités montrent le cadre de dépôt : socle-ui 1.22.0 au moins (`Page`, D-418).
        for spec in ["specs/ListPage.md", "specs/Page.md", "specs/ChatPage.md"] {
            assert!(
                crate::socle_ui::DOCS.iter().any(|(path, text)| *path == spec && text.contains("isDraggingFiles")),
                "socle-ui {} : {spec} sans `isDraggingFiles`",
                crate::socle_ui::VERSION
            );
        }
    }

    #[test]
    fn le_guide_de_l_espace_dit_de_travailler_sans_commenter() {
        let root = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(&root.path().join("espace"), Some("Essai")).unwrap();
        materialize(&space).unwrap();
        let guide = fs::read_to_string(space.root.join("AGENTS.md")).unwrap();
        for expected in [
            "## Ta façon de parler",
            "**Travaille en silence.**",
            "Tiens ton plan à jour avec l’outil de plan de ton harnais",
            "**Écris seulement trois sortes de messages.**",
            "ce qui reste ou n’est pas vérifié",
            "Une idée par phrase.",
            "Vouvoie l’utilisateur",
            "Alfred est une personne, pas un logiciel.",
            "Une proposition, en une ligne",
        ] {
            assert!(guide.contains(expected), "le guide n’a pas « {expected} »");
        }
        for removed in ["majordome qui devance", "dis ce que tu as fait et où le trouver", "Puis dis-lui ce que tu as créé"] {
            assert!(!guide.contains(removed), "le guide a encore « {removed} »");
        }
        assert_eq!(fs::read_to_string(space.root.join("CLAUDE.md")).unwrap(), "@AGENTS.md\n");
        // Le guide chargé d’office reste court ; ses parties sont lues à la demande, et chacune est citée.
        assert!(guide.len() < 24_000, "AGENTS.md fait {} octets", guide.len());
        for (name, _) in GUIDES {
            assert!(space.root.join("docs/alfred/guides").join(name).is_file(), "{name}");
            assert!(guide.contains(&format!("`{name}`")), "AGENTS.md ne cite pas {name}");
        }
    }

    #[test]
    fn les_guides_disent_ou_vivent_les_preferences_de_design() {
        // Le fichier que lisent `check` et `place_page` est celui que les guides font écrire, hors de `docs/alfred/`.
        let file = crate::agent_tools::DESIGN_PREFERENCES;
        assert!(!file.starts_with("docs/alfred/"), "Alfred réécrit docs/alfred/ : {file}");
        let page = GUIDES.iter().find(|(name, _)| *name == "page.md").map(|(_, text)| *text).unwrap();
        for expected in ["## Préférences de design", "0 bis. **Préférences de l’utilisateur.**", "`designPreferences`", "`review`"] {
            assert!(page.contains(expected), "page.md n’a pas « {expected} »");
        }
        assert!(page.contains(&format!("`{file}`")) && GUIDE.contains(&format!("`{file}`")), "les guides ne citent pas {file}");
        assert!(DESIGN.contains("`review`") && DESIGN.contains("`designPreferences`"));
    }
}
