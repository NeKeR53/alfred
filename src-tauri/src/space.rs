//! L’espace : le dossier où vit l’application que l’utilisateur construit. Tout y est rangé par module ; la
//! navigation affichée est calculée à partir des manifestes des modules et des réglages de l’espace.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
pub use crate::scripts::Runtime;
use crate::transpile::{self, Diagnostic};

pub const SPACE_FILE: &str = "alfred.json";
pub const MODULE_FILE: &str = "module.json";
pub const MODULES_DIR: &str = "modules";
pub const CLIENTS_DIR: &str = "clients";
/// Données locales de l’espace (base SQLite) : jamais versionnées.
pub const LOCAL_DIR: &str = ".alfred";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SpaceManifest {
    pub name: String,
    /// Couleur d’accent choisie par l’utilisateur ; `None` garde celle d’Alfred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    pub layout: Layout,
    /// Client demandé par un module (`module/client`) → client déclaré dans l’espace.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub bindings: BTreeMap<String, String>,
}

/// Réorganisation faite par l’utilisateur. Elle ne touche jamais aux modules, donc s’applique aussi à ceux qui
/// sont installés en lecture seule.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub sections: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub tabs: BTreeMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<String>,
    /// Clés `module:<module>`, `section:<id>` et `page:<module>/<page>`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub overrides: BTreeMap<String, Override>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Override {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModuleManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// Modules dont celui-ci utilise les fonctions et les clients.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<Requirement>,
    /// Présent quand le module vient d’un marketplace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<SectionDecl>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<PageDecl>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub functions: Vec<FunctionDecl>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub clients: Vec<ClientNeed>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub webhooks: Vec<WebhookDecl>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub schedules: Vec<ScheduleDecl>,
    /// Parcours de configuration proposé après l’installation (texte d’accueil).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<SetupDecl>,
}

/// Ce que le module dit à l’utilisateur au début du parcours de configuration. Les étapes suivent l’ordre de
/// `clients`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SetupDecl {
    /// Texte d’accueil, en mots simples : ce que fait le module et ce qu’il faudra avoir sous la main.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub welcome: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Origin {
    pub marketplace: String,
    pub version: String,
    pub commit: String,
    /// Détaché : devenu un module local modifiable, qui ne reçoit plus les mises à jour.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub detached: bool,
    /// Figé : les mises à jour sont signalées mais jamais proposées dans « Tout mettre à jour ».
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
}

impl ModuleManifest {
    pub fn read_only(&self) -> bool {
        self.origin.as_ref().is_some_and(|origin| !origin.detached)
    }

    /// Le module déclare-t-il dépendre de `module` ?
    pub fn requires_module(&self, module: &str) -> bool {
        self.requires.iter().any(|requirement| requirement.module == module)
    }
}

/// Dépendance d’un module : il appelle les fonctions de `module` et se sert de ses clients sans demander d’accord,
/// et ne fonctionne pas sans lui.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Requirement {
    pub module: String,
    /// Version minimale, « majeur.mineur.correctif ».
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
}

impl Requirement {
    /// La version `version` convient-elle ? Une version illisible ne convient qu’à une dépendance sans minimum.
    pub fn accepts(&self, version: &str) -> bool {
        match self.min_version.as_deref().map(str::trim).filter(|min| !min.is_empty()) {
            None => true,
            Some(min) => match (parse_version(version), parse_version(min)) {
                (Some(version), Some(min)) => version >= min,
                _ => false,
            },
        }
    }

    pub fn describe(&self) -> String {
        match self.min_version.as_deref().filter(|min| !min.trim().is_empty()) {
            Some(min) => format!("« {} » v{} ou plus", self.module, min.trim()),
            None => format!("« {} »", self.module),
        }
    }
}

/// Version « majeur.mineur.correctif » ; les composantes absentes valent zéro.
pub fn parse_version(text: &str) -> Option<[u64; 3]> {
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let mut parts = [0u64; 3];
    for (index, piece) in text.split('.').enumerate() {
        if index == 3 || piece.is_empty() || !piece.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        parts[index] = piece.parse().ok()?;
    }
    Some(parts)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SectionDecl {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Besoin client du module (`jira`, ou `dépendance/besoin`) : la section est répétée pour chaque instance du
    /// client qui y répond, et ses pages appellent cette instance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_instance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Placement {
    /// Onglet d’une section ; `section` vaut `module/section`, ou `section` seul pour une section du même module.
    Tab { section: String },
    /// Panneau de droite d’une page (`module/page`).
    Panel { page: String },
    /// Onglet des Réglages.
    Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageDecl {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub placement: Placement,
    #[serde(default, skip_serializing_if = "Uses::is_empty")]
    pub uses: Uses,
}

/// Ce dont une page ou une fonction déclare avoir besoin. L’accès n’est accordé que par l’utilisateur.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Uses {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub clients: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub functions: Vec<String>,
}

impl Uses {
    fn is_empty(&self) -> bool {
        self.clients.is_empty() && self.functions.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FunctionDecl {
    pub id: String,
    pub description: String,
    /// Schémas JSON de l’entrée et de la sortie.
    pub input: Value,
    pub output: Value,
    /// Proposée aux agents comme outil.
    pub tool: bool,
    #[serde(skip_serializing_if = "Uses::is_empty")]
    pub uses: Uses,
    /// Langage : TypeScript (par défaut, exécuté dans l’interface) ou un script (bash, pwsh, python) lancé par Rust.
    #[serde(skip_serializing_if = "Runtime::is_ts")]
    pub runtime: Runtime,
    /// Ce que fait la fonction chez le service : lire (`read`) ou modifier (`write`). Absent, elle compte comme
    /// une écriture : ses tests ne se lancent jamais d’office.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<Effect>,
    /// Cas de test : une entrée d’exemple et ce que la sortie doit montrer.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<FunctionTest>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Effect {
    Read,
    Write,
}

/// Cas de test d’une fonction. Ceux d’une fonction de lecture se lancent d’office (bouton « Tout vérifier »,
/// outil `check`) ; ceux d’une écriture attendent l’accord de l’utilisateur, sur la cible qu’il choisit.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FunctionTest {
    /// Ce que vérifie le test, en mots simples ; identifie le test dans la fonction.
    pub name: String,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<TestTarget>,
    pub expect: Expect,
}

/// Cible d’un test d’écriture : l’utilisateur la saisit (un ticket de test…) et elle remplace `input[field]`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TestTarget {
    /// Chemin dans l’entrée (`issue`, `filter.project`).
    pub field: String,
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub hint: String,
}

/// Ce que la sortie doit montrer. Les chemins s’écrivent `issues.0.key` ; `""` désigne la sortie elle-même.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Expect {
    /// Conforme au schéma `output` de la fonction (vrai par défaut).
    pub schema: bool,
    /// Chemins présents et non nuls.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub has: Vec<String>,
    /// Chemins vers une liste, un texte ou un objet non vide.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub non_empty: Vec<String>,
    /// Valeurs attendues, chemin par chemin.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub equals: BTreeMap<String, Value>,
}

impl Default for Expect {
    fn default() -> Self {
        Expect { schema: true, has: Vec::new(), non_empty: Vec::new(), equals: BTreeMap::new() }
    }
}

impl FunctionDecl {
    /// Fichier de la fonction dans `functions/` : `<id>.ts`, `.sh`, `.ps1` ou `.py` selon son langage.
    pub fn file_name(&self) -> String {
        format!("{}.{}", self.id, self.runtime.extension())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientNeed {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Type d’authentification attendu : `bearer`, `apiKey`, `basic`, `oauth2`, `clientCredentials`, `none`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// Aide du parcours de configuration : où trouver la clé, quel compte utiliser.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub help: String,
    /// Le module fonctionne sans ce service : le parcours permet de passer l’étape.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    /// Modèle du service, de la forme de `clients/<id>.json` sans secret ni instance : le parcours de
    /// configuration le crée tel quel, l’utilisateur n’ajoute que son compte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WebhookDecl {
    pub id: String,
    pub description: String,
    pub function: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleDecl {
    pub id: String,
    pub description: String,
    pub function: String,
    /// Intervalle en minutes ; exclusif avec `at`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_minutes: Option<u32>,
    /// Heure locale « HH:MM », une fois par jour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub input: Value,
}

// ---------------------------------------------------------------------------------------------------------------
// Vue calculée pour l’interface
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    pub name: String,
    pub accent: Option<String>,
    pub sections: Vec<ResolvedSection>,
    pub settings_pages: Vec<ResolvedPage>,
    pub modules: Vec<ModuleSummary>,
    pub functions: Vec<ResolvedFunction>,
    pub bindings: BTreeMap<String, String>,
    pub problems: Vec<Problem>,
    /// Réorganisation enregistrée par l’utilisateur, que l’interface modifie puis renvoie en entier.
    pub layout: Layout,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSection {
    pub id: String,
    pub module: String,
    pub label: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub hidden: bool,
    pub pages: Vec<ResolvedPage>,
    /// Besoin client dont la section suit les instances (`perInstance` du module).
    pub per_instance: Option<String>,
    /// Instance que montre cette copie de la section ; son identifiant est alors `module/section@instance`.
    pub instance: Option<String>,
    /// Section déclarée dont celle-ci est la copie pour une instance.
    pub instance_of: Option<String>,
    /// Section par instance qui n’a encore aucune instance à montrer : ce qu’il faut faire.
    pub waiting: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPage {
    /// `module/page`.
    pub reference: String,
    pub module: String,
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub description: String,
    pub hidden: bool,
    pub read_only: bool,
    /// Le fichier de la page n’existe pas encore : l’agent est en train de l’écrire.
    pub missing: bool,
    pub errors: Vec<Diagnostic>,
    pub uses: Uses,
    /// Panneau de droite déclaré pour cette page.
    pub panel: Option<Box<ResolvedPage>>,
    /// Instance du client que montre cette page, dans une section par instance ; sa référence est alors
    /// `module/page@instance`.
    pub instance: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub read_only: bool,
    pub origin: Option<Origin>,
    /// Masqué par l’utilisateur (ou installé comme dépendance) : ses sections et ses pages quittent le menu.
    pub hidden: bool,
    pub requires: Vec<Requirement>,
    /// Modules de l’espace qui dépendent de celui-ci.
    pub required_by: Vec<String>,
    pub pages: usize,
    pub functions: usize,
    pub clients: Vec<ClientNeed>,
    pub webhooks: Vec<WebhookDecl>,
    pub schedules: Vec<ScheduleDecl>,
    pub setup: Option<SetupDecl>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFunction {
    /// `module/fonction`.
    pub reference: String,
    pub module: String,
    pub id: String,
    pub description: String,
    pub input: Value,
    pub output: Value,
    pub tool: bool,
    pub missing: bool,
    pub errors: Vec<Diagnostic>,
    pub uses: Uses,
    pub runtime: Runtime,
    pub effect: Option<Effect>,
    pub tests: Vec<FunctionTest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub module: String,
    pub message: String,
}

/// Emplacement demandé pour une nouvelle page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlaceTarget {
    /// Nouvelle entrée du menu de gauche : crée un module local et sa section.
    Menu {
        label: String,
        #[serde(default)]
        icon: Option<String>,
        #[serde(default)]
        color: Option<String>,
    },
    Tab { section: String },
    Panel { page: String },
    Settings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedPage {
    pub module: String,
    pub page: String,
    pub reference: String,
    /// Chemin absolu du fichier que l’agent doit écrire.
    pub file: String,
    pub module_dir: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Identifiants et chemins
// ---------------------------------------------------------------------------------------------------------------

/// Identifiant sûr pour un dossier et une URL : minuscules ASCII, chiffres et tirets.
pub fn slug(text: &str) -> String {
    let mut slug = String::new();
    for character in text.chars() {
        let mapped = match character {
            'a'..='z' | '0'..='9' => Some(character),
            'A'..='Z' => Some(character.to_ascii_lowercase()),
            'à' | 'â' | 'ä' | 'á' | 'ã' | 'À' | 'Â' | 'Ä' => Some('a'),
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => Some('e'),
            'î' | 'ï' | 'í' | 'Î' | 'Ï' => Some('i'),
            'ô' | 'ö' | 'ó' | 'Ô' | 'Ö' => Some('o'),
            'ù' | 'û' | 'ü' | 'ú' | 'Ù' | 'Û' | 'Ü' => Some('u'),
            'ç' | 'Ç' => Some('c'),
            _ => None,
        };
        match mapped {
            Some(character) => slug.push(character),
            None if !slug.is_empty() && !slug.ends_with('-') => slug.push('-'),
            None => {}
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "element".to_string()
    } else {
        slug
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.starts_with('-')
        && !windows_reserved(id)
}

/// Noms que Windows réserve à des périphériques (`con`, `nul`, `com1`…), avec ou sans extension : un dossier ou un
/// fichier de ce nom ne peut pas y être créé. Refusés partout, pour qu’un espace reste ouvrable sur tout poste.
pub fn windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ').to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

fn check_id(kind: &str, id: &str) -> AppResult<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(AppError::new(format!(
            "Identifiant de {kind} invalide : « {id} ». Utiliser des minuscules, des chiffres et des tirets."
        )))
    }
}

#[derive(Debug, Clone)]
pub struct Space {
    pub root: PathBuf,
}

impl Space {
    pub fn modules_dir(&self) -> PathBuf {
        self.root.join(MODULES_DIR)
    }

    pub fn module_dir(&self, module: &str) -> PathBuf {
        self.modules_dir().join(module)
    }

    pub fn local_dir(&self) -> PathBuf {
        self.root.join(LOCAL_DIR)
    }

    pub fn page_file(&self, module: &str, page: &str) -> PathBuf {
        self.module_dir(module).join("pages").join(format!("{page}.tsx"))
    }

    /// Fichier d’une fonction déclarée.
    pub fn function_path(&self, module: &str, function: &FunctionDecl) -> PathBuf {
        self.module_dir(module).join("functions").join(function.file_name())
    }

    /// Fichier d’une fonction désignée par son identifiant : son langage est lu dans le manifeste du module (une
    /// fonction non déclarée est supposée en TypeScript).
    pub fn function_file(&self, module: &str, function: &str) -> PathBuf {
        let runtime = self
            .module(module)
            .ok()
            .and_then(|manifest| manifest.functions.into_iter().find(|declared| declared.id == function))
            .map(|declared| declared.runtime)
            .unwrap_or_default();
        self.module_dir(module).join("functions").join(format!("{function}.{}", runtime.extension()))
    }

    /// Crée un espace vide dans `root`, ou ouvre celui qui s’y trouve déjà.
    pub fn open_or_create(root: &Path, name: Option<&str>) -> AppResult<Self> {
        fs::create_dir_all(root.join(MODULES_DIR))?;
        fs::create_dir_all(root.join(CLIENTS_DIR))?;
        fs::create_dir_all(root.join(LOCAL_DIR))?;
        let space = Self { root: root.to_path_buf() };
        if !root.join(SPACE_FILE).exists() {
            let default_name = root.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
            space.write_manifest(&SpaceManifest {
                name: name.map(str::to_string).unwrap_or(default_name),
                ..SpaceManifest::default()
            })?;
        }
        let ignore = root.join(".gitignore");
        if !ignore.exists() {
            fs::write(&ignore, format!("{LOCAL_DIR}/\n.DS_Store\n"))?;
        }
        crate::git::init(root)?;
        Ok(space)
    }

    pub fn manifest(&self) -> AppResult<SpaceManifest> {
        let text = fs::read_to_string(self.root.join(SPACE_FILE))?;
        serde_json::from_str(&text)
            .map_err(|error| AppError::new(format!("Le fichier {SPACE_FILE} de l’espace est illisible : {error}")))
    }

    pub fn write_manifest(&self, manifest: &SpaceManifest) -> AppResult<()> {
        write_json(&self.root.join(SPACE_FILE), manifest)
    }

    pub fn module_ids(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.modules_dir()) else { return Vec::new() };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.path().join(MODULE_FILE).is_file())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|id| valid_id(id))
            .collect();
        ids.sort();
        ids
    }

    pub fn module(&self, id: &str) -> AppResult<ModuleManifest> {
        check_id("module", id)?;
        let path = self.module_dir(id).join(MODULE_FILE);
        let text =
            fs::read_to_string(&path).map_err(|_| AppError::new(format!("Le module « {id} » n’existe pas.")))?;
        let mut manifest: ModuleManifest = serde_json::from_str(&text)
            .map_err(|error| AppError::new(format!("Le manifeste du module « {id} » est illisible : {error}")))?;
        // Le dossier fait foi : un manifeste recopié à la main ne peut pas usurper un autre module.
        manifest.id = id.to_string();
        Ok(manifest)
    }

    pub fn write_module(&self, manifest: &ModuleManifest) -> AppResult<()> {
        check_id("module", &manifest.id)?;
        let dir = self.module_dir(&manifest.id);
        fs::create_dir_all(dir.join("pages"))?;
        write_json(&dir.join(MODULE_FILE), manifest)
    }

    fn writable_module(&self, id: &str) -> AppResult<ModuleManifest> {
        let manifest = self.module(id)?;
        if manifest.read_only() {
            return Err(AppError::new(format!(
                "Le module « {} » est installé depuis un marketplace et ne se modifie pas sur place. Le détacher pour l’adapter.",
                manifest.name
            )));
        }
        Ok(manifest)
    }

    fn unique_module_id(&self, wanted: &str) -> String {
        let existing: BTreeSet<String> = self.module_ids().into_iter().collect();
        if !existing.contains(wanted) {
            return wanted.to_string();
        }
        (2..).map(|index| format!("{wanted}-{index}")).find(|id| !existing.contains(id)).unwrap_or_default()
    }

    /// Module local où ranger ce qu’on ajoute à un module en lecture seule.
    fn companion_module(&self, owner: &ModuleManifest) -> AppResult<ModuleManifest> {
        let id = format!("{}-ajouts", owner.id);
        if let Ok(existing) = self.module(&id) {
            return Ok(existing);
        }
        let manifest = ModuleManifest {
            id,
            name: format!("{} (ajouts)", owner.name),
            version: "0.1.0".to_string(),
            description: format!("Pages ajoutées localement au module {}.", owner.name),
            ..ModuleManifest::default()
        };
        self.write_module(&manifest)?;
        Ok(manifest)
    }

    /// Enregistre une page à l’emplacement demandé et renvoie le fichier à écrire. Le rangement par module suit
    /// l’emplacement : une entrée de menu crée un module, un onglet ou un panneau rejoint le module de sa cible.
    pub fn place_page(
        &self,
        title: &str,
        icon: Option<String>,
        description: &str,
        target: &PlaceTarget,
        module_hint: Option<&str>,
    ) -> AppResult<PlacedPage> {
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::new("La page doit avoir un titre."));
        }
        let (mut module, placement) = match target {
            PlaceTarget::Menu { label, icon: section_icon, color } => {
                let label = if label.trim().is_empty() { title } else { label.trim() };
                let id = self.unique_module_id(&slug(label));
                let module = ModuleManifest {
                    id,
                    name: label.to_string(),
                    version: "0.1.0".to_string(),
                    sections: vec![SectionDecl {
                        id: "principal".to_string(),
                        label: label.to_string(),
                        icon: section_icon.clone(),
                        color: color.clone(),
                        per_instance: None,
                    }],
                    ..ModuleManifest::default()
                };
                (module, Placement::Tab { section: "principal".to_string() })
            }
            PlaceTarget::Tab { section } => {
                let (owner_id, section_id) = section
                    .split_once('/')
                    .ok_or_else(|| AppError::new("La section doit être désignée par « module/section »."))?;
                let owner = self.module(owner_id)?;
                if !owner.sections.iter().any(|declared| declared.id == section_id) {
                    return Err(AppError::new(format!("La section « {section} » n’existe pas.")));
                }
                if owner.read_only() {
                    (self.companion_module(&owner)?, Placement::Tab { section: section.clone() })
                } else {
                    (owner, Placement::Tab { section: section_id.to_string() })
                }
            }
            PlaceTarget::Panel { page } => {
                let (owner_id, page_id) = page
                    .split_once('/')
                    .ok_or_else(|| AppError::new("La page hôte doit être désignée par « module/page »."))?;
                let owner = self.module(owner_id)?;
                if !owner.pages.iter().any(|declared| declared.id == page_id) {
                    return Err(AppError::new(format!("La page « {page} » n’existe pas.")));
                }
                if self.panel_of(page)?.is_some() {
                    return Err(AppError::new(format!(
                        "La page « {page} » a déjà un panneau de droite. Le supprimer ou le modifier plutôt que d’en créer un second."
                    )));
                }
                let module = if owner.read_only() { self.companion_module(&owner)? } else { owner };
                (module, Placement::Panel { page: page.clone() })
            }
            PlaceTarget::Settings => {
                let module = match module_hint {
                    Some(id) => self.writable_module(id)?,
                    None => {
                        let id = self.unique_module_id(&slug(title));
                        ModuleManifest {
                            id,
                            name: title.to_string(),
                            version: "0.1.0".to_string(),
                            ..ModuleManifest::default()
                        }
                    }
                };
                (module, Placement::Settings)
            }
        };

        let base = slug(title);
        let page_id = (1..)
            .map(|index| if index == 1 { base.clone() } else { format!("{base}-{index}") })
            .find(|id| !module.pages.iter().any(|page| &page.id == id))
            .unwrap_or_default();
        module.pages.push(PageDecl {
            id: page_id.clone(),
            title: title.to_string(),
            icon,
            description: description.trim().to_string(),
            placement,
            uses: Uses::default(),
        });
        self.write_module(&module)?;
        Ok(PlacedPage {
            reference: format!("{}/{page_id}", module.id),
            file: self.page_file(&module.id, &page_id).to_string_lossy().to_string(),
            module_dir: self.module_dir(&module.id).to_string_lossy().to_string(),
            module: module.id,
            page: page_id,
        })
    }

    fn panel_of(&self, page_reference: &str) -> AppResult<Option<String>> {
        for id in self.module_ids() {
            let Ok(module) = self.module(&id) else { continue };
            for page in &module.pages {
                if matches!(&page.placement, Placement::Panel { page: host } if host == page_reference) {
                    return Ok(Some(format!("{id}/{}", page.id)));
                }
            }
        }
        Ok(None)
    }

    /// Supprime une page : son entrée du manifeste et son fichier. Un module resté sans page ni fonction disparaît.
    pub fn delete_page(&self, reference: &str) -> AppResult<()> {
        let (module_id, page_id) =
            reference.split_once('/').ok_or_else(|| AppError::new("Page désignée par « module/page » attendue."))?;
        let mut module = self.writable_module(module_id)?;
        let before = module.pages.len();
        module.pages.retain(|page| page.id != page_id);
        if module.pages.len() == before {
            return Err(AppError::new(format!("La page « {reference} » n’existe pas.")));
        }
        let _ = fs::remove_file(self.page_file(module_id, page_id));
        // Le dossier ne disparaît que s’il ne porte plus rien : ni tables, ni code partagé, ni déclarations.
        let dir = self.module_dir(module_id);
        let empty = module.pages.is_empty()
            && module.functions.is_empty()
            && module.webhooks.is_empty()
            && module.schedules.is_empty()
            && module.clients.is_empty()
            && !dir.join("migrations").exists()
            && !dir.join("lib").exists();
        if empty {
            fs::remove_dir_all(dir)?;
        } else {
            self.write_module(&module)?;
        }
        let mut manifest = self.manifest()?;
        manifest.layout.overrides.remove(&format!("page:{reference}"));
        for pages in manifest.layout.tabs.values_mut() {
            pages.retain(|page| page != reference);
        }
        manifest.layout.settings.retain(|page| page != reference);
        self.write_manifest(&manifest)
    }

    /// Modules de l’espace qui déclarent dépendre de `module`.
    pub fn dependents(&self, module: &str) -> Vec<String> {
        self.module_ids()
            .into_iter()
            .filter(|id| id != module)
            .filter(|id| self.module(id).is_ok_and(|manifest| manifest.requires_module(module)))
            .collect()
    }

    /// Masque ou réaffiche un module (`module:<id>`), une section (`section:<module>/<section>`) ou une page
    /// (`page:<module>/<page>`) dans le menu, sans rien supprimer. Renvoie la phrase qui décrit le changement, ou
    /// `None` s’il n’y avait rien à changer.
    pub fn set_visibility(&self, target: &str, hidden: bool) -> AppResult<Option<String>> {
        let (kind, reference) = target.split_once(':').ok_or_else(|| {
            AppError::new("Cible attendue : « module:<module> », « section:<module>/<section> » ou « page:<module>/<page> ».")
        })?;
        let what = match kind {
            "module" => {
                let module = self.module(reference)?;
                format!("du module {}", if module.name.is_empty() { &module.id } else { &module.name })
            }
            "section" | "page" => {
                let (module_id, id) = reference
                    .split_once('/')
                    .ok_or_else(|| AppError::new(format!("La {kind} doit être désignée par « module/{kind} ».")))?;
                let module = self.module(module_id)?;
                // `@instance` désigne la copie d’une section par instance (ou de l’une de ses pages).
                let (id, instance) = match id.split_once('@') {
                    Some((id, instance)) if valid_id(instance) => (id, Some(instance)),
                    _ => (id, None),
                };
                let label = if kind == "section" {
                    module.sections.iter().find(|section| section.id == id).map(|section| section.label.clone())
                } else {
                    module.pages.iter().find(|page| page.id == id).map(|page| page.title.clone())
                };
                let label =
                    label.ok_or_else(|| AppError::new(format!("La {kind} « {reference} » n’existe pas.")))?;
                match instance {
                    Some(instance) => format!("de la {kind} {label} pour l’instance {instance}"),
                    None => format!("de la {kind} {label}"),
                }
            }
            _ => return Err(AppError::new(format!("Type de cible inconnu : « {kind} ». Attendu : module, section ou page."))),
        };
        let mut manifest = self.manifest()?;
        let entry = manifest.layout.overrides.entry(target.to_string()).or_default();
        if entry.hidden == hidden {
            return Ok(None);
        }
        entry.hidden = hidden;
        if *entry == Override::default() {
            manifest.layout.overrides.remove(target);
        }
        self.write_manifest(&manifest)?;
        Ok(Some(format!("{} {what}", if hidden { "Masquage" } else { "Réaffichage" })))
    }

    /// Remplace chaque section par instance par une copie pour chaque instance du client qu’elle suit. Sans
    /// instance (ou sans client), la section reste seule et dit quoi faire.
    fn expand_instances(
        &self,
        sections: Vec<ResolvedSection>,
        manifest: &SpaceManifest,
        problems: &mut Vec<Problem>,
    ) -> Vec<ResolvedSection> {
        let overrides = &manifest.layout.overrides;
        let mut expanded = Vec::new();
        for section in sections {
            let Some(need) = section.per_instance.clone() else {
                expanded.push(section);
                continue;
            };
            let declared = self
                .module(&section.module)
                .is_ok_and(|module| need.contains('/') || module.clients.iter().any(|client| client.id == need));
            if !declared {
                problems.push(Problem {
                    module: section.module.clone(),
                    message: format!(
                        "La section « {} » suit les instances de « {need} », que le module ne déclare pas dans `clients`.",
                        section.id
                    ),
                });
            }
            match crate::clients::client_for(self, &section.module, &need) {
                Ok(client) if !client.instances.is_empty() => {
                    for instance in &client.instances {
                        let id = format!("{}@{}", section.id, instance.id);
                        let own = overrides.get(&format!("section:{id}"));
                        let mut copy = section.clone();
                        copy.label = own
                            .and_then(|o| o.label.clone())
                            .unwrap_or_else(|| format!("{} — {}", section.label, instance.display_label()));
                        copy.icon = own.and_then(|o| o.icon.clone()).or_else(|| section.icon.clone());
                        copy.color = own.and_then(|o| o.color.clone()).or_else(|| section.color.clone());
                        copy.hidden = section.hidden || own.is_some_and(|o| o.hidden);
                        copy.pages =
                            section.pages.iter().map(|page| page_for_instance(page, &instance.id, overrides)).collect();
                        copy.instance = Some(instance.id.clone());
                        copy.instance_of = Some(section.id.clone());
                        copy.id = id;
                        expanded.push(copy);
                    }
                }
                Ok(client) => expanded.push(ResolvedSection {
                    waiting: Some(format!(
                        "Le service « {} » n’a encore aucun compte. En ajouter un dans Réglages → Modules, fiche du module : cette section apparaîtra pour chacun.",
                        client.label
                    )),
                    ..section
                }),
                Err(error) => expanded.push(ResolvedSection { waiting: Some(error.message), ..section }),
            }
        }
        expanded
    }

    /// Calcule la navigation affichée et l’état de compilation de chaque page et fonction.
    pub fn snapshot(&self) -> AppResult<Snapshot> {
        let manifest = self.manifest()?;
        let mut problems = Vec::new();
        let mut modules = Vec::new();
        for id in self.module_ids() {
            match self.module(&id) {
                Ok(module) => modules.push(module),
                Err(error) => problems.push(Problem { module: id, message: error.message }),
            }
        }

        problems.extend(dependency_problems(&modules));
        let module_hidden =
            |module: &str| manifest.layout.overrides.get(&module_key(module)).is_some_and(|o| o.hidden);
        let page_override = |reference: &str| manifest.layout.overrides.get(&format!("page:{reference}"));
        let mut pages: Vec<(ResolvedPage, Placement)> = Vec::new();
        let libraries = |module: &str| crate::libraries::entries(&self.module_dir(module));
        for module in &modules {
            for page in &module.pages {
                let reference = format!("{}/{}", module.id, page.id);
                let overridden = page_override(&reference);
                let file = self.page_file(&module.id, &page.id);
                let (missing, errors) = match fs::read_to_string(&file) {
                    Ok(source) => (false, transpile::transpile_in(&source, "page.tsx", 1, &libraries(&module.id)).err().unwrap_or_default()),
                    Err(_) => (true, Vec::new()),
                };
                let placement = overridden
                    .and_then(|overridden| overridden.placement.clone())
                    .unwrap_or_else(|| qualify(&page.placement, &module.id));
                let resolved = ResolvedPage {
                    module: module.id.clone(),
                    id: page.id.clone(),
                    title: overridden.and_then(|o| o.label.clone()).unwrap_or_else(|| page.title.clone()),
                    icon: overridden.and_then(|o| o.icon.clone()).or_else(|| page.icon.clone()),
                    description: page.description.clone(),
                    hidden: overridden.is_some_and(|o| o.hidden) || module_hidden(&module.id),
                    read_only: module.read_only(),
                    missing,
                    errors,
                    uses: page.uses.clone(),
                    panel: None,
                    instance: None,
                    reference,
                };
                pages.push((resolved, placement));
            }
        }

        // Les panneaux se rattachent à leur page avant le classement des onglets.
        let panels: Vec<(String, ResolvedPage)> = pages
            .iter()
            .filter_map(|(page, placement)| match placement {
                Placement::Panel { page: host } => Some((host.clone(), page.clone())),
                _ => None,
            })
            .collect();
        for (host, panel) in panels {
            match pages.iter_mut().find(|(page, _)| page.reference == host) {
                Some((page, _)) if page.panel.is_none() => page.panel = Some(Box::new(panel)),
                Some(_) => problems.push(Problem {
                    module: panel.module.clone(),
                    message: format!("La page « {host} » a plusieurs panneaux ; « {} » est ignoré.", panel.reference),
                }),
                None => problems.push(Problem {
                    module: panel.module.clone(),
                    message: format!("Le panneau « {} » vise une page absente : « {host} ».", panel.reference),
                }),
            }
        }

        let mut sections: Vec<ResolvedSection> = Vec::new();
        for module in &modules {
            for section in &module.sections {
                let id = format!("{}/{}", module.id, section.id);
                let overridden = manifest.layout.overrides.get(&format!("section:{id}"));
                sections.push(ResolvedSection {
                    module: module.id.clone(),
                    label: overridden.and_then(|o| o.label.clone()).unwrap_or_else(|| section.label.clone()),
                    icon: overridden.and_then(|o| o.icon.clone()).or_else(|| section.icon.clone()),
                    color: overridden.and_then(|o| o.color.clone()).or_else(|| section.color.clone()),
                    hidden: overridden.is_some_and(|o| o.hidden) || module_hidden(&module.id),
                    pages: Vec::new(),
                    per_instance: section.per_instance.clone().filter(|need| !need.trim().is_empty()),
                    instance: None,
                    instance_of: None,
                    waiting: None,
                    id,
                });
            }
        }

        let mut settings_pages = Vec::new();
        for (page, placement) in &pages {
            match placement {
                Placement::Tab { section } => match sections.iter_mut().find(|candidate| &candidate.id == section) {
                    Some(target) => target.pages.push(page.clone()),
                    None => problems.push(Problem {
                        module: page.module.clone(),
                        message: format!("La page « {} » vise une section absente : « {section} ».", page.reference),
                    }),
                },
                Placement::Settings => settings_pages.push(page.clone()),
                Placement::Panel { .. } => {}
            }
        }

        let mut sections = self.expand_instances(sections, &manifest, &mut problems);
        // Une copie par instance prend la place de sa section tant que l’utilisateur ne l’a pas rangée elle-même.
        order_by_either(&mut sections, &manifest.layout.sections, |section| {
            (section.id.as_str(), section.instance_of.as_deref())
        });
        for section in &mut sections {
            let order = manifest
                .layout
                .tabs
                .get(&section.id)
                .or_else(|| section.instance_of.as_ref().and_then(|base| manifest.layout.tabs.get(base)));
            if let Some(order) = order {
                order_by_either(&mut section.pages, order, |page| {
                    (page.reference.as_str(), page.reference.split_once('@').map(|(base, _)| base))
                });
            }
        }
        order_by(&mut settings_pages, &manifest.layout.settings, |page| page.reference.as_str());

        let mut functions = Vec::new();
        for module in &modules {
            for function in &module.functions {
                let file = self.function_path(&module.id, function);
                let (missing, mut errors) = match fs::read_to_string(&file) {
                    Ok(_) if function.runtime.is_script() => (false, Vec::new()),
                    Ok(source) => (false, transpile::transpile_in(&source, "function.ts", 1, &libraries(&module.id)).err().unwrap_or_default()),
                    Err(_) => (true, Vec::new()),
                };
                if let Some(message) = crate::scripts::availability(function.runtime) {
                    errors.push(Diagnostic { message, line: None, column: None });
                }
                functions.push(ResolvedFunction {
                    reference: format!("{}/{}", module.id, function.id),
                    module: module.id.clone(),
                    id: function.id.clone(),
                    description: function.description.clone(),
                    input: function.input.clone(),
                    output: function.output.clone(),
                    tool: function.tool,
                    missing,
                    errors,
                    uses: function.uses.clone(),
                    runtime: function.runtime,
                    effect: function.effect,
                    tests: function.tests.clone(),
                });
            }
        }

        Ok(Snapshot {
            path: self.root.to_string_lossy().to_string(),
            name: manifest.name,
            accent: manifest.accent,
            sections,
            settings_pages,
            modules: modules
                .iter()
                .map(|module| ModuleSummary {
                    id: module.id.clone(),
                    name: module.name.clone(),
                    version: module.version.clone(),
                    description: module.description.clone(),
                    read_only: module.read_only(),
                    origin: module.origin.clone(),
                    hidden: module_hidden(&module.id),
                    requires: module.requires.clone(),
                    required_by: modules
                        .iter()
                        .filter(|other| other.requires_module(&module.id))
                        .map(|other| other.id.clone())
                        .collect(),
                    pages: module.pages.len(),
                    functions: module.functions.len(),
                    clients: module.clients.clone(),
                    webhooks: module.webhooks.clone(),
                    schedules: module.schedules.clone(),
                    setup: module.setup.clone(),
                })
                .collect(),
            functions,
            bindings: manifest.bindings,
            problems,
            layout: manifest.layout,
        })
    }
}

/// Clé du réglage d’affichage d’un module dans `layout.overrides`.
pub fn module_key(module: &str) -> String {
    format!("module:{module}")
}

/// Dépendances qui ne tiennent pas : module requis absent ou trop ancien, dépendance à soi-même, cycle.
fn dependency_problems(modules: &[ModuleManifest]) -> Vec<Problem> {
    let find = |id: &str| modules.iter().find(|module| module.id == id);
    let mut problems = Vec::new();
    for module in modules {
        for requirement in &module.requires {
            let message = if requirement.module == module.id {
                Some("Le module ne peut pas dépendre de lui-même.".to_string())
            } else if !valid_id(&requirement.module) {
                Some(format!("Dépendance invalide : « {} » n’est pas un identifiant de module.", requirement.module))
            } else {
                match find(&requirement.module) {
                    None => Some(format!(
                        "Le module dépend de {}, absent de l’espace : l’installer ou retirer la dépendance de `requires`.",
                        requirement.describe()
                    )),
                    Some(required) if !requirement.accepts(&required.version) => Some(format!(
                        "Le module dépend de {}, mais la version présente est la v{} : le mettre à jour.",
                        requirement.describe(),
                        required.version
                    )),
                    Some(_) => None,
                }
            };
            if let Some(message) = message {
                problems.push(Problem { module: module.id.clone(), message });
            }
        }
        if let Some(path) = cycle_through(modules, &module.id) {
            problems.push(Problem {
                module: module.id.clone(),
                message: format!("Dépendances en boucle : {}. Retirer l’une d’elles de `requires`.", path.join(" → ")),
            });
        }
    }
    problems
}

/// Chemin de dépendances qui part de `start` et y revient, s’il existe (`start` exclu des dépendances directes
/// vers lui-même, signalées à part).
fn cycle_through(modules: &[ModuleManifest], start: &str) -> Option<Vec<String>> {
    fn walk(modules: &[ModuleManifest], start: &str, current: &str, path: &mut Vec<String>, seen: &mut BTreeSet<String>) -> bool {
        let Some(module) = modules.iter().find(|module| module.id == current) else { return false };
        for requirement in &module.requires {
            let next = requirement.module.as_str();
            if next == current {
                continue;
            }
            if next == start {
                path.push(next.to_string());
                return true;
            }
            if seen.insert(next.to_string()) {
                path.push(next.to_string());
                if walk(modules, start, next, path, seen) {
                    return true;
                }
                path.pop();
            }
        }
        false
    }
    let mut path = vec![start.to_string()];
    let mut seen = BTreeSet::new();
    walk(modules, start, start, &mut path, &mut seen).then_some(path)
}

/// Rend absolue une référence de section écrite sans son module.
fn qualify(placement: &Placement, module: &str) -> Placement {
    match placement {
        Placement::Tab { section } if !section.contains('/') => {
            Placement::Tab { section: format!("{module}/{section}") }
        }
        other => other.clone(),
    }
}

/// Classe `items` selon `order` ; ce qui n’y figure pas garde son ordre d’origine, à la suite.
fn order_by<T>(items: &mut [T], order: &[String], key: impl Fn(&T) -> &str) {
    items.sort_by_key(|item| order.iter().position(|id| id == key(item)).unwrap_or(usize::MAX));
}

/// Classe d’après sa propre clé, sinon d’après celle de l’élément dont il est la copie.
fn order_by_either<T>(items: &mut [T], order: &[String], key: impl Fn(&T) -> (&str, Option<&str>)) {
    let rank = |item: &T| {
        let (own, base) = key(item);
        order
            .iter()
            .position(|id| id == own)
            .or_else(|| base.and_then(|base| order.iter().position(|id| id == base)))
            .unwrap_or(usize::MAX)
    };
    items.sort_by_key(|item| rank(item));
}

/// Copie d’une page pour une instance : sa référence et celle de son panneau prennent `@instance`, et ses propres
/// réglages d’affichage s’ajoutent à ceux de la page déclarée.
fn page_for_instance(page: &ResolvedPage, instance: &str, overrides: &BTreeMap<String, Override>) -> ResolvedPage {
    let reference = format!("{}@{instance}", page.reference);
    let own = overrides.get(&format!("page:{reference}"));
    let mut copy = page.clone();
    copy.title = own.and_then(|o| o.label.clone()).unwrap_or_else(|| page.title.clone());
    copy.icon = own.and_then(|o| o.icon.clone()).or_else(|| page.icon.clone());
    copy.hidden = page.hidden || own.is_some_and(|o| o.hidden);
    copy.panel = page.panel.as_ref().map(|panel| Box::new(page_for_instance(panel, instance, overrides)));
    copy.instance = Some(instance.to_string());
    copy.reference = reference;
    copy
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    fs::write(path, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_device_names_are_not_valid_ids() {
        for reserved in ["con", "nul", "aux", "prn", "com1", "lpt9"] {
            assert!(!valid_id(reserved), "{reserved}");
        }
        for allowed in ["console", "contacts", "com", "com10", "nul-1"] {
            assert!(valid_id(allowed), "{allowed}");
        }
        assert!(windows_reserved("CON.txt") && windows_reserved("Nul.tar.gz") && !windows_reserved("connexion.md"));
    }

    #[test]
    fn builds_navigation_from_placements_and_keeps_installed_modules_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();

        // Une entrée de menu crée un module local et sa section.
        let first = space
            .place_page(
                "Tableau de bord",
                None,
                "",
                &PlaceTarget::Menu { label: "Suivi".into(), icon: Some("list".into()), color: None },
                None,
            )
            .unwrap();
        assert_eq!(first.reference, "suivi/tableau-de-bord");
        fs::write(&first.file, "export default function Page() { return <p>Bonjour</p>; }").unwrap();

        // Un onglet rejoint le module de sa section ; un panneau rejoint celui de sa page.
        let tab =
            space.place_page("Détails", None, "", &PlaceTarget::Tab { section: "suivi/principal".into() }, None).unwrap();
        assert_eq!(tab.module, "suivi");
        let panel =
            space.place_page("Aide", None, "", &PlaceTarget::Panel { page: first.reference.clone() }, None).unwrap();
        fs::write(&panel.file, "export default function Panel() { return <p>; }").unwrap();
        assert!(space.place_page("Autre", None, "", &PlaceTarget::Panel { page: first.reference.clone() }, None).is_err());

        // Un module installé reste intact : l’ajout va dans un module local d’accompagnement.
        let mut installed = space.module("suivi").unwrap();
        installed.origin = Some(Origin { marketplace: "git@exemple:mp.git".into(), ..Origin::default() });
        space.write_module(&installed).unwrap();
        let added =
            space.place_page("Notes", None, "", &PlaceTarget::Tab { section: "suivi/principal".into() }, None).unwrap();
        assert_eq!(added.module, "suivi-ajouts");
        assert!(space.delete_page("suivi/details").is_err());

        let snapshot = space.snapshot().unwrap();
        assert_eq!(snapshot.sections.len(), 1);
        let section = &snapshot.sections[0];
        let titles: Vec<&str> = section.pages.iter().map(|page| page.title.as_str()).collect();
        assert_eq!(titles, ["Tableau de bord", "Détails", "Notes"]);
        let dashboard = &section.pages[0];
        assert!(dashboard.errors.is_empty() && !dashboard.missing && dashboard.read_only);
        let help = dashboard.panel.as_ref().unwrap();
        assert_eq!(help.errors.len(), 1, "le panneau cassé porte son erreur de compilation");
        assert!(section.pages[1].missing, "page enregistrée mais pas encore écrite");

        // L’ordre choisi par l’utilisateur prime, sans modifier les modules.
        let mut manifest = space.manifest().unwrap();
        manifest.layout.tabs.insert("suivi/principal".into(), vec!["suivi-ajouts/notes".into()]);
        space.write_manifest(&manifest).unwrap();
        assert_eq!(space.snapshot().unwrap().sections[0].pages[0].title, "Notes");
    }

    #[test]
    fn reports_broken_dependencies_and_hides_a_whole_module() {
        let dir = tempfile::tempdir().unwrap();
        let space = Space::open_or_create(dir.path(), Some("Test")).unwrap();
        for label in ["CRM", "Devis", "Boucle"] {
            space.place_page("Liste", None, "", &PlaceTarget::Menu { label: label.into(), icon: None, color: None }, None).unwrap();
        }
        let require = |id: &str, requires: Vec<Requirement>| {
            let mut module = space.module(id).unwrap();
            module.requires = requires;
            space.write_module(&module).unwrap();
        };
        let on = |module: &str, min: Option<&str>| Requirement { module: module.into(), min_version: min.map(str::to_string) };
        require("devis", vec![on("crm", Some("0.2.0")), on("absent", None)]);
        let problems: Vec<String> = space.snapshot().unwrap().problems.into_iter().map(|p| format!("{}: {}", p.module, p.message)).collect();
        assert!(problems.iter().any(|p| p.starts_with("devis:") && p.contains("v0.1.0")), "{problems:?}");
        assert!(problems.iter().any(|p| p.starts_with("devis:") && p.contains("« absent »")), "{problems:?}");

        require("devis", vec![on("crm", Some("0.1"))]);
        require("crm", vec![on("boucle", None)]);
        require("boucle", vec![on("devis", None)]);
        let snapshot = space.snapshot().unwrap();
        assert!(snapshot.problems.iter().any(|p| p.module == "crm" && p.message.contains("crm → boucle → devis → crm")));
        require("boucle", vec![]);
        let snapshot = space.snapshot().unwrap();
        assert!(snapshot.problems.is_empty(), "{:?}", snapshot.problems);
        let crm = snapshot.modules.iter().find(|module| module.id == "crm").unwrap();
        assert_eq!(crm.required_by, ["devis"]);
        assert_eq!(space.dependents("crm"), ["devis"]);

        // Masquer le module retire du menu sa section et ses pages, où qu’elles soient rangées.
        assert!(space.set_visibility("module:crm", true).unwrap().is_some());
        assert!(space.set_visibility("module:crm", true).unwrap().is_none(), "rien à changer");
        let snapshot = space.snapshot().unwrap();
        let section = snapshot.sections.iter().find(|section| section.module == "crm").unwrap();
        assert!(section.hidden && section.pages.iter().all(|page| page.hidden));
        assert!(snapshot.modules.iter().find(|module| module.id == "crm").unwrap().hidden);
        assert!(snapshot.sections.iter().filter(|section| section.module != "crm").all(|section| !section.hidden));
        space.set_visibility("module:crm", false).unwrap();
        assert!(space.manifest().unwrap().layout.overrides.is_empty(), "un réglage revenu par défaut disparaît");
        assert!(space.set_visibility("page:crm/liste", true).unwrap().is_some());
        assert!(space.set_visibility("page:crm/absente", true).is_err());
        assert!(space.set_visibility("crm", true).is_err());
    }
}
