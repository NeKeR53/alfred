//! Lignes et en-tête d’un `Drawer` (spec Drawer, « Exclus » et `DetailHeader` ; DESIGN.md, section 6).
//!
//! Erreur : un champ de saisie dans une ligne ou une section du panneau (`PropertyRow`, valeur d’un champ de
//! `fields`, enfants de `Drawer.Section`, `content` d’une section), écrit là ou rendu par une fonction du module :
//! un composant ou une fonction du fichier, ou d’un fichier du module importé par un chemin relatif (`./…`, `../…`),
//! suivis jusqu’à six niveaux. Seule exception : `InlineEdit`, le texte modifiable sur place.
//!
//! Limite : la relecture suit des noms, pas des valeurs. Un composant passé en paramètre, rangé dans un tableau ou
//! choisi au moment de l’exécution n’est pas suivi. Les gestionnaires d’événements (`onPress`, `onChange`…) et le
//! contenu d’une fenêtre (`Dialog`, `Modal`, `Popover`) ne sont pas des lignes : ils ne sont pas relus.
//!
//! Avertissement : un titre d’en-tête qui commence par « Détail », ou un sous-titre écrit comme une phrase d’aide
//! (il finit par un point). Seuls les textes écrits dans la page sont lus.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    ArrowFunctionBody, CallExpression, Declaration, ExportDefaultDeclarationKind, Expression, Function,
    ImportDeclarationSpecifier, JSXAttribute, JSXAttributeValue, JSXElement, JSXElementName,
    ObjectExpression, ObjectProperty, ObjectPropertyKind, Program, Statement, VariableDeclarator,
};
use oxc::ast_visit::{walk, Visit};
use oxc::parser::Parser;
use oxc::span::SourceType;
use oxc::syntax::scope::ScopeFlags;

use super::{attribute, attribute_name, element_name, SOCLE_ENTRIES};

/// Champs de saisie de socle-ui, anciens noms compris (`TextField`, `RadioGroup`, `SearchField`).
pub const INPUTS: [&str; 20] = [
    "Select",
    "ComboBox",
    "TextInput",
    "TextField",
    "TextArea",
    "NumberField",
    "DatePicker",
    "DateRangePicker",
    "Checkbox",
    "CheckboxGroup",
    "RadioButtonGroup",
    "RadioGroup",
    "SegmentedControl",
    "Slider",
    "SearchInput",
    "SearchField",
    "MentionInput",
    "CodeField",
    "ColorPicker",
    "FileUpload",
];

/// Ce qui s’ouvre au-dessus de la page : son contenu n’est pas une ligne du panneau.
const OVERLAYS: [&str; 3] = ["Dialog", "Modal", "Popover"];

/// Noms de socle-ui qui font d’un fichier un panneau (composants et types de la forme déclarative).
const DRAWER_NAMES: [&str; 6] = ["Drawer", "DetailPanel", "PropertyRow", "DetailField", "DetailSection", "DetailHeader"];

/// Profondeur de suivi des composants et fonctions, d’un fichier à l’autre.
const MAX_DEPTH: usize = 6;

/// `onPress`, `onChange`… : un gestionnaire d’événement, pas un contenu.
fn is_handler(name: &str) -> bool {
    name.strip_prefix("on").and_then(|rest| rest.chars().next()).is_some_and(char::is_uppercase)
}

/// Ce qu’un fichier du module déclare, gardé sans son arbre de syntaxe.
#[derive(Default)]
pub struct Facts {
    /// Noms importés de socle-ui (local → exporté).
    socle: BTreeMap<String, String>,
    /// Noms importés d’un fichier du module (local → (chemin relatif, nom exporté ou `default`)).
    imports: BTreeMap<String, (String, String)>,
    /// Fonctions et constantes qui contiennent du JSX : les noms qu’elles rendent ou appellent.
    things: BTreeMap<String, Vec<String>>,
    /// Exports (nom exporté → nom local).
    exports: BTreeMap<String, String>,
}

/// Noms rendus (`<Nom>`) ou appelés (`nom(…)`) dans une expression ou un corps, et, si demandé, les noms lus.
struct Names<'s> {
    socle: &'s BTreeMap<String, String>,
    reads: bool,
    found: Vec<(String, u32)>,
    jsx: bool,
}

impl<'s> Names<'s> {
    fn new(socle: &'s BTreeMap<String, String>, reads: bool) -> Self {
        Names { socle, reads, found: Vec::new(), jsx: false }
    }
}

impl<'a> Visit<'a> for Names<'_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.jsx = true;
        let opening = &element.opening_element;
        let member = matches!(opening.name, JSXElementName::MemberExpression(_));
        if let Some((local, intrinsic)) = element_name(&opening.name) {
            if !intrinsic && !member {
                // Une fenêtre s’ouvre au-dessus : ses champs ne sont pas dans la ligne.
                if self.socle.get(&local).is_some_and(|imported| OVERLAYS.contains(&imported.as_str())) {
                    return;
                }
                self.found.push((local, opening.span.start));
            }
        }
        walk::walk_jsx_element(self, element);
    }

    fn visit_jsx_attribute(&mut self, attribute: &JSXAttribute<'a>) {
        if attribute_name(attribute).is_some_and(|name| is_handler(&name)) {
            return;
        }
        walk::walk_jsx_attribute(self, attribute);
    }

    fn visit_object_property(&mut self, property: &ObjectProperty<'a>) {
        if property.key.static_name().is_some_and(|name| is_handler(&name)) {
            return;
        }
        walk::walk_object_property(self, property);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Expression::Identifier(callee) = call.callee.without_parentheses() {
            self.found.push((callee.name.to_string(), call.span.start));
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_identifier_reference(&mut self, reference: &oxc::ast::ast::IdentifierReference<'a>) {
        if self.reads {
            self.found.push((reference.name.to_string(), reference.span.start));
        }
    }
}

/// Relève les fonctions et les constantes à JSX d’un fichier, à toute profondeur.
struct Collect<'s> {
    socle: &'s BTreeMap<String, String>,
    things: BTreeMap<String, Vec<String>>,
}

impl Collect<'_> {
    fn add(&mut self, name: String, names: Names) {
        self.things.entry(name).or_default().extend(names.found.into_iter().map(|(name, _)| name));
    }
}

impl<'a> Visit<'a> for Collect<'_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if let (Some(id), Some(body)) = (&function.id, &function.body) {
            let mut names = Names::new(self.socle, false);
            names.visit_function_body(body);
            self.add(id.name.to_string(), names);
        }
        walk::walk_function(self, function, flags);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let (Some(id), Some(init)) = (declarator.id.get_binding_identifier(), &declarator.init) {
            let mut names = Names::new(self.socle, false);
            match init.without_parentheses() {
                Expression::ArrowFunctionExpression(arrow) => match &arrow.body {
                    ArrowFunctionBody::FunctionBody(body) => names.visit_function_body(body),
                    other => {
                        if let Some(expression) = other.as_expression() {
                            names.visit_expression(expression);
                        }
                    }
                },
                Expression::FunctionExpression(function) => {
                    if let Some(body) = &function.body {
                        names.visit_function_body(body);
                    }
                }
                other => {
                    // Une constante qui contient du JSX (`const ligne = <Select … />`) est suivie comme un rendu.
                    let mut values = Names::new(self.socle, true);
                    values.visit_expression(other);
                    if values.jsx {
                        names = values;
                    }
                }
            }
            if !names.found.is_empty() {
                self.add(id.name.to_string(), names);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

fn declared_names(declaration: &Declaration) -> Vec<String> {
    match declaration {
        Declaration::FunctionDeclaration(function) => function.id.iter().map(|id| id.name.to_string()).collect(),
        Declaration::VariableDeclaration(variables) => variables
            .declarations
            .iter()
            .filter_map(|declarator| declarator.id.get_binding_identifier().map(|id| id.name.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

impl Facts {
    pub fn of(program: &Program) -> Facts {
        let mut facts = Facts::default();
        for statement in &program.body {
            match statement {
                Statement::ImportDeclaration(import) => {
                    let source = import.source.value.as_str();
                    let relative = source.starts_with("./") || source.starts_with("../");
                    for specifier in import.specifiers.iter().flatten() {
                        let (local, imported) = match specifier {
                            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                                (named.local.name.to_string(), named.imported.name().to_string())
                            }
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                                (default.local.name.to_string(), "default".to_string())
                            }
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => continue,
                        };
                        if SOCLE_ENTRIES.contains(&source) {
                            facts.socle.insert(local, imported);
                        } else if relative {
                            facts.imports.insert(local, (source.to_string(), imported));
                        }
                    }
                }
                Statement::ExportDeclaration(export) => {
                    for name in declared_names(&export.declaration) {
                        facts.exports.insert(name.clone(), name);
                    }
                }
                Statement::ExportNamedDeclaration(export) => {
                    for specifier in &export.specifiers {
                        facts.exports.insert(specifier.exported.name().to_string(), specifier.local.name().to_string());
                    }
                }
                Statement::ExportFromDeclaration(export) => {
                    let source = export.source.value.as_str();
                    for specifier in &export.specifiers {
                        let exported = specifier.exported.name().to_string();
                        // Un nom repris d’un autre fichier : il se suit comme un import.
                        let local = format!("{exported}@{source}");
                        facts.imports.insert(local.clone(), (source.to_string(), specifier.local.name().to_string()));
                        facts.exports.insert(exported, local);
                    }
                }
                Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        let name = function.id.as_ref().map_or_else(|| "default".to_string(), |id| id.name.to_string());
                        if function.id.is_none() {
                            if let Some(body) = &function.body {
                                let mut names = Names::new(&facts.socle, false);
                                names.visit_function_body(body);
                                let found = names.found.into_iter().map(|(name, _)| name).collect();
                                facts.things.insert("default".to_string(), found);
                            }
                        }
                        facts.exports.insert("default".to_string(), name);
                    }
                    ExportDefaultDeclarationKind::Identifier(reference) => {
                        facts.exports.insert("default".to_string(), reference.name.to_string());
                    }
                    kind => {
                        if let Some(expression) = kind.as_expression() {
                            let mut names = Names::new(&facts.socle, false);
                            names.visit_expression(expression);
                            let found = names.found.into_iter().map(|(name, _)| name).collect();
                            facts.things.insert("default".to_string(), found);
                            facts.exports.insert("default".to_string(), "default".to_string());
                        }
                    }
                },
                _ => {}
            }
        }
        let mut collect = Collect { socle: &facts.socle, things: BTreeMap::new() };
        collect.visit_program(program);
        let things = collect.things;
        for (name, names) in things {
            facts.things.entry(name).or_default().extend(names);
        }
        facts
    }

    fn is_drawer(&self) -> bool {
        self.socle.values().any(|imported| DRAWER_NAMES.contains(&imported.as_str()))
    }
}

/// Fichiers du module : lus à la demande, une fois chacun.
pub struct Sources<'r> {
    pub(super) read: &'r dyn Fn(&Path) -> Option<String>,
    cache: RefCell<HashMap<PathBuf, Option<Rc<Facts>>>>,
}

pub(super) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

impl<'r> Sources<'r> {
    pub fn new(read: &'r dyn Fn(&Path) -> Option<String>) -> Self {
        Sources { read, cache: RefCell::new(HashMap::new()) }
    }

    fn facts(&self, path: &Path) -> Option<Rc<Facts>> {
        if let Some(known) = self.cache.borrow().get(path) {
            return known.clone();
        }
        let facts = (self.read)(path).and_then(|source| {
            let allocator = Allocator::default();
            let parsed = Parser::new(&allocator, &source, SourceType::tsx()).parse();
            (!parsed.fatal_error).then(|| Rc::new(Facts::of(&parsed.program)))
        });
        self.cache.borrow_mut().insert(path.to_path_buf(), facts.clone());
        facts
    }

    /// Fichier visé par un import relatif : chemin exact, puis avec une extension, puis `index`.
    fn resolve(&self, from: &Path, specifier: &str) -> Option<(PathBuf, Rc<Facts>)> {
        let base = normalize(&from.parent()?.join(specifier));
        let mut candidates = vec![base.clone()];
        for extension in ["tsx", "ts", "jsx", "js"] {
            candidates.push(PathBuf::from(format!("{}.{extension}", base.display())));
        }
        for extension in ["tsx", "ts", "jsx", "js"] {
            candidates.push(base.join(format!("index.{extension}")));
        }
        candidates.into_iter().find_map(|path| self.facts(&path).map(|facts| (path, facts)))
    }

    /// Le champ de saisie de socle-ui que rend `name` (directement ou par ce qu’il rend), s’il y en a un.
    fn input_of(&self, file: &Path, facts: &Facts, name: &str, depth: usize, seen: &mut BTreeSet<(PathBuf, String)>) -> Option<String> {
        if depth > MAX_DEPTH || !seen.insert((file.to_path_buf(), name.to_string())) {
            return None;
        }
        if let Some(imported) = facts.socle.get(name) {
            return INPUTS.contains(&imported.as_str()).then(|| imported.clone());
        }
        if let Some(used) = facts.things.get(name) {
            return used.iter().find_map(|inner| self.input_of(file, facts, inner, depth + 1, seen));
        }
        let (specifier, imported) = facts.imports.get(name)?;
        let (path, other) = self.resolve(file, specifier)?;
        let local = other.exports.get(imported)?.clone();
        self.input_of(&path, &other, &local, depth + 1, seen)
    }
}

/// Où se trouve le champ de saisie.
#[derive(Clone, Copy)]
enum Place {
    Row,
    Field,
    Section,
    Content,
}

impl Place {
    fn describe(self) -> &'static str {
        match self {
            Place::Row => "une ligne de `Drawer` (`value` de `PropertyRow`)",
            Place::Field => "une ligne de `Drawer` (`value` d’un champ de `fields`)",
            Place::Section => "une section de `Drawer` (enfants de `Drawer.Section`)",
            Place::Content => "une section de `Drawer` (`content`)",
        }
    }
}

const REMEDY: &str = "Montrer la valeur en texte (valeur brute et son `type`) et modifier par l’action de la ligne : `action: { type: \"icon\", icon, label, menu }` avec un `DropdownMenu.Section` de choix, `type: \"switch\"`, ou `onPress` qui ouvre `useOpenForm` pour une saisie. Seul un texte se modifie sur place, avec `InlineEdit` en `value` de `PropertyRow` (forme à composants) (DESIGN.md, section 6 ; spec Drawer, « Exclus »).";

/// Relecture des lignes et de l’en-tête dans le fichier d’une page.
struct Rows<'f, 'r> {
    file: &'f Path,
    facts: &'f Facts,
    sources: &'f Sources<'r>,
    /// Le fichier décrit un panneau : ses objets `{ label, value }` sont des champs.
    drawer: bool,
    found: Vec<(u32, String)>,
    reported: BTreeSet<u32>,
}

impl Rows<'_, '_> {
    fn socle(&self, local: &str) -> Option<&str> {
        self.facts.socle.get(local).map(String::as_str)
    }

    fn check_names(&mut self, names: Vec<(String, u32)>, place: Place) {
        for (name, offset) in names {
            if self.reported.contains(&offset) {
                continue;
            }
            let message = if let Some(imported) = self.socle(&name).filter(|imported| INPUTS.contains(imported)) {
                format!("Champ de saisie `<{imported}>` dans {} : la spec Drawer l’interdit. {REMEDY}", place.describe())
            } else if self.facts.socle.contains_key(&name) {
                continue;
            } else {
                let mut seen = BTreeSet::new();
                let Some(input) = self.sources.input_of(self.file, self.facts, &name, 0, &mut seen) else { continue };
                let origin = self
                    .facts
                    .imports
                    .get(&name)
                    .map(|(specifier, _)| format!(" (de `{specifier}`)"))
                    .unwrap_or_default();
                format!(
                    "`{name}`{origin} rend un champ de saisie (`<{input}>`) dans {} : la spec Drawer l’interdit. {REMEDY}",
                    place.describe()
                )
            };
            self.reported.insert(offset);
            self.found.push((offset, message));
        }
    }

    fn check_expression(&mut self, expression: &Expression, place: Place) {
        let mut names = Names::new(&self.facts.socle, true);
        names.visit_expression(expression);
        self.check_names(names.found, place);
    }

    /// La valeur d’un champ de `fields` est brute : `FormattedValue` la met en forme, un élément React y devient
    /// « [object Object] ».
    fn check_raw_value(&mut self, value: &Expression) {
        let jsx = |expression: &Expression| {
            matches!(expression.without_parentheses(), Expression::JSXElement(_) | Expression::JSXFragment(_))
        };
        let element = match value.without_parentheses() {
            Expression::ConditionalExpression(choice) => jsx(&choice.consequent) || jsx(&choice.alternate),
            Expression::LogicalExpression(logical) => jsx(&logical.right),
            other => jsx(other),
        };
        let offset = oxc::span::GetSpan::span(value).start;
        if element && !self.reported.contains(&offset) {
            self.reported.insert(offset);
            self.found.push((
                offset,
                "Élément React en `value` d’un champ de `fields` : la forme déclarative du `Drawer` met la valeur brute en forme (`type`), un élément s’y affiche « [object Object] ». Passer la valeur brute et son `type` ; une modification passe par l’action de la ligne (DESIGN.md, section 6 ; spec Drawer, `DetailField`).".to_string(),
            ));
        }
    }

    fn check_header(&mut self, expression: &Expression) {
        match expression.without_parentheses() {
            Expression::ConditionalExpression(choice) => {
                self.check_header(&choice.consequent);
                self.check_header(&choice.alternate);
            }
            Expression::LogicalExpression(logical) => self.check_header(&logical.right),
            Expression::ObjectExpression(object) => {
                for (key, value) in properties(object) {
                    let Some(text) = literal_start(value) else { continue };
                    let offset = oxc::span::GetSpan::span(value).start;
                    if key == "title" && text.trim_start().starts_with("Détail") {
                        self.found.push((
                            offset,
                            "Avertissement : le titre de l’en-tête du `Drawer` commence par « Détail ». Le titre est le nom de l’objet (« ALF-12 · Export en échec »), le panneau porte déjà « Détail » (DESIGN.md, section 6 ; spec Drawer, `DetailHeader`).".to_string(),
                        ));
                    }
                    if key == "subtitle" && is_help_sentence(value) {
                        self.found.push((
                            offset,
                            format!("Avertissement : le sous-titre de l’en-tête du `Drawer` est une phrase d’aide (« {} »). Le sous-titre est une ligne de contexte (« Nantes · client depuis 2019 »)  ; une phrase d’aide n’a pas sa place dans le panneau (DESIGN.md, section 6 ; spec Drawer, `DetailHeader`).", text.trim()),
                        ));
                    }
                }
            }
            _ => {}
        }
    }
}

fn properties<'b, 'a>(object: &'b ObjectExpression<'a>) -> Vec<(String, &'b Expression<'a>)> {
    object
        .properties
        .iter()
        .filter_map(|property| match property {
            ObjectPropertyKind::ObjectProperty(property) if !property.computed => {
                property.key.static_name().map(|key| (key.to_string(), &property.value))
            }
            _ => None,
        })
        .collect()
}

/// Début d’un texte écrit dans la page : une chaîne, ou le premier morceau d’un gabarit de chaîne.
fn literal_start(expression: &Expression) -> Option<String> {
    match expression.without_parentheses() {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        Expression::TemplateLiteral(template) => template.quasis.first().map(|quasi| quasi.value.raw.to_string()),
        _ => None,
    }
}

/// Une phrase d’aide finit par un point (une ligne de contexte n’en a pas) : seulement un texte entier.
fn is_help_sentence(expression: &Expression) -> bool {
    let text = match expression.without_parentheses() {
        Expression::StringLiteral(literal) => literal.value.to_string(),
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
            template.quasis.iter().map(|quasi| quasi.value.raw.to_string()).collect()
        }
        _ => return false,
    };
    let text = text.trim();
    text.ends_with('.') && !text.ends_with("...") || text.ends_with('!') || text.ends_with('?')
}

impl<'a> Visit<'a> for Rows<'_, '_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        let opening = &element.opening_element;
        match &opening.name {
            JSXElementName::MemberExpression(member) => {
                let object = match &member.object {
                    oxc::ast::ast::JSXMemberExpressionObject::IdentifierReference(reference) => Some(reference.name.to_string()),
                    _ => None,
                };
                let drawer = object.as_deref().and_then(|local| self.socle(local)).is_some_and(|imported| {
                    matches!(imported, "Drawer" | "DetailPanel")
                });
                if drawer && member.property.name == "Section" {
                    let mut names = Names::new(&self.facts.socle, true);
                    for child in &element.children {
                        names.visit_jsx_child(child);
                    }
                    self.check_names(names.found, Place::Section);
                }
            }
            name => {
                if let Some((local, false)) = element_name(name) {
                    match self.socle(&local).map(str::to_string).as_deref() {
                        Some("PropertyRow") => {
                            if let Some(value) = attribute(opening, "value") {
                                match &value.value {
                                    Some(JSXAttributeValue::ExpressionContainer(container)) => {
                                        if let Some(expression) = container.expression.as_expression() {
                                            self.check_expression(expression, Place::Row);
                                        }
                                    }
                                    Some(JSXAttributeValue::Element(inner)) => {
                                        let mut names = Names::new(&self.facts.socle, true);
                                        names.visit_jsx_element(inner);
                                        self.check_names(names.found, Place::Row);
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some("Drawer" | "DetailPanel") => {
                            if let Some(header) = attribute(opening, "header") {
                                if let Some(JSXAttributeValue::ExpressionContainer(container)) = &header.value {
                                    if let Some(expression) = container.expression.as_expression() {
                                        self.check_header(expression);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        walk::walk_jsx_element(self, element);
    }

    fn visit_object_expression(&mut self, object: &ObjectExpression<'a>) {
        if self.drawer {
            let found = properties(object);
            let has = |wanted: &str| found.iter().any(|(key, _)| key == wanted);
            if has("label") {
                if let Some((_, value)) = found.iter().find(|(key, _)| key == "value") {
                    self.check_expression(value, Place::Field);
                    self.check_raw_value(value);
                }
            }
            if has("title") {
                if let Some((_, content)) = found.iter().find(|(key, _)| key == "content") {
                    self.check_expression(content, Place::Content);
                }
            }
        }
        walk::walk_object_expression(self, object);
    }
}

/// Remarques sur les lignes et l’en-tête des `Drawer` d’un fichier (`file` : son chemin, pour suivre ses imports).
pub fn check(program: &Program, file: &Path, sources: &Sources, panel: bool) -> Vec<(u32, String)> {
    let facts = Facts::of(program);
    let drawer = panel || facts.is_drawer();
    let mut rows = Rows { file, facts: &facts, sources, drawer, found: Vec::new(), reported: BTreeSet::new() };
    rows.visit_program(program);
    rows.found
}

/// Une remarque d’avertissement : elle n’empêche pas `check` de réussir.
pub fn is_warning(message: &str) -> bool {
    message.starts_with("Avertissement : ")
}
