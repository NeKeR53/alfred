//! Régénère les types des harnais depuis les schémas vendus dans `schemas/` (repris de OneApp, ADR 0022).
//!
//! - **Codex** : `codex app-server generate-json-schema` (0.169, `schemas/codex/`) → typify. Les définitions v2
//!   sont aplaties, les schémas `true` deviennent `{}` et les propriétés déclarées à côté d’un `oneOf` descendent
//!   dans chaque variante. Seules les définitions atteintes depuis `CODEX_ROOTS` sont gardées.
//! - **OpenCode** : client progenitor depuis l’OpenAPI vendu (`schemas/opencode/openapi.json`).
//!
//! Source : `GET /openapi.json` d'un `opencode serve` 2.1.2 (OpenAPI 3.1, voir
//! `schemas/opencode/README.md`). Progenitor ne lit que l'OpenAPI 3.0 :
//! le document est abaissé, ses `anyOf` deviennent des `oneOf`, `deepObject` est développé et les
//! réponses d'erreur sont fusionnées. Seules les opérations utilisées par Alfred (`OPERATIONS`)
//! et les schémas qu'elles atteignent sont gardés, pour limiter le code compilé.
//!
//! - `cargo run --manifest-path src-tauri/codegen/Cargo.toml` réécrit le client ;
//! - `-- --check` échoue si le fichier committé diffère de ce que produit l'OpenAPI vendu.
use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};
use std::{collections::BTreeSet, fs, path::Path};

/// Types du protocole de Codex lus ou écrits par Alfred, et ceux qu’ils atteignent.
const CODEX_ROOTS: &[&str] = &[
    "InitializeParams",
    "InitializeResponse",
    "ThreadStartParams",
    "ThreadStartResponse",
    "ThreadResumeParams",
    "ThreadResumeResponse",
    "ThreadSetNameParams",
    "TurnStartParams",
    "TurnStartResponse",
    "TurnSteerParams",
    "TurnInterruptParams",
    "ModelListParams",
    "ModelListResponse",
    "SkillsListParams",
    "SkillsListResponse",
    "ItemStartedNotification",
    "ItemCompletedNotification",
    "AgentMessageDeltaNotification",
    "ErrorNotification",
    "CommandExecutionOutputDeltaNotification",
    "ReasoningSummaryTextDeltaNotification",
    "PlanDeltaNotification",
    "McpToolCallProgressNotification",
    "TurnCompletedNotification",
    "CommandExecutionRequestApprovalParams",
    "CommandExecutionRequestApprovalResponse",
    "FileChangeRequestApprovalParams",
    "FileChangeRequestApprovalResponse",
];

/// Opérations de l'API v2 pilotées par Alfred (`operationId`).
const OPERATIONS: &[&str] = &[
    "server.info",
    "server.pair",
    "server.connect",
    "event.subscribe",
    "model.list",
    "session.create",
    "session.get",
    "session.remove",
    "session.update",
    "session.switchModel",
    "session.prompt",
    "session.interrupt",
    "session.message.list",
    "session.permission.list",
    "session.permission.reply",
    "experimental.session.instructions.entry.put",
];

fn main() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let check = std::env::args().any(|arg| arg == "--check");
    let codex_code = codex(&root)?;
    write_or_check(&root.join("src/agents/codex/generated.rs"), &codex_code, "codex", check)?;
    let raw = fs::read_to_string(root.join("schemas/opencode/openapi.json"))?;
    let mut spec: Value = serde_json::from_str(&raw)?;
    keep_operations(&mut spec)?;
    spec["openapi"] = Value::from("3.0.3");
    downgrade(&mut spec);
    expand_deep_objects(&mut spec);
    collapse_responses(&mut spec);
    let api: openapiv3::OpenAPI =
        serde_json::from_value(spec).context("OpenAPI 3.0 après abaissement")?;
    let mut generator = progenitor::Generator::new(
        progenitor::GenerationSettings::default()
            .with_interface(progenitor::InterfaceStyle::Positional)
            .with_tag(progenitor::TagStyle::Merged),
    );
    let tokens = generator.generate_tokens(&api)?;
    let file = syn::parse_file(&tokens.to_string())?;
    // L'application dépend déjà de reqwest 0.12 sous le nom `reqwest` ; le client généré utilise
    // la 0.13 de progenitor-client, importée sous le nom `reqwest013` (Cargo.toml).
    let code = prettyplease::unparse(&file).replace("::reqwest::", "reqwest013::").replace("reqwest::", "reqwest013::");
    write_or_check(&root.join("src/agents/opencode/generated.rs"), &code, "opencode/openapi.json", check)
}

fn write_or_check(path: &Path, code: &str, source: &str, check: bool) -> Result<()> {
    let body = format!(
        "// @generated par `cargo run --manifest-path src-tauri/codegen/Cargo.toml` depuis\n// `src-tauri/schemas/{source}` : ne pas éditer à la main.\n#![allow(clippy::all, clippy::pedantic, dead_code, unused_imports, irrefutable_let_patterns, unreachable_pub)]\n{code}"
    );
    if check {
        if fs::read_to_string(path).unwrap_or_default() != body {
            bail!("{} n'est plus à jour : relancez le générateur", path.display());
        }
        println!("{} est à jour", path.display());
        return Ok(());
    }
    fs::write(path, &body)?;
    println!("écrit {} ({} lignes)", path.display(), body.lines().count());
    Ok(())
}

/// Types de Codex, réduits aux définitions atteintes depuis `CODEX_ROOTS`.
fn codex(root: &Path) -> Result<String> {
    let raw = fs::read_to_string(root.join("schemas/codex/codex_app_server_protocol.schemas.json"))?;
    let mut bundle: Value = serde_json::from_str(&raw)?;
    let defs = bundle["definitions"].as_object_mut().context("definitions")?;
    if let Some(Value::Object(v2)) = defs.remove("v2") {
        let inner = match v2.get("definitions") {
            Some(Value::Object(map)) => map.clone(),
            _ => v2,
        };
        for (name, schema) in inner {
            defs.entry(name).or_insert(schema);
        }
    }
    replace_true_schemas(&mut bundle);
    let text = serde_json::to_string(&bundle)?.replace("#/definitions/v2/", "#/definitions/");
    let mut bundle: Value = serde_json::from_str(&text)?;
    let defs = bundle["definitions"].as_object_mut().context("definitions")?;
    push_shared_properties_into_variants(defs);
    let mut kept = BTreeSet::new();
    let mut pending: Vec<String> = CODEX_ROOTS.iter().map(|name| (*name).to_owned()).collect();
    while let Some(name) = pending.pop() {
        let Some(schema) = defs.get(&name) else {
            bail!("définition Codex absente : {name}");
        };
        if kept.insert(name.clone()) {
            collect_definition_refs(schema, &mut pending);
        }
    }
    defs.retain(|name, _| kept.contains(name));
    let root_schema = serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": bundle["definitions"].clone(),
    });
    let schema: schemars::schema::RootSchema = serde_json::from_value(root_schema)?;
    let mut settings = typify::TypeSpaceSettings::default();
    settings.with_struct_builder(false);
    let mut space = typify::TypeSpace::new(&settings);
    space.add_root_schema(schema)?;
    let file = syn::parse_file(&space.to_stream().to_string())?;
    Ok(prettyplease::unparse(&file))
}

fn collect_definition_refs(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get("$ref") {
                if let Some(name) = reference.strip_prefix("#/definitions/") {
                    out.push(name.to_owned());
                }
            }
            map.values().for_each(|child| collect_definition_refs(child, out));
        }
        Value::Array(items) => items.iter().for_each(|child| collect_definition_refs(child, out)),
        _ => {}
    }
}

/// typify 0.8 panique (`todo!`) quand il soustrait un schéma `true` d'une variante : les schémas booléens « tout
/// accepter » deviennent `{}`, équivalent en JSON Schema.
fn replace_true_schemas(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if matches!(key.as_str(), "additionalProperties" | "items") && *child == Value::Bool(true) {
                    *child = Value::Object(Map::new());
                } else if key == "properties" {
                    if let Value::Object(properties) = child {
                        for (_, property) in properties.iter_mut() {
                            if *property == Value::Bool(true) {
                                *property = Value::Object(Map::new());
                            }
                        }
                    }
                }
                replace_true_schemas(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(replace_true_schemas),
        _ => {}
    }
}

/// Des propriétés déclarées à côté d'un `oneOf` (`ThreadItem` et ses horodatages) empêchent typify de trouver le
/// marqueur `type` : elles sont recopiées dans chaque variante.
fn push_shared_properties_into_variants(defs: &mut Map<String, Value>) {
    for (_, definition) in defs.iter_mut() {
        let Some(object) = definition.as_object_mut() else {
            continue;
        };
        let Some(Value::Array(_)) = object.get("oneOf") else {
            continue;
        };
        let Some(Value::Object(shared)) = object.remove("properties") else {
            continue;
        };
        if let Some(Value::Array(variants)) = object.get_mut("oneOf") {
            for variant in variants.iter_mut() {
                if let Some(properties) = variant.get_mut("properties").and_then(Value::as_object_mut) {
                    for (name, schema) in &shared {
                        properties.entry(name.clone()).or_insert(schema.clone());
                    }
                }
            }
        }
    }
}

/// Garde les opérations de `OPERATIONS` et les seuls schémas qu'elles référencent.
fn keep_operations(spec: &mut Value) -> Result<()> {
    let paths = spec["paths"].as_object_mut().context("paths")?;
    let mut found = BTreeSet::new();
    paths.retain(|_, item| {
        let Some(ops) = item.as_object_mut() else {
            return false;
        };
        ops.retain(|method, op| {
            let keep = matches!(method.as_str(), "get" | "post" | "put" | "patch" | "delete")
                && op["operationId"]
                    .as_str()
                    .is_some_and(|id| OPERATIONS.contains(&id));
            if keep {
                found.insert(op["operationId"].as_str().unwrap_or_default().to_owned());
            }
            keep
        });
        !ops.is_empty()
    });
    if found.len() != OPERATIONS.len() {
        let missing: Vec<_> = OPERATIONS.iter().filter(|id| !found.contains(**id)).collect();
        bail!("opérations absentes de l'OpenAPI : {missing:?}");
    }
    let schemas = spec["components"]["schemas"].clone();
    let mut reachable = BTreeSet::new();
    let mut pending: Vec<String> = Vec::new();
    collect_refs(&spec["paths"], &mut pending);
    while let Some(name) = pending.pop() {
        if reachable.insert(name.clone()) {
            collect_refs(&schemas[&name], &mut pending);
        }
    }
    if let Some(all) = spec["components"]["schemas"].as_object_mut() {
        all.retain(|name, _| reachable.contains(name));
    }
    Ok(())
}

fn collect_refs(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get("$ref") {
                if let Some(name) = reference.strip_prefix("#/components/schemas/") {
                    out.push(name.to_owned());
                }
            }
            map.values().for_each(|child| collect_refs(child, out));
        }
        Value::Array(items) => items.iter().for_each(|child| collect_refs(child, out)),
        _ => {}
    }
}

/// OpenAPI 3.1 → 3.0 : `anyOf:[X,{type:null}]` → `X + nullable`, `type:[a,"null"]` → `type:a`,
/// `const` → `enum`, schémas booléens et `not:{}` neutralisés, exemples 3.1 supprimés.
fn downgrade(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (_, child) in map.iter_mut() {
                downgrade(child);
            }
            fix_object(map);
        }
        Value::Array(items) => items.iter_mut().for_each(downgrade),
        _ => {}
    }
}

fn is_null_schema(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("null")
}

fn fix_object(map: &mut Map<String, Value>) {
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(items)) = map.get(key) {
            if items.iter().any(is_null_schema) {
                let rest: Vec<Value> = items
                    .iter()
                    .filter(|i| !is_null_schema(i))
                    .cloned()
                    .collect();
                map.remove(key);
                map.insert("nullable".into(), Value::Bool(true));
                if rest.len() == 1 {
                    match &rest[0] {
                        Value::Object(only) if only.contains_key("$ref") => {
                            map.insert("allOf".into(), Value::Array(rest));
                        }
                        Value::Object(only) => {
                            for (k, val) in only {
                                map.entry(k.clone()).or_insert(val.clone());
                            }
                        }
                        _ => {}
                    }
                } else if !rest.is_empty() {
                    map.insert(key.into(), Value::Array(rest));
                }
            }
        }
    }
    // Effect Schema (OpenCode) écrit ses unions discriminées en `anyOf`. typify traduit `anyOf`
    // par une struct de sous-types `flatten` tous facultatifs, qui perd les données ; `oneOf`
    // donne un vrai enum marqué par `type`.
    if let Some(any) = map.remove("anyOf") {
        map.insert("oneOf".into(), any);
    }
    if let Some(Value::Array(types)) = map.get("type").cloned() {
        let non_null: Vec<_> = types.into_iter().filter(|t| t != "null").collect();
        map.insert("nullable".into(), Value::Bool(true));
        map.insert(
            "type".into(),
            non_null.into_iter().next().unwrap_or(Value::from("string")),
        );
    }
    if let Some(c) = map.remove("const") {
        map.insert("enum".into(), Value::Array(vec![c]));
    }
    map.remove("examples");
    map.remove("$schema");
    map.remove("contentMediaType");
    map.remove("contentEncoding");
    for key in ["additionalProperties", "items"] {
        if let Some(Value::Bool(b)) = map.get(key) {
            if *b {
                map.insert(key.into(), Value::Object(Map::new()));
            } else if key == "items" {
                map.insert(key.into(), Value::Object(Map::new()));
            }
        }
    }
    if let Some(Value::Object(n)) = map.get("not") {
        // `not:{}` (jamais) et `not:{type:null}` (« non nul ») n'ont pas d'équivalent en 3.0.
        if n.is_empty() || is_null_schema(&Value::Object(n.clone())) {
            map.remove("not");
        }
    }
    if let Some(Value::Array(prefix)) = map.remove("prefixItems") {
        map.insert(
            "items".into(),
            prefix
                .into_iter()
                .next()
                .unwrap_or(Value::Object(Map::new())),
        );
    }
    for k in ["exclusiveMinimum", "exclusiveMaximum"] {
        if let Some(n @ Value::Number(_)) = map.get(k).cloned() {
            map.insert(k.into(), Value::Bool(true));
            map.insert(
                if k == "exclusiveMinimum" {
                    "minimum"
                } else {
                    "maximum"
                }
                .into(),
                n,
            );
        }
    }
}

/// progenitor refuse `style: deepObject` : `location={directory}` devient `location[directory]`,
/// exactement ce qu'un client deepObject enverrait.
fn expand_deep_objects(spec: &mut Value) {
    let Some(paths) = spec["paths"].as_object_mut() else {
        return;
    };
    for (_, item) in paths.iter_mut() {
        let Some(ops) = item.as_object_mut() else {
            continue;
        };
        for (_, op) in ops.iter_mut() {
            let Some(params) = op.get_mut("parameters").and_then(Value::as_array_mut) else {
                continue;
            };
            let mut out = Vec::new();
            for prm in params.drain(..) {
                if prm["style"] == "deepObject" {
                    let name = prm["name"].as_str().unwrap_or_default().to_string();
                    if let Some(props) = prm["schema"]["properties"].as_object() {
                        for (prop, schema) in props {
                            let mut schema = schema.clone();
                            if let Some(obj) = schema.as_object_mut() {
                                obj.remove("nullable");
                            }
                            out.push(serde_json::json!({
                                "name": format!("{name}[{prop}]"), "in": "query",
                                "required": false, "schema": schema
                            }));
                        }
                        continue;
                    }
                }
                // Un paramètre facultatif ET `nullable` donnerait `Option<Option<T>>` (en-têtes).
                let mut prm = prm;
                if let Some(schema) = prm.get_mut("schema").and_then(Value::as_object_mut) {
                    schema.remove("nullable");
                }
                out.push(prm);
            }
            *params = out;
        }
    }
}

/// progenitor n'accepte qu'un type par famille de réponses (succès / erreur). OpenCode déclare
/// une erreur typée par code (400, 401, 404, 409…) : on les fusionne en une réponse `4XX`
/// non typée (`serde_json::Value`) et on ne garde que le premier succès.
fn collapse_responses(spec: &mut Value) {
    let Some(paths) = spec["paths"].as_object_mut() else {
        return;
    };
    for (_, item) in paths.iter_mut() {
        let Some(ops) = item.as_object_mut() else {
            continue;
        };
        for (_, op) in ops.iter_mut() {
            let Some(responses) = op.get_mut("responses").and_then(Value::as_object_mut) else {
                continue;
            };
            let mut success: Vec<(String, Value)> = responses
                .iter()
                .filter(|(c, _)| c.starts_with('2'))
                .map(|(c, v)| (c.clone(), v.clone()))
                .collect();
            success.sort_by(|a, b| a.0.cmp(&b.0));
            responses.clear();
            if let Some((code, v)) = success.into_iter().next() {
                responses.insert(code, v);
            }
            responses.insert(
                "4XX".into(),
                serde_json::json!({
                    "description": "Erreur OpenCode (InvalidRequest, Unauthorized, NotFound, Conflict…)",
                    "content": { "application/json": { "schema": { "type": "object" } } }
                }),
            );
        }
    }
}

