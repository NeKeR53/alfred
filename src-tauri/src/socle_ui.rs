//! La version installée de socle-ui, lue au build (`build.rs`) : exports, anciens noms et doc pour l’IA. `check`
//! s’en sert pour relire les imports d’une page, et `docs` recopie la doc dans chaque espace.

include!(concat!(env!("OUT_DIR"), "/socle_ui.rs"));

/// Noms exportés par une entrée de socle-ui (`socle-ui`, `socle-ui/markdown`, `socle-ui/markdown-editor`).
pub fn exports(entry: &str) -> &'static [&'static str] {
    match entry {
        "socle-ui" => EXPORTS,
        "socle-ui/markdown" => MARKDOWN_EXPORTS,
        "socle-ui/markdown-editor" => MARKDOWN_EDITOR_EXPORTS,
        _ => &[],
    }
}

/// Nom actuel d’un ancien nom de socle-ui, s’il en est un.
pub fn replacement(name: &str) -> Option<&'static str> {
    DEPRECATED.iter().find(|(old, _)| *old == name).map(|(_, new)| *new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_la_version_installee() {
        // node_modules est là pendant les tests : les listes sont lues depuis la version installée.
        assert!(!VERSION.is_empty());
        for name in ["ListPage", "Drawer", "Toggle", "useOpenForm", "PageSection", "Action", "FormField", "StatusMap"] {
            assert!(EXPORTS.contains(&name), "{name} manque dans {EXPORTS:?}");
        }
        assert!(MARKDOWN_EXPORTS.contains(&"Markdown"));
        assert!(MARKDOWN_EDITOR_EXPORTS.contains(&"MarkdownEditor"));
        assert_eq!(replacement("Switch"), Some("Toggle"));
        assert_eq!(replacement("Dialog"), Some("Modal"));
        assert_eq!(replacement("Toggle"), None);
        assert!(DOCS.iter().any(|(path, text)| *path == "AI.md" && text.contains(VERSION)));
        assert!(DOCS.iter().any(|(path, _)| *path == "docs/layout-rules.md"));
        assert!(DOCS.iter().any(|(path, _)| *path == "specs/ListPage.md"));
    }
}
