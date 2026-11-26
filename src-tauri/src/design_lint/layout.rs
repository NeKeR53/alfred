//! Mise en page d’une page de la zone principale (socle-ui, D-404 « vue d’ensemble d’abord ») : ce qui se lit dans
//! le JSX sans exécuter la page. Chaque remarque est un avertissement et dit quoi écrire à la place.
//!
//! - Longue pile : `LONG_PILE` blocs ou plus l’un sous l’autre dans une `Page` (`PageSection`, `Card`, `Table`,
//!   `List`, `Alert`… ; une `PageGrid` compte pour ses rangées, une `Row` de `@alfred/kit` pour une seule).
//! - Colonne étroite : `width="text"` sur une page qui n’est ni un texte à lire ni une conversation.
//! - Zone de dépôt : un `FileUpload` posé comme un bloc de la page, hors d’un formulaire ou d’une fenêtre.
//! - Actions principales : plus d’une action `primary` (ou d’un `Button` plein) sur un même écran, barre du haut
//!   comprise (`useTopBarActions`).
//! - Exemples : une liste de questions d’exemple rendue hors d’un état vide.
//!
//! Limites : seuls les composants et les constantes du fichier sont suivis, pas ceux d’un autre fichier du module.
//! Une condition compte pour sa branche la plus chargée ; une liste produite par `.map` compte pour deux blocs. La
//! hauteur réelle de la page est mesurée par l’examen de la capture (`page_review`).

use std::collections::BTreeMap;

use oxc::ast::ast::{
    ArrayExpressionElement, Argument, CallExpression, ChainElement, ConditionalExpression, Declaration, Expression,
    ImportDeclarationSpecifier, JSXAttribute, JSXAttributeValue, JSXChild, JSXElement, JSXElementName,
    JSXMemberExpressionObject, LogicalExpression, LogicalOperator, ObjectExpression, ObjectPropertyKind, Program,
    Statement,
};
use oxc::ast_visit::{walk, Visit};
use oxc::span::GetSpan;

use super::{attribute, attribute_name, components, element_name, Body, DefaultExport, Returns};

/// Blocs l’un sous l’autre dans une `Page` à partir desquels la pile est longue. D-404 ne fixe pas de nombre (« le
/// bon nombre dépend de leur hauteur ») : quatre blocs empilés dépassent presque toujours un écran de 862 px
/// (fenêtre de 1440 × 900), ce que l’examen de la capture mesure ensuite.
pub const LONG_PILE: u32 = 4;
/// Profondeur de suivi des composants et des constantes du fichier.
const MAX_DEPTH: usize = 4;
/// Ce qui s’ouvre au-dessus de la page, ou la page de droite : ni un bloc de la page, ni le même écran.
const OVERLAYS: [&str; 5] = ["Modal", "Dialog", "Popover", "Drawer", "DetailPanel"];
/// Formulaires où un `FileUpload` est un champ (spec FileUpload, « Placement »).
const FORMS: [&str; 2] = ["FormPage", "Fieldset"];
/// Gabarits et blocs du contenu d’une page : un `FileUpload` posé là est un bloc de la page.
const CONTENT: [&str; 6] = ["Page", "PageSection", "PageGrid", "ListPage", "DetailPage", "Card"];
/// Composants de socle-ui qui forment un bloc quand ils sont posés directement dans le contenu d’une `Page`.
const BLOCKS: [&str; 17] = [
    "PageSection",
    "Card",
    "Table",
    "List",
    "Alert",
    "TreeView",
    "Accordion",
    "DiffView",
    "LogViewer",
    "Terminal",
    "DocumentViewer",
    "HtmlContent",
    "Markdown",
    "MarkdownEditor",
    "FileUpload",
    "EmptyState",
    "Code",
];
/// Ce qui fait d’une page un texte à lire ou une conversation : la colonne de 760 px lui convient (D-214, D-404).
const READING: [&str; 7] =
    ["Markdown", "MarkdownEditor", "HtmlContent", "DocumentViewer", "ChatTranscript", "ChatComposer", "ChatPage"];
/// Paragraphes (`<Text as="p">` de `@alfred/kit`) à partir desquels une page est un texte à lire.
const READING_PARAGRAPHS: usize = 3;
/// Gabarits et blocs dont `actions` reçoit des `Action` : leur `primary` est une action principale de l’écran.
const ACTION_OWNERS: [&str; 5] = ["Page", "ListPage", "DetailPage", "PageSection", "ActionBar"];
/// Noms qui désignent une liste d’exemples à montrer (questions types, idées, premiers pas).
const EXAMPLE_NAMES: [&str; 6] = ["exempl", "exampl", "suggest", "idee", "idée", "prompt"];
/// Champs d’un exemple écrit en objet.
const EXAMPLE_FIELDS: [&str; 7] = ["label", "question", "text", "texte", "title", "titre", "prompt"];
/// Champs d’une réponse : une liste de questions avec leurs réponses est un contenu (une FAQ), pas des exemples.
const ANSWER_FIELDS: [&str; 5] = ["reponse", "réponse", "answer", "contenu", "content"];

/// `onPress`, `onChange`… : un gestionnaire d’événement, pas un contenu.
fn is_handler(name: &str) -> bool {
    name.strip_prefix("on").and_then(|rest| rest.chars().next()).is_some_and(char::is_uppercase)
}

/// Noms importés d’une entrée (local → exporté).
fn imported(program: &Program, from: &str) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else { continue };
        if import.source.value.as_str() != from {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier {
                names.insert(named.local.name.to_string(), named.imported.name().to_string());
            }
        }
    }
    names
}

/// Constantes d’une liste d’instructions (nom → valeur), sans entrer dans les blocs.
fn declarators<'b, 'a>(statements: &'b [Statement<'a>], found: &mut BTreeMap<String, &'b Expression<'a>>) {
    for statement in statements {
        let declaration = match statement {
            Statement::ExportDeclaration(export) => &export.declaration,
            other => match other.as_declaration() {
                Some(declaration) => declaration,
                None => continue,
            },
        };
        let Declaration::VariableDeclaration(variables) = declaration else { continue };
        for declarator in &variables.declarations {
            if let (Some(id), Some(init)) = (declarator.id.get_binding_identifier(), &declarator.init) {
                found.entry(id.name.to_string()).or_insert(init);
            }
        }
    }
}

/// Une valeur d’attribut écrite en texte : `"text"` ou `{"text"}`.
fn literal(value: Option<&JSXAttributeValue>) -> Option<String> {
    match value? {
        JSXAttributeValue::StringLiteral(text) => Some(text.value.to_string()),
        JSXAttributeValue::ExpressionContainer(container) => match container.expression.as_expression()?.without_parentheses() {
            Expression::StringLiteral(text) => Some(text.value.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// Texte écrit d’une expression : chaîne, ou gabarit sans valeur insérée.
fn text_of(expression: &Expression) -> Option<String> {
    match expression.without_parentheses() {
        Expression::StringLiteral(text) => Some(text.value.to_string()),
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
            Some(template.quasis.iter().map(|quasi| quasi.value.raw.as_str()).collect())
        }
        _ => None,
    }
}

/// Valeur d’un champ d’un objet écrit (`{ label: "…" }`).
fn field<'b, 'a>(object: &'b ObjectExpression<'a>, wanted: &str) -> Option<&'b Expression<'a>> {
    object.properties.iter().find_map(|property| match property {
        ObjectPropertyKind::ObjectProperty(property) if property.key.static_name().as_deref() == Some(wanted) => {
            Some(&property.value)
        }
        _ => None,
    })
}

/// La condition dit que la zone est vide : `liste.length === 0`, `!liste.length`, `vide`, `isEmpty`…
fn mentions_empty(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    // Les deux branches d’une condition sur le vide comptent comme l’état vide : la relecture ne sait pas laquelle
    // s’affiche quand la zone est vide.
    ["length===0", "length==0", "length<1", "length>0", "length!==0", "length!=0", "length>=1", "isempty", "vide", "empty", "aucun"]
        .iter()
        .any(|marker| compact.contains(marker))
        || (compact.starts_with('!') && compact.contains(".length"))
}

/// Le plus long de deux relevés : une condition compte pour sa branche la plus chargée.
fn longer<T>(left: Vec<T>, right: Vec<T>) -> Vec<T> {
    if right.len() > left.len() {
        right
    } else {
        left
    }
}

/// Appel `x.map(…)` ou `x?.map(…)` : l’objet et la fonction rappelée.
fn map_call<'b, 'a>(call: &'b CallExpression<'a>) -> Option<(&'b Expression<'a>, Option<&'b Expression<'a>>)> {
    let member = call.callee.without_parentheses().as_member_expression()?;
    if !matches!(member.static_property_name(), Some("map" | "flatMap")) {
        return None;
    }
    Some((member.object(), call.arguments.first().and_then(Argument::as_expression)))
}

/// Appel d’une expression, y compris par chaînage optionnel (`x?.map(…)`).
fn as_call<'b, 'a>(expression: &'b Expression<'a>) -> Option<&'b CallExpression<'a>> {
    match expression.without_parentheses() {
        Expression::CallExpression(call) => Some(call),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => Some(call),
            _ => None,
        },
        _ => None,
    }
}

struct Layout<'b, 'a> {
    socle: &'b BTreeMap<String, String>,
    /// Noms importés de `@alfred/kit` (local → exporté).
    kit: BTreeMap<String, String>,
    /// Nom local de `useTopBarActions`.
    top_bar: Option<String>,
    named: BTreeMap<String, Body<'b, 'a>>,
    values: BTreeMap<String, &'b Expression<'a>>,
    source: &'b str,
}

impl<'b, 'a> Layout<'b, 'a> {
    /// Nom Socle d’un élément (`Page.Grid` → `PageGrid`), ou `None` s’il ne vient pas de socle-ui.
    fn socle_name(&self, name: &JSXElementName) -> Option<String> {
        match name {
            JSXElementName::IdentifierReference(reference) => self.socle.get(reference.name.as_str()).cloned(),
            JSXElementName::MemberExpression(member) => {
                let JSXMemberExpressionObject::IdentifierReference(object) = &member.object else { return None };
                let base = self.socle.get(object.name.as_str())?;
                Some(match (base.as_str(), member.property.name.as_str()) {
                    ("Page", "Grid") => "PageGrid".to_string(),
                    ("Page", "Section") => "PageSection".to_string(),
                    (base, property) => format!("{base}.{property}"),
                })
            }
            _ => None,
        }
    }

    /// Nom de l’élément : le nom Socle (`PageSection`), sinon `kit:Row` pour `@alfred/kit`, `local:Bloc` pour un
    /// composant du module et `tag:div` pour une balise. Un composant du fichier qui s’appelle `Page` n’est pas la
    /// `Page` de socle-ui.
    fn name_of(&self, name: &JSXElementName) -> String {
        if let Some(socle) = self.socle_name(name) {
            return socle;
        }
        match name {
            JSXElementName::IdentifierReference(reference) => match self.kit.get(reference.name.as_str()) {
                Some(exported) => format!("kit:{exported}"),
                None => format!("local:{}", reference.name),
            },
            JSXElementName::Identifier(tag) => format!("tag:{}", tag.name),
            _ => "autre".to_string(),
        }
    }

    /// Composant du fichier rendu par cet élément (`<Bloc />`), s’il est déclaré au premier niveau.
    fn component(&self, element: &JSXElement) -> Option<&Body<'b, 'a>> {
        match &element.opening_element.name {
            JSXElementName::IdentifierReference(reference) if !self.socle.contains_key(reference.name.as_str()) => {
                self.named.get(reference.name.as_str())
            }
            _ => None,
        }
    }

    fn text(&self, span: oxc::span::Span) -> &str {
        self.source.get(span.start as usize..span.end as usize).unwrap_or_default()
    }

    // --- Pile de blocs ---

    fn pile_children(&self, children: &[JSXChild<'a>], depth: usize) -> u32 {
        children.iter().map(|child| self.pile_child(child, depth)).sum()
    }

    fn pile_child(&self, child: &JSXChild<'a>, depth: usize) -> u32 {
        match child {
            JSXChild::Element(element) => self.pile_element(element, depth),
            JSXChild::Fragment(fragment) => self.pile_children(&fragment.children, depth),
            JSXChild::ExpressionContainer(container) => {
                container.expression.as_expression().map_or(0, |expression| self.pile_expression(expression, depth))
            }
            _ => 0,
        }
    }

    fn pile_element(&self, element: &JSXElement<'a>, depth: usize) -> u32 {
        let name = self.name_of(&element.opening_element.name);
        if OVERLAYS.contains(&name.as_str()) {
            return 0;
        }
        if name == "PageGrid" {
            return self.grid_rows(element, depth);
        }
        if BLOCKS.contains(&name.as_str()) {
            return 1;
        }
        // Une rangée de `@alfred/kit` pose ses enfants côte à côte.
        if name == "kit:Row" {
            return element.children.iter().map(|child| self.pile_child(child, depth)).max().unwrap_or(0).min(1);
        }
        if let Some(body) = self.component(element) {
            if depth >= MAX_DEPTH {
                return 0;
            }
            return Returns::of(body).into_iter().map(|returned| self.pile_expression(returned, depth + 1)).max().unwrap_or(0);
        }
        self.pile_children(&element.children, depth)
    }

    fn pile_expression(&self, expression: &Expression<'a>, depth: usize) -> u32 {
        if let Some(call) = as_call(expression) {
            // Une liste de blocs produite par `.map` : deux au moins.
            return match map_call(call) {
                Some((_, Some(callback))) => self.callback_pile(callback, depth) * 2,
                _ => 0,
            };
        }
        match expression.without_parentheses() {
            Expression::JSXElement(element) => self.pile_element(element, depth),
            Expression::JSXFragment(fragment) => self.pile_children(&fragment.children, depth),
            Expression::ConditionalExpression(choice) => {
                self.pile_expression(&choice.consequent, depth).max(self.pile_expression(&choice.alternate, depth))
            }
            Expression::LogicalExpression(logical) => match logical.operator {
                LogicalOperator::And => self.pile_expression(&logical.right, depth),
                _ => self.pile_expression(&logical.left, depth).max(self.pile_expression(&logical.right, depth)),
            },
            Expression::ArrayExpression(array) => array
                .elements
                .iter()
                .filter_map(ArrayExpressionElement::as_expression)
                .map(|item| self.pile_expression(item, depth))
                .sum(),
            Expression::Identifier(reference) if depth < MAX_DEPTH => self
                .values
                .get(reference.name.as_str())
                .map_or(0, |value| self.pile_expression(value, depth + 1)),
            _ => 0,
        }
    }

    fn callback_pile(&self, callback: &Expression<'a>, depth: usize) -> u32 {
        let Some(body) = super::expression_body(callback) else { return 0 };
        Returns::of(&body).into_iter().map(|returned| self.pile_expression(returned, depth)).max().unwrap_or(0)
    }

    /// Rangées d’une `PageGrid` dans la zone principale d’une fenêtre de 1440 px (1 200 px de large) : chaque bloc
    /// est une case, `columns` cases par rangée (2 par défaut ; 3 et 4 tiennent à cette largeur, D-403).
    fn grid_rows(&self, element: &JSXElement<'a>, depth: usize) -> u32 {
        let columns = attribute(&element.opening_element, "columns")
            .and_then(|columns| match &columns.value {
                Some(JSXAttributeValue::ExpressionContainer(container)) => match container.expression.as_expression() {
                    Some(Expression::NumericLiteral(number)) => Some(number.value as u32),
                    _ => None,
                },
                _ => None,
            })
            .filter(|columns| (2..=4).contains(columns))
            .unwrap_or(2);
        let cells: u32 = element.children.iter().map(|child| self.cells(child, depth)).sum();
        cells.div_ceil(columns)
    }

    /// Cases d’une grille : chaque élément en est une ; une liste produite par `.map`, deux au moins.
    fn cells(&self, child: &JSXChild<'a>, depth: usize) -> u32 {
        match child {
            JSXChild::Element(_) => 1,
            JSXChild::Fragment(fragment) => fragment.children.iter().map(|inner| self.cells(inner, depth)).sum(),
            JSXChild::ExpressionContainer(container) => {
                container.expression.as_expression().map_or(0, |expression| self.cells_expression(expression, depth))
            }
            _ => 0,
        }
    }

    fn cells_expression(&self, expression: &Expression<'a>, depth: usize) -> u32 {
        if as_call(expression).is_some_and(|call| map_call(call).is_some()) {
            return 2;
        }
        match expression.without_parentheses() {
            Expression::JSXElement(_) => 1,
            Expression::JSXFragment(fragment) => fragment.children.iter().map(|inner| self.cells(inner, depth)).sum(),
            Expression::ConditionalExpression(choice) => {
                self.cells_expression(&choice.consequent, depth).max(self.cells_expression(&choice.alternate, depth))
            }
            Expression::LogicalExpression(logical) => match logical.operator {
                LogicalOperator::And => self.cells_expression(&logical.right, depth),
                _ => self.cells_expression(&logical.left, depth).max(self.cells_expression(&logical.right, depth)),
            },
            Expression::Identifier(reference) if depth < MAX_DEPTH => self
                .values
                .get(reference.name.as_str())
                .map_or(0, |value| self.cells_expression(value, depth + 1)),
            _ => 0,
        }
    }

    // --- Actions principales ---

    /// Actions principales d’un écran rendu par `expression` : (position, libellé).
    fn primaries(&self, expression: &Expression<'a>, depth: usize) -> Vec<(u32, String)> {
        if let Some(call) = as_call(expression) {
            return match map_call(call) {
                Some((_, Some(callback))) => {
                    let Some(body) = super::expression_body(callback) else { return Vec::new() };
                    let once = Returns::of(&body)
                        .into_iter()
                        .map(|returned| self.primaries(returned, depth))
                        .fold(Vec::new(), longer);
                    // Une action principale par élément de la liste : il y en a deux au moins.
                    once.iter().cloned().chain(once.iter().cloned()).collect()
                }
                _ => Vec::new(),
            };
        }
        match expression.without_parentheses() {
            Expression::JSXElement(element) => self.element_primaries(element, depth),
            Expression::JSXFragment(fragment) => self.children_primaries(&fragment.children, depth),
            Expression::ConditionalExpression(choice) => {
                longer(self.primaries(&choice.consequent, depth), self.primaries(&choice.alternate, depth))
            }
            Expression::LogicalExpression(logical) => match logical.operator {
                LogicalOperator::And => self.primaries(&logical.right, depth),
                _ => longer(self.primaries(&logical.left, depth), self.primaries(&logical.right, depth)),
            },
            Expression::Identifier(reference) if depth < MAX_DEPTH => self
                .values
                .get(reference.name.as_str())
                .map_or_else(Vec::new, |value| self.primaries(value, depth + 1)),
            _ => Vec::new(),
        }
    }

    fn children_primaries(&self, children: &[JSXChild<'a>], depth: usize) -> Vec<(u32, String)> {
        let mut found = Vec::new();
        for child in children {
            match child {
                JSXChild::Element(element) => found.extend(self.element_primaries(element, depth)),
                JSXChild::Fragment(fragment) => found.extend(self.children_primaries(&fragment.children, depth)),
                JSXChild::ExpressionContainer(container) => {
                    if let Some(expression) = container.expression.as_expression() {
                        found.extend(self.primaries(expression, depth));
                    }
                }
                _ => {}
            }
        }
        found
    }

    fn element_primaries(&self, element: &JSXElement<'a>, depth: usize) -> Vec<(u32, String)> {
        let opening = &element.opening_element;
        let name = self.name_of(&opening.name);
        // Une fenêtre, le panneau de droite et un état vide ne sont pas l’écran de la page.
        if OVERLAYS.contains(&name.as_str()) || name == "EmptyState" {
            return Vec::new();
        }
        if name == "Button" {
            if literal(attribute(opening, "variant").and_then(|variant| variant.value.as_ref())).as_deref() == Some("primary") {
                let label = element
                    .children
                    .iter()
                    .find_map(|child| match child {
                        JSXChild::Text(text) if !text.value.trim().is_empty() => Some(text.value.trim().to_string()),
                        _ => None,
                    })
                    .unwrap_or_else(|| "bouton plein".to_string());
                return vec![(opening.span.start, label)];
            }
            return Vec::new();
        }
        let mut found = Vec::new();
        if ACTION_OWNERS.contains(&name.as_str()) {
            if let Some(actions) = attribute(opening, "actions") {
                if let Some(JSXAttributeValue::ExpressionContainer(container)) = &actions.value {
                    if let Some(expression) = container.expression.as_expression() {
                        found.extend(self.action_primaries(expression, depth));
                    }
                }
            }
        }
        if let Some(body) = self.component(element) {
            if depth < MAX_DEPTH {
                found.extend(
                    Returns::of(body).into_iter().map(|returned| self.primaries(returned, depth + 1)).fold(Vec::new(), longer),
                );
            }
            return found;
        }
        found.extend(self.children_primaries(&element.children, depth));
        found
    }

    /// Actions `primary` d’une liste d’`Action`.
    fn action_primaries(&self, expression: &Expression<'a>, depth: usize) -> Vec<(u32, String)> {
        if let Some(call) = as_call(expression) {
            // `[…].filter(Boolean)`, `useMemo(() => […], [])`.
            if let Some(member) = call.callee.without_parentheses().as_member_expression() {
                return self.action_primaries(member.object(), depth);
            }
            if let Some(body) = call.arguments.first().and_then(Argument::as_expression).and_then(super::expression_body) {
                return Returns::of(&body).into_iter().map(|returned| self.action_primaries(returned, depth)).fold(Vec::new(), longer);
            }
            return Vec::new();
        }
        match expression.without_parentheses() {
            Expression::ArrayExpression(array) => {
                let mut found = Vec::new();
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(spread) => found.extend(self.action_primaries(&spread.argument, depth)),
                        ArrayExpressionElement::Elision(_) => {}
                        item => {
                            if let Some(item) = item.as_expression() {
                                found.extend(self.action_item(item, depth));
                            }
                        }
                    }
                }
                found
            }
            Expression::ConditionalExpression(choice) => {
                longer(self.action_primaries(&choice.consequent, depth), self.action_primaries(&choice.alternate, depth))
            }
            Expression::LogicalExpression(logical) => match logical.operator {
                LogicalOperator::And => self.action_primaries(&logical.right, depth),
                _ => longer(self.action_primaries(&logical.left, depth), self.action_primaries(&logical.right, depth)),
            },
            Expression::Identifier(reference) if depth < MAX_DEPTH => self
                .values
                .get(reference.name.as_str())
                .map_or_else(Vec::new, |value| self.action_primaries(value, depth + 1)),
            _ => Vec::new(),
        }
    }

    /// Une `Action` de la liste : principale si `primary` n’est pas écrit `false`.
    fn action_item(&self, item: &Expression<'a>, depth: usize) -> Vec<(u32, String)> {
        match item.without_parentheses() {
            Expression::ObjectExpression(object) => {
                let primary = field(object, "primary")
                    .is_some_and(|value| !matches!(value.without_parentheses(), Expression::BooleanLiteral(flag) if !flag.value));
                let hidden = field(object, "isHidden")
                    .is_some_and(|value| matches!(value.without_parentheses(), Expression::BooleanLiteral(flag) if flag.value));
                if !primary || hidden {
                    return Vec::new();
                }
                let label = field(object, "label").and_then(text_of).unwrap_or_else(|| "action principale".to_string());
                vec![(object.span.start, label)]
            }
            Expression::ConditionalExpression(choice) => {
                longer(self.action_item(&choice.consequent, depth), self.action_item(&choice.alternate, depth))
            }
            Expression::LogicalExpression(logical) if logical.operator == LogicalOperator::And => {
                self.action_item(&logical.right, depth)
            }
            Expression::Identifier(reference) if depth < MAX_DEPTH => self
                .values
                .get(reference.name.as_str())
                .map_or_else(Vec::new, |value| self.action_item(value, depth + 1)),
            _ => Vec::new(),
        }
    }

    /// Actions principales que le composant place dans la barre du haut (`useTopBarActions([…])`).
    fn top_bar_primaries(&self, body: &Body<'b, 'a>) -> Vec<(u32, String)> {
        let (Some(hook), Body::Statements(body)) = (&self.top_bar, body) else { return Vec::new() };
        let mut found = Vec::new();
        for statement in &body.statements {
            let Statement::ExpressionStatement(statement) = statement else { continue };
            let Some(call) = as_call(&statement.expression) else { continue };
            if !matches!(call.callee.without_parentheses(), Expression::Identifier(callee) if callee.name.as_str() == hook) {
                continue;
            }
            if let Some(actions) = call.arguments.first().and_then(Argument::as_expression) {
                found.extend(self.action_primaries(actions, 0));
            }
        }
        found
    }

    /// Remarque pour chaque écran (chaque rendu d’un composant du fichier) qui porte plus d’une action principale.
    fn screens(&self, default: Option<&Body<'b, 'a>>) -> Vec<(u32, String)> {
        let mut found = Vec::new();
        for body in self.named.values().chain(default) {
            let top = self.top_bar_primaries(body);
            for returned in Returns::of(body) {
                let mut primaries = top.clone();
                primaries.extend(self.primaries(returned, 0));
                if primaries.len() > 1 {
                    let labels: Vec<String> = primaries.iter().take(4).map(|(_, label)| format!("« {label} »")).collect();
                    found.push((
                        primaries[1].0,
                        format!(
                            "Avertissement : {} actions principales sur le même écran ({}) : un écran n’a qu’une action attendue et un seul bouton plein (D-220 ; DESIGN.md, section 4). Garder `primary: true` sur l’action qui sert le plus, dans la barre (`actions` de `Page`, `ListPage` ou `DetailPage`, ou `useTopBarActions`), et retirer `primary` des autres, qui restent des actions de leur zone.",
                            primaries.len(),
                            labels.join(", ")
                        ),
                    ));
                }
            }
        }
        found
    }

    // --- Zone de dépôt ---

    /// Un composant du fichier pose un `FileUpload` dans ce qu’il rend, hors d’une fenêtre ou d’un formulaire.
    fn renders_upload(&self, body: &Body<'b, 'a>, depth: usize) -> bool {
        depth < MAX_DEPTH && Returns::of(body).into_iter().any(|returned| self.upload_in(returned, depth))
    }

    fn upload_in(&self, expression: &Expression<'a>, depth: usize) -> bool {
        match expression.without_parentheses() {
            Expression::JSXElement(element) => self.upload_in_element(element, depth),
            Expression::JSXFragment(fragment) => fragment.children.iter().any(|child| self.upload_in_child(child, depth)),
            Expression::ConditionalExpression(choice) => {
                self.upload_in(&choice.consequent, depth) || self.upload_in(&choice.alternate, depth)
            }
            Expression::LogicalExpression(logical) => self.upload_in(&logical.right, depth),
            _ => false,
        }
    }

    fn upload_in_child(&self, child: &JSXChild<'a>, depth: usize) -> bool {
        match child {
            JSXChild::Element(element) => self.upload_in_element(element, depth),
            JSXChild::Fragment(fragment) => fragment.children.iter().any(|inner| self.upload_in_child(inner, depth)),
            JSXChild::ExpressionContainer(container) => {
                container.expression.as_expression().is_some_and(|expression| self.upload_in(expression, depth))
            }
            _ => false,
        }
    }

    fn upload_in_element(&self, element: &JSXElement<'a>, depth: usize) -> bool {
        let name = self.name_of(&element.opening_element.name);
        if OVERLAYS.contains(&name.as_str()) || FORMS.contains(&name.as_str()) {
            return false;
        }
        if name == "FileUpload" {
            return true;
        }
        if let Some(body) = self.component(element) {
            return self.renders_upload(body, depth + 1);
        }
        element.children.iter().any(|child| self.upload_in_child(child, depth))
    }

    // --- Exemples ---

    /// Liste d’exemples rendue par `call` (`EXEMPLES.map(…)`) : son nom pour la remarque.
    fn example_list(&self, call: &CallExpression<'a>) -> Option<String> {
        let (object, callback) = map_call(call)?;
        let mut object = object.without_parentheses();
        // `EXEMPLES.slice(0, 3).map(…)`, `EXEMPLES.filter(…).map(…)`.
        while let Some(inner) = as_call(object).and_then(|inner| inner.callee.without_parentheses().as_member_expression()) {
            object = inner.object().without_parentheses();
        }
        let (name, array) = match object {
            Expression::Identifier(reference) => match self.values.get(reference.name.as_str())?.without_parentheses() {
                Expression::ArrayExpression(array) => (Some(reference.name.to_string()), array),
                _ => return None,
            },
            Expression::ArrayExpression(array) => (None, array),
            _ => return None,
        };
        let mut texts = Vec::new();
        for item in array.elements.iter().filter_map(ArrayExpressionElement::as_expression) {
            match item.without_parentheses() {
                Expression::ObjectExpression(object) => {
                    if ANSWER_FIELDS.iter().any(|answer| field(object, answer).is_some()) {
                        return None;
                    }
                    if let Some(text) = EXAMPLE_FIELDS.iter().find_map(|wanted| field(object, wanted).and_then(text_of)) {
                        texts.push(text);
                    }
                }
                other => texts.extend(text_of(other)),
            }
        }
        if texts.len() < 2 {
            return None;
        }
        let named = name.as_deref().is_some_and(|name| {
            let lower = name.to_lowercase();
            EXAMPLE_NAMES.iter().any(|marker| lower.contains(marker))
        });
        let questions = texts.iter().filter(|text| text.trim_end().ends_with('?')).count();
        let clickable = callback.is_some_and(|callback| {
            let mut clicks = Clickable::default();
            clicks.visit_expression(callback);
            clicks.found
        });
        (named || (questions * 2 >= texts.len() && clickable))
            .then(|| name.map_or_else(|| "une liste de questions".to_string(), |name| format!("`{name}`")))
    }
}

/// Un élément cliquable dans ce que rend une liste (`onPress`, `onClick`, `href`).
#[derive(Default)]
struct Clickable {
    found: bool,
}

impl<'a> Visit<'a> for Clickable {
    fn visit_jsx_attribute(&mut self, attribute: &JSXAttribute<'a>) {
        if attribute_name(attribute).is_some_and(|name| matches!(name.as_str(), "onPress" | "onClick" | "onAction" | "href")) {
            self.found = true;
        }
        walk::walk_jsx_attribute(self, attribute);
    }
}

/// Parcours du fichier : la pile de chaque `Page`, sa largeur, les zones de dépôt et les exemples.
struct Scan<'l, 'b, 'a> {
    layout: &'l Layout<'b, 'a>,
    /// Noms des éléments qui entourent celui qu’on relit.
    stack: Vec<String>,
    /// Profondeur dans un état vide : `EmptyState`, attribut `empty`, branche d’une condition sur le vide.
    empty: u32,
    /// La page est un texte à lire ou une conversation.
    reading: bool,
    found: Vec<(u32, String)>,
}

impl Scan<'_, '_, '_> {
    fn in_content(&self) -> bool {
        self.stack.iter().any(|name| CONTENT.contains(&name.as_str()))
    }

    fn in_form(&self) -> bool {
        self.stack.iter().any(|name| OVERLAYS.contains(&name.as_str()) || FORMS.contains(&name.as_str()))
    }

    fn upload(&mut self, offset: u32, what: &str) {
        self.found.push((
            offset,
            format!(
                "Avertissement : {what} posé comme un bloc de la page : une grande zone de dépôt pour une seule action, et le cadre d’une page n’a pas de disque. Une action n’est jamais un bloc à elle seule (D-404 ; DESIGN.md, section 2). Écrire une `Action` « Ajouter des fichiers » (icône `Upload`) dans `actions` de la `Page` ou de la `ListPage`, qui appelle `files.pick({{ accept, multiple: true }})`, et montrer l’état de chaque fichier dans la liste elle-même (`status` d’un élément). `FileUpload` reste pour un formulaire (`useOpenForm`, `FormPage`) ou une `Modal` (spec FileUpload, « Placement »)."
            ),
        ));
    }
}

impl<'a> Visit<'a> for Scan<'_, '_, 'a> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        let opening = &element.opening_element;
        let name = self.layout.name_of(&opening.name);
        if name == "Page" {
            let rows = self.layout.pile_children(&element.children, 0);
            if rows >= LONG_PILE {
                self.found.push((
                    opening.span.start,
                    format!(
                        "Avertissement : longue pile de {rows} blocs l’un sous l’autre dans `<Page>` : il faut la faire défiler pour comprendre la page (D-404, vue d’ensemble d’abord). Ranger d’abord ce qui a sa zone : les vues de la page en onglets fixes (`place_page` avec `{{ \"kind\": \"tab\" }}`), les actions dans `actions` de `Page`, l’élément choisi dans le panneau de droite, les exemples dans l’état vide. Puis mettre côte à côte les blocs courts de même rang : `<PageGrid columns={{2}}>` (2 à 4 colonnes) ; une collection devient une `ListPage` (DESIGN.md, règle 11 et section 2, « Répartir avant de composer »)."
                    ),
                ));
            }
            if let Some(width) = attribute(opening, "width") {
                if literal(width.value.as_ref()).as_deref() == Some("text") && !self.reading {
                    self.found.push((
                        width.span.start,
                        "Avertissement : `width=\"text\"` sur une page qui n’est ni un texte à lire ni une conversation : la colonne de 760 px centrée laisse vide un tiers de l’écran. Retirer `width` (toute la largeur) ; la colonne étroite sert à un texte (`Markdown`, `HtmlContent`, `MarkdownEditor`) ou à une conversation (`ChatPage`) (D-214, D-404 ; DESIGN.md, règle 11).".to_string(),
                    ));
                }
            }
        }
        if !self.in_form() && self.in_content() {
            if name == "FileUpload" {
                self.upload(opening.span.start, "`<FileUpload>`");
            } else if let Some(body) = self.layout.component(element) {
                if self.layout.renders_upload(body, 0) {
                    let local = element_name(&opening.name).map(|(local, _)| local).unwrap_or_default();
                    self.upload(opening.span.start, &format!("`<{local}>` (il rend un `FileUpload`)"));
                }
            }
        }
        let empty = name == "EmptyState";
        if empty {
            self.empty += 1;
        }
        self.stack.push(name);
        walk::walk_jsx_element(self, element);
        self.stack.pop();
        if empty {
            self.empty -= 1;
        }
    }

    fn visit_jsx_attribute(&mut self, attribute: &JSXAttribute<'a>) {
        let name = attribute_name(attribute).unwrap_or_default();
        // Un gestionnaire n’est pas un contenu de la page.
        if is_handler(&name) {
            return;
        }
        let empty = name == "empty";
        if empty {
            self.empty += 1;
        }
        walk::walk_jsx_attribute(self, attribute);
        if empty {
            self.empty -= 1;
        }
    }

    fn visit_conditional_expression(&mut self, choice: &ConditionalExpression<'a>) {
        self.visit_expression(&choice.test);
        let empty = mentions_empty(self.layout.text(choice.test.span()));
        if empty {
            self.empty += 1;
        }
        self.visit_expression(&choice.consequent);
        self.visit_expression(&choice.alternate);
        if empty {
            self.empty -= 1;
        }
    }

    fn visit_logical_expression(&mut self, logical: &LogicalExpression<'a>) {
        self.visit_expression(&logical.left);
        let empty = logical.operator == LogicalOperator::And && mentions_empty(self.layout.text(logical.left.span()));
        if empty {
            self.empty += 1;
        }
        self.visit_expression(&logical.right);
        if empty {
            self.empty -= 1;
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if !self.stack.is_empty() && self.empty == 0 {
            if let Some(name) = self.layout.example_list(call) {
                self.found.push((
                    call.span.start,
                    format!(
                        "Avertissement : exemples ({name}) affichés hors d’un état vide : ils restent à l’écran après le premier usage et chargent la page (D-404 ; DESIGN.md, section 2). Les mettre dans l’état vide de la zone, qui disparaît avec lui : `empty` du gabarit, `empty` du relevé d’une `ChatPage`, ou un `EmptyState` (un `Link` par exemple dans sa `description`) montré tant qu’il n’y a rien ; ensuite, le `placeholder` du champ suffit (« Par exemple : … »)."
                    ),
                ));
            }
        }
        walk::walk_call_expression(self, call);
    }
}

/// Paragraphes et composants de lecture rendus par le fichier.
struct Reading<'l> {
    socle: &'l BTreeMap<String, String>,
    kit: &'l BTreeMap<String, String>,
    paragraphs: usize,
    reading: bool,
}

impl<'a> Visit<'a> for Reading<'_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        if let JSXElementName::IdentifierReference(reference) = &element.opening_element.name {
            let local = reference.name.as_str();
            if self.socle.get(local).is_some_and(|name| READING.contains(&name.as_str())) {
                self.reading = true;
            }
            let paragraph = literal(attribute(&element.opening_element, "as").and_then(|value| value.value.as_ref()));
            if self.kit.get(local).is_some_and(|name| name == "Text") && paragraph.as_deref() == Some("p") {
                self.paragraphs += 1;
            }
        }
        walk::walk_jsx_element(self, element);
    }
}

/// La page est un texte à lire ou une conversation (`Markdown`, `HtmlContent`, `ChatPage`… ou trois paragraphes) :
/// la colonne étroite lui convient, et sa hauteur ne se juge pas comme celle d’une page de travail.
pub fn is_reading(program: &Program) -> bool {
    let mut socle = BTreeMap::new();
    for entry in super::SOCLE_ENTRIES {
        socle.extend(imported(program, entry));
    }
    let kit = imported(program, "@alfred/kit");
    let mut reading = Reading { socle: &socle, kit: &kit, paragraphs: 0, reading: false };
    reading.visit_program(program);
    reading.reading || reading.paragraphs >= READING_PARAGRAPHS
}

/// Avertissements de mise en page d’une page de la zone principale : (position, message).
pub fn check(program: &Program, socle: &BTreeMap<String, String>, source: &str) -> Vec<(u32, String)> {
    let (named, default) = components(&program.body);
    let mut values = BTreeMap::new();
    declarators(&program.body, &mut values);
    let default = match default {
        Some(DefaultExport::Body(body)) => Some(body),
        _ => None,
    };
    for body in named.values().chain(default.as_ref()) {
        if let Body::Statements(body) = body {
            declarators(&body.statements, &mut values);
        }
    }
    let kit = imported(program, "@alfred/kit");
    let top_bar = imported(program, "@alfred/sdk")
        .into_iter()
        .find(|(_, exported)| exported == "useTopBarActions")
        .map(|(local, _)| local);
    let mut reading = Reading { socle, kit: &kit, paragraphs: 0, reading: false };
    reading.visit_program(program);
    let layout = Layout { socle, kit: kit.clone(), top_bar, named, values, source };
    let mut scan = Scan {
        layout: &layout,
        stack: Vec::new(),
        empty: 0,
        reading: reading.reading || reading.paragraphs >= READING_PARAGRAPHS,
        found: Vec::new(),
    };
    scan.visit_program(program);
    let mut found = scan.found;
    found.extend(layout.screens(default.as_ref()));
    found
}
