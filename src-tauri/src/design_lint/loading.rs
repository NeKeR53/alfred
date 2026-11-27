//! L’interface d’abord : une page ne remplace jamais toute son interface par un chargement. Sa barre d’outils, ses
//! actions, ses filtres et ses titres s’affichent tout de suite ; seul le bloc qui attend une donnée montre son
//! attente, et seulement s’il n’a encore aucune valeur. `useAlfredState` donne la dernière valeur connue tout de
//! suite (gardée sur le disque) : un écran de chargement n’a plus de raison d’être.
//!
//! Refusé, dans le composant exporté par défaut (la page) :
//! - un retour anticipé pendant un chargement : `if (tickets.loading) return <Page state="loading" />`,
//!   `if (!data) return <Skeleton />`, `if (loading) return null` ;
//! - un retour conditionnel sur un chargement : `return loading ? <Spinner /> : <ListPage … />` ;
//! - `Page` tout entière en chargement (`state="loading"`, ou `state` lié à un chargement) : l’état va sur chaque
//!   `PageSection` ;
//! - un état de chargement tiré d’une relecture (`state={x.refreshing ? "loading" : …}`) : une relecture garde les
//!   données à l’écran.
//!
//! - une erreur cachée quand une donnée reste à l’écran (`hasError={Boolean(x.error) && !x.data}`) : la donnée gardée
//!   n’est plus juste, son bloc doit le dire (`ListPage` garde ses lignes et affiche « Résultats non mis à jour »).
//!
//! Un composant de bloc (pas la page) peut attendre sa donnée : c’est sa place.

use std::collections::BTreeMap;

use oxc::ast::ast::{
    Expression, IdentifierReference, JSXAttributeValue, JSXElement, JSXExpression, Program, Statement,
    StaticMemberExpression, StringLiteral, UnaryExpression,
};
use oxc::syntax::operator::UnaryOperator;
use oxc::ast_visit::{walk, Visit};
use oxc::span::GetSpan;

use super::{attribute, components, element_name, Body, DefaultExport};

/// Noms d’un drapeau de chargement : un retour anticipé sur l’un d’eux remplace toute la page.
const LOADING: [&str; 6] = ["loading", "isLoading", "pending", "isPending", "isFetching", "chargement"];
/// Noms d’une relecture : les données restent à l’écran.
const REFRESHING: [&str; 2] = ["refreshing", "isRefreshing"];
/// Ce qui ne montre qu’une attente.
const WAITING: [&str; 4] = ["Skeleton", "SkeletonGroup", "Spinner", "ProgressBar"];

const INSTEAD: &str = "Rends toujours le gabarit (barre d’outils, actions, filtres, titres) et laisse chaque bloc montrer son attente : `<ListPage rows={tickets.data} isLoading={tickets.refreshing} …>` (squelettes sans lignes, barre fine avec), `<PageSection state={meteo.loading ? \"loading\" : \"ready\"} …>`. `useAlfredState` donne tout de suite la dernière valeur connue, même après un redémarrage (SDK.md, section 3, « L’interface d’abord »).";

/// Drapeaux lus par une expression : chargement, relecture.
#[derive(Default)]
struct Flags {
    loading: bool,
    refreshing: bool,
    /// L’expression peut valoir `"loading"` (`!x.data ? "loading" : "ready"`).
    literal: bool,
}

impl Flags {
    fn of(expression: &Expression) -> Self {
        let mut flags = Self::default();
        flags.visit_expression(expression);
        flags
    }

    fn name(&mut self, name: &str) {
        self.loading |= LOADING.contains(&name);
        self.refreshing |= REFRESHING.contains(&name);
    }
}

impl<'a> Visit<'a> for Flags {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        self.name(it.name.as_str());
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        self.name(it.property.name.as_str());
        walk::walk_static_member_expression(self, it);
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        self.literal |= it.value == "loading";
    }
}

/// L’expression rendue ne montre qu’une attente : un squelette, une roue, une barre, ou un gabarit en chargement
/// (`state="loading"`, `isLoading` seul). `null` n’en est une que sous un drapeau de chargement (rien de sélectionné
/// n’est pas une attente).
fn only_waits(expression: &Expression, socle: &BTreeMap<String, String>) -> bool {
    match expression.without_parentheses() {
        Expression::JSXElement(element) => {
            let Some((local, _)) = element_name(&element.opening_element.name) else { return false };
            let name = socle.get(&local).map(String::as_str).unwrap_or(local.as_str());
            WAITING.contains(&name) || in_loading_state(element)
        }
        _ => false,
    }
}

fn in_loading_state(element: &JSXElement) -> bool {
    let opening = &element.opening_element;
    let literal_loading = attribute(opening, "state").is_some_and(|state| {
        matches!(&state.value, Some(JSXAttributeValue::StringLiteral(text)) if text.value == "loading")
    });
    let bare_loading = attribute(opening, "isLoading").is_some_and(|loading| loading.value.is_none());
    literal_loading || bare_loading
}

/// Retours d’une instruction de premier niveau de la page (`if`, bloc), sans entrer dans les fonctions.
fn returns<'b, 'a>(statement: &'b Statement<'a>, found: &mut Vec<&'b Expression<'a>>) {
    match statement {
        Statement::ReturnStatement(ret) => match &ret.argument {
            Some(argument) => found.push(argument),
            None => {}
        },
        Statement::BlockStatement(block) => block.body.iter().for_each(|inner| returns(inner, found)),
        _ => {}
    }
}

struct Scan<'s> {
    socle: &'s BTreeMap<String, String>,
    found: Vec<(u32, String)>,
}

impl Scan<'_> {
    fn statements(&mut self, statements: &[Statement]) {
        for statement in statements {
            match statement {
                Statement::IfStatement(branch) => {
                    let flags = Flags::of(&branch.test);
                    let mut found = Vec::new();
                    returns(&branch.consequent, &mut found);
                    let bare = matches!(&branch.consequent, Statement::ReturnStatement(ret) if ret.argument.is_none());
                    let waits = found.iter().any(|expression| only_waits(expression, self.socle));
                    if (flags.loading || flags.refreshing) && (!found.is_empty() || bare) || waits {
                        self.found.push((
                            branch.span.start,
                            format!("La page remplace toute son interface pendant un chargement (retour anticipé `if (…) return …`). {INSTEAD}"),
                        ));
                    }
                }
                Statement::ReturnStatement(ret) => {
                    if let Some(argument) = &ret.argument {
                        self.conditional(argument);
                    }
                }
                _ => {}
            }
        }
    }

    /// `return loading ? <Spinner /> : <ListPage />`, `return loading && <Skeleton />`.
    fn conditional(&mut self, expression: &Expression) {
        let (test, waits) = match expression.without_parentheses() {
            Expression::ConditionalExpression(choice) => (
                &choice.test,
                only_waits(&choice.consequent, self.socle) || only_waits(&choice.alternate, self.socle),
            ),
            Expression::LogicalExpression(logical) => (&logical.left, only_waits(&logical.right, self.socle)),
            _ => return,
        };
        let flags = Flags::of(test);
        if flags.loading || flags.refreshing || waits {
            self.found.push((
                expression.span().start,
                format!("La page rend soit un chargement, soit son interface (`return chargement ? … : …`). {INSTEAD}"),
            ));
        }
    }
}

/// Une expression qui vaut faux dès qu’une donnée est là (`!x.data`, `!rows`) : une erreur ainsi cachée laisse une
/// donnée périmée à l’écran sans le dire.
#[derive(Default)]
struct HidesWithData(bool);

impl<'a> Visit<'a> for HidesWithData {
    fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
        if it.operator == UnaryOperator::LogicalNot {
            let name = match it.argument.without_parentheses() {
                Expression::StaticMemberExpression(member) => Some(member.property.name.as_str()),
                Expression::Identifier(identifier) => Some(identifier.name.as_str()),
                _ => None,
            };
            self.0 |= name.is_some_and(|name| ["data", "rows", "donnees"].contains(&name));
        }
        walk::walk_unary_expression(self, it);
    }
}

/// États tirés d’un chargement sur toute la page, ou d’une relecture sur un bloc.
struct States<'s> {
    socle: &'s BTreeMap<String, String>,
    found: Vec<(u32, String)>,
}

impl<'a> Visit<'a> for States<'_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        let opening = &element.opening_element;
        if let Some((local, _)) = element_name(&opening.name) {
            let name = self.socle.get(&local).map(String::as_str).unwrap_or_default();
            if let Some(error) = attribute(opening, "hasError") {
                let mut hides = HidesWithData::default();
                if let Some(JSXAttributeValue::ExpressionContainer(container)) = &error.value {
                    if let Some(expression) = container.expression.as_expression() {
                        hides.visit_expression(expression);
                    }
                }
                if hides.0 {
                    self.found.push((
                        opening.span.start,
                        format!("`hasError` de `{local}` cache l’échec dès qu’une donnée est là (`!x.data`) : l’utilisateur verrait une donnée périmée sans le savoir. Écris `hasError={{Boolean(x.error)}}` : `ListPage` garde ses lignes et affiche « Résultats non mis à jour » (AGENTS.md, ordre de priorité, point 2)."),
                    ));
                }
            }
            // `isLoading` d’une collection : squelettes sans données, barre fine pendant une relecture. (Celui de
            // `Card variant="metric"` dit « valeur pas encore lue » : il suit bien `loading`.)
            let collection = ["ListPage", "Table", "List", "Drawer"].contains(&name);
            if let Some(waiting) = attribute(opening, "isLoading").filter(|_| collection) {
                if let Some(JSXAttributeValue::ExpressionContainer(container)) = &waiting.value {
                    let flags = container.expression.as_expression().map(Flags::of).unwrap_or_default();
                    if flags.loading && !flags.refreshing {
                        self.found.push((
                            opening.span.start,
                            format!("`isLoading` de `{local}` suit `loading` : la relecture d’une donnée déjà affichée ne se verrait pas. Écris `isLoading={{x.refreshing}}` : squelettes sans données, barre fine de 2 px pendant une relecture (SDK.md, section 3, « L’interface d’abord »)."),
                        ));
                    }
                }
            }
            if let Some(state) = attribute(opening, "state") {
                let flags = match &state.value {
                    Some(JSXAttributeValue::ExpressionContainer(container)) => match &container.expression {
                        JSXExpression::EmptyExpression(_) => Flags::default(),
                        other => other.as_expression().map(Flags::of).unwrap_or_default(),
                    },
                    _ => Flags::default(),
                };
                if flags.refreshing {
                    self.found.push((
                        opening.span.start,
                        format!("`state` de `{local}` suit une relecture (`refreshing`) : à chaque relecture, le contenu laisserait place aux squelettes. `state` suit `loading` (aucune valeur encore) ; une relecture garde les données à l’écran."),
                    ));
                } else if name == "Page" && (flags.loading || flags.literal || in_loading_state(element)) {
                    self.found.push((
                        opening.span.start,
                        "`<Page state=\"loading\">` remplace tous les blocs de la page par des squelettes, titres compris. Mets l’état sur chaque `PageSection` qui attend sa donnée : `<PageSection title=\"…\" state={meteo.loading ? \"loading\" : \"ready\"}>` ; les autres blocs s’affichent tout de suite (SDK.md, section 3, « L’interface d’abord »).".to_string(),
                    ));
                }
            }
        }
        walk::walk_jsx_element(self, element);
    }
}

/// Remarques : (position, message). Chacune est un refus.
pub fn check(program: &Program, socle: &BTreeMap<String, String>) -> Vec<(u32, String)> {
    let (named, default) = components(&program.body);
    let page = match &default {
        Some(DefaultExport::Body(body)) => Some(body),
        Some(DefaultExport::Named(name)) => named.get(name),
        None => None,
    };
    let mut scan = Scan { socle, found: Vec::new() };
    match page {
        Some(Body::Statements(body)) => scan.statements(&body.statements),
        Some(Body::Expression(expression)) => scan.conditional(expression),
        None => {}
    }
    let mut states = States { socle, found: Vec::new() };
    states.visit_program(program);
    let mut found = scan.found;
    found.extend(states.found);
    found
}
