//! Transpilation des pages et des fonctions : TSX vers un module ES que le cadre isolé charge tel quel. Aucun
//! contrôle de types n’est fait ici ; les erreurs de syntaxe et les imports interdits sont signalés à l’agent.

use std::collections::BTreeMap;
use std::path::Path;

use oxc::allocator::Allocator;
use oxc::codegen::Codegen;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};
use serde::Serialize;

/// Paquets qu’une page ou une fonction a le droit d’importer : la carte d’imports du cadre ne connaît qu’eux.
pub const ALLOWED_IMPORTS: [&str; 9] = [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "lucide-react",
    "socle-ui",
    "socle-ui/markdown",
    "socle-ui/markdown-editor",
    "@alfred/sdk",
    "@alfred/kit",
];

/// Ancienne bibliothèque des pages, remplacée par `socle-ui`. Transition (2026-11-23) : le runtime la sert encore
/// aux pages des espaces pas encore migrées ; l’import passe, et l’outil `check` le signale « à migrer vers
/// socle-ui ». À retirer quand les espaces sont migrés.
pub const RETIRED_UI: &str = "@alfred/ui";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

fn position(source: &str, offset: u32) -> (u32, u32) {
    let offset = (offset as usize).min(source.len());
    let before = &source[..offset];
    let line = before.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1;
    let column = before.rsplit('\n').next().map_or(0, |text| text.chars().count()) as u32 + 1;
    (line, column)
}

fn diagnostics(source: &str, errors: impl IntoIterator<Item = oxc::diagnostics::OxcDiagnostic>) -> Vec<Diagnostic> {
    errors
        .into_iter()
        .map(|error| {
            let offset = error.labels.iter().next().map(|label| label.offset());
            let (line, column) = offset.map_or((None, None), |offset| {
                let (line, column) = position(source, offset);
                (Some(line), Some(column))
            });
            let help = error.help.as_ref().map(|help| format!(" ({help})")).unwrap_or_default();
            Diagnostic { message: format!("{}{help}", error.message), line, column }
        })
        .collect()
}

/// Transpile un fichier `.ts` ou `.tsx`. `Err` porte toutes les erreurs trouvées, positions comprises.
#[cfg(test)]
pub fn transpile(source: &str, file_name: &str) -> Result<String, Vec<Diagnostic>> {
    transpile_at(source, file_name, usize::MAX)
}

/// Vrai si un import relatif remonte au-dessus de la racine du module, depuis un fichier à `depth` dossiers d’elle.
fn escapes_module(specifier: &str, depth: usize) -> bool {
    let mut level = depth as isize;
    for part in specifier.split('/') {
        match part {
            ".." => level -= 1,
            "." | "" => {}
            _ => level += 1,
        }
        if level < 0 {
            return true;
        }
    }
    false
}

/// Comme `transpile`, pour un fichier situé à `depth` dossiers de la racine de son module : un import relatif qui
/// en sortirait est refusé, car un module ne dépend jamais du code d’un autre.
#[cfg(test)]
pub fn transpile_at(source: &str, file_name: &str, depth: usize) -> Result<String, Vec<Diagnostic>> {
    transpile_in(source, file_name, depth, &BTreeMap::new())
}

/// Comme `transpile_at`, avec les librairies du module (nom importé → fichier d’entrée de `vendor/`) : une page les
/// importe par leur nom, et ce nom devient le chemin du fichier.
pub fn transpile_in(
    source: &str,
    file_name: &str,
    depth: usize,
    libraries: &BTreeMap<String, String>,
) -> Result<String, Vec<Diagnostic>> {
    let allocator = Allocator::default();
    let path = Path::new(file_name);
    let source_type = if file_name.ends_with(".tsx") { SourceType::tsx() } else { SourceType::ts() };
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() || parsed.fatal_error {
        return Err(diagnostics(source, parsed.diagnostics));
    }
    let program = parsed.program;

    // Le registre du module liste chaque import et réexport, quelle que soit sa forme.
    let mut import_errors = Vec::new();
    for (specifier, requests) in &parsed.module_record.requested_modules {
        let specifier = specifier.as_str();
        let relative = specifier.starts_with("./") || specifier.starts_with("../");
        let outside = relative && depth != usize::MAX && escapes_module(specifier, depth);
        if (relative && !outside)
            || ALLOWED_IMPORTS.contains(&specifier)
            || specifier == RETIRED_UI
            || libraries.contains_key(specifier)
        {
            continue;
        }
        for request in requests {
            let (line, column) = position(source, request.statement_span.start);
            import_errors.push(Diagnostic {
                message: if outside {
                    format!("Import interdit : « {specifier} » sort du module. Un module n’importe que ses propres fichiers.")
                } else if specifier.starts_with("socle-ui/") {
                    format!("Import interdit : « {specifier} » est un chemin interne de socle-ui. Importer depuis `socle-ui`, `socle-ui/markdown` ou `socle-ui/markdown-editor`.")
                } else {
                    format!(
                        "Import interdit : « {specifier} ». Seuls {}, les fichiers du module (./…) et ses librairies sont disponibles ; une autre librairie npm s’ajoute au module avec `set_libraries`.",
                        ALLOWED_IMPORTS.join(", ")
                    )
                },
                line: Some(line),
                column: Some(column),
            });
        }
    }
    import_errors.sort_by_key(|error| (error.line, error.column));
    if !import_errors.is_empty() {
        return Err(import_errors);
    }

    // Les librairies importées par leur nom pointent vers leur fichier de `vendor/` ; on relit la source réécrite.
    let linked = crate::libraries::link(source, source_type, depth, libraries);
    let relinked;
    let mut program = match &linked {
        Some(linked) => {
            relinked = Parser::new(&allocator, linked, source_type).parse();
            relinked.program
        }
        None => program,
    };

    let semantic = SemanticBuilder::new().with_excess_capacity(2.0).build(&program);
    if !semantic.diagnostics.is_empty() {
        return Err(diagnostics(source, semantic.diagnostics));
    }
    let scoping = semantic.semantic.into_scoping();
    let options = TransformOptions::default();
    let transformed = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !transformed.diagnostics.is_empty() {
        return Err(diagnostics(source, transformed.diagnostics));
    }
    Ok(Codegen::new().build(&program).code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transpiles_a_page_and_reports_what_the_agent_must_fix() {
        let page = r#"
import { useState } from "react";
import { Button } from "socle-ui";
import { Stack } from "@alfred/kit";
import { Row } from "./parts/Row";
type Props = { label: string };
export default function Page({ label }: Props) {
  const [count, setCount] = useState<number>(0);
  return <Stack><Button onPress={() => setCount(count + 1)}>{label}</Button><Row /></Stack>;
}
"#;
        let code = transpile(page, "page.tsx").expect("la page est valide");
        assert!(code.contains("react/jsx-runtime"), "{code}");
        assert!(!code.contains("type Props"), "{code}");
        assert!(code.contains("./parts/Row"), "{code}");

        let forbidden = transpile("import fs from \"node:fs\";\nexport default 1;", "fn.ts").unwrap_err();
        assert_eq!(forbidden[0].line, Some(1));
        assert!(forbidden[0].message.contains("node:fs"));

        let page_file = "import { x } from \"../lib/x\";\nimport { y } from \"../../autre/pages/y\";\nexport default 1;";
        let escaping = transpile_at(page_file, "page.tsx", 1).unwrap_err();
        assert_eq!(escaping.len(), 1, "seul l’import qui sort du module est refusé");
        assert!(escaping[0].message.contains("sort du module"));

        // Transition : une page encore sur `@alfred/ui` se compile ; `check` la signale à migrer.
        assert!(transpile("import { Page } from \"@alfred/ui\";\nexport default 1;", "page.tsx").is_ok());
        let internal = transpile("import { Button } from \"socle-ui/dist/index.js\";\nexport default 1;", "page.tsx").unwrap_err();
        assert!(internal[0].message.contains("chemin interne"), "{internal:?}");

        let broken = transpile("export default function Page() {\n  return <div>;\n}", "page.tsx").unwrap_err();
        assert!(broken[0].line.is_some_and(|line| line >= 2), "l’erreur de syntaxe est localisée");
    }
}
