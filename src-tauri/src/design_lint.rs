//! Relecture de design d’une page, rapportée par l’outil `check` : les règles de socle-ui (DESIGN.md) qu’on lit dans
//! le JSX sans exécuter la page. Imports depuis `socle-ui` seulement (ni chemin interne, ni librairie que Socle
//! couvre déjà, ni l’ancienne `@alfred/ui`), ni `style` ni `className`, ni balise HTML stylée, ni couleur en dur, des
//! actions décrites par des données, et les noms accessibles des composants qui en demandent un. Une page placée
//! dans les Réglages a ses règles propres ; une page placée en panneau rend un `Drawer` à sa racine, sans champ de
//! saisie dans ses lignes ni en-tête détourné (`rows`). Chaque remarque dit quoi écrire à la place.

mod rows;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub use rows::is_warning;

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    ArrowFunctionBody, ArrowFunctionExpression, Declaration, ExportDefaultDeclarationKind, Expression, Function, FunctionBody,
    ImportDeclarationSpecifier, ReturnStatement, Statement, JSXAttribute, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild,
    JSXElement, JSXElementName, JSXExpression, JSXOpeningElement, StringLiteral, TemplateLiteral,
};
use oxc::ast_visit::{walk, Visit};
use oxc::parser::Parser;
use oxc::span::SourceType;

use crate::transpile::Diagnostic;

/// Balises HTML admises dans une page : sans apparence propre (DESIGN.md, règle 5).
const ALLOWED_TAGS: [&str; 3] = ["form", "option", "optgroup"];

/// Entrées de socle-ui qu’une page importe.
const SOCLE_ENTRIES: [&str; 3] = ["socle-ui", "socle-ui/markdown", "socle-ui/markdown-editor"];

/// Ce que devient chaque nom de l’ancienne `@alfred/ui` (DESIGN.md, section 15).
const UI_REPLACEMENTS: [(&str, &str); 44] = [
    ("CollectionPage", "`ListPage` de `socle-ui` (`title`, `rows`, `columns` typées, `filters`, `actions`, `rowActions`, `empty`)"),
    ("DetailPanel", "`Drawer` de `socle-ui`, forme déclarative (`header`, `sections`, `isLoading`, `hasError`)"),
    ("SettingsPage", "`Page` et `PageSection` de `socle-ui`, avec des `Toggle`, `Select`, `TextInput` qui s’appliquent tout de suite"),
    ("openForm", "`useOpenForm()` de `socle-ui` (`await openForm({ title, fields, submitLabel, onSubmit })`)"),
    ("openModal", "`Modal` de `socle-ui` (`isOpen`, `onOpenChange`, `title`, `footer`)"),
    ("openSubpage", "`DetailPage` de `socle-ui` avec `back`, rendue à la place de la liste"),
    ("confirmAction", "`useConfirm()` de `socle-ui`, ou une `Action` `danger`"),
    ("ConfirmDialog", "`useConfirm()` de `socle-ui`, ou une `Action` `danger`"),
    ("Modal", "`Modal` de `socle-ui` (options différentes : lire sa spec)"),
    ("usePageState", "`usePageState` de `@alfred/sdk`"),
    ("Page", "`Page` et `PageSection` de `socle-ui` (tableau de bord), ou `DetailPage` (un élément ouvert)"),
    ("Section", "`PageSection` de `socle-ui`"),
    ("Stack", "`Stack` de `@alfred/kit`"),
    ("Row", "`Row` de `@alfred/kit`"),
    ("Text", "`Text` de `@alfred/kit`"),
    ("Heading", "le `title` d’une `PageSection`"),
    ("Surface", "une `PageSection` de `socle-ui`"),
    ("Grid", "`PageGrid` de `socle-ui` (blocs côte à côte, `columns` de 2 à 4), ou des `PageSection` empilées"),
    ("FeedbackBanner", "`Alert` de `socle-ui` (encart dans la zone), ou une notification"),
    ("DataTable", "`Table` de `socle-ui`, ou `ListPage` pour une collection"),
    ("DataGrid", "`Table` de `socle-ui` (`density=\"compact\"`, `groupBy`)"),
    ("ListItem", "`List` de `socle-ui` (`items`)"),
    ("KeyValueList", "`Drawer` déclaratif (`fields`), ou `PropertyRow`"),
    ("Spinner", "`ProgressBar` sans `value`, ou l’état `loading` du gabarit"),
    ("LoadingSkeleton", "`Skeleton`, ou l’état `loading` du gabarit"),
    ("Pagination", "`pagination` de `ListPage`"),
    ("TextInput", "`TextInput` de `socle-ui`"),
    ("SelectControl", "`Select` de `socle-ui`"),
    ("CheckboxControl", "`Checkbox` de `socle-ui`"),
    ("SwitchControl", "`Toggle` de `socle-ui`"),
    ("RadioControl", "`RadioButtonGroup` de `socle-ui`"),
    ("FormField", "le `label` du champ Socle (`TextInput label=…`)"),
    ("Combobox", "`ComboBox` de `socle-ui`"),
    ("MultiSelectCombobox", "`ComboBox selectionMode=\"multiple\"` de `socle-ui`"),
    ("ChoiceGroup", "`RadioButtonGroup orientation=\"horizontal\"` dans un formulaire, `SegmentedControl` pour un mode d’affichage, des onglets fixes pour des vues"),
    ("MenuButton", "`DropdownMenu` de `socle-ui` (`trigger`, `items`)"),
    ("OverflowMenu", "une `Action` sans icône : les gabarits la rangent dans « … »"),
    ("RefreshButton", "une `Action` « Actualiser » avec l’icône `RefreshCw`"),
    ("AnchoredPanel", "`Popover` de `socle-ui`"),
    ("Markdown", "`Markdown` de `socle-ui/markdown`"),
    ("MarkdownEditor", "`MarkdownEditor` de `socle-ui/markdown-editor`"),
    ("PageToolbar", "`toolbar` et `actions` de `Page`, ou `ListPage`"),
    ("ObjectHeader", "`header` de `Drawer`, ou `DetailPage`"),
    ("copyText", "`navigator.clipboard.writeText`"),
];

/// Librairies que socle-ui couvre déjà : la page prend le composant au lieu de la déclarer.
const COVERED_LIBRARIES: [(&str, &str); 44] = [
    ("@xterm/xterm", "`<Terminal label engine={loadTerminal} connection={…} />` (xterm.js fourni par `loadTerminal` de `@alfred/sdk`)"),
    ("xterm", "`<Terminal label engine={loadTerminal} connection={…} />`"),
    ("@xterm/addon-fit", "`<Terminal>`, qui s’ajuste seul à sa place"),
    ("ansi-to-html", "`<LogViewer label lines={…} />`, qui lit les couleurs ANSI"),
    ("ansi_up", "`<LogViewer label lines={…} />`, qui lit les couleurs ANSI"),
    ("anser", "`<LogViewer label lines={…} />`, qui lit les couleurs ANSI"),
    ("react-window", "`<LogViewer>` pour un journal, `<Table>` ou `ListPage` pour des lignes"),
    ("react-virtualized", "`<LogViewer>`, `<Table>` ou `<TreeView>`, qui tiennent de longues listes"),
    ("diff", "`<DiffView label before={…} after={…} />` (ou `patch={git.diff(…).text}`)"),
    ("diff2html", "`<DiffView label patch={…} />`"),
    ("react-diff-viewer", "`<DiffView label before={…} after={…} />`"),
    ("react-diff-viewer-continued", "`<DiffView label before={…} after={…} />`"),
    ("@codemirror/merge", "`<DiffView label before={…} after={…} />`"),
    ("@codemirror/lang-markdown", "`<MarkdownEditor label value onChange />` de `socle-ui/markdown-editor`"),
    ("@uiw/react-md-editor", "`<MarkdownEditor label value onChange />` de `socle-ui/markdown-editor`"),
    ("@uiw/react-markdown-editor", "`<MarkdownEditor label value onChange />` de `socle-ui/markdown-editor`"),
    ("@mdxeditor/editor", "`<MarkdownEditor label value onChange />` de `socle-ui/markdown-editor`"),
    ("easymde", "`<MarkdownEditor label value onChange />` de `socle-ui/markdown-editor`"),
    ("react-simplemde-editor", "`<MarkdownEditor label value onChange />` de `socle-ui/markdown-editor`"),
    ("react-markdown", "`<Markdown>{texte}</Markdown>` de `socle-ui/markdown`"),
    ("marked", "`<Markdown>{texte}</Markdown>` de `socle-ui/markdown`"),
    ("markdown-it", "`<Markdown>{texte}</Markdown>` de `socle-ui/markdown`"),
    ("pdfjs-dist", "`<DocumentViewer label data={…} loadPdf={loadPdf} />` (pdf.js fourni par `loadPdf` de `@alfred/sdk`)"),
    ("react-pdf", "`<DocumentViewer label data={…} loadPdf={loadPdf} />`"),
    ("dompurify", "`<HtmlContent label html={…} />`, qui nettoie le HTML reçu"),
    ("sanitize-html", "`<HtmlContent label html={…} />`, qui nettoie le HTML reçu"),
    ("react-arborist", "`<TreeView aria-label nodes loadChildren />`"),
    ("react-complex-tree", "`<TreeView aria-label nodes loadChildren />`"),
    ("rc-tree", "`<TreeView aria-label nodes loadChildren />`"),
    ("react-accessible-treeview", "`<TreeView aria-label nodes loadChildren />`"),
    ("@mui/x-tree-view", "`<TreeView aria-label nodes loadChildren />`"),
    ("@tanstack/react-table", "`ListPage` (colonnes typées, tri, filtres), ou `<Table>`"),
    ("@tanstack/react-virtual", "`<Table>`, `<LogViewer>` ou `<TreeView>`, qui tiennent de longues listes"),
    ("ag-grid-react", "`<Table density=\"compact\" groupBy={…} />`, ou `ListPage`"),
    ("ag-grid-community", "`<Table density=\"compact\" />`, ou `ListPage`"),
    ("react-data-grid", "`<Table density=\"compact\" />`, ou `ListPage`"),
    ("@glideapps/glide-data-grid", "`<Table density=\"compact\" />`, ou `ListPage`"),
    ("@mui/x-data-grid", "`<Table>`, ou `ListPage`"),
    ("sonner", "`useNotify()` de `socle-ui` ou `shell.notify` : Alfred affiche la notification"),
    ("react-hot-toast", "`useNotify()` de `socle-ui` ou `shell.notify`"),
    ("react-toastify", "`useNotify()` de `socle-ui` ou `shell.notify`"),
    ("react-select", "`<Select>` ou `<ComboBox>` de `socle-ui`"),
    ("react-modal", "`<Modal>` de `socle-ui`"),
    ("@tanstack/react-query", "`useAlfredState` de `@alfred/sdk` pour une donnée d’un service (état partagé), `useAsync` sinon, et les états `loading`/`error` des gabarits"),
];

/// Librairies de composants « sans style » : socle-ui les enveloppe déjà, une page ne les prend pas.
const HEADLESS: [&str; 8] = [
    "react-aria",
    "react-aria-components",
    "@react-aria",
    "@radix-ui",
    "radix-ui",
    "@headlessui/react",
    "@ariakit/react",
    "@base-ui-components/react",
];

/// Ce que la coquille ou l’hôte du cadre posent : une page ne le rend jamais.
const SHELL_PARTS: [(&str, &str); 5] = [
    ("AppShell", "la coquille d’Alfred : la page rend seulement son gabarit"),
    ("Sidebar", "le menu de gauche d’Alfred ; une page ajoute des entrées avec `menu.setEntries` de `@alfred/sdk`"),
    ("NotificationCenter", "la cloche d’Alfred ; une page notifie avec `useNotify()` ou `shell.notify`"),
    ("SocleProvider", "l’hôte du cadre, qui enveloppe déjà la page"),
    ("SettingsPage", "la fenêtre des Réglages d’Alfred ; une page des Réglages est une `Page` avec des `PageSection` (DESIGN.md, section 7)"),
];

/// Gabarits et blocs dont `actions` reçoit une liste d’`Action`.
const ACTION_OWNERS: [&str; 6] = ["ListPage", "Page", "PageSection", "DetailPage", "DocumentViewer", "ActionBar"];

/// Composants Socle qui demandent un nom accessible : (composant, attribut, exemple).
const NAMED: [(&str, &str, &str); 7] = [
    ("LogViewer", "label", "« Journal du build n° 42 »"),
    ("Terminal", "label", "« Console du conteneur web »"),
    ("DiffView", "label", "« Modifications de README.md »"),
    ("DocumentViewer", "label", "« Facture F-2026-114 »"),
    ("HtmlContent", "label", "« Message de Paul »"),
    ("MarkdownEditor", "label", "« Contenu de la note »"),
    ("TreeView", "aria-label", "« Dossiers »"),
];

/// Où la page est placée : ses règles en dépendent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    /// Une page d’une section, dans la zone principale.
    Page,
    /// Une page des Réglages (`placement: { kind: "settings" }`).
    Settings,
    /// Une page du panneau de droite d’une autre page (`placement: { kind: "panel" }`).
    Panel,
}

struct Lint<'s> {
    source: &'s str,
    /// La page importe une librairie npm : elle peut lui donner un conteneur (`<div ref>`), les balises HTML n’y
    /// sont donc pas relevées.
    uses_library: bool,
    /// Noms locaux importés de socle-ui (nom local → nom exporté).
    socle: BTreeMap<String, String>,
    /// La page est placée dans les Réglages (`placement: { kind: "settings" }`).
    settings: bool,
    /// Éléments JSX qui entourent celui qu’on relit (nom Socle quand il vient de socle-ui).
    stack: Vec<String>,
    /// Profondeur des attributs où un `Button` est à sa place (pied de `Modal`, action d’`EmptyState`…).
    button_allowed: u32,
    /// Composants de socle-ui rendus par la page.
    rendered: BTreeSet<String>,
    found: Vec<Diagnostic>,
}

/// Attributs où un `Button` de socle-ui est à sa place : (élément, attribut). Ailleurs, une `Action` passée au
/// gabarit (DESIGN.md, règle 2 ; spec Button, Modal, EmptyState, Drawer).
const BUTTON_SLOTS: [(&str, &str); 4] = [("Modal", "footer"), ("Dialog", "footer"), ("EmptyState", "action"), ("Section", "footer")];

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

fn is_color(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if ["rgb(", "rgba(", "hsl(", "hsla(", "oklch(", "oklab(", "lab(", "lch(", "hwb("].iter().any(|f| lower.contains(f)) {
        return true;
    }
    let bytes = lower.as_bytes();
    let mut index = 0;
    while let Some(offset) = lower[index..].find('#') {
        let start = index + offset + 1;
        let digits = bytes[start..].iter().take_while(|byte| byte.is_ascii_hexdigit()).count();
        let after = bytes.get(start + digits).copied();
        let ends = after.is_none_or(|byte| !(byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
        // Un fragment d’adresse (`#section`) n’est pas une couleur : seules 3, 4, 6 ou 8 chiffres hexadécimaux.
        if ends && matches!(digits, 3 | 4 | 6 | 8) && (start < 2 || bytes[start - 2] != b'&') {
            return true;
        }
        index = start;
    }
    false
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

    fn socle_name(&self, local: &str) -> Option<&str> {
        self.socle.get(local).map(String::as_str)
    }

    fn check_element(&mut self, element: &JSXElement) {
        let opening = &element.opening_element;
        let Some((local, intrinsic)) = element_name(&opening.name) else { return };
        let start = opening.span.start;
        // Un composant Socle se reconnaît par son import, même renommé (`Button as B`).
        let name = self.socle_name(&local).map(str::to_string).unwrap_or_else(|| local.clone());
        let from_socle = self.socle.contains_key(&local);

        for forbidden in ["style", "className"] {
            if let Some(found) = attribute(opening, forbidden) {
                let what = if from_socle { "un composant de socle-ui" } else { "une page" };
                self.report(
                    found.span.start,
                    format!(
                        "Style propre interdit : `{forbidden}` sur `<{local}>` ({what}). Régler les options du composant (`variant`, `size`, `tone`, `width`, `density`) ou composer avec `Stack` et `Row` de `@alfred/kit` (DESIGN.md, règle 5)."
                    ),
                );
            }
        }

        if intrinsic && !self.uses_library && !ALLOWED_TAGS.contains(&name.as_str()) {
            let instead = match name.as_str() {
                "div" | "section" | "header" | "footer" | "main" | "aside" | "nav" => {
                    "un gabarit (`Page` et `PageSection`, `ListPage`, `DetailPage`), ou `Stack` et `Row` de `@alfred/kit`"
                }
                "span" | "p" | "strong" | "em" | "small" | "b" | "i" | "label" => "`Text` de `@alfred/kit`",
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => "le `title` d’une `PageSection` (le nom de la page est dans la barre du haut)",
                "button" => "une `Action` passée au gabarit, ou `Button` / `IconButton` de `socle-ui`",
                "a" => "`Link` de `socle-ui`",
                "input" => "`TextInput`, `Checkbox`, `Toggle` ou `RadioButtonGroup` de `socle-ui`",
                "select" => "`Select` de `socle-ui`",
                "textarea" => "`TextArea` de `socle-ui`",
                "table" | "thead" | "tbody" | "tr" | "td" | "th" => "`Table` de `socle-ui`, ou `ListPage`",
                "ul" | "ol" | "li" => "`List` de `socle-ui`",
                "dl" | "dt" | "dd" => "les `fields` d’un `Drawer`",
                "hr" => "`Separator` de `socle-ui`",
                "pre" | "code" => "`Code` de `socle-ui` (un journal : `LogViewer` ; une console : `Terminal`)",
                "img" => "`DocumentViewer` de `socle-ui` (ou `Avatar` pour une personne)",
                "style" => "les tokens de socle-ui : une page n’a pas de feuille de style",
                _ => "un composant de `socle-ui`",
            };
            self.report(start, format!("Balise HTML `<{name}>` dans une page : utiliser {instead} (DESIGN.md, règle 5)."));
        }

        if !intrinsic {
            if let Some((_, instead)) = SHELL_PARTS.iter().find(|(part, _)| *part == name) {
                if from_socle {
                    self.report(start, format!("`<{name}>` n’a pas sa place dans une page : c’est {instead}."));
                }
            }
        }

        for (component, wanted, example) in NAMED {
            if name == component && from_socle && attribute(opening, wanted).is_none() {
                self.report(
                    start,
                    format!(
                        "`<{name}>` sans `{wanted}` : nommer ce qu’il montre ({example}), lu par les lecteurs d’écran (spec {name})."
                    ),
                );
            }
        }
        if name == "Terminal" && from_socle && attribute(opening, "engine").is_none() {
            self.report(
                start,
                "`<Terminal>` sans moteur : `engine={loadTerminal}` (de `@alfred/sdk`), puis `connection={{ send, subscribe }}` pour le brancher au programme (DESIGN.md, section 8).".to_string(),
            );
        }
        if name == "DiffView"
            && from_socle
            && attribute(opening, "patch").is_none()
            && (attribute(opening, "before").is_none() || attribute(opening, "after").is_none())
        {
            self.report(
                start,
                "`<DiffView>` sans contenu : `before` et `after` (deux textes) ou `patch` (le `text` de `git.diff`) (spec DiffView).".to_string(),
            );
        }
        if name == "DocumentViewer" && from_socle && attribute(opening, "loadPdf").is_none() {
            self.report(
                start,
                "`<DocumentViewer>` sans `loadPdf` : un PDF resterait en erreur. Passer `loadPdf={loadPdf}` (de `@alfred/sdk`) (DESIGN.md, section 8).".to_string(),
            );
        }

        if from_socle {
            self.rendered.insert(name.clone());
        }
        if name == "Button"
            && from_socle
            && !self.stack.is_empty()
            && self.button_allowed == 0
            && !self.stack.iter().any(|around| around == "Popover")
        {
            self.report(
                start,
                "Avertissement : `<Button>` posé dans la page. Un bouton n’a sa place qu’au pied d’une `Modal`, dans l’action d’un `EmptyState`, au pied d’une section de `Drawer` ou dans un `Popover`. Ailleurs, décrire une `Action` (`{ id, label, icon, onPress, primary }`) et la passer au gabarit de sa zone : `actions` de `ListPage`, `DetailPage`, `Page` ou `PageSection`, `rowActions`, `header.actions` du `Drawer` (PLACEMENT.md, section 6 ; DESIGN.md, règle 2).".to_string(),
            );
        }
        if name == "Tabs" && from_socle {
            self.report(
                start,
                "Avertissement : `<Tabs>` dans une page. Les onglets sont ceux de la barre du haut, dessinés par Alfred (spec Tabs, « Exclus » : pas d’onglets dans le contenu). Une vue de la section est un onglet fixe (`place_page` avec `{ \"kind\": \"tab\" }`), un élément ouvert un onglet fermable (`views.open`) ; un mode d’affichage ou une période, un `SegmentedControl` dans la `toolbar` de `Page` (PLACEMENT.md, section 5).".to_string(),
            );
        }

        if from_socle && matches!(name.as_str(), "Button" | "IconButton" | "Link") && attribute(opening, "onClick").is_some() {
            self.report(
                start,
                format!("`onClick` n’existe pas sur `<{name}>` de socle-ui : écrire `onPress` (spec {name})."),
            );
        }

        if ACTION_OWNERS.contains(&name.as_str()) || (PANEL_ROOTS.contains(&name.as_str()) && from_socle) {
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
                            "`actions` de `<{name}>` reçoit une liste d’`Action` (`{{ id, label, icon, onPress, primary, danger }}`), pas des boutons : le gabarit choisit icône, texte ou menu « … » (DESIGN.md, section 4)."
                        ),
                    );
                }
            }
        }

        if self.settings && from_socle {
            if name == "Page" {
                if let Some(width) = attribute(opening, "width") {
                    self.report(
                        width.span.start,
                        "Une page des Réglages prend toute la largeur de la rubrique : retirer `width` de `<Page>` (DESIGN.md, section 7).".to_string(),
                    );
                }
            }
            if name == "FormPage" {
                self.report(
                    start,
                    "Pas de `<FormPage>` dans les Réglages : un réglage s’applique tout de suite (`Toggle`, `Select`, `TextInput` qui enregistre à la sortie du champ) ; une saisie plus longue passe par `useOpenForm()` depuis un bouton (DESIGN.md, section 7).".to_string(),
                );
            }
        }
    }

    fn check_text(&mut self, offset: u32, text: &str) {
        if is_color(text) {
            self.report(
                offset,
                "Couleur en dur interdite : le sens passe par un ton (`tone` d’un `Badge`, statut d’une colonne), et une librairie reçoit les tokens Socle (`var(--fg)`, `var(--accent)`, `var(--line)`) (DESIGN.md, règle 5).".to_string(),
            );
        }
    }
}

impl<'a> Visit<'a> for Lint<'_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.check_element(element);
        let name = element_name(&element.opening_element.name)
            .map(|(local, _)| self.socle_name(&local).map(str::to_string).unwrap_or(local))
            .unwrap_or_default();
        self.stack.push(name);
        walk::walk_jsx_element(self, element);
        self.stack.pop();
    }

    fn visit_jsx_attribute(&mut self, attribute: &JSXAttribute<'a>) {
        let owner = self.stack.last().map(String::as_str).unwrap_or_default();
        let slot = attribute_name(attribute)
            .is_some_and(|name| BUTTON_SLOTS.iter().any(|(element, wanted)| *element == owner && *wanted == name));
        if slot {
            self.button_allowed += 1;
        }
        walk::walk_jsx_attribute(self, attribute);
        if slot {
            self.button_allowed -= 1;
        }
    }

    fn visit_string_literal(&mut self, literal: &StringLiteral<'a>) {
        self.check_text(literal.span.start, literal.value.as_str());
    }

    fn visit_template_literal(&mut self, literal: &TemplateLiteral<'a>) {
        for quasi in &literal.quasis {
            self.check_text(quasi.span.start, quasi.value.raw.as_str());
        }
        walk::walk_template_literal(self, literal);
    }

    fn visit_jsx_child(&mut self, child: &JSXChild<'a>) {
        if let JSXChild::Text(text) = child {
            self.check_text(text.span.start, text.value.as_str());
        }
        walk::walk_jsx_child(self, child);
    }
}

fn matches_library(source: &str, library: &str) -> bool {
    source == library || source.starts_with(&format!("{library}/"))
}

/// Remarques de design sur le fichier d’une page ; vide si la page ne se lit pas (ses erreurs sont dites ailleurs).
/// `placement` : où la page est placée (zone principale, Réglages ou panneau de droite). Sans le chemin du fichier,
/// les composants importés d’un autre fichier du module ne sont pas suivis : voir `lint_file`.
#[cfg(test)]
pub fn lint(source: &str, placement: Placement) -> Vec<Diagnostic> {
    let none = |_: &Path| None;
    lint_with(source, placement, Path::new("page.tsx"), &rows::Sources::new(&none))
}

/// Remarques de design sur le fichier d’une page, en suivant les composants qu’elle importe du module (`./…`).
pub fn lint_file(path: &Path, placement: Placement) -> Vec<Diagnostic> {
    let Ok(source) = std::fs::read_to_string(path) else { return Vec::new() };
    let read = |file: &Path| std::fs::read_to_string(file).ok();
    lint_with(&source, placement, path, &rows::Sources::new(&read))
}

fn lint_with(source: &str, placement: Placement, path: &Path, sources: &rows::Sources) -> Vec<Diagnostic> {
    let settings = placement == Placement::Settings;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
        return Vec::new();
    }
    let uses_library = parsed.module_record.requested_modules.keys().any(|specifier| {
        let specifier = specifier.as_str();
        !specifier.starts_with('.')
            && !crate::transpile::ALLOWED_IMPORTS.contains(&specifier)
            && specifier != crate::transpile::RETIRED_UI
    });
    let mut lint = Lint {
        source,
        uses_library,
        socle: BTreeMap::new(),
        settings,
        stack: Vec::new(),
        button_allowed: 0,
        rendered: BTreeSet::new(),
        found: Vec::new(),
    };
    let mut top_bar_actions = None;
    for statement in &parsed.program.body {
        let oxc::ast::ast::Statement::ImportDeclaration(import) = statement else { continue };
        let source_name = import.source.value.as_str();
        let named = || {
            import.specifiers.iter().flatten().filter_map(|specifier| match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    Some((named.local.name.to_string(), named.imported.name().to_string(), named.span.start))
                }
                _ => None,
            })
        };
        if SOCLE_ENTRIES.contains(&source_name) {
            let exported = crate::socle_ui::exports(source_name);
            for (local, imported, offset) in named() {
                if let Some(current) = crate::socle_ui::replacement(&imported) {
                    lint.report(
                        offset,
                        format!(
                            "Avertissement : `{imported}` est l’ancien nom de `{current}` (socle-ui {}) ; il disparaîtra en 2.0.0. Importer et écrire `{current}` (DESIGN.md, section 8 ; D-336).",
                            crate::socle_ui::VERSION
                        ),
                    );
                } else if !exported.is_empty() && !exported.contains(&imported.as_str()) {
                    lint.report(
                        offset,
                        format!(
                            "`{imported}` n’existe pas dans `{source_name}` (socle-ui {}) : la page échouerait. Prendre un composant du catalogue (DESIGN.md, section 8, et sa spec dans docs/alfred/socle/specs/) ; si aucun ne convient, demander à l’utilisateur avant de construire (PLACEMENT.md, section 9).",
                            crate::socle_ui::VERSION
                        ),
                    );
                }
                lint.socle.insert(local, imported);
            }
            continue;
        }
        if source_name.starts_with("socle-ui/") {
            lint.report(
                import.span.start,
                format!("Chemin interne de socle-ui : « {source_name} ». Importer depuis `socle-ui`, `socle-ui/markdown` ou `socle-ui/markdown-editor` (DESIGN.md, règle 3)."),
            );
            continue;
        }
        if source_name == crate::transpile::RETIRED_UI {
            let names: Vec<_> = named().collect();
            if names.is_empty() {
                lint.report(import.span.start, "`@alfred/ui` n’existe plus : importer `socle-ui` (DESIGN.md, section 15).".to_string());
            }
            for (_, imported, offset) in names {
                let instead = UI_REPLACEMENTS
                    .iter()
                    .find(|(old, _)| *old == imported)
                    .map(|(_, instead)| (*instead).to_string())
                    .unwrap_or_else(|| format!("`{imported}` de `socle-ui` (lire sa spec : options différentes)"));
                lint.report(offset, format!("`@alfred/ui` n’existe plus : `{imported}` devient {instead} (DESIGN.md, section 15)."));
            }
            continue;
        }
        if let Some(library) = HEADLESS.iter().find(|library| matches_library(source_name, library)) {
            lint.report(
                import.span.start,
                format!("`{library}` est déjà enveloppé par socle-ui : prendre le composant de `socle-ui` (DESIGN.md, règle 3)."),
            );
        }
        if let Some((library, instead)) = COVERED_LIBRARIES.iter().find(|(library, _)| matches_library(source_name, library)) {
            lint.report(
                import.span.start,
                format!("`{library}` est déjà couvert par socle-ui : utiliser {instead} (DESIGN.md, section 8)."),
            );
        }
        if source_name != "@alfred/sdk" {
            continue;
        }
        for (_, imported, offset) in named() {
            if imported == "client" {
                lint.report(
                    offset,
                    "Une page n’appelle pas un client : chaque appel au service est une fonction du connecteur                      (`declare_function`, `effect`, `tests`), que la page appelle avec `functions.call(\"module/fonction\", …)`.                      Le client refuse les requêtes des pages."
                        .to_string(),
                );
            }
            if imported == "useTopBarActions" {
                top_bar_actions = Some(offset);
            }
            if imported == "useTopBarSearch" {
                lint.report(
                    offset,
                    "La barre du haut n’a plus de recherche : la recherche d’une collection est celle de `ListPage` (`search`), sinon un `SearchInput` dans la `toolbar` de `Page` (DESIGN.md, section 4).".to_string(),
                );
            }
        }
    }
    lint.visit_program(&parsed.program);
    if let Some(offset) = top_bar_actions {
        if let Some(template) = ["ListPage", "DetailPage"].into_iter().find(|name| lint.rendered.contains(*name)) {
            lint.report(
                offset,
                format!("Avertissement : `useTopBarActions` dans une page qui rend une `{template}`. Ses actions vont dans `actions` du gabarit (zone `header`) : la barre du haut est réservée aux actions d’une `Page` composée, et un écran n’a qu’un bouton plein (PLACEMENT.md, section 6 ; D-220)."),
            );
        }
    }
    for (offset, message) in rows::check(&parsed.program, path, sources, placement == Placement::Panel) {
        lint.report(offset, message);
    }
    if placement == Placement::Panel {
        if let Some((offset, message)) = panel_root_problem(&parsed.program.body, &lint.socle) {
            lint.report(offset, message);
        }
    }
    lint.found
}

/// Corps d’une fonction de composant du fichier : sa liste d’instructions, ou l’expression rendue d’une flèche.
enum Body<'b, 'a> {
    Statements(&'b FunctionBody<'a>),
    Expression(&'b Expression<'a>),
}

fn function_body<'b, 'a>(function: &'b Function<'a>) -> Option<Body<'b, 'a>> {
    function.body.as_deref().map(Body::Statements)
}

fn arrow_body<'b, 'a>(arrow: &'b ArrowFunctionExpression<'a>) -> Option<Body<'b, 'a>> {
    match &arrow.body {
        ArrowFunctionBody::FunctionBody(body) => Some(Body::Statements(body)),
        other => other.as_expression().map(Body::Expression),
    }
}

fn expression_body<'b, 'a>(expression: &'b Expression<'a>) -> Option<Body<'b, 'a>> {
    match expression.without_parentheses() {
        Expression::ArrowFunctionExpression(arrow) => arrow_body(arrow),
        Expression::FunctionExpression(function) => function_body(function),
        _ => None,
    }
}

/// Expressions rendues par un corps, sans entrer dans les fonctions qu’il déclare.
#[derive(Default)]
struct Returns<'b, 'a> {
    found: Vec<&'b Expression<'a>>,
}

impl<'b, 'a> Returns<'b, 'a> {
    fn of(body: &Body<'b, 'a>) -> Vec<&'b Expression<'a>> {
        match body {
            Body::Expression(expression) => vec![*expression],
            Body::Statements(body) => {
                let mut returns = Returns::default();
                for statement in &body.statements {
                    returns.statement(statement);
                }
                returns.found
            }
        }
    }

    fn statement(&mut self, statement: &'b Statement<'a>) {
        match statement {
            Statement::ReturnStatement(ret) => self.ret(ret),
            Statement::BlockStatement(block) => block.body.iter().for_each(|inner| self.statement(inner)),
            Statement::IfStatement(branch) => {
                self.statement(&branch.consequent);
                if let Some(alternate) = &branch.alternate {
                    self.statement(alternate);
                }
            }
            Statement::TryStatement(attempt) => {
                attempt.block.body.iter().for_each(|inner| self.statement(inner));
                if let Some(handler) = &attempt.handler {
                    handler.body.body.iter().for_each(|inner| self.statement(inner));
                }
                if let Some(finalizer) = &attempt.finalizer {
                    finalizer.body.iter().for_each(|inner| self.statement(inner));
                }
            }
            Statement::SwitchStatement(switch) => {
                switch.cases.iter().flat_map(|case| &case.consequent).for_each(|inner| self.statement(inner));
            }
            _ => {}
        }
    }

    fn ret(&mut self, ret: &'b ReturnStatement<'a>) {
        if let Some(argument) = &ret.argument {
            self.found.push(argument);
        }
    }
}

fn register<'b, 'a>(declaration: &'b Declaration<'a>, named: &mut BTreeMap<String, Body<'b, 'a>>) {
    match declaration {
        Declaration::FunctionDeclaration(function) => {
            if let (Some(id), Some(body)) = (&function.id, function_body(function)) {
                named.insert(id.name.to_string(), body);
            }
        }
        Declaration::VariableDeclaration(variables) => {
            for declarator in &variables.declarations {
                let (Some(id), Some(init)) = (declarator.id.get_binding_identifier(), &declarator.init) else { continue };
                if let Some(body) = expression_body(init) {
                    named.insert(id.name.to_string(), body);
                }
            }
        }
        _ => {}
    }
}

/// Composant exporté par défaut : son corps, ou le nom du composant du fichier qu’il désigne.
enum DefaultExport<'b, 'a> {
    Body(Body<'b, 'a>),
    Named(String),
}

/// Composants déclarés au premier niveau du fichier (nom → corps), et le composant exporté par défaut.
fn components<'b, 'a>(body: &'b [Statement<'a>]) -> (BTreeMap<String, Body<'b, 'a>>, Option<DefaultExport<'b, 'a>>) {
    let mut named = BTreeMap::new();
    let mut default = None;
    for statement in body {
        if let Some(declaration) = statement.as_declaration() {
            register(declaration, &mut named);
            continue;
        }
        match statement {
            Statement::ExportDeclaration(export) => register(&export.declaration, &mut named),
            Statement::ExportDefaultDeclaration(export) => {
                default = match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        if let (Some(id), Some(body)) = (&function.id, function_body(function)) {
                            named.insert(id.name.to_string(), body);
                        }
                        function_body(function).map(DefaultExport::Body)
                    }
                    ExportDefaultDeclarationKind::Identifier(reference) => Some(DefaultExport::Named(reference.name.to_string())),
                    kind => kind.as_expression().and_then(expression_body).map(DefaultExport::Body),
                };
            }
            _ => {}
        }
    }
    (named, default)
}

const PANEL_ROOTS: [&str; 2] = ["Drawer", "DetailPanel"];

/// Ce que rend une expression, à sa racine : un élément JSX nommé, autre chose, ou rien (`null`).
fn root_problem<'b, 'a>(
    expression: &'b Expression<'a>,
    named: &BTreeMap<String, Body<'b, 'a>>,
    socle: &BTreeMap<String, String>,
    depth: usize,
) -> Option<(u32, String)> {
    let not_drawer = |offset: u32, what: String| {
        Some((
            offset,
            format!(
                "Une page placée en panneau (`placement: {{ kind: \"panel\" }}`) rend un `<Drawer>` de `socle-ui` à sa racine, pas {what} : un panneau de droite ne contient qu’un `Drawer` (sections, propriétés, actions) (DESIGN.md, section 6)."
            ),
        ))
    };
    match expression.without_parentheses() {
        Expression::NullLiteral(_) => None,
        Expression::ConditionalExpression(choice) => root_problem(&choice.consequent, named, socle, depth)
            .or_else(|| root_problem(&choice.alternate, named, socle, depth)),
        Expression::LogicalExpression(logical) => root_problem(&logical.right, named, socle, depth),
        Expression::JSXElement(element) => {
            let opening = &element.opening_element;
            let Some((local, intrinsic)) = element_name(&opening.name) else {
                return not_drawer(opening.span.start, "cet élément".to_string());
            };
            let member = matches!(opening.name, JSXElementName::MemberExpression(_));
            if !member && socle.get(&local).is_some_and(|imported| PANEL_ROOTS.contains(&imported.as_str())) {
                return None;
            }
            // Un composant du fichier qui rend lui-même le Drawer convient.
            if !member && !intrinsic && depth < 4 {
                if let Some(body) = named.get(&local) {
                    return panel_body_problem(body, named, socle, depth + 1)
                        .map(|(_, message)| (opening.span.start, message));
                }
            }
            not_drawer(opening.span.start, format!("`<{local}>`"))
        }
        Expression::JSXFragment(fragment) => not_drawer(fragment.span.start, "un fragment `<>…</>`".to_string()),
        other => not_drawer(oxc::span::GetSpan::span(other).start, "cette expression".to_string()),
    }
}

fn panel_body_problem<'b, 'a>(
    body: &Body<'b, 'a>,
    named: &BTreeMap<String, Body<'b, 'a>>,
    socle: &BTreeMap<String, String>,
    depth: usize,
) -> Option<(u32, String)> {
    let returns = Returns::of(body);
    // Un composant qui ne rend jamais que `null` n'a pas de Drawer.
    if returns.iter().all(|expression| matches!(expression.without_parentheses(), Expression::NullLiteral(_))) {
        return Some((
            0,
            "Une page placée en panneau rend un `<Drawer>` de `socle-ui` à sa racine (DESIGN.md, section 6).".to_string(),
        ));
    }
    returns.into_iter().find_map(|expression| root_problem(expression, named, socle, depth))
}

/// Une page placée en panneau rend un `Drawer` (ou l’ancien nom `DetailPanel`) de socle-ui à sa racine.
fn panel_root_problem(body: &[Statement], socle: &BTreeMap<String, String>) -> Option<(u32, String)> {
    let (named, default) = components(body);
    let default = match &default {
        Some(DefaultExport::Body(body)) => Some(body),
        Some(DefaultExport::Named(name)) => named.get(name),
        None => None,
    };
    let Some(default) = default else {
        return Some((
            0,
            "Une page placée en panneau exporte par défaut un composant qui rend un `<Drawer>` de `socle-ui` (DESIGN.md, section 6).".to_string(),
        ));
    };
    panel_body_problem(default, &named, socle, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(source: &str) -> Vec<String> {
        lint(source, Placement::Page).into_iter().map(|found| format!("{}: {}", found.line.unwrap_or(0), found.message)).collect()
    }

    fn panel_messages(source: &str) -> Vec<String> {
        lint(source, Placement::Panel).into_iter().map(|found| format!("{}: {}", found.line.unwrap_or(0), found.message)).collect()
    }

    fn settings_messages(source: &str) -> Vec<String> {
        lint(source, Placement::Settings).into_iter().map(|found| format!("{}: {}", found.line.unwrap_or(0), found.message)).collect()
    }

    fn module_messages(files: &[(&str, &str)], page: &str) -> Vec<String> {
        let map: std::collections::HashMap<std::path::PathBuf, String> =
            files.iter().map(|(path, source)| (std::path::PathBuf::from(path), source.to_string())).collect();
        let read = |path: &Path| map.get(path).cloned();
        let source = map.get(Path::new(page)).cloned().unwrap_or_default();
        lint_with(&source, Placement::Panel, Path::new(page), &rows::Sources::new(&read))
            .into_iter()
            .map(|found| format!("{}: {}", found.line.unwrap_or(0), found.message))
            .collect()
    }

    #[test]
    fn un_champ_de_saisie_dans_une_ligne_de_drawer_est_refuse() {
        let page = r#"
import { Drawer, InlineEdit, PropertyRow, Select, TextField as Saisie } from "socle-ui";
export default function Fiche() {
  return (
    <Drawer
      sections={[
        { id: "a", title: "Suivi", fields: [
          { label: "État", value: <Select label="État" options={[]} /> },
          { label: "Titre", value: <InlineEdit label="Titre" value={t} onSave={enregistrer} /> },
          { label: "Échéance", value: t.echeance, type: "date" },
        ] },
        { id: "b", title: "Notes", content: <Saisie label="Note" /> },
      ]}
    />
  );
}
function Lignes() {
  return <PropertyRow label="Priorité" value={<Select label="Priorité" options={[]} />} />;
}
function Texte() {
  return <PropertyRow label="Titre" value={<InlineEdit label="Titre" value={t} onSave={enregistrer} />} />;
}
"#;
        let found = panel_messages(page);
        assert!(found.iter().any(|m| m.starts_with("8: Champ de saisie `<Select>` dans une ligne de `Drawer` (`value` d’un champ de `fields`)") && m.contains("DESIGN.md, section 6") && m.contains("spec Drawer")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("12: Champ de saisie `<TextField>` dans une section de `Drawer` (`content`)")), "ancien nom, renommé à l’import : {found:?}");
        assert!(found.iter().any(|m| m.starts_with("18: Champ de saisie `<Select>` dans une ligne de `Drawer` (`value` de `PropertyRow`)")), "{found:?}");
        // Forme déclarative : la valeur est brute ; un élément, même un InlineEdit, s’y affiche « [object Object] ».
        assert!(found.iter().any(|m| m.starts_with("9: Élément React en `value` d’un champ de `fields`")), "{found:?}");
        assert!(!found.iter().any(|m| m.starts_with("10:") || m.starts_with("21:")), "valeur typée, InlineEdit de PropertyRow : {found:?}");
        // L’ancien nom `TextField` reçoit en plus son avertissement (ligne 2).
        assert!(found.iter().any(|m| m.starts_with("2: Avertissement : `TextField` est l’ancien nom de `TextInput`")), "{found:?}");
        assert_eq!(found.len(), 5, "{found:?}");
    }

    #[test]
    fn un_composant_du_module_qui_rend_un_champ_est_suivi() {
        let page = r#"
import { Drawer, PropertyRow } from "socle-ui";
import { ChampDirect } from "../lib/champ-direct";
import Bloc from "../lib/bloc";
export default function Details() {
  const champs = (liste) => liste.map((c) => <PropertyRow key={c.id} label={c.nom} value={<ChampDirect champ={c} />} />);
  return <Drawer sections={[{ id: "champs", title: "Champs", content: champs(liste) }, { id: "x", title: "X", content: <Bloc /> }]} />;
}
"#;
        let champ = r#"
import { ComboBox, InlineEdit } from "socle-ui";
import { Choix } from "./choix";
export function ChampDirect({ champ }) {
  if (champ.texte) return <InlineEdit label={champ.nom} value={champ.valeur} onSave={enregistrer} />;
  return champ.multiple ? <ComboBox label={champ.nom} /> : <Choix champ={champ} />;
}
"#;
        let choix = r#"export { Liste as Choix } from "./liste";"#;
        let liste = r#"
import { RadioGroup } from "socle-ui";
export const Liste = ({ champ }) => <RadioGroup label={champ.nom} />;
"#;
        let bloc = r#"
import { Dialog, IconButton, TextField } from "socle-ui";
export default function Bloc() {
  return (
    <>
      <IconButton label="Modifier" onPress={() => ouvrir(<TextField label="Nom" />)} />
      <Dialog isOpen={ouvert} title="Modifier"><TextField label="Nom" /></Dialog>
    </>
  );
}
"#;
        let files = [
            ("m/pages/details.tsx", page),
            ("m/lib/champ-direct.tsx", champ),
            ("m/lib/choix.ts", choix),
            ("m/lib/liste.tsx", liste),
            ("m/lib/bloc.tsx", bloc),
        ];
        let found = module_messages(&files, "m/pages/details.tsx");
        assert!(found.iter().any(|m| m.starts_with("6: `ChampDirect` (de `../lib/champ-direct`) rend un champ de saisie (`<ComboBox>`) dans une ligne de `Drawer` (`value` de `PropertyRow`)")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("7: `champs` rend un champ de saisie")), "{found:?}");
        assert!(!found.iter().any(|m| m.contains("`Bloc`")), "une fenêtre et un gestionnaire ne sont pas des lignes : {found:?}");

        // Seule la liste de choix, reprise d’un autre fichier, rend un champ : elle est trouvée à travers l’export.
        let champ_radio = champ.replace("<ComboBox label={champ.nom} />", "null");
        let files = [("m/pages/details.tsx", page), ("m/lib/champ-direct.tsx", champ_radio.as_str()), ("m/lib/choix.ts", choix), ("m/lib/liste.tsx", liste), ("m/lib/bloc.tsx", bloc)];
        let found = module_messages(&files, "m/pages/details.tsx");
        assert!(found.iter().any(|m| m.contains("`ChampDirect` (de `../lib/champ-direct`) rend un champ de saisie (`<RadioGroup>`)")), "{found:?}");

        // Sans les fichiers du module, la page seule ne dit rien de ses composants.
        assert!(!panel_messages(page).iter().any(|m| m.contains("ChampDirect")), "{:?}", panel_messages(page));
    }

    #[test]
    fn les_lignes_de_drawer_section_et_les_actions_de_ligne() {
        let page = r#"
import { Drawer, DropdownMenu, PropertyRow, Checkbox } from "socle-ui";
import { Pencil } from "lucide-react";
export default function Fiche() {
  return (
    <Drawer>
      <Drawer.Section id="a" title="Accès">
        <PropertyRow
          label="Profil"
          value={profil.nom}
          action={{ type: "icon", icon: <Pencil size={16} />, label: "Changer le profil", menu: (
            <DropdownMenu.Section selectionMode="single" selectedKeys={[profil.id]} onSelectionChange={choisir}>
              <DropdownMenu.Item id="a" label="Admin" />
            </DropdownMenu.Section>
          ) }}
        />
        <Checkbox isSelected={coche}>Appliquer</Checkbox>
      </Drawer.Section>
    </Drawer>
  );
}
"#;
        let found = panel_messages(page);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].starts_with("17: Champ de saisie `<Checkbox>` dans une section de `Drawer` (enfants de `Drawer.Section`)"), "{found:?}");
    }

    #[test]
    fn l_en_tete_du_drawer_nomme_l_objet() {
        let page = r#"
import { Drawer } from "socle-ui";
export default function Details() {
  return (
    <Drawer
      header={ticket ? { title: `Détails · ${ticket.cle}`, subtitle: "Chaque changement est enregistré aussitôt." } : undefined}
      sections={[]}
    />
  );
}
"#;
        let found = lint(page, Placement::Panel);
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.iter().all(|f| is_warning(&f.message) && f.line == Some(6)), "{found:?}");
        assert!(found[0].message.contains("commence par « Détail »") && found[0].message.contains("DESIGN.md, section 6"), "{found:?}");
        assert!(found[1].message.contains("phrase d’aide (« Chaque changement est enregistré aussitôt. »)"), "{found:?}");

        let bon = r#"
import { Drawer } from "socle-ui";
export default function Details() {
  return <Drawer header={{ title: `${ticket.cle} · ${ticket.titre}`, subtitle: "Bug · Projet Alfred" }} sections={[]} />;
}
"#;
        assert!(panel_messages(bon).is_empty(), "{:?}", panel_messages(bon));
    }

    #[test]
    fn un_import_de_l_ancienne_bibliotheque_dit_le_gabarit_socle() {
        let page = r#"
import { CollectionPage, openForm, Pagination } from "@alfred/ui";
export default function P() {
  return null;
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.contains("`CollectionPage` devient `ListPage`")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`openForm` devient `useOpenForm()`")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`Pagination` devient `pagination` de `ListPage`")), "{found:?}");
    }

    #[test]
    fn socle_ui_s_importe_par_ses_entrees_seulement() {
        let page = r#"
import { Button } from "socle-ui/dist/components/Button";
import { Dialog } from "react-aria-components";
export default function P() {
  return null;
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("2: Chemin interne de socle-ui")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("3: `react-aria-components` est déjà enveloppé")), "{found:?}");
    }

    #[test]
    fn une_librairie_couverte_par_socle_est_refusee_avec_le_composant() {
        let page = r#"
import { createTwoFilesPatch } from "diff";
import ReactMarkdown from "react-markdown";
import { Terminal as XTerm } from "@xterm/xterm";
import { useReactTable } from "@tanstack/react-table";
import { Tree } from "react-arborist";
export default function P() {
  return null;
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("2: `diff` est déjà couvert") && m.contains("<DiffView")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("3: `react-markdown`") && m.contains("socle-ui/markdown")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("4: `@xterm/xterm`") && m.contains("loadTerminal")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("5: `@tanstack/react-table`") && m.contains("ListPage")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("6: `react-arborist`") && m.contains("<TreeView")), "{found:?}");
    }

    #[test]
    fn signale_le_style_propre_meme_renomme_et_les_balises_html() {
        let page = r#"
import { Button as Bouton, Page, PageSection } from "socle-ui";
export default function P() {
  return (
    <Page>
      <PageSection title="Équipe">
        <Bouton className="grand" onPress={go}>Ajouter</Bouton>
        <div style={{ padding: 8 }}>texte</div>
        <form noValidate><select><option>a</option></select></form>
      </PageSection>
    </Page>
  );
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("7: Style propre interdit : `className` sur `<Bouton>` (un composant de socle-ui)")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("8: Style propre interdit : `style`")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("8: Balise HTML `<div>`") && m.contains("`Stack`")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`<select>`") && m.contains("`Select`")), "{found:?}");
        assert!(!found.iter().any(|m| m.contains("`<form>`") || m.contains("`<option>`")), "{found:?}");
    }

    #[test]
    fn signale_les_couleurs_en_dur() {
        let page = r##"
import { Page, PageSection } from "socle-ui";
const accent = "#ff0055";
const ombre = `0 0 4px rgba(0, 0, 0, 0.2)`;
const lien = "#section";
export default function P() {
  return <Page><PageSection title="Bilan" /></Page>;
}
"##;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("3: Couleur en dur")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("4: Couleur en dur")), "{found:?}");
        assert!(!found.iter().any(|m| m.starts_with("5:")), "un fragment d’adresse n’est pas une couleur : {found:?}");
    }

    #[test]
    fn les_actions_sont_des_donnees_et_les_boutons_prennent_on_press() {
        let page = r#"
import { Button, ListPage, Page, PageSection } from "socle-ui";
export default function P() {
  return (
    <Page actions={<Button onClick={ajouter}>Nouveau</Button>}>
      <PageSection title="Équipe" actions={[{ id: "ajouter", label: "Ajouter un membre", onPress: ajouter }]} />
    </Page>
  );
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.contains("`actions` de `<Page>` reçoit une liste d’`Action`")), "{found:?}");
        assert!(!found.iter().any(|m| m.contains("`actions` de `<PageSection>`")), "une liste d’actions convient : {found:?}");
        assert!(found.iter().any(|m| m.contains("`onClick` n’existe pas sur `<Button>`")), "{found:?}");
    }

    #[test]
    fn les_composants_qui_demandent_un_nom_et_un_moteur() {
        let page = r#"
import { DiffView, DocumentViewer, LogViewer, Page, Terminal, TreeView } from "socle-ui";
import { MarkdownEditor } from "socle-ui/markdown-editor";
export default function P() {
  return (
    <Page>
      <LogViewer lines={[]} />
      <Terminal label="Console" />
      <DiffView label="Modifications" before="a" />
      <DocumentViewer label="Facture" data={octets} />
      <TreeView nodes={[]} />
      <MarkdownEditor value="" onChange={changer} />
    </Page>
  );
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("7: `<LogViewer>` sans `label`")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("8: `<Terminal>` sans moteur")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("9: `<DiffView>` sans contenu")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("10: `<DocumentViewer>` sans `loadPdf`")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("11: `<TreeView>` sans `aria-label`")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("12: `<MarkdownEditor>` sans `label`")), "{found:?}");

        let good = r#"
import { loadPdf, loadTerminal } from "@alfred/sdk";
import { DiffView, DocumentViewer, LogViewer, Page, Terminal, TreeView } from "socle-ui";
export default function P() {
  return (
    <Page>
      <LogViewer label="Journal" lines={[]} />
      <Terminal label="Console" engine={loadTerminal} connection={lien} />
      <DiffView label="Modifications" patch={patch} />
      <DocumentViewer label="Facture" data={octets} loadPdf={loadPdf} />
      <TreeView aria-label="Dossiers" nodes={[]} />
    </Page>
  );
}
"#;
        assert!(messages(good).is_empty(), "{:?}", messages(good));
    }

    #[test]
    fn la_coquille_et_la_recherche_du_haut_ne_sont_pas_dans_une_page() {
        let page = r#"
import { useTopBarSearch, functions, client } from "@alfred/sdk";
import { AppShell, SettingsPage } from "socle-ui";
export default function P() {
  return <AppShell><SettingsPage groups={[]} /></AppShell>;
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("2: La barre du haut n’a plus de recherche")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("2: Une page n’appelle pas un client")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`<AppShell>` n’a pas sa place")), "{found:?}");
        assert!(found.iter().any(|m| m.contains("`<SettingsPage>` n’a pas sa place")), "{found:?}");
    }

    #[test]
    fn une_page_des_reglages_s_applique_tout_de_suite() {
        let page = r#"
import { FormPage, Page, PageSection } from "socle-ui";
export default function P() {
  return (
    <Page width="text">
      <PageSection title="Signature">
        <FormPage title="Signature" sections={[]} submitLabel="Enregistrer" onSubmit={enregistrer} />
      </PageSection>
    </Page>
  );
}
"#;
        let found = settings_messages(page);
        assert!(found.iter().any(|m| m.starts_with("5: Une page des Réglages prend toute la largeur")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("7: Pas de `<FormPage>`")), "{found:?}");
        assert!(messages(page).is_empty(), "hors des Réglages, rien à redire : {:?}", messages(page));
    }

    #[test]
    fn une_librairie_garde_son_conteneur() {
        let page = r#"
import * as echarts from "echarts";
export default function P() {
  return <div ref={ref} />;
}
"#;
        assert!(messages(page).is_empty(), "{:?}", messages(page));
    }

    #[test]
    fn une_page_conforme_ne_recoit_aucune_remarque() {
        let page = r#"
import { Pencil, Plus } from "lucide-react";
import { notifyActionError, shell, useAsync } from "@alfred/sdk";
import { Text } from "@alfred/kit";
import { ListPage, Page, PageSection, useOpenForm } from "socle-ui";
export default function Taches() {
  const openForm = useOpenForm();
  const taches = useAsync(charger, []);
  return (
    <ListPage
      title="Tâches"
      rows={taches.data}
      columns={[{ id: "titre", label: "Titre" }, { id: "etat", label: "État", type: "status", statuses: ETATS }]}
      empty={{ title: "Aucune tâche", description: "Créez la première tâche." }}
      hasError={Boolean(taches.error)}
      onRetry={taches.reload}
      onSelect={(row) => void shell.publish(row)}
      onActionError={notifyActionError}
      actions={[{ id: "nouvelle", label: "Nouvelle tâche", icon: <Plus size={16} />, primary: true, onPress: () => openForm({ title: "Nouvelle tâche", fields: [{ name: "titre", label: "Titre" }], submitLabel: "Créer", onSubmit: creer }) }]}
      rowActions={(t) => [{ id: "modifier", label: "Modifier", icon: <Pencil size={16} />, onPress: () => modifier(t) }]}
    />
  );
}
export function Bilan() {
  return (
    <Page>
      <PageSection title="Résumé">
        <Text>Contenu</Text>
      </PageSection>
    </Page>
  );
}
"#;
        assert!(messages(page).is_empty(), "{:?}", messages(page));
    }

    #[test]
    fn une_page_en_panneau_rend_un_drawer() {
        let drawer = r#"
import { Drawer } from "socle-ui";
export default function Fiche() {
  const fiche = useFiche();
  if (!fiche) return null;
  return <Drawer header={{ title: fiche.nom }} sections={[{ id: "infos", title: "Infos", fields: [] }]} />;
}
"#;
        assert!(panel_messages(drawer).is_empty(), "{:?}", panel_messages(drawer));

        // Ancien nom, renommé à l'import, ou rendu par un composant du fichier : toujours un Drawer.
        let alias = r#"
import { DetailPanel as Panneau } from "socle-ui";
const Contenu = ({ id }) => (chargement ? <Panneau isLoading /> : <Panneau sections={[]} />);
export default function Fiche() {
  return <Contenu id="a" />;
}
"#;
        let alias_found = panel_messages(alias);
        assert!(alias_found.iter().all(|m| is_warning(m.split_once(": ").unwrap().1) && m.contains("ancien nom de `Drawer`")), "{alias_found:?}");

        let fleche = r#"
import { Drawer } from "socle-ui";
const Fiche = () => <Drawer sections={[]} />;
export default Fiche;
"#;
        assert!(panel_messages(fleche).is_empty(), "{:?}", panel_messages(fleche));
    }

    #[test]
    fn une_page_en_panneau_sans_drawer_est_refusee() {
        let page = r#"
import { Page, PageSection } from "socle-ui";
import { Text } from "@alfred/kit";
export default function Fiche() {
  return (
    <Page>
      <PageSection title="Infos">
        <Text>Contenu</Text>
      </PageSection>
    </Page>
  );
}
"#;
        let found = panel_messages(page);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].starts_with("6: "), "{found:?}");
        assert!(found[0].contains("`<Page>`") && found[0].contains("DESIGN.md, section 6"), "{found:?}");
        // La même page n'est pas relevée hors du panneau.
        assert!(messages(page).is_empty(), "{:?}", messages(page));

        // Une seule branche sans Drawer suffit, comme un fragment ou un composant du fichier qui n'en rend pas.
        let branche = r#"
import { Drawer, EmptyState } from "socle-ui";
export default function Fiche() {
  return vide ? <EmptyState title="Rien" /> : <Drawer sections={[]} />;
}
"#;
        assert!(panel_messages(branche).iter().any(|m| m.contains("`<EmptyState>`")), "{:?}", panel_messages(branche));
        let fragment = r#"
import { Drawer } from "socle-ui";
function Interne() {
  return <><Drawer sections={[]} /></>;
}
export default function Fiche() {
  return <Interne />;
}
"#;
        assert!(panel_messages(fragment).iter().any(|m| m.contains("fragment")), "{:?}", panel_messages(fragment));

        // Un Drawer qui ne vient pas de socle-ui ne compte pas.
        let local = r#"
function Drawer() {
  return null;
}
export default function Fiche() {
  return <Drawer />;
}
"#;
        assert!(!panel_messages(local).is_empty());
        assert!(!panel_messages("export const x = 1;").is_empty());
    }

    #[test]
    fn un_ancien_nom_de_socle_dit_le_nouveau_et_un_nom_inconnu_est_refuse() {
        let page = r#"
import { Switch as Bascule, Dialog, ListPage, Calendrier } from "socle-ui";
import { Markdown } from "socle-ui/markdown";
export default function P() { return <ListPage title="T" rows={[]} columns={[]} empty={{ title: "Rien" }} />; }
"#;
        let found = lint(page, Placement::Page);
        let warnings: Vec<_> = found.iter().filter(|f| is_warning(&f.message)).collect();
        assert!(warnings.iter().any(|f| f.message.contains("`Switch` est l’ancien nom de `Toggle`") && f.line == Some(2)), "{found:?}");
        assert!(warnings.iter().any(|f| f.message.contains("`Dialog` est l’ancien nom de `Modal`")), "{found:?}");
        let errors: Vec<_> = found.iter().filter(|f| !is_warning(&f.message)).collect();
        assert_eq!(errors.len(), 1, "{found:?}");
        assert!(errors[0].message.starts_with("`Calendrier` n’existe pas dans `socle-ui`") && errors[0].message.contains("PLACEMENT.md, section 9"), "{found:?}");
        // Les noms actuels, types compris, passent.
        let current = r#"
import { Toggle, Modal, type FormField, type StatusMap, useOpenForm } from "socle-ui";
import { MarkdownEditor } from "socle-ui/markdown-editor";
"#;
        assert!(lint(current, Placement::Page).is_empty(), "{:?}", lint(current, Placement::Page));
    }

    #[test]
    fn un_bouton_hors_de_sa_place_est_signale() {
        let page = r#"
import { Button, EmptyState, Modal, Page, PageSection, Popover, Drawer } from "socle-ui";
export default function P() {
  return (
    <Page>
      <PageSection title="Bloc">
        <Button onPress={go}>Exporter</Button>
        <EmptyState title="Rien" action={<Button variant="primary" onPress={go}>Créer</Button>} />
        <Modal isOpen title="Aperçu" footer={<><Button onPress={close}>Annuler</Button><Button variant="primary" onPress={go}>Envoyer</Button></>}>
          <Button onPress={go}>Dans le corps</Button>
        </Modal>
        <Popover trigger={x} title="Filtrer"><Button onPress={go}>Appliquer</Button></Popover>
      </PageSection>
    </Page>
  );
}
const pied = <Button onPress={go}>Hors JSX</Button>;
"#;
        let found = messages(page);
        let buttons: Vec<_> = found.iter().filter(|m| m.contains("`<Button>` posé dans la page")).collect();
        assert_eq!(buttons.len(), 2, "{found:?}");
        assert!(buttons[0].starts_with("7: Avertissement") && buttons[1].starts_with("10: Avertissement"), "{found:?}");
    }

    #[test]
    fn des_onglets_dans_la_page_et_la_barre_du_haut_d_une_liste_sont_signales() {
        let page = r#"
import { useTopBarActions } from "@alfred/sdk";
import { ListPage, Tabs } from "socle-ui";
export default function P() {
  useTopBarActions([{ id: "n", label: "Nouveau", onPress: go }]);
  return <><Tabs items={[]} /><ListPage title="T" rows={[]} columns={[]} empty={{ title: "Rien" }} /></>;
}
"#;
        let found = messages(page);
        assert!(found.iter().any(|m| m.starts_with("6: Avertissement : `<Tabs>` dans une page") && m.contains("views.open")), "{found:?}");
        assert!(found.iter().any(|m| m.starts_with("2: Avertissement : `useTopBarActions` dans une page qui rend une `ListPage`")), "{found:?}");
        let composee = r#"
import { useTopBarActions } from "@alfred/sdk";
import { Page } from "socle-ui";
export default function P() { useTopBarActions([]); return <Page />; }
"#;
        assert!(messages(composee).is_empty(), "{:?}", messages(composee));
    }
}
