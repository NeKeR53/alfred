//! Aucune fonction au montage : une page n’appelle jamais `functions.call` dans un `useEffect` (ou
//! `useLayoutEffect`), ni dans le chargeur d’un `useAsync`, sans geste de l’utilisateur. Une lecture à l’ouverture est un état (`useAlfredState`), que le
//! cœur ne relit que s’il est périmé ; une écriture à l’ouverture ferait relire les états du module à chaque
//! ouverture de la page (la latence que la page voulait éviter). Une écriture est un geste : `onPress` d’une `Action`.
//! Une tâche qui doit tourner seule est une planification ou une automatisation.
//!
//! Suivi : les fonctions du fichier appelées par l’effet (à toute profondeur du fichier), et celles importées d’un
//! fichier du module par un chemin relatif (`../lib/support`), de proche en proche ([`MAX_DEPTH`] niveaux).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    Argument, ArrowFunctionBody, ArrowFunctionExpression, CallExpression, Declaration, ExportDefaultDeclarationKind,
    Expression, Function, FunctionBody, ImportDeclarationSpecifier, Program, Statement, VariableDeclarator,
};
use oxc::ast_visit::{walk, Visit};
use oxc::parser::Parser;
use oxc::span::SourceType;
use oxc::syntax::scope::ScopeFlags;

const MAX_DEPTH: usize = 4;
/// Ce qui s’exécute à l’ouverture de la page, sans geste : un effet, ou le chargeur d’un `useAsync`.
const EFFECTS: [&str; 3] = ["useEffect", "useLayoutEffect", "useAsync"];

/// Ce qu’un corps de fonction appelle, sans entrer dans les fonctions qu’il déclare (un gestionnaire `onPress`
/// défini dedans n’est pas un appel au montage) : les fonctions d’Alfred (`functions.call("…")`) et les fonctions
/// nommées.
#[derive(Default, Clone)]
struct Calls {
    functions: Vec<String>,
    callees: Vec<String>,
}

impl Calls {
    fn of_body(body: &FunctionBody) -> Self {
        let mut calls = Self::default();
        for statement in &body.statements {
            calls.visit_statement(statement);
        }
        calls
    }

    fn of_arrow(arrow: &ArrowFunctionExpression) -> Self {
        match &arrow.body {
            ArrowFunctionBody::FunctionBody(body) => Self::of_body(body),
            other => {
                let mut calls = Self::default();
                if let Some(expression) = other.as_expression() {
                    calls.visit_expression(expression);
                }
                calls
            }
        }
    }

    fn of_callback(expression: &Expression) -> Option<Self> {
        match expression.without_parentheses() {
            Expression::ArrowFunctionExpression(arrow) => Some(Self::of_arrow(arrow)),
            Expression::FunctionExpression(function) => function.body.as_deref().map(Self::of_body),
            _ => None,
        }
    }
}

impl<'a> Visit<'a> for Calls {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        match call.callee.without_parentheses() {
            Expression::StaticMemberExpression(member)
                if member.property.name == "call"
                    && matches!(&member.object, Expression::Identifier(object) if object.name == "functions") =>
            {
                let name = match call.arguments.first() {
                    Some(Argument::StringLiteral(text)) => text.value.to_string(),
                    _ => "…".to_string(),
                };
                self.functions.push(name);
            }
            Expression::Identifier(callee) => self.callees.push(callee.name.to_string()),
            // `(async () => { … })()` : le corps s’exécute tout de suite.
            other => {
                if let Some(calls) = Self::of_callback(other) {
                    self.functions.extend(calls.functions);
                    self.callees.extend(calls.callees);
                }
            }
        }
        for argument in &call.arguments {
            if let Some(expression) = argument.as_expression() {
                self.visit_expression(expression);
            }
        }
        if let Expression::StaticMemberExpression(member) = call.callee.without_parentheses() {
            self.visit_expression(&member.object);
        }
    }

    // Une fonction déclarée dans le corps ne s’exécute pas d’elle-même.
    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _arrow: &ArrowFunctionExpression<'a>) {}
}

/// Ce que l’on sait d’un fichier : ses fonctions nommées (à toute profondeur), ses imports relatifs, ses exports et
/// les effets de ses composants.
#[derive(Default)]
struct Facts {
    bodies: HashMap<String, Calls>,
    imports: HashMap<String, (String, String)>,
    exports: HashMap<String, String>,
    effects: Vec<(u32, Calls)>,
}

impl Facts {
    fn add(&mut self, name: &str, calls: Calls) {
        let entry = self.bodies.entry(name.to_string()).or_default();
        entry.functions.extend(calls.functions);
        entry.callees.extend(calls.callees);
    }

    fn of(program: &Program) -> Self {
        let mut facts = Self::default();
        for statement in &program.body {
            match statement {
                Statement::ImportDeclaration(import) if import.source.value.starts_with('.') => {
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
                        facts.imports.insert(local, (import.source.value.to_string(), imported));
                    }
                }
                Statement::ExportDeclaration(export) => match &export.declaration {
                    Declaration::FunctionDeclaration(function) => {
                        if let Some(id) = &function.id {
                            facts.exports.insert(id.name.to_string(), id.name.to_string());
                        }
                    }
                    Declaration::VariableDeclaration(variables) => {
                        for declarator in &variables.declarations {
                            if let Some(id) = declarator.id.get_binding_identifier() {
                                facts.exports.insert(id.name.to_string(), id.name.to_string());
                            }
                        }
                    }
                    _ => {}
                },
                Statement::ExportNamedDeclaration(export) => {
                    for specifier in &export.specifiers {
                        facts.exports.insert(specifier.exported.name().to_string(), specifier.local.name().to_string());
                    }
                }
                Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        let name = function.id.as_ref().map(|id| id.name.to_string()).unwrap_or_else(|| "default".into());
                        if let Some(body) = function.body.as_deref() {
                            facts.add(&name, Calls::of_body(body));
                        }
                        facts.exports.insert("default".into(), name);
                    }
                    ExportDefaultDeclarationKind::Identifier(reference) => {
                        facts.exports.insert("default".into(), reference.name.to_string());
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        let mut collect = Collect { facts };
        collect.visit_program(program);
        collect.facts
    }
}

struct Collect {
    facts: Facts,
}

impl<'a> Visit<'a> for Collect {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if let (Some(id), Some(body)) = (&function.id, function.body.as_deref()) {
            self.facts.add(id.name.as_str(), Calls::of_body(body));
        }
        walk::walk_function(self, function, flags);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let (Some(id), Some(init)) = (declarator.id.get_binding_identifier(), &declarator.init) {
            if let Some(calls) = Calls::of_callback(init) {
                self.facts.add(id.name.as_str(), calls);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let effect = match call.callee.without_parentheses() {
            Expression::Identifier(callee) => EFFECTS.contains(&callee.name.as_str()),
            Expression::StaticMemberExpression(member) => EFFECTS.contains(&member.property.name.as_str()),
            _ => false,
        };
        if effect {
            if let Some(calls) = call.arguments.first().and_then(Argument::as_expression).and_then(Calls::of_callback) {
                self.facts.effects.push((call.span.start, calls));
            }
        }
        walk::walk_call_expression(self, call);
    }
}

/// Fichiers du module lus à la demande.
struct Files<'r> {
    read: &'r dyn Fn(&Path) -> Option<String>,
    cache: HashMap<PathBuf, Option<std::rc::Rc<Facts>>>,
}

impl Files<'_> {
    fn facts(&mut self, path: &Path) -> Option<std::rc::Rc<Facts>> {
        if let Some(known) = self.cache.get(path) {
            return known.clone();
        }
        let facts = (self.read)(path).and_then(|source| {
            let allocator = Allocator::default();
            let parsed = Parser::new(&allocator, &source, SourceType::tsx()).parse();
            (!parsed.fatal_error).then(|| std::rc::Rc::new(Facts::of(&parsed.program)))
        });
        self.cache.insert(path.to_path_buf(), facts.clone());
        facts
    }

    fn resolve(&mut self, from: &Path, specifier: &str) -> Option<(PathBuf, std::rc::Rc<Facts>)> {
        let base = super::rows::normalize(&from.parent()?.join(specifier));
        let mut candidates = vec![base.clone()];
        for extension in ["tsx", "ts", "jsx", "js"] {
            candidates.push(PathBuf::from(format!("{}.{extension}", base.display())));
            candidates.push(base.join(format!("index.{extension}")));
        }
        candidates.into_iter().find_map(|path| self.facts(&path).map(|facts| (path, facts)))
    }

    /// Fonctions d’Alfred appelées, de proche en proche, par `calls` lu dans `file`.
    fn reached(&mut self, file: &Path, facts: &Facts, calls: &Calls, depth: usize, seen: &mut BTreeSet<(PathBuf, String)>, found: &mut Vec<String>) {
        found.extend(calls.functions.iter().cloned());
        if depth >= MAX_DEPTH {
            return;
        }
        for callee in &calls.callees {
            if !seen.insert((file.to_path_buf(), callee.clone())) {
                continue;
            }
            if let Some(local) = facts.bodies.get(callee) {
                let local = local.clone();
                self.reached(file, facts, &local, depth + 1, seen, found);
            } else if let Some((specifier, imported)) = facts.imports.get(callee) {
                let Some((path, other)) = self.resolve(file, specifier) else { continue };
                let Some(name) = other.exports.get(imported).cloned() else { continue };
                if let Some(body) = other.bodies.get(&name).cloned() {
                    if seen.insert((path.clone(), name)) {
                        self.reached(&path, &other, &body, depth + 1, seen, found);
                    }
                }
            }
        }
    }
}

/// Remarques : (position, message). Chacune est un refus.
pub fn check(program: &Program, path: &Path, read: &dyn Fn(&Path) -> Option<String>) -> Vec<(u32, String)> {
    let facts = Facts::of(program);
    let mut files = Files { read, cache: HashMap::new() };
    let mut out = Vec::new();
    for (offset, calls) in &facts.effects {
        let mut found = Vec::new();
        files.reached(path, &facts, calls, 0, &mut BTreeSet::new(), &mut found);
        found.dedup();
        if found.is_empty() {
            continue;
        }
        let names = found.iter().map(|name| format!("« {name} »")).collect::<Vec<_>>().join(", ");
        out.push((
            *offset,
            format!(
                "La page appelle {names} au montage (`useEffect` ou `useAsync`, sans geste de l’utilisateur) : refusé. Chaque ouverture lancerait la fonction et ferait relire les états du module. Une donnée à montrer est un état : `useAlfredState(\"module/etat\")`, relu par le cœur seulement s’il est périmé. Une écriture est un geste : `onPress` d’une `Action`. Une tâche qui tourne seule est une planification ou une automatisation (SDK.md, section 3, « L’interface d’abord »)."
            ),
        ));
    }
    out
}

/// Sources des fichiers du module qu’une page importe par un chemin relatif, de proche en proche ([`MAX_DEPTH`]
/// niveaux), page non comprise : les règles qui lisent le texte de la page (`sharedReads`) les lisent aussi.
pub fn imported_sources(path: &Path, read: &dyn Fn(&Path) -> Option<String>) -> Vec<String> {
    let mut files = Files { read, cache: HashMap::new() };
    let mut seen = BTreeSet::from([path.to_path_buf()]);
    let mut queue = vec![(path.to_path_buf(), 0usize)];
    let mut found = Vec::new();
    while let Some((file, depth)) = queue.pop() {
        if depth >= MAX_DEPTH {
            continue;
        }
        let Some(source) = read(&file) else { continue };
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &source, SourceType::tsx()).parse();
        for statement in &parsed.program.body {
            let Statement::ImportDeclaration(import) = statement else { continue };
            if !import.source.value.starts_with('.') {
                continue;
            }
            let Some((target, _)) = files.resolve(&file, import.source.value.as_str()) else { continue };
            if seen.insert(target.clone()) {
                if let Some(text) = read(&target) {
                    found.push(text);
                }
                queue.push((target, depth + 1));
            }
        }
    }
    found
}
