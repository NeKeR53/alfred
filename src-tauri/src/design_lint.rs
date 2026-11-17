//! Relecture de design d’une page, rapportée par l’outil `check` : ce que DESIGN.md interdit et qu’on lit dans le
//! JSX sans exécuter la page. Le style propre (`style`, `className`, balises HTML stylées), une liste ou un champ
//! étiré dans une barre, et un bouton texte là où une icône suffit. Une page placée dans les Réglages est en plus une
//! `SettingsPage`, sans largeur imposée ni formulaire. Chaque remarque dit quoi écrire à la place.

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    JSXAttribute, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild, JSXElement, JSXElementName,
    JSXExpression, JSXOpeningElement,
};
use oxc::ast_visit::{walk, Visit};
use oxc::parser::Parser;
use oxc::span::SourceType;

use crate::transpile::Diagnostic;

/// Balises HTML admises dans une page : sans apparence propre (DESIGN.md, section 1).
const ALLOWED_TAGS: [&str; 3] = ["form", "option", "optgroup"];

/// Verbes d’une action secondaire courante, qui a son icône et va dans un `IconButton` dans une barre ou une ligne.
const ICON_VERBS: [(&str, &str); 16] = [
    ("Modifier", "Pencil"),
    ("Éditer", "Pencil"),
    ("Supprimer", "Trash2"),
    ("Copier", "Copy"),
    ("Dupliquer", "CopyPlus"),
    ("Actualiser", "RefreshButton"),
    ("Rafraîchir", "RefreshButton"),
    ("Exporter", "Download"),
    ("Télécharger", "Download"),
    ("Ouvrir", "ExternalLink"),
    ("Fermer", "X"),
    ("Filtrer", "Filter"),
    ("Partager", "Share2"),
    ("Réglages", "Settings"),
    ("Paramètres", "Settings"),
    ("Plus", "OverflowMenu"),
];

/// Briques que les gabarits posent eux-mêmes : une page ne les emploie pas, elle décrit ses données et ses actions.
const TEMPLATE_PARTS: [(&str, &str); 9] = [
    ("PageToolbar", "les props `actions` et `search` de `Page`, ou `CollectionPage` pour une liste"),
    ("ToolbarSeparator", "les props `actions` de `Page`, ou `CollectionPage`"),
    ("SettingRow", "`SettingsPage` et ses réglages (`switch`, `select`, `text`, `action`, `info`)"),
    ("SettingRows", "`SettingsPage` et ses réglages (`switch`, `select`, `text`, `action`, `info`)"),
    ("Modal", "`openModal({ title, content, actions })`, ou `openForm({ title, fields, submitLabel, onSubmit })` pour une saisie"),
    ("ConfirmDialog", "une `Action` avec `danger` et `confirm`, ou `confirmAction(…)`"),
    ("FormActions", "`openForm(…)`, qui pose ses boutons"),
    ("AnchoredPanel", "un filtre de `CollectionPage` ou une `Action` qui ouvre `openForm`"),
    ("ObjectHeader", "`DetailPanel`, ou la prop `header` de `Page` (`{ title, subtitle, status, actions }`)"),
];

/// Où se trouve l’élément visité : élément parent, ou attribut d’un élément (`actions` de `Section`…).
enum Frame {
    Element(String),
    Attribute { owner: String, name: String },
}

struct Lint<'s> {
    source: &'s str,
    /// La page importe une librairie npm : elle peut lui donner un conteneur (`<div ref>`) et un `<style>` limité à
    /// ses classes (AGENTS.md, règle 4), les balises HTML n’y sont donc pas relevées.
    uses_library: bool,
    stack: Vec<Frame>,
    owners: Vec<String>,
    /// La page est placée dans les Réglages (`placement: { kind: "settings" }`).
    settings: bool,
    /// Le fichier pose une `SettingsPage`.
    has_settings_page: bool,
    /// Début de la première `<Page>` du fichier.
    first_page: Option<u32>,
    found: Vec<Diagnostic>,
}

fn element_name(name: &JSXElementName) -> Option<(String, bool)> {
    match name {
        JSXElementName::Identifier(identifier) => Some((identifier.name.to_string(), true)),
        JSXElementName::IdentifierReference(reference) => Some((reference.name.to_string(), false)),
        JSXElementName::MemberExpression(member) => Some((member.property.name.to_string(), false)),
        JSXElementName::NamespacedName(_) | JSXElementName::ThisExpression(_) => None,
    }
}

fn attribute_name(attribute: &JSXAttribute) -> Option<String> {
    match &attribute.name {
        JSXAttributeName::Identifier(identifier) => Some(identifier.name.to_string()),
        JSXAttributeName::NamespacedName(_) => None,
    }
}

fn attribute<'b, 'a>(opening: &'b JSXOpeningElement<'a>, wanted: &str) -> Option<&'b JSXAttribute<'a>> {
    opening.attributes.iter().find_map(|item| match item {
        JSXAttributeItem::Attribute(attribute) if attribute_name(attribute).as_deref() == Some(wanted) => {
            Some(&**attribute)
        }
        _ => None,
    })
}

fn string_value(attribute: &JSXAttribute) -> Option<String> {
    match &attribute.value {
        Some(JSXAttributeValue::StringLiteral(literal)) => Some(literal.value.to_string()),
        _ => None,
    }
}

/// Texte visible d’un élément, s’il n’est fait que de texte (les icônes et expressions sont ignorées).
fn plain_text(element: &JSXElement) -> String {
    element
        .children
        .iter()
        .filter_map(|child| match child {
            JSXChild::Text(text) => Some(text.value.trim().to_string()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

impl Lint<'_> {
    fn report(&mut self, offset: u32, message: String) {
        let offset = (offset as usize).min(self.source.len());
        let before = &self.source[..offset];
        let line = before.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1;
        let column = before.rsplit('\n').next().map_or(0, |text| text.chars().count()) as u32 + 1;
        // Une même remarque à la même ligne n’est dite qu’une fois.
        if self.found.iter().any(|known| known.line == Some(line) && known.message == message) {
            return;
        }
        self.found.push(Diagnostic { message, line: Some(line), column: Some(column) });
    }

    fn inside_element(&self, names: &[&str]) -> bool {
        self.stack.iter().any(|frame| matches!(frame, Frame::Element(name) if names.contains(&name.as_str())))
    }

    /// Vrai dans une zone d’actions compacte : barre d’outils, actions d’une section ou d’un en-tête, fin de ligne.
    fn in_compact_actions(&self) -> bool {
        self.inside_element(&["PageToolbar"])
            || self.stack.iter().any(|frame| {
                matches!(frame, Frame::Attribute { owner, name }
                    if (name == "actions" && matches!(owner.as_str(), "Section" | "ObjectHeader"))
                        || (name == "trailing" && owner == "ListItem")
                        || (name == "start" && owner == "PageToolbar"))
            })
    }

    fn check_element(&mut self, element: &JSXElement) {
        let opening = &element.opening_element;
        let Some((name, intrinsic)) = element_name(&opening.name) else { return };
        let start = opening.span.start;

        for forbidden in ["style", "className"] {
            if let Some(found) = attribute(opening, forbidden) {
                self.report(
                    found.span.start,
                    format!(
                        "Style propre interdit : `{forbidden}` sur `<{name}>`. Régler les props des composants de `@alfred/ui` (`gap`, `width`, `variant`, `size`, `tone`) ou composer `Stack`, `Row`, `Grid` (DESIGN.md, règle 3)."
                    ),
                );
            }
        }

        if intrinsic && !self.uses_library && !ALLOWED_TAGS.contains(&name.as_str()) {
            let instead = match name.as_str() {
                "div" | "section" | "header" | "footer" | "main" | "aside" | "nav" => {
                    "`Stack`, `Row`, `Grid`, `Section`, `Surface` ou `ObjectHeader`"
                }
                "span" | "p" | "strong" | "em" | "small" | "b" | "i" | "label" => "`Text` (ou `Text as=\"span\"`)",
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => "`Heading`, `Section title` ou `ObjectHeader`",
                "button" => "`Button`, `IconButton` ou `MenuItem`",
                "a" => "`Link`",
                "input" => "`TextInput`, `CheckboxControl`, `SwitchControl` ou `RadioControl`",
                "select" => "`SelectControl`",
                "textarea" => "`TextArea`",
                "img" => "`Image`",
                "table" | "thead" | "tbody" | "tr" | "td" | "th" => "`DataTable`",
                "ul" | "ol" | "li" => "`List` et `ListItem`",
                "dl" | "dt" | "dd" => "`KeyValueList`",
                "hr" => "`Divider`",
                "pre" | "code" => "`Code`",
                _ => "un composant de `@alfred/ui`",
            };
            self.report(start, format!("Balise HTML `<{name}>` dans une page : utiliser {instead} (DESIGN.md, section 1)."));
        }

        if let Some((_, instead)) = TEMPLATE_PARTS.iter().find(|(part, _)| *part == name) {
            self.report(
                start,
                format!(
                    "`<{name}>` est posé par les gabarits : utiliser {instead} (DESIGN.md, section 2). La page décrit ses données et ses actions, Alfred les dispose."
                ),
            );
        }

        if name == "SettingsPage" {
            self.has_settings_page = true;
        }
        if name == "Page" && self.first_page.is_none() {
            self.first_page = Some(start);
        }
        if self.settings {
            if name == "Page" {
                if let Some(width) = attribute(opening, "width") {
                    self.report(
                        width.span.start,
                        "Une page des Réglages prend toute la largeur de la rubrique, comme les rubriques intégrées : retirer `width` de `<Page>` (DESIGN.md, section 4.3).".to_string(),
                    );
                }
            }
            if name == "Form" {
                self.report(
                    start,
                    "Pas de `<Form>` dans une page des Réglages : chaque réglage est une ligne de `SettingsPage` (`type: \"text\"`, `\"select\"`, `\"switch\"`), qui s’enregistre seule, et une saisie plus longue passe par `openForm(…)` depuis une ligne `type: \"action\"` (DESIGN.md, section 4.3).".to_string(),
                );
            }
        }

        if name == "Page" && attribute(opening, "toolbar").is_some() {
            self.report(
                start,
                "`<Page toolbar>` est réservé aux gabarits : la barre de la page s’obtient avec `search` (recherche), `bar` (filtres, compteur) et `actions` (une liste d’`Action`) sur `Page`.".to_string(),
            );
        }

        for owner in ["Section", "Page", "ObjectHeader"] {
            if name != owner {
                continue;
            }
            if let Some(actions) = attribute(opening, "actions") {
                let jsx = match &actions.value {
                    Some(JSXAttributeValue::Element(_) | JSXAttributeValue::Fragment(_)) => true,
                    Some(JSXAttributeValue::ExpressionContainer(container)) => matches!(
                        container.expression,
                        JSXExpression::JSXElement(_) | JSXExpression::JSXFragment(_)
                    ),
                    _ => false,
                };
                if jsx {
                    self.report(
                        actions.span.start,
                        format!(
                            "`actions` de `<{name}>` reçoit une liste d’`Action` (`{{ label, icon, onClick, primary, danger }}`), pas des boutons : Alfred choisit icône, texte ou menu « ⋯ »."
                        ),
                    );
                }
            }
        }

        if matches!(name.as_str(), "SelectControl" | "TextInput")
            && attribute(opening, "width").and_then(string_value).as_deref() == Some("full")
            && (self.inside_element(&["Row", "PageToolbar", "SettingRow"]) || self.in_compact_actions())
        {
            self.report(
                start,
                format!(
                    "`<{name} width=\"full\">` dans une barre ou une ligne s’étire sur toute la largeur : laisser la largeur par défaut ou choisir `width=\"sm\"`, `\"md\"` ou `\"lg\"`."
                ),
            );
        }

        if name == "Button" && self.in_compact_actions() {
            let variant = attribute(opening, "variant").and_then(string_value);
            let secondary = variant.as_deref().is_none_or(|variant| variant == "secondary");
            let text = plain_text(element);
            if secondary {
                if let Some((verb, icon)) = ICON_VERBS.iter().find(|(verb, _)| text == *verb) {
                    let instead = match *icon {
                        "RefreshButton" => "`RefreshButton`".to_string(),
                        "OverflowMenu" => "`OverflowMenu`".to_string(),
                        icon => format!(
                            "`<IconButton label=\"{verb} …\" tooltip=\"{verb}\"><{icon} size={{16}} aria-hidden=\"true\" /></IconButton>`"
                        ),
                    };
                    self.report(
                        start,
                        format!(
                            "Bouton texte « {verb} » dans une barre ou une ligne : une action secondaire courante s’écrit {instead} (DESIGN.md, section 5.3)."
                        ),
                    );
                }
            }
        }
    }
}

impl<'a> Visit<'a> for Lint<'_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.check_element(element);
        let name = element_name(&element.opening_element.name).map(|(name, _)| name).unwrap_or_default();
        self.owners.push(name.clone());
        // Les attributs sont visités avec leur élément comme propriétaire, les enfants avec l’élément comme parent.
        self.visit_jsx_opening_element(&element.opening_element);
        self.owners.pop();
        self.stack.push(Frame::Element(name));
        self.visit_jsx_children(&element.children);
        self.stack.pop();
    }

    fn visit_jsx_attribute(&mut self, attribute: &JSXAttribute<'a>) {
        let owner = self.owners.last().cloned().unwrap_or_default();
        let name = attribute_name(attribute).unwrap_or_default();
        self.stack.push(Frame::Attribute { owner, name });
        walk::walk_jsx_attribute(self, attribute);
        self.stack.pop();
    }
}

/// Remarques de design sur le fichier d’une page ; vide si la page ne se lit pas (ses erreurs sont dites ailleurs).
/// `settings` : la page est placée dans les Réglages, où elle doit être une `SettingsPage`.
pub fn lint(source: &str, settings: bool) -> Vec<Diagnostic> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
        return Vec::new();
    }
    let uses_library = parsed.module_record.requested_modules.keys().any(|specifier| {
        let specifier = specifier.as_str();
        !specifier.starts_with('.') && !crate::transpile::ALLOWED_IMPORTS.contains(&specifier)
    });
    let mut lint = Lint {
        source,
        uses_library,
        stack: Vec::new(),
        owners: Vec::new(),
        settings,
        has_settings_page: false,
        first_page: None,
        found: Vec::new(),
    };
    // Cloisonnement : une page n’appelle jamais un client, elle passe par les fonctions du connecteur.
    for statement in &parsed.program.body {
        let oxc::ast::ast::Statement::ImportDeclaration(import) = statement else { continue };
        if import.source.value.as_str() != "@alfred/sdk" {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            if let oxc::ast::ast::ImportDeclarationSpecifier::ImportSpecifier(named) = specifier {
                if named.imported.name().as_str() == "client" {
                    lint.report(
                        named.span.start,
                        "Une page n’appelle pas un client : chaque appel au service est une fonction du connecteur \
                         (`declare_function`, `effect`, `tests`), que la page appelle avec `functions.call(\"module/fonction\", …)`. \
                         Le client refuse les requêtes des pages."
                            .to_string(),
                    );
                }
            }
        }
    }
    lint.visit_program(&parsed.program);
    if settings && !lint.has_settings_page {
        if let Some(start) = lint.first_page {
            lint.report(
                start,
                "Une page placée dans les Réglages est une `SettingsPage` : `<SettingsPage load={…} sections={(valeurs) => [{ title, settings: [{ id, type, title, value, save }] }]} />` (DESIGN.md, sections 4.3 et 12.3). Elle prend alors la largeur, les marges et les lignes des rubriques intégrées.".to_string(),
            );
        }
    }
    lint.found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(source: &str) -> Vec<String> {
        lint(source, false).into_iter().map(|found| format!("{}: {}", found.line.unwrap_or(0), found.message)).collect()
    }

    #[test]
    fn une_page_n_importe_pas_le_client() {
        let page = r#"
import { functions, client } from "@alfred/sdk";
import { Page } from "@alfred/ui";
export default function P() {
  return <Page>{null}</Page>;
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("2: Une page n’appelle pas un client")), "{found:?}");
        assert!(messages(&page.replace(", client", "")).is_empty());
    }

    fn settings_messages(source: &str) -> Vec<String> {
        lint(source, true).into_iter().map(|found| format!("{}: {}", found.line.unwrap_or(0), found.message)).collect()
    }

    #[test]
    fn une_page_des_reglages_est_une_settings_page_sans_largeur() {
        let page = r#"
import { Page, Form, Section } from "@alfred/ui";
export default function P() {
  return (
    <Page width="text">
      <Section title="Signature">
        <Form onSubmit={enregistrer}>{null}</Form>
      </Section>
    </Page>
  );
}
"#;
        let found = settings_messages(page);
        assert!(found.iter().any(|m| m.starts_with("5: Une page des Réglages prend toute la largeur") && m.contains("retirer `width`")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("7: Pas de `<Form>`") && m.contains("`SettingsPage`")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("5: Une page placée dans les Réglages est une `SettingsPage`")), "{found:?}");
        // Hors des Réglages, la même page n’a rien à corriger sur ces points.
        assert!(messages(page).is_empty(), "{:?}", messages(page));

        let settings_page = r#"
import { SettingsPage } from "@alfred/ui";
export default function P() {
  return <SettingsPage sections={() => [{ title: "Lecture", settings: [] }]} />;
}
"#;
        assert!(settings_messages(settings_page).is_empty(), "{:?}", settings_messages(settings_page));
    }

    #[test]
    fn signale_le_style_propre_et_les_balises_html() {
        let page = r#"
import { Page, Text } from "@alfred/ui";
export default function P() {
  return (
    <Page>
      <div style={{ padding: 8 }}>
        <Text>ok</Text>
      </div>
      <form noValidate><select><option>a</option></select></form>
    </Page>
  );
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("6: Style propre interdit : `style`")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("6: Balise HTML `<div>`") && m.contains("`Stack`")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`<select>`") && m.contains("`SelectControl`")), "{found:?}");
        assert!(!found.iter().any(|m| m.contains("`<form>`") || m.contains("`<option>`")), "{found:?}");
    }

    #[test]
    fn impose_les_gabarits_et_les_actions_declarees() {
        let page = r#"
export default function P() {
  return (
    <Page toolbar={<PageToolbar />} actions={<Button>Nouveau</Button>}>
      <Section title="Équipe" actions={[{ label: "Ajouter un membre", onClick: ajouter }]}>
        <SettingRows><SettingRow title="x" /></SettingRows>
      </Section>
      <Modal open title="Renommer" />
    </Page>
  );
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.contains("`<PageToolbar>` est posé par les gabarits")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`<Page toolbar>`")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`actions` de `<Page>`")), "{found:?}");
        assert!(!found.iter().any(|m| m.contains("`actions` de `<Section>`")), "une liste d’actions convient : {found:?}");
        assert!(found.iter().any(|m| m.contains("`<SettingRow>`") && m.contains("`SettingsPage`")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`<Modal>`") && m.contains("`openForm(")), "{found:?}");
    }

    #[test]
    fn demande_une_icone_pour_une_action_courante_dans_une_barre() {
        let page = r#"
export default function P() {
  return (
    <Page toolbar={<PageToolbar><Button onClick={a}>Actualiser</Button><Button variant="primary">Nouvelle tâche</Button></PageToolbar>}>
      <Section title="Contacts" actions={<Button>Modifier</Button>}>
        <List><ListItem title="x" trailing={<Button>Supprimer</Button>} /></List>
        <FormActions submitLabel="Enregistrer" />
        <Row><Button>Modifier</Button><SelectControl width="full" aria-label="Tri" /></Row>
      </Section>
    </Page>
  );
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.contains("« Actualiser »") && m.contains("`RefreshButton`")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("« Modifier »") && m.contains("<Pencil size={16}")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("« Supprimer »") && m.contains("Trash2")), "{found:?}");
        assert!(!found.iter().any(|m| m.contains("Nouvelle tâche")), "{found:?}");
        assert_eq!(found.iter().filter(|m| m.contains("« Modifier »")).count(), 1, "hors d’une barre, un bouton texte reste admis : {found:?}");
        assert!(found.iter().any(|m| m.contains("`<SelectControl width=\"full\">`")), "{found:?}");
    }

    #[test]
    fn une_librairie_garde_son_conteneur() {
        let page = r#"
import * as echarts from "echarts";
export default function P() {
  return <Page><style>{".chart { color: var(--color-ink); }"}</style><div ref={ref} /></Page>;
}
"#;
        assert!(messages(page).is_empty(), "{:?}", messages(page));
    }

    #[test]
    fn une_page_conforme_ne_recoit_aucune_remarque() {
        let page = r#"
import { Pencil } from "lucide-react";
export default function P() {
  return (
    <CollectionPage
      label="Tâches"
      load={charger}
      rowKey={(t) => t.id}
      columns={[{ key: "titre", header: "Titre" }]}
      emptyTitle="Aucune tâche"
      actions={[{ label: "Nouvelle tâche", primary: true, onClick: () => openForm({ title: "Nouvelle tâche", fields: [{ name: "titre", label: "Titre" }], submitLabel: "Créer", onSubmit: creer }) }]}
      rowActions={(t) => [{ label: "Modifier", icon: Pencil, onClick: () => modifier(t) }]}
    />
  );
}
function Autre() {
  return (
    <Page actions={[{ label: "Actualiser", onClick: recharger }]}>
      <Section title="Résumé" actions={[{ label: "Copier", onClick: copier }]}>
        <Text>Contenu</Text>
      </Section>
    </Page>
  );
}
"#;
        assert!(messages(page).is_empty(), "{:?}", messages(page));
    }
}
