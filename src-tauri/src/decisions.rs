//! Décisions locales : un modèle de décision (Laya multilingue, de Convai Innovations, Apache-2.0) lit un texte et
//! répond à des questions typées — un choix parmi des options, un niveau sur une échelle, un oui ou un non — avec la
//! probabilité de chaque réponse. Il ne génère pas de texte : une seule passe, sur cet ordinateur, sans service ni
//! Python. Les pages et les fonctions l’appellent par `ai.decide`.
//!
//! Le modèle (`convaiinnovations/laya-multilingual`, encodeur mmBERT-base et tête de décision, 647 Mo) se
//! télécharge une fois, quand l’utilisateur l’accepte dans Réglages → Général, dans le cache Hugging Face (voir
//! `model_files`).
//! Il tourne en Rust par candle et reproduit le paquet Python `laya` 0.4.35 : même gabarit d’entrée
//! (`[CLS] <type> question: … [SEP] [MASK] option … [SEP] texte [SEP]`), mêmes budgets de jetons, même décodage
//! (température, probabilités, confiance). `decisions_golden.json` garde ses réponses sur douze cas.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use candle_core::{DType, Device, IndexOp, Tensor, D};
use candle_nn::{LayerNorm, Linear, Module};
use serde_json::{json, Map, Value};

use crate::error::{opt_arg, AppError, AppResult};
use crate::model_files::{short_revision, unsupported, Installed, ModelSpec};
use crate::state::AppState;

const MODEL: &str = "convaiinnovations/laya-multilingual";
const MODEL_DIR: &str = "laya-multilingual";
/// Le modèle, à la dernière révision annoncée par la source (voir `model_files`).
const SPEC: ModelSpec = ModelSpec {
    repo: MODEL,
    legacy_dir: MODEL_DIR,
    // Révision que figeaient les versions précédentes d’Alfred (celle du Laya déjà téléchargé dans l’ancien dossier).
    legacy_revision: "92d22143468d8af669dc1a5a0480a2b21b4fe56e",
    files: &["encoder/config.json", "rl_agent_config.json", "tokenizer/tokenizer.json", "model.safetensors"],
};
/// Taille annoncée à l’utilisateur avant le téléchargement, en Mo de 1 024 Ko comme le reste des Réglages
/// (678 201 112 octets en tout).
pub const MODEL_SIZE_MB: u64 = 647;
const MODEL_BYTES: u64 = 678_201_112;
/// Longueur d’une option, en jetons (comme `build_head`).
const OPTION_TOKENS: usize = 48;
const MAX_OPTIONS: usize = 50;
const MAX_QUESTIONS: usize = 20;

fn model_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(format!("Modèle de décision : {error}"))
}

// ---------------------------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Choice,
    Score,
    YesNo,
}

impl Kind {
    /// Nom donné au modèle, et indice de son plongement de type (`QTYPES` du paquet).
    fn laya(self) -> (&'static str, u32) {
        match self {
            Kind::Choice => ("choice", 0),
            Kind::Score => ("score", 1),
            Kind::YesNo => ("noul", 2),
        }
    }
}

/// Une question prête pour le modèle : ses options rendues en texte, dans l’ordre où il les voit.
#[derive(Clone, Debug)]
struct Question {
    kind: Kind,
    instructions: String,
    /// Les libellés rendus à l’appelant (choix) ; vide pour une échelle ou un oui/non.
    labels: Vec<String>,
    options: Vec<String>,
}

/// Un critère en texte : tel quel s’il est une chaîne, sinon en JSON sur une ligne (`render_criterion`).
fn criterion(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => python_json(other),
    }
}

/// JSON écrit comme `json.dumps(..., ensure_ascii=False)` de Python : « , » entre les membres, « : » avant une valeur.
/// Les clés d’un objet sont dans l’ordre alphabétique (celui de `serde_json` dans Alfred).
fn python_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(python_json).collect::<Vec<_>>().join(", ")),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(key, value)| format!("{}: {}", Value::String(key.clone()), python_json(value)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => other.to_string(),
    }
}

fn describe(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(criterion(value)),
    }
}

/// Les choix d’une question `choice` : une liste de libellés, de paires `[libellé, description]` ou d’objets
/// `{ label, description }`, ou un objet libellé → description (rangé alors par ordre alphabétique).
fn choice_entries(id: &str, choices: &Value) -> AppResult<Vec<(String, Option<String>)>> {
    let invalid = || AppError::new(format!("Question « {id} » : `choices` attend une liste de choix."));
    let entries: Vec<(String, Option<String>)> = match choices {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(label) => Ok((label.clone(), None)),
                Value::Array(pair) if !pair.is_empty() && pair.len() <= 2 => {
                    Ok((pair[0].as_str().map(str::to_string).unwrap_or_else(|| criterion(&pair[0])), describe(pair.get(1))))
                }
                Value::Object(map) => {
                    let label = map.get("label").and_then(Value::as_str).ok_or_else(invalid)?;
                    Ok((label.to_string(), describe(map.get("description"))))
                }
                Value::Number(_) | Value::Bool(_) => Ok((item.to_string(), None)),
                _ => Err(invalid()),
            })
            .collect::<AppResult<_>>()?,
        Value::Object(map) => map.iter().map(|(label, description)| (label.clone(), describe(Some(description)))).collect(),
        _ => return Err(invalid()),
    };
    let mut seen = std::collections::HashSet::new();
    for (label, _) in &entries {
        if label.trim().is_empty() || !seen.insert(label.as_str()) {
            return Err(AppError::new(format!("Question « {id} » : chaque choix a un libellé non vide et distinct.")));
        }
    }
    Ok(entries)
}

impl Question {
    /// Lit une question du SDK : `{ type, question, choices }`.
    fn parse(id: &str, definition: &Value) -> AppResult<Self> {
        let kind = match definition.get("type").and_then(Value::as_str).unwrap_or("choice") {
            "choice" => Kind::Choice,
            "score" => Kind::Score,
            "yesno" => Kind::YesNo,
            other => {
                return Err(AppError::new(format!(
                    "Question « {id} » : type « {other} » inconnu (choice, score ou yesno)."
                )))
            }
        };
        let instructions = match definition.get("question") {
            Some(Value::String(text)) if !text.trim().is_empty() => text.clone(),
            _ => return Err(AppError::new(format!("Question « {id} » : `question` est le texte de la question."))),
        };
        let choices = definition.get("choices").filter(|value| !value.is_null());
        let (labels, options) = match kind {
            Kind::Choice => {
                let entries = choice_entries(id, choices.ok_or_else(|| {
                    AppError::new(format!("Question « {id} » : une question à choix donne ses choix (`choices`)."))
                })?)?;
                let options = entries
                    .iter()
                    .map(|(label, description)| match description {
                        Some(description) => format!("{label}: {description}"),
                        None => label.clone(),
                    })
                    .collect();
                (entries.into_iter().map(|(label, _)| label).collect(), options)
            }
            Kind::Score => {
                let levels = choices.and_then(Value::as_array).filter(|levels| !levels.is_empty()).ok_or_else(|| {
                    AppError::new(format!("Question « {id} » : une échelle donne ses niveaux, du plus bas au plus haut (`choices`)."))
                })?;
                (Vec::new(), levels.iter().enumerate().map(|(index, level)| format!("level {index}: {}", criterion(level))).collect())
            }
            Kind::YesNo => {
                let side = |names: [&str; 2]| choices.and_then(|map| describe(names.iter().find_map(|name| map.get(*name))));
                let no = side(["no", "false"]).unwrap_or_else(|| "no, the statement does not hold".into());
                let yes = side(["yes", "true"]).unwrap_or_else(|| "yes, the statement holds".into());
                (Vec::new(), vec![format!("false: {no}"), format!("true: {yes}")])
            }
        };
        if options.is_empty() {
            return Err(AppError::new(format!("Question « {id} » : donnez au moins un choix.")));
        }
        if options.len() > MAX_OPTIONS {
            return Err(AppError::new(format!("Question « {id} » : {MAX_OPTIONS} choix au plus (moins de 20 de préférence).")));
        }
        Ok(Question { kind, instructions, labels, options })
    }
}

/// Les questions d’un appel, dans l’ordre : un objet `{ id: question }` ou une liste de paires `[id, question]`.
fn parse_questions(value: &Value) -> AppResult<Vec<(String, Question)>> {
    let pairs: Vec<(String, &Value)> = match value {
        Value::Object(map) => map.iter().map(|(id, definition)| (id.clone(), definition)).collect(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item.as_array().map(Vec::as_slice) {
                Some([Value::String(id), definition]) => Ok((id.clone(), definition)),
                _ => Err(AppError::new("`questions` attend un objet { identifiant: question }.")),
            })
            .collect::<AppResult<_>>()?,
        _ => return Err(AppError::new("`questions` attend un objet { identifiant: question }.")),
    };
    if pairs.is_empty() || pairs.len() > MAX_QUESTIONS {
        return Err(AppError::new(format!("Une décision pose entre 1 et {MAX_QUESTIONS} questions.")));
    }
    pairs.into_iter().map(|(id, definition)| Ok((id.clone(), Question::parse(&id, definition)?))).collect()
}

#[derive(serde::Deserialize)]
struct Preset {
    name: String,
    field: String,
    questions: Vec<(String, Value)>,
}

/// Les présets du paquet (`laya.presets`), recopiés tels quels : leurs questions sont en anglais, ce que le modèle
/// lit très bien quel que soit la langue du texte.
fn presets() -> &'static [Preset] {
    static PRESETS: OnceLock<Vec<Preset>> = OnceLock::new();
    PRESETS.get_or_init(|| serde_json::from_str(include_str!("decisions_presets.json")).expect("présets de décision"))
}

/// Ce que demande un appel : le texte (l’« état » du paquet) et les questions, dans l’ordre.
struct Request {
    state: Value,
    questions: Vec<(String, Question)>,
    /// Forme simple (`question` + `choices`) : la réponse est celle de l’unique question, sans enveloppe.
    single: bool,
}

fn parse_request(args: &Value) -> AppResult<Request> {
    let state = args.get("text").cloned().unwrap_or(Value::Null);
    let empty = match &state {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        _ => false,
    };
    if empty {
        return Err(AppError::new("`text` est le texte à lire (une chaîne, ou un objet ou une liste de messages)."));
    }
    if let Some(name) = args.get("preset").and_then(Value::as_str) {
        let preset = presets().iter().find(|preset| preset.name == name).ok_or_else(|| {
            let names = presets().iter().map(|preset| preset.name.as_str()).collect::<Vec<_>>().join(", ");
            AppError::new(format!("Préset « {name} » inconnu ({names})."))
        })?;
        // Les questions d’un préset nomment le champ qu’elles lisent (`body`, `message`…) : un texte seul y est rangé.
        let state = if state.is_string() { json!({ preset.field.clone(): state }) } else { state };
        let questions = preset
            .questions
            .iter()
            .map(|(id, definition)| Ok((id.clone(), Question::parse(id, definition)?)))
            .collect::<AppResult<_>>()?;
        return Ok(Request { state, questions, single: false });
    }
    if let Some(questions) = args.get("questions").filter(|value| !value.is_null()) {
        return Ok(Request { state, questions: parse_questions(questions)?, single: false });
    }
    let mut definition = Map::new();
    definition.insert("type".into(), args.get("type").cloned().unwrap_or_else(|| json!("choice")));
    definition.insert("question".into(), args.get("question").cloned().unwrap_or(Value::Null));
    definition.insert("choices".into(), args.get("choices").cloned().unwrap_or(Value::Null));
    let question = Question::parse("decision", &Value::Object(definition))?;
    Ok(Request { state, questions: vec![("decision".into(), question)], single: true })
}

// ---------------------------------------------------------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------------------------------------------------------

struct Tokens {
    tokenizer: tokenizers::Tokenizer,
    cls: u32,
    sep: u32,
    mask: u32,
}

const MASK: &str = "<mask>";

impl Tokens {
    fn load(path: &Path) -> AppResult<Self> {
        let mut tokenizer = tokenizers::Tokenizer::from_file(path).map_err(model_error)?;
        tokenizer.with_padding(None);
        tokenizer.with_truncation(None).map_err(model_error)?;
        let id = |token: &str| tokenizer.token_to_id(token).ok_or_else(|| model_error(format!("jeton {token} absent")));
        let (cls, sep, mask) = (id("<bos>")?, id("<eos>")?, id(MASK)?);
        Ok(Tokens { tokenizer, cls, sep, mask })
    }

    fn encode(&self, text: &str) -> AppResult<Vec<u32>> {
        Ok(self.tokenizer.encode(text, false).map_err(model_error)?.get_ids().to_vec())
    }
}

/// Une séquence prête : ses jetons, la position du `[MASK]` de chaque option, et si le texte a été coupé.
struct Sequence {
    ids: Vec<u32>,
    markers: Vec<usize>,
    truncated: bool,
}

/// `build_head` puis `build_sequence` du paquet (gabarit séquentiel, sans réordonner les options).
fn build_sequence(tokens: &Tokens, state: &[u32], truncate_left: bool, question: &Question, max_len: usize, head_max_len: usize) -> AppResult<Sequence> {
    let (kind, _) = question.kind.laya();
    let mut head = tokens.encode(&format!("{kind} question: {}", question.instructions.replace(MASK, " ")))?;
    let mut options = Vec::with_capacity(question.options.len());
    for option in &question.options {
        let mut ids = vec![tokens.mask];
        let encoded = tokens.encode(&format!(" {}", option.replace(MASK, " ")))?;
        ids.extend(encoded.into_iter().take(OPTION_TOKENS));
        options.push(ids);
    }
    let used = |options: &[Vec<u32>]| options.iter().map(Vec::len).sum::<usize>();
    let mut budget = head_max_len as isize - used(&options) as isize;
    if budget < 16 {
        let per = 4.max(head_max_len.saturating_sub(16) / options.len().max(1));
        for option in &mut options {
            option.truncate(per);
        }
        budget = head_max_len as isize - used(&options) as isize;
    }
    head.truncate(budget.max(8) as usize);
    let mut ids = vec![tokens.cls];
    ids.extend(head);
    ids.push(tokens.sep);
    let mut markers = Vec::with_capacity(options.len());
    for option in options {
        markers.push(ids.len());
        ids.extend(option);
    }
    ids.push(tokens.sep);
    let room = max_len.saturating_sub(ids.len() + 1);
    let kept = if truncate_left { &state[state.len().saturating_sub(room)..] } else { &state[..state.len().min(room)] };
    let truncated = kept.len() < state.len();
    ids.extend_from_slice(kept);
    ids.push(tokens.sep);
    ids.truncate(max_len);
    if markers.iter().any(|&marker| marker >= max_len) {
        return Err(AppError::new("La question et ses choix sont trop longs pour le modèle : raccourcissez-les ou réduisez le nombre de choix."));
    }
    Ok(Sequence { ids, markers, truncated })
}

// ---------------------------------------------------------------------------------------------------------------
// Modèle
// ---------------------------------------------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct EncoderConfig {
    hidden_size: usize,
    num_attention_heads: usize,
    norm_eps: f64,
    local_attention: usize,
    layer_types: Vec<String>,
    rope_parameters: HashMap<String, RopeParameters>,
}

#[derive(serde::Deserialize)]
struct RopeParameters {
    rope_theta: f64,
}

#[derive(serde::Deserialize)]
struct AgentConfig {
    #[serde(default = "default_head_layers")]
    head_layers: usize,
    #[serde(default = "default_max_len")]
    max_len: usize,
    #[serde(default = "default_head_max_len")]
    head_max_len: usize,
    #[serde(default = "default_temperature")]
    temperature: Vec<f64>,
    #[serde(default)]
    temperature_by_options: HashMap<String, f64>,
}

fn default_head_layers() -> usize {
    2
}
fn default_max_len() -> usize {
    512
}
fn default_head_max_len() -> usize {
    192
}
fn default_temperature() -> Vec<f64> {
    vec![1.0; 3]
}

/// `clamp_temperature` du paquet : une température hors de [0,5 ; 5] est ramenée dans l’intervalle.
fn clamp_temperature(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.5, 5.0)
    } else {
        1.0
    }
}

struct EncoderLayer {
    attn_norm: Option<LayerNorm>,
    wqkv: Linear,
    wo: Linear,
    mlp_norm: LayerNorm,
    wi: Linear,
    mlp_wo: Linear,
    sliding: bool,
}

struct HeadLayer {
    norm1: LayerNorm,
    in_proj: Linear,
    out_proj: Linear,
    norm2: LayerNorm,
    linear1: Linear,
    linear2: Linear,
}

/// mmBERT-base (ModernBERT) suivi de la tête de décision de Laya (`DecisionModel` du paquet).
struct Laya {
    device: Device,
    tokens: Tokens,
    /// Gardée en f16 : 256 000 lignes ; seules celles des jetons lus passent en f32.
    embeddings: Tensor,
    embedding_norm: LayerNorm,
    layers: Vec<EncoderLayer>,
    final_norm: LayerNorm,
    heads: usize,
    window: usize,
    rope: [(Tensor, Tensor); 2],
    type_emb: Tensor,
    head: Vec<HeadLayer>,
    scorer_norm: LayerNorm,
    scorer_in: Linear,
    scorer_out: Linear,
    config: AgentConfig,
}

fn rope_tables(theta: f64, head_dim: usize, max_len: usize, device: &Device) -> candle_core::Result<(Tensor, Tensor)> {
    let inv_freq: Vec<f32> = (0..head_dim).step_by(2).map(|i| 1.0 / theta.powf(i as f64 / head_dim as f64) as f32).collect();
    let half = inv_freq.len();
    let inv_freq = Tensor::from_vec(inv_freq, (1, half), &Device::Cpu)?;
    let positions = Tensor::arange(0u32, max_len as u32, &Device::Cpu)?.to_dtype(DType::F32)?.reshape((max_len, 1))?;
    let freqs = positions.matmul(&inv_freq)?;
    Ok((freqs.cos()?.to_device(device)?, freqs.sin()?.to_device(device)?))
}

impl Laya {
    fn load(dir: &Path, device: Device) -> AppResult<Self> {
        let encoder: EncoderConfig = serde_json::from_str(&std::fs::read_to_string(dir.join("encoder/config.json"))?).map_err(model_error)?;
        let config: AgentConfig = serde_json::from_str(&std::fs::read_to_string(dir.join("rl_agent_config.json"))?).map_err(model_error)?;
        let tokens = Tokens::load(&dir.join("tokenizer/tokenizer.json"))?;
        let mut weights = candle_core::safetensors::load(dir.join("model.safetensors"), &device).map_err(model_error)?;
        let embeddings = weights
            .remove("encoder.embeddings.tok_embeddings.weight")
            .ok_or_else(|| model_error("poids des jetons absents"))?
            .to_dtype(DType::F16)
            .map_err(model_error)?;
        let mut take = |name: &str| -> AppResult<Tensor> {
            let tensor = weights.remove(name).ok_or_else(|| model_error(format!("poids {name} absent")))?;
            tensor.to_dtype(DType::F32).map_err(model_error)
        };
        let eps = encoder.norm_eps;
        let linear = |take: &mut dyn FnMut(&str) -> AppResult<Tensor>, name: &str, bias: bool| -> AppResult<Linear> {
            let weight = take(&format!("{name}.weight"))?;
            let bias = if bias { Some(take(&format!("{name}.bias"))?) } else { None };
            Ok(Linear::new(weight, bias))
        };
        let norm = |take: &mut dyn FnMut(&str) -> AppResult<Tensor>, name: &str, bias: bool, eps: f64| -> AppResult<LayerNorm> {
            let weight = take(&format!("{name}.weight"))?;
            Ok(if bias { LayerNorm::new(weight, take(&format!("{name}.bias"))?, eps) } else { LayerNorm::new_no_bias(weight, eps) })
        };
        let mut layers = Vec::with_capacity(encoder.layer_types.len());
        for (index, layer_type) in encoder.layer_types.iter().enumerate() {
            let prefix = format!("encoder.layers.{index}");
            layers.push(EncoderLayer {
                // La première couche n’a pas de normalisation avant l’attention (celle des plongements en tient lieu).
                attn_norm: if index == 0 { None } else { Some(norm(&mut take, &format!("{prefix}.attn_norm"), false, eps)?) },
                wqkv: linear(&mut take, &format!("{prefix}.attn.Wqkv"), false)?,
                wo: linear(&mut take, &format!("{prefix}.attn.Wo"), false)?,
                mlp_norm: norm(&mut take, &format!("{prefix}.mlp_norm"), false, eps)?,
                wi: linear(&mut take, &format!("{prefix}.mlp.Wi"), false)?,
                mlp_wo: linear(&mut take, &format!("{prefix}.mlp.Wo"), false)?,
                sliding: layer_type == "sliding_attention",
            });
        }
        let mut head = Vec::with_capacity(config.head_layers);
        for index in 0..config.head_layers {
            let prefix = format!("head.layers.{index}");
            head.push(HeadLayer {
                norm1: norm(&mut take, &format!("{prefix}.norm1"), true, 1e-5)?,
                in_proj: Linear::new(take(&format!("{prefix}.self_attn.in_proj_weight"))?, Some(take(&format!("{prefix}.self_attn.in_proj_bias"))?)),
                out_proj: linear(&mut take, &format!("{prefix}.self_attn.out_proj"), true)?,
                norm2: norm(&mut take, &format!("{prefix}.norm2"), true, 1e-5)?,
                linear1: linear(&mut take, &format!("{prefix}.linear1"), true)?,
                linear2: linear(&mut take, &format!("{prefix}.linear2"), true)?,
            });
        }
        let embedding_norm = norm(&mut take, "encoder.embeddings.norm", false, eps)?;
        let final_norm = norm(&mut take, "encoder.final_norm", false, eps)?;
        let type_emb = take("type_emb.weight")?;
        let scorer_norm = norm(&mut take, "scorer.0", true, 1e-5)?;
        let scorer_in = linear(&mut take, "scorer.1", true)?;
        let scorer_out = linear(&mut take, "scorer.3", true)?;
        let head_dim = encoder.hidden_size / encoder.num_attention_heads;
        let theta = |kind: &str| encoder.rope_parameters.get(kind).map(|rope| rope.rope_theta).unwrap_or(160_000.0);
        let length = config.max_len.max(1);
        let rope = [rope_tables(theta("full_attention"), head_dim, length, &device).map_err(model_error)?, rope_tables(theta("sliding_attention"), head_dim, length, &device).map_err(model_error)?];
        Ok(Laya {
            device,
            tokens,
            embeddings,
            embedding_norm,
            layers,
            final_norm,
            heads: encoder.num_attention_heads,
            window: encoder.local_attention / 2,
            rope,
            type_emb,
            head,
            scorer_norm,
            scorer_in,
            scorer_out,
            config,
        })
    }

    /// Attention à plusieurs têtes sur (1, L, d) ; `rope` pour l’encodeur, `mask` additif (L, L) facultatif.
    fn attention(&self, q: Tensor, k: Tensor, v: Tensor, rope: Option<&(Tensor, Tensor)>, mask: Option<&Tensor>) -> candle_core::Result<Tensor> {
        let (batch, length, width) = q.dims3()?;
        let head_dim = width / self.heads;
        let split = |t: Tensor| t.reshape((batch, length, self.heads, head_dim))?.transpose(1, 2)?.contiguous();
        let (mut q, mut k, v) = (split(q)?, split(k)?, split(v)?);
        if let Some((cos, sin)) = rope {
            let (cos, sin) = (cos.narrow(0, 0, length)?.contiguous()?, sin.narrow(0, 0, length)?.contiguous()?);
            q = candle_nn::rotary_emb::rope(&q, &cos, &sin)?;
            k = candle_nn::rotary_emb::rope(&k, &cos, &sin)?;
        }
        let mut scores = (q.matmul(&k.t()?)? * (head_dim as f64).powf(-0.5))?;
        if let Some(mask) = mask {
            scores = scores.broadcast_add(mask)?;
        }
        let weights = candle_nn::ops::softmax_last_dim(&scores)?;
        weights.matmul(&v)?.transpose(1, 2)?.reshape((batch, length, width))
    }

    /// Logits des options d’une séquence (avant température).
    fn logits(&self, sequence: &Sequence, kind: Kind) -> candle_core::Result<Vec<f32>> {
        let length = sequence.ids.len();
        let ids = Tensor::new(sequence.ids.as_slice(), &self.device)?;
        let mut h = self.embeddings.index_select(&ids, 0)?.to_dtype(DType::F32)?.unsqueeze(0)?;
        h = self.embedding_norm.forward(&h)?;
        // Fenêtre glissante : un jeton ne voit que ceux à `window` positions au plus (|i − j| ≤ 64).
        let local = if length > self.window + 1 {
            let window = self.window as isize;
            let values: Vec<f32> = (0..length as isize)
                .flat_map(|i| (0..length as isize).map(move |j| if (i - j).abs() > window { f32::NEG_INFINITY } else { 0.0 }))
                .collect();
            Some(Tensor::from_vec(values, (length, length), &self.device)?)
        } else {
            None
        };
        for layer in &self.layers {
            let normed = match &layer.attn_norm {
                Some(norm) => norm.forward(&h)?,
                None => h.clone(),
            };
            let qkv = layer.wqkv.forward(&normed)?;
            let width = h.dim(D::Minus1)?;
            let (q, k, v) = (qkv.narrow(2, 0, width)?, qkv.narrow(2, width, width)?, qkv.narrow(2, 2 * width, width)?);
            let rope = if layer.sliding { &self.rope[1] } else { &self.rope[0] };
            let mask = if layer.sliding { local.as_ref() } else { None };
            let attended = self.attention(q, k, v, Some(rope), mask)?;
            h = (h + layer.wo.forward(&attended)?)?;
            let gated = layer.wi.forward(&layer.mlp_norm.forward(&h)?)?;
            let half = gated.dim(D::Minus1)? / 2;
            let mixed = (gated.narrow(2, 0, half)?.gelu_erf()? * gated.narrow(2, half, half)?)?;
            h = (h + layer.mlp_wo.forward(&mixed)?)?;
        }
        h = self.final_norm.forward(&h)?;
        h = h.broadcast_add(&self.type_emb.i(kind.laya().1 as usize)?)?;
        for layer in &self.head {
            let normed = layer.norm1.forward(&h)?;
            let qkv = layer.in_proj.forward(&normed)?;
            let width = h.dim(D::Minus1)?;
            let (q, k, v) = (qkv.narrow(2, 0, width)?, qkv.narrow(2, width, width)?, qkv.narrow(2, 2 * width, width)?);
            let attended = self.attention(q, k, v, None, None)?;
            h = (h + layer.out_proj.forward(&attended)?)?;
            let hidden = layer.linear1.forward(&layer.norm2.forward(&h)?)?.relu()?;
            h = (h + layer.linear2.forward(&hidden)?)?;
        }
        let positions: Vec<u32> = sequence.markers.iter().map(|&marker| marker as u32).collect();
        let markers = h.i(0)?.index_select(&Tensor::new(positions.as_slice(), &self.device)?, 0)?;
        let scored = self.scorer_out.forward(&self.scorer_in.forward(&self.scorer_norm.forward(&markers)?)?.gelu_erf()?)?;
        scored.squeeze(1)?.to_vec1::<f32>()
    }

    fn temperature(&self, kind: Kind, options: usize) -> f64 {
        let (name, index) = kind.laya();
        let size = match options {
            0..=2 => "2",
            3..=5 => "3-5",
            6..=10 => "6-10",
            _ => "11+",
        };
        let raw = self.config.temperature_by_options.get(&format!("{name}:{size}")).copied().or_else(|| self.config.temperature.get(index as usize).copied()).unwrap_or(1.0);
        clamp_temperature(raw)
    }

    fn decide(&self, request: &Request) -> AppResult<Vec<(String, Answer)>> {
        let serialized = match &request.state {
            Value::String(text) => text.clone(),
            other => python_json(other),
        };
        let state = self.tokens.encode(&serialized.replace(MASK, " "))?;
        // Une conversation (liste) garde ses derniers messages quand elle est trop longue.
        let truncate_left = request.state.is_array();
        let mut answers = Vec::with_capacity(request.questions.len());
        for (id, question) in &request.questions {
            let sequence = build_sequence(&self.tokens, &state, truncate_left, question, self.config.max_len, self.config.head_max_len)?;
            let logits = self.logits(&sequence, question.kind).map_err(model_error)?;
            let temperature = self.temperature(question.kind, logits.len());
            answers.push((id.clone(), Answer::decode(question, &logits, temperature, sequence.truncated)));
        }
        Ok(answers)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------------------------------------------

/// Une réponse décodée comme `_decode_answers` du paquet, avant mise en forme pour le SDK.
#[derive(Debug, Clone)]
struct Answer {
    kind: Kind,
    labels: Vec<String>,
    probabilities: Vec<f64>,
    /// Probabilité de la réponse retenue (`answer_confidence` du paquet).
    confidence: f64,
    /// Concentration de toute la distribution, 1 − H(p)/log k (`confidence` du paquet pour un choix ou une échelle).
    #[cfg_attr(not(test), allow(dead_code))]
    concentration: f64,
    truncated: bool,
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

impl Answer {
    fn decode(question: &Question, logits: &[f32], temperature: f64, truncated: bool) -> Self {
        let scaled: Vec<f64> = logits.iter().map(|&logit| f64::from(logit) / temperature).collect();
        let max = scaled.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let exp: Vec<f64> = scaled.iter().map(|value| (value - max).exp()).collect();
        let sum: f64 = exp.iter().sum();
        let probabilities: Vec<f64> = exp.iter().map(|value| value / sum).collect();
        let k = probabilities.len();
        let confidence = probabilities.iter().copied().fold(0.0, f64::max).clamp(0.0, 1.0);
        let concentration = if k < 2 {
            1.0
        } else {
            let entropy: f64 = -probabilities.iter().map(|p| p * p.clamp(1e-12, 1.0).ln()).sum::<f64>();
            (1.0 - entropy / (k as f64).ln()).clamp(0.0, 1.0)
        };
        Answer { kind: question.kind, labels: question.labels.clone(), probabilities, confidence, concentration, truncated }
    }

    /// Indice de la plus forte probabilité (la première en cas d’égalité, comme `argmax`).
    fn best(&self) -> usize {
        let mut best = 0;
        for (index, value) in self.probabilities.iter().enumerate() {
            if *value > self.probabilities[best] {
                best = index;
            }
        }
        best
    }

    fn expected_level(&self) -> f64 {
        self.probabilities.iter().enumerate().map(|(index, p)| index as f64 * p).sum()
    }

    fn to_json(&self) -> Value {
        let confidence = round4(self.confidence);
        match self.kind {
            Kind::Choice => {
                let probabilities: Map<String, Value> =
                    self.labels.iter().zip(&self.probabilities).map(|(label, p)| (label.clone(), json!(round4(*p)))).collect();
                json!({ "type": "choice", "choice": self.labels[self.best()], "confidence": confidence, "probabilities": probabilities })
            }
            Kind::Score => json!({
                "type": "score",
                "score": round4(self.expected_level()),
                "level": self.best(),
                "confidence": confidence,
                "probabilities": self.probabilities.iter().map(|p| round4(*p)).collect::<Vec<_>>(),
            }),
            Kind::YesNo => {
                let yes = self.probabilities[1];
                json!({ "type": "yesno", "answer": yes >= 0.5, "probability": round4(yes), "confidence": confidence })
            }
        }
    }
}

fn result_json(request: &Request, answers: &[(String, Answer)]) -> Value {
    let truncated = answers.iter().any(|(_, answer)| answer.truncated);
    if request.single {
        let mut value = answers[0].1.to_json();
        if let Some(map) = value.as_object_mut() {
            map.remove("type");
            map.insert("truncated".into(), json!(truncated));
        }
        return value;
    }
    let answers: Map<String, Value> = answers.iter().map(|(id, answer)| (id.clone(), answer.to_json())).collect();
    json!({ "answers": answers, "truncated": truncated })
}

// ---------------------------------------------------------------------------------------------------------------
// État du modèle
// ---------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct ModelState {
    loaded: Option<Arc<Laya>>,
    downloading: Option<(u64, u64)>,
    /// Échec du dernier téléchargement.
    error: Option<String>,
    /// Modèle installé qu’Alfred n’a pas pu charger (format non pris en charge, fichier illisible).
    damaged: Option<String>,
}

fn model_state() -> &'static Mutex<ModelState> {
    static STATE: OnceLock<Mutex<ModelState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ModelState::default()))
}

fn lock() -> AppResult<std::sync::MutexGuard<'static, ModelState>> {
    model_state().lock().map_err(|_| model_error("indisponible"))
}

fn installed(state: &AppState) -> Option<Installed> {
    SPEC.installed(&state.data_dir)
}

/// Où calculer : la carte graphique sur macOS (Metal), sinon le processeur. Sur un Mac, le calcul sur Metal laisse
/// les cœurs libres pour la fenêtre et les autres pages.
fn compute_device() -> Device {
    #[cfg(target_os = "macos")]
    if let Ok(device) = Device::new_metal(0) {
        return device;
    }
    Device::Cpu
}

/// Charge le modèle installé. Un échec veut dire que cette révision a changé de format (configuration, noms de
/// tenseurs) : l’erreur le dit, avec ce qui manque. Les fichiers ont été vérifiés au téléchargement.
fn load_installed(installed: &Installed, device: Device) -> AppResult<Laya> {
    Laya::load(&installed.dir, device).map_err(|error| {
        let detail = error.message.trim_start_matches("Modèle de décision : ").to_string();
        model_error(unsupported(&SPEC, installed, &detail))
    })
}

/// Le tour du modèle : un seul chargement et une seule décision à la fois. Les appels simultanés attendent leur tour,
/// chacun dans son thread bloquant (jamais celui de la fenêtre ni le moteur asynchrone), au lieu de charger chacun
/// 647 Mo ou de se disputer le calcul.
fn turn() -> std::sync::MutexGuard<'static, ()> {
    static TURN: Mutex<()> = Mutex::new(());
    TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn missing_model() -> AppError {
    AppError::new("Les décisions locales ne sont pas encore installées : l’utilisateur télécharge leur modèle dans Réglages → Général.")
}

/// Le modèle chargé ; une erreur claire s’il manque ou s’il est abîmé.
fn model(state: &AppState) -> AppResult<Arc<Laya>> {
    if let Some(loaded) = lock()?.loaded.clone() {
        return Ok(loaded);
    }
    let Some(installed) = installed(state) else {
        return Err(missing_model());
    };
    match load_installed(&installed, compute_device()) {
        Ok(model) => {
            let model = Arc::new(model);
            let mut current = lock()?;
            current.damaged = None;
            current.loaded = Some(model.clone());
            Ok(model)
        }
        Err(error) => {
            lock()?.damaged = Some(error.message.clone());
            state.emit("decisions:changed", Value::Null);
            Err(error)
        }
    }
}

/// Le code du module demande-t-il des décisions (`ai.decide` dans une page, une fonction ou une librairie) ?
fn uses_decisions(dir: &Path) -> bool {
    fn walk(dir: &Path, depth: usize) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        entries.flatten().any(|entry| {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" {
                return false;
            }
            if path.is_dir() {
                return depth > 0 && walk(&path, depth - 1);
            }
            let code = matches!(path.extension().and_then(|ext| ext.to_str()), Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "py" | "sh" | "ps1"));
            code && entry.metadata().is_ok_and(|meta| meta.len() <= 1024 * 1024)
                && std::fs::read_to_string(&path).is_ok_and(|text| text.contains("decide"))
        })
    }
    walk(dir, 4)
}

/// Quand s’ouvre une page d’un module qui demande des décisions : le modèle se charge en arrière-plan et fait une
/// décision à blanc (le calcul sur Metal y prépare ses programmes), si bien que la première vraie décision n’attend
/// pas. Sans effet si le modèle n’est pas installé ou déjà chargé ; jamais sur le thread de l’appelant.
pub fn warm_for_module(state: &Arc<AppState>, module_dir: PathBuf) {
    static WARMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    use std::sync::atomic::Ordering;
    let ready = model_state().lock().is_ok_and(|current| current.loaded.is_some() || current.damaged.is_some() || current.downloading.is_some());
    if ready || installed(state).is_none() || WARMING.swap(true, Ordering::AcqRel) {
        return;
    }
    let state = state.clone();
    let spawned = std::thread::Builder::new().name("decisions-warm".into()).spawn(move || {
        if uses_decisions(&module_dir) {
            let _turn = turn();
            if let Ok(model) = model(&state) {
                if let Ok(request) = parse_request(&json!({ "text": "Bonjour", "type": "yesno", "question": "Est-ce une salutation ?" })) {
                    let _ = model.decide(&request);
                }
            }
        }
        WARMING.store(false, Ordering::Release);
    });
    if spawned.is_err() {
        WARMING.store(false, Ordering::Release);
    }
}

pub fn model_status(state: &AppState) -> Value {
    let current = model_state().lock().ok();
    let downloading = current.as_ref().and_then(|current| current.downloading);
    let error = current.as_ref().and_then(|current| current.error.clone());
    let damaged = current.as_ref().and_then(|current| current.damaged.clone());
    let loaded = current.as_ref().is_some_and(|current| current.loaded.is_some());
    let status = if downloading.is_some() {
        "downloading"
    } else if loaded {
        "ready"
    } else if damaged.is_some() {
        "damaged"
    } else if installed(state).is_some() {
        "ready"
    } else {
        "missing"
    };
    json!({
        "model": MODEL,
        "sizeMb": MODEL_SIZE_MB,
        "status": status,
        "received": downloading.map(|(received, _)| received),
        "total": downloading.map(|(_, total)| total),
        "error": error,
        "damaged": damaged,
        "revision": installed(state).map(|installed| short_revision(&installed.revision)),
    })
}

/// Télécharge la dernière révision du modèle depuis la source des modèles (Hugging Face ou un miroir), fichier par
/// fichier, en vérifiant chacun avec l’empreinte ou la taille que la source annonce.
pub fn download(state: Arc<AppState>) -> AppResult<()> {
    {
        let mut current = lock()?;
        if current.downloading.is_some() {
            return Ok(());
        }
        current.downloading = Some((0, MODEL_BYTES));
        current.error = None;
    }
    tokio::spawn(async move {
        let notified = std::sync::atomic::AtomicU64::new(0);
        let notifier = state.clone();
        let result = crate::model_files::fetch(&SPEC, &state, MODEL_BYTES, model_error, move |received, total| {
            if let Ok(mut current) = model_state().lock() {
                current.downloading = Some((received, total));
            }
            if received >= notified.load(std::sync::atomic::Ordering::Relaxed) + 8 * 1024 * 1024 {
                notified.store(received, std::sync::atomic::Ordering::Relaxed);
                notifier.emit("decisions:changed", Value::Null);
            }
        })
        .await;
        if let Ok(mut current) = model_state().lock() {
            current.downloading = None;
            current.error = result.as_ref().err().map(|error| error.message.clone());
            if result.is_ok() {
                // La révision téléchargée sera chargée au prochain usage.
                current.damaged = None;
                current.loaded = None;
            }
        }
        state.emit("decisions:changed", Value::Null);
    });
    Ok(())
}

pub async fn handle(state: &Arc<AppState>, command: &str, args: &Value) -> Option<AppResult<Value>> {
    match command {
        "decisions.model" => Some(Ok(model_status(state))),
        "decisions.download" => Some(download(state.clone()).map(|()| model_status(state))),
        "frame.ai.decide" => {
            let state = state.clone();
            let args = args.clone();
            let result = tokio::task::spawn_blocking(move || -> AppResult<Value> {
                // Le sujet (page ou fonction) est vérifié par le pont ; la décision ne lit rien de l’espace.
                let _subject: Option<crate::permissions::Subject> = opt_arg(&args, "subject")?;
                let request = parse_request(&args)?;
                let _turn = turn();
                let model = model(&state)?;
                let answers = model.decide(&request)?;
                Ok(result_json(&request, &answers))
            })
            .await
            .unwrap_or_else(|_| Err(AppError::new("La décision a échoué.")));
            Some(result)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_json_matches_json_dumps() {
        let value = json!({ "corps": "Été \"chaud\"\n", "n": [1, 2.5, true, null], "objet": {} });
        assert_eq!(python_json(&value), r#"{"corps": "Été \"chaud\"\n", "n": [1, 2.5, true, null], "objet": {}}"#);
    }

    #[test]
    fn questions_render_like_the_package() {
        let choice = Question::parse("q", &json!({ "question": "Qui ?", "choices": [["a", "premier"], "b", { "label": "c", "description": "" }] })).unwrap();
        assert_eq!(choice.options, ["a: premier", "b", "c"]);
        assert_eq!(choice.labels, ["a", "b", "c"]);
        let score = Question::parse("q", &json!({ "type": "score", "question": "Combien ?", "choices": ["peu", { "x": 1 }] })).unwrap();
        assert_eq!(score.options, ["level 0: peu", "level 1: {\"x\": 1}"]);
        let yesno = Question::parse("q", &json!({ "type": "yesno", "question": "Vrai ?", "choices": { "yes": "oui" } })).unwrap();
        assert_eq!(yesno.options, ["false: no, the statement does not hold", "true: oui"]);
        assert!(Question::parse("q", &json!({ "question": "Qui ?", "choices": ["a", "a"] })).is_err());
        assert!(Question::parse("q", &json!({ "type": "choice", "question": "Qui ?" })).is_err());
        assert!(Question::parse("q", &json!({ "question": "Qui ?", "choices": [] })).is_err());
        assert!(Question::parse("q", &json!({ "question": "Qui ?", "choices": {} })).is_err());
        assert!(Question::parse("q", &json!({ "type": "autre", "question": "Qui ?", "choices": ["a"] })).is_err());
    }

    #[test]
    fn requests_take_a_single_question_a_list_or_a_preset() {
        let single = parse_request(&json!({ "text": "Bonjour", "question": "Quoi ?", "choices": ["a", "b"] })).unwrap();
        assert!(single.single);
        assert_eq!(single.questions.len(), 1);
        let preset = parse_request(&json!({ "text": "Bonjour", "preset": "email" })).unwrap();
        assert_eq!(preset.state, json!({ "body": "Bonjour" }));
        assert_eq!(preset.questions.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["category", "is_spam", "is_phishing", "urgency", "needs_reply"]);
        assert!(parse_request(&json!({ "text": "Bonjour", "preset": "inconnu" })).is_err());
        assert!(parse_request(&json!({ "text": " ", "question": "Quoi ?", "choices": ["a"] })).is_err());
        let listed = parse_request(&json!({ "text": "x", "questions": [["b", { "question": "?", "choices": ["1"] }], ["a", { "type": "yesno", "question": "?" }]] })).unwrap();
        assert_eq!(listed.questions.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn answers_decode_like_the_package() {
        let question = Question::parse("q", &json!({ "question": "?", "choices": ["a", "b", "c"] })).unwrap();
        let answer = Answer::decode(&question, &[2.0, 0.0, 0.0], 1.0, false);
        let p0 = 2f64.exp() / (2f64.exp() + 2.0);
        assert!((answer.confidence - p0).abs() < 1e-9);
        let value = answer.to_json();
        assert_eq!(value["choice"], "a");
        assert_eq!(value["confidence"], json!(round4(p0)));
        let yesno = Question::parse("q", &json!({ "type": "yesno", "question": "?" })).unwrap();
        let value = Answer::decode(&yesno, &[0.0, 1.0], 1.0, false).to_json();
        assert_eq!(value["answer"], true);
        assert_eq!(clamp_temperature(0.1), 0.5);
    }

    #[test]
    fn without_the_model_a_decision_points_to_the_settings() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("data")).unwrap();
        assert_eq!(model_status(&state)["status"], "missing");
        let error = model(&state).err().unwrap();
        assert!(error.message.contains("Réglages → Général"), "{}", error.message);
    }

    #[test]
    fn a_model_in_a_format_alfred_does_not_know_says_so() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("encoder")).unwrap();
        std::fs::create_dir_all(dir.path().join("tokenizer")).unwrap();
        // Une révision plus récente dont la configuration a changé de forme.
        std::fs::write(dir.path().join("encoder/config.json"), r#"{"architecture": "autre"}"#).unwrap();
        for file in ["rl_agent_config.json", "tokenizer/tokenizer.json", "model.safetensors"] {
            std::fs::write(dir.path().join(file), "{}").unwrap();
        }
        let installed = Installed { dir: dir.path().to_path_buf(), revision: "2fa0c067f72703cb90024d119bc7eff361b03d84".into() };
        let Err(error) = load_installed(&installed, Device::Cpu) else { panic!("chargé") };
        assert!(error.message.starts_with("Modèle de décision : la version 2fa0c06 du modèle convaiinnovations/laya-multilingual n’est pas prise en charge par cette version d’Alfred ("), "{}", error.message);
        assert!(error.message.ends_with("Une mise à jour d’Alfred est nécessaire."), "{}", error.message);
        assert!(!error.message.contains("Modèle de décision : la version 2fa0c06 du modèle convaiinnovations/laya-multilingual n’est pas prise en charge par cette version d’Alfred (Modèle"));
    }

    #[test]
    fn a_module_that_asks_for_decisions_is_recognized_by_its_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("pages")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::write(dir.path().join("pages/liste.tsx"), "export default function Page() { return null; }").unwrap();
        std::fs::write(dir.path().join("node_modules/x/index.js"), "ai.decide()").unwrap();
        assert!(!uses_decisions(dir.path()));
        std::fs::write(dir.path().join("pages/tri.tsx"), "const tri = await ai.decide({ text, preset: \"email\" });").unwrap();
        assert!(uses_decisions(dir.path()));
    }

    /// Le vrai modèle, s’il est déjà téléchargé dans `ALFRED_LAYA_DIR` : mêmes décisions que le paquet Python `laya`
    /// 0.4.35 sur les cas de `decisions_golden.json` (même choix, probabilités et confiances à 0,01 près).
    #[test]
    #[ignore]
    fn the_local_model_decides_like_the_python_package() {
        let Ok(dir) = std::env::var("ALFRED_LAYA_DIR") else { return };
        let mut devices = vec![compute_device()];
        if !devices[0].is_cpu() {
            devices.push(Device::Cpu);
        }
        for device in devices {
            eprintln!("— {device:?}");
            decides_like_the_python_package_on(Path::new(&dir), device);
        }
    }

    fn decides_like_the_python_package_on(dir: &Path, device: Device) {
        let started = std::time::Instant::now();
        let model = Laya::load(dir, device).unwrap();
        eprintln!("chargement : {:?}", started.elapsed());
        let single = parse_request(&json!({
            "text": "Bonjour, pouvez-vous m’envoyer la facture de mars avant vendredi ? Merci, Claire",
            "question": "De quoi parle ce message ?",
            "choices": ["facture", "rendez-vous", "réclamation", "autre"],
        }))
        .unwrap();
        for round in 1..=3 {
            let started = std::time::Instant::now();
            model.decide(&single).unwrap();
            eprintln!("décision simple n° {round} : {:?}", started.elapsed());
        }
        let cases: Vec<Value> = serde_json::from_str(include_str!("decisions_golden.json")).unwrap();
        let mut worst = 0f64;
        for case in &cases {
            let name = case["name"].as_str().unwrap();
            let request = Request { state: case["state"].clone(), questions: parse_questions(&case["questions"]).unwrap(), single: false };
            let started = std::time::Instant::now();
            let answers = model.decide(&request).unwrap();
            eprintln!("{name} : {:?}", started.elapsed());
            for (id, answer) in &answers {
                let expected = &case["answers"][id];
                let mut check = |what: &str, got: f64, want: &Value| {
                    let want = want.as_f64().unwrap_or_else(|| panic!("{name}/{id} : {what} absent"));
                    worst = worst.max((got - want).abs());
                    assert!((got - want).abs() <= 0.01, "{name}/{id} : {what} = {got}, le paquet donne {want}");
                };
                check("answer_confidence", answer.confidence, &expected["answer_confidence"]);
                check("confidence", if answer.kind == Kind::YesNo { answer.confidence } else { answer.concentration }, &expected["confidence"]);
                match answer.kind {
                    Kind::Choice => {
                        assert_eq!(answer.labels[answer.best()], expected["choice"].as_str().unwrap(), "{name}/{id}");
                        for (label, p) in answer.labels.iter().zip(&answer.probabilities) {
                            check(label, *p, &expected["probabilities"][label]);
                        }
                    }
                    Kind::Score => {
                        check("score", answer.expected_level(), &expected["score"]);
                        for (index, p) in answer.probabilities.iter().enumerate() {
                            check("probabilité", *p, &expected["probabilities"][index.to_string()]);
                        }
                    }
                    Kind::YesNo => check("noul", answer.probabilities[1], &expected["noul"]),
                }
            }
        }
        eprintln!("plus grand écart avec le paquet Python : {worst}");
    }
}
