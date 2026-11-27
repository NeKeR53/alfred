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
    /// Pages que l’utilisateur a ajoutées à chaque compte (`client/instance` → `module/page`), parmi celles qui sont
    /// pour ses comptes (`perInstance`). Un compte absent n’en a aucune. `None` : espace d’avant ce choix, où chaque
    /// compte montre toutes ses pages jusqu’à `migrate_account_pages`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_pages: Option<BTreeMap<String, Vec<String>>>,
    /// Sections du menu créées pendant l’usage par les modules (`menu.addSection`), dans l’ordre de création.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub created_sections: Vec<crate::menu_sections::CreatedSection>,
}

/// Clé d’un compte dans `account_pages`.
pub fn account_key(client: &str, instance: &str) -> String {
    format!("{client}/{instance}")
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
    /// Pages de l’utilisateur (entrées du menu), créées à partir des modèles des modules. `None` : espace d’avant,
    /// dont le menu est repris des règles d’alors à l’ouverture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menu: Option<Vec<crate::menu::MenuPage>>,
    /// Modèles déjà proposés à l’utilisateur : un modèle nouveau est ajouté une fois au menu, un modèle retiré n’y
    /// revient pas.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub menu_templates: Vec<String>,
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
    /// Publications d’un module développé dans cet espace de travail : une par marketplace, la dernière version
    /// envoyée. Comme `origin`, elles décrivent ce poste et ne partent jamais dans le marketplace.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub published: Vec<Publication>,
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
    /// Index de recherche plein texte, tenus à jour par Alfred.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub search: Vec<IndexDecl>,
    /// Index de recherche par le sens (vecteurs calculés par un modèle local).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub semantic: Vec<IndexDecl>,
    /// Tables dont Alfred garde l’historique des modifications (qui, quand, avant et après).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<String>,
    /// Événements que le module publie, et ceux d’autres modules auxquels ses fonctions s’abonnent.
    #[serde(skip_serializing_if = "EventsDecl::is_empty")]
    pub events: EventsDecl,
    /// Tables partagées entre les membres d’une équipe par un dépôt git (`team_sync`).
    #[serde(skip_serializing_if = "SyncDecl::is_empty")]
    pub sync: SyncDecl,
    /// Paquets Python du module et version de Python : Alfred leur crée un environnement isolé (`python::env`).
    #[serde(skip_serializing_if = "PythonDecl::is_empty")]
    pub python: PythonDecl,
    /// Types d’entité du service (un ticket, un mail) : chaque objet est rangé une seule fois dans le magasin des
    /// états, sous sa clé d’entité (`states.rs`). Contrat entre modules, versionné.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<EntityDecl>,
    /// États nommés du module (« mes-tickets », « boite-de-reception ») : les pages s’y abonnent (`useAlfredState`),
    /// ses fonctions de lecture les alimentent. Contrat entre modules.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<StateDecl>,
}

/// Type d’entité déclaré par le module qui détient le client : nom, champ identifiant, forme, version du contrat.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EntityDecl {
    pub id: String,
    pub description: String,
    /// Champ identifiant de l’objet (`id`, `key`) ; par défaut `id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Schéma JSON d’un objet.
    pub schema: Value,
    /// Version du contrat : à monter quand la forme change de façon incompatible.
    pub version: u32,
    /// Besoin (`clients` du manifeste) dont le compte entre dans la portée ; omis : le seul besoin du module.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
}

impl EntityDecl {
    pub fn key_field(&self) -> &str {
        self.key.as_deref().filter(|key| !key.is_empty()).unwrap_or("id")
    }
}

/// État nommé : une valeur, ou une liste d’entités (`entity`) dont l’état garde seulement les identifiants.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StateDecl {
    pub id: String,
    pub description: String,
    /// Schéma JSON de la valeur (pour une liste d’entités : la liste rendue, objets compris).
    pub schema: Value,
    /// Liste d’entités de ce type : l’état garde les identifiants, le magasin les objets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    /// Pour une liste d’entités rendue dans un objet par la fonction (`{ "issues": [...] }`) : le champ de la liste.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<String>,
    /// Besoin dont le compte entre dans la portée ; omis : le seul besoin du module.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// Paramètres de l’état (`jql` pour `jira/tickets-du-filtre`) : chaque jeu de valeurs est un état à part, et
    /// deux abonnés avec les mêmes paramètres normalisés partagent le même. Chacun est décrit (`description`,
    /// `example`) : c’est ainsi qu’un module consommateur sait quoi passer (`space_overview`, `states`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<StateParam>,
    /// Politique de rafraîchissement : le module fournisseur tient l’état à jour lui-même, dans le cœur (`states.rs`).
    /// Absente : l’état change seulement quand quelqu’un le lit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<RefreshDecl>,
    /// Âge maximal de la valeur, en secondes, choisi par le fournisseur selon le métier (des tickets changent peu, un
    /// job CI change vite). À l’abonnement, à l’ouverture et au retour sur une page, Alfred relit l’état seulement si
    /// sa valeur est plus vieille. Omis : `refresh.every`, sinon 10 minutes. L’utilisateur peut le changer dans
    /// Réglages → États.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_age: Option<u64>,
    /// Version du contrat de l’état : à monter quand sa forme change. Une valeur gardée sur le disque d’une autre
    /// version est oubliée (et relue).
    #[serde(skip_serializing_if = "is_zero")]
    pub version: u32,
    /// `false` : la valeur n’est jamais gardée sur le disque (donnée sensible) ; elle vit le temps du lancement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist: Option<bool>,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl StateDecl {
    /// Noms des paramètres, dans l’ordre déclaré.
    pub fn param_names(&self) -> Vec<&str> {
        self.params.iter().map(StateParam::id).collect()
    }
}

/// Paramètre d’un état : un nom seul (`"jql"`), ou décrit (`{ "id": "jql", "description": "…", "example": "…" }`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum StateParam {
    Name(String),
    Described(ParamDecl),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ParamDecl {
    pub id: String,
    /// Ce que le paramètre choisit, en mots de l’utilisateur (« Filtre JQL des tickets »).
    pub description: String,
    /// Une valeur d’exemple, montrée aux modules qui s’abonnent (`assignee = currentUser()`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<Value>,
}

impl StateParam {
    pub fn id(&self) -> &str {
        match self {
            Self::Name(id) => id,
            Self::Described(param) => &param.id,
        }
    }

    pub fn description(&self) -> &str {
        match self {
            Self::Name(_) => "",
            Self::Described(param) => &param.description,
        }
    }
}

impl From<&str> for StateParam {
    fn from(id: &str) -> Self {
        Self::Name(id.to_string())
    }
}

/// Comment le fournisseur tient un état à jour.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RefreshDecl {
    /// Fonction de lecture du module qui rafraîchit l’état ; elle reçoit les paramètres (et `instance`).
    pub function: String,
    /// Période, en secondes (10 au moins).
    pub every: u64,
    /// Lecture incrémentale : la fonction reçoit aussi `current` (la valeur courante) et `since` (fin de la dernière
    /// lecture réussie, ms, ou `null`), et rend les changements à fusionner (`{ changed, removed }` ou une liste).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub incremental: bool,
    /// `subscribed` (par défaut) : tant qu’il y a un abonné ; `always` : toujours, dès que le module est là.
    #[serde(skip_serializing_if = "RefreshMode::is_default")]
    pub mode: RefreshMode,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefreshMode {
    #[default]
    Subscribed,
    Always,
}

impl RefreshMode {
    fn is_default(&self) -> bool {
        *self == Self::Subscribed
    }
}

/// Dépendances Python d’un module : `requirements` (spécifications pip, « pandas>=2.2 ») et `version` facultative
/// (« 3.12 »). Validées par `python::env::problems`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PythonDecl {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub requirements: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Champs inconnus (une faute de frappe, « requirement ») : signalés par `check` au lieu d’être ignorés.
    #[serde(flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub unknown: serde_json::Map<String, Value>,
}

impl PythonDecl {
    pub fn is_empty(&self) -> bool {
        self.requirements.is_empty() && self.version.is_none() && self.unknown.is_empty()
    }

    /// Le module a-t-il besoin de son propre environnement ?
    pub fn needs_env(&self) -> bool {
        !self.requirements.is_empty() || self.version.is_some()
    }
}

/// Partage des données du module en équipe : les tables dont chaque ligne va dans le dépôt de l’équipe.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncDecl {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<String>,
}

impl SyncDecl {
    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EventsDecl {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub publishes: Vec<EventDecl>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subscribes: Vec<SubscriptionDecl>,
}

impl EventsDecl {
    pub fn is_empty(&self) -> bool {
        self.publishes.is_empty() && self.subscribes.is_empty()
    }
}

/// Événement publié par le module (« ticket-cree »), avec la forme de ce qu’il transmet.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EventDecl {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Schéma JSON du contenu, pour les modules qui s’y abonnent.
    #[serde(skip_serializing_if = "Value::is_null")]
    pub schema: Value,
}

/// Abonnement : la fonction du module appelée à chaque publication de l’événement.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SubscriptionDecl {
    /// « module/événement », ou « événement » pour un événement du module lui-même.
    pub event: String,
    /// Fonction du module, sans préfixe.
    pub function: String,
}

/// Index déclaré sur une table du module : Alfred le crée, le tient à jour à chaque écriture et le reconstruit
/// quand la déclaration ou la table change.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexDecl {
    pub id: String,
    pub table: String,
    /// Colonne qui identifie la ligne, rendue avec chaque résultat (`id` par défaut).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// Colonnes de texte indexées.
    pub columns: Vec<String>,
}

impl IndexDecl {
    pub fn key(&self) -> &str {
        if self.key.is_empty() { "id" } else { &self.key }
    }
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
    /// Modifié sur place, avec l’accord de l’utilisateur : le module reste lié à son marketplace et modifiable. Une
    /// mise à jour demande alors de remplacer ses changements (ou de garder sa version) ; elle remet ce drapeau à
    /// faux, comme une publication de ses changements sur le marketplace d’origine.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub edited: bool,
}

/// Dernière publication d’un module développé ici sur un marketplace.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Publication {
    /// Adresse git du marketplace.
    pub marketplace: String,
    pub version: String,
    /// Commit du marketplace qui a reçu cette version.
    pub commit: String,
}

impl ModuleManifest {
    pub fn read_only(&self) -> bool {
        self.origin.as_ref().is_some_and(|origin| !origin.detached && !origin.edited)
    }

    /// Importé d’un marketplace et toujours lié à lui (modifié sur place ou non).
    pub fn imported(&self) -> bool {
        self.origin.as_ref().is_some_and(|origin| !origin.detached)
    }

    /// Le module déclare-t-il dépendre de `module` ?
    pub fn requires_module(&self, module: &str) -> bool {
        self.requires.iter().any(|requirement| requirement.module == module)
    }
}

/// Refus d’écrire dans un module importé encore en lecture seule, et la façon d’obtenir l’accord.
pub fn imported_refusal(manifest: &ModuleManifest) -> String {
    let name = if manifest.name.is_empty() { &manifest.id } else { &manifest.name };
    format!(
        "Le module « {name} » est importé d’un marketplace et en lecture seule. Pour le modifier, demander d’abord l’accord de l’utilisateur avec `alfred edit_module --module {}` (lui le fait depuis Réglages → Modules → « Modifier sur place… »).",
        manifest.id
    )
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
    /// La version `version` convient-elle ? Il faut au moins `min_version`, dans la même version majeure : une
    /// nouvelle majeure change ce dont le module dépend (fonctions, clients, tables), elle ne le remplace pas. Une
    /// version illisible ne convient qu’à une dépendance sans minimum.
    pub fn accepts(&self, version: &str) -> bool {
        match self.min_version.as_deref().map(str::trim).filter(|min| !min.is_empty()) {
            None => true,
            Some(min) => match (parse_version(version), parse_version(min)) {
                (Some(version), Some(min)) => version >= min && version[0] == min[0],
                _ => false,
            },
        }
    }

    pub fn describe(&self) -> String {
        match self.min_version.as_deref().map(str::trim).filter(|min| !min.is_empty()) {
            Some(min) => {
                let major = parse_version(min).map(|parts| parts[0].to_string()).unwrap_or_else(|| min.to_string());
                format!("« {} » v{min} ou plus (v{major}.x)", self.module)
            }
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
    /// Comment les comptes d’une section par instance s’affichent : une entrée de menu par compte (par défaut), ou
    /// une seule entrée avec un onglet par compte (`"tabs"`).
    #[serde(skip_serializing_if = "InstancesAs::is_sections")]
    pub instances_as: InstancesAs,
}

/// Affichage des comptes d’une section dont les pages sont pour chaque compte.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstancesAs {
    /// Une copie de la section par compte, chacune avec ses pages en onglets.
    #[default]
    Sections,
    /// Une seule section, avec un onglet par page de chaque compte.
    Tabs,
}

impl InstancesAs {
    fn is_sections(&self) -> bool {
        *self == InstancesAs::Sections
    }
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
    /// Besoin client du module (`jira`, ou `dépendance/besoin`) dont la page montre un compte : sans compte, elle
    /// attend. L’utilisateur choisit ce compte pour chaque copie de la page (`layout.menu`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_instance: Option<String>,
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
    /// Python seulement : la fonction tourne dans le noyau Python du module (`def main(input)` de son fichier, état
    /// gardé entre deux appels) au lieu d’un processus neuf par appel (stdin et stdout JSON).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub kernel: bool,
    /// Ce que fait la fonction chez le service : lire (`read`) ou modifier (`write`). Absent, elle compte comme
    /// une écriture : ses tests ne se lancent jamais d’office.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<Effect>,
    /// État nommé du module que la sortie de cette lecture alimente (`states`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Type d’entité du module que la sortie (un objet, ou une liste d’objets) met à jour (`entities`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    /// Champ de l’entrée qui porte la sous-clé de l’état (`job` pour `jenkins/ci/<job>`), ou l’identifiant de
    /// l’entité lue seule : Alfred s’en sert pour ranger la sortie et pour relancer la lecture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<String>,
    /// Écriture : les états du module qu’elle change (`["mes-tickets"]`) ; eux seuls se relisent après elle. `[]` :
    /// elle ne change aucun état. Omis (et sans `entity`) : tous les états suivis du module se relisent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub touches: Option<Vec<String>>,
    /// Cas de test : une entrée d’exemple et ce que la sortie doit montrer.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<FunctionTest>,
    /// Données d’exemple : des réponses rendues à la place du service quand le module est en mode « données
    /// d’exemple » (aucune requête ne part alors vers le service).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<FunctionExample>,
}

/// Réponse d’exemple d’une fonction de connecteur : pour une entrée, la sortie au format exact du service.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FunctionExample {
    /// Ce que montre l’exemple, en mots simples (« Trois tickets ouverts »).
    pub name: String,
    /// Entrée à laquelle l’exemple répond ; l’appel choisit l’exemple dont les champs fournis correspondent.
    pub input: Value,
    /// Sortie rendue, conforme au schéma `output` de la fonction.
    pub output: Value,
}

impl FunctionDecl {
    /// Fonction de connecteur : elle joint un service (`uses.clients`).
    pub fn is_connector(&self) -> bool {
        !self.uses.clients.is_empty()
    }
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
    /// Durée (en secondes) pendant laquelle les lectures réussies de ce service sont gardées, par défaut.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<u64>,
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
    /// Intervalle en minutes ; exclusif avec `at` et `every_seconds`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_minutes: Option<u32>,
    /// Intervalle en secondes (au moins 5), pour un relevé rapproché ; exclusif avec `at` et `every_minutes`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_seconds: Option<u32>,
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
    /// Modules affichés avec leurs données d’exemple (réglage du poste, dans la base d’Alfred) ; rempli par la
    /// commande qui envoie la vue à l’interface.
    pub examples: Vec<String>,
    /// Modèles de pages des modules, que l’utilisateur ajoute comme pages ou comme onglets.
    pub templates: Vec<crate::menu::PageTemplate>,
    /// Sections déclarées : l’apparence d’une page et ses onglets par défaut.
    pub section_templates: Vec<crate::menu::SectionTemplate>,
    /// Sections créées par les modules installés (`menu.addSection`), dans l’ordre de création.
    pub created_sections: Vec<crate::menu_sections::CreatedSection>,
    /// Onglets qui se servent de chaque compte (`client/instance` → références).
    pub account_usage: BTreeMap<String, Vec<String>>,
    /// Services dont les comptes peuvent servir à chaque besoin d’un modèle (`module/besoin` → clients), le sien
    /// d’abord : le choix d’un compte propose aussi ceux d’un autre service du même type.
    pub compatible_clients: BTreeMap<String, Vec<String>>,
    /// Menu calculé qui n’est pas encore sur le disque (espace d’avant, modèles nouveaux) : `persist_menu` l’écrit.
    #[serde(skip)]
    pub pending_menu: Option<(Vec<crate::menu::MenuPage>, Vec<String>)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSection {
    pub id: String,
    pub module: String,
    pub label: String,
    /// Nom d’icône Lucide, ou chemin d’une image du module (`icons/jira.svg`).
    pub icon: Option<String>,
    /// Adresse `data:` de l’icône quand c’est une image du module lisible ; `None` sinon (l’interface retombe
    /// alors sur l’icône Lucide, ou sur l’icône par défaut).
    pub icon_url: Option<String>,
    pub color: Option<String>,
    pub hidden: bool,
    pub pages: Vec<ResolvedPage>,
    /// Besoin client dont la section suit les instances (`perInstance` du module).
    pub per_instance: Option<String>,
    /// Affichage des comptes : une copie de la section par compte, ou un onglet par compte dans cette section.
    pub instances_as: InstancesAs,
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
    /// Besoin client dont la page suit les instances : le sien (`perInstance` de la page), sinon celui de sa section.
    pub per_instance: Option<String>,
    /// Modèle dont la page est la copie (`module/page`) ; sa référence est la sienne, ou porte un suffixe.
    pub template: String,
    /// Compte choisi pour chaque besoin (`jira` → `acme`).
    pub accounts: BTreeMap<String, String>,
    /// La page attend un compte : ce qu’il faut faire, montré à la place de la page.
    pub waiting: Option<String>,
}

/// Page qui est pour chaque compte d’un client : ce que la fiche d’un compte propose d’ajouter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPage {
    /// `module/page` ; la page d’un compte est `module/page@instance`.
    pub reference: String,
    pub module: String,
    pub title: String,
    /// Nom de la section où elle se range.
    pub section: String,
    /// Besoin client qu’elle suit.
    pub need: String,
    /// Client de l’espace qui répond à ce besoin ; `None` s’il n’y en a pas encore.
    pub client: Option<String>,
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
    pub published: Vec<Publication>,
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
    /// Tables partagées en équipe (`sync.tables`).
    pub sync: Vec<String>,
    /// Empreinte du code du module (chemins, tailles, dates de ses fichiers) : ses pages ne se rechargent que
    /// quand elle change, pas quand le menu ou un autre module change.
    pub code: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<String>,
    pub tests: Vec<FunctionTest>,
    /// Nombre de réponses d’exemple déclarées.
    pub examples: usize,
    /// Script gardé par l’agent (`kept_scripts.rs`) : `toValidate` ou `accepted`. Rempli pour l’interface.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept: Option<String>,
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

/// Empreinte du code d’un module : chemin, taille et date de chaque fichier, dossiers cachés exceptés. Un fichier
/// écrit, ajouté ou retiré la change ; les données (base, fichiers déposés) sont rangées ailleurs et n’y entrent pas.
pub fn code_fingerprint(dir: &Path) -> String {
    use std::hash::{Hash, Hasher};
    fn walk(dir: &Path, base: &Path, hasher: &mut std::collections::hash_map::DefaultHasher) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            path.strip_prefix(base).unwrap_or(&path).hash(hasher);
            if meta.is_dir() {
                walk(&path, base, hasher);
                continue;
            }
            meta.len().hash(hasher);
            if let Ok(modified) = meta.modified() {
                modified.hash(hasher);
            }
        }
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    walk(dir, dir, &mut hasher);
    format!("{:016x}", hasher.finish())
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
            // Un espace neuf naît avec les pages de l’utilisateur : il n’a pas de menu d’avant à reprendre.
            space.write_manifest(&SpaceManifest {
                name: name.map(str::to_string).unwrap_or(default_name),
                layout: Layout { menu: Some(Vec::new()), ..Layout::default() },
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
            .map_err(|error| AppError::new(format!("Le fichier {SPACE_FILE} de l’espace de travail est illisible : {error}")))
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
            return Err(AppError::new(imported_refusal(&manifest)));
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
                        instances_as: InstancesAs::Sections,
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
            per_instance: None,
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

    /// Pose une icône image (déjà vérifiée par `section_icons::prepare`) sur une section déclarée
    /// (`module/section`) : le fichier va dans `icons/<section>.<ext>` du module, le manifeste pointe dessus,
    /// l’ancienne image de la section disparaît si plus rien ne s’en sert, et l’icône que l’utilisateur avait
    /// choisie pour cette entrée (et ses copies par instance) s’efface, pour que le logo se voie. Renvoie le
    /// chemin de l’icône dans le module et le libellé de la section.
    pub fn set_section_icon(
        &self,
        reference: &str,
        content: &[u8],
        format: crate::section_icons::Format,
    ) -> AppResult<(String, String)> {
        let (module_id, id) = reference
            .split_once('/')
            .ok_or_else(|| AppError::new("La section doit être désignée par « module/section »."))?;
        if id.contains('@') {
            return Err(AppError::new(format!(
                "« {reference} » est la copie d’une section pour une instance : poser l’icône sur la section déclarée, « {module_id}/{} ».",
                id.split('@').next().unwrap_or_default()
            )));
        }
        let mut module = self.writable_module(module_id)?;
        let section = module
            .sections
            .iter_mut()
            .find(|section| section.id == id)
            .ok_or_else(|| AppError::new(format!("La section « {reference} » n’existe pas.")))?;
        let label = section.label.clone();
        let icon = format!("{}/{id}.{}", crate::section_icons::ICONS_DIR, format.extension());
        let previous = section.icon.replace(icon.clone());
        let dir = self.module_dir(module_id);
        fs::create_dir_all(dir.join(crate::section_icons::ICONS_DIR))?;
        fs::write(dir.join(&icon), content)?;
        if let Some(previous) = previous.filter(|previous| {
            previous != &icon
                && previous.starts_with(&format!("{}/", crate::section_icons::ICONS_DIR))
                && !previous.contains("..")
        }) {
            if !module.sections.iter().any(|section| section.icon.as_deref() == Some(previous.as_str())) {
                let _ = fs::remove_file(dir.join(&previous));
            }
        }
        self.write_module(&module)?;
        let mut manifest = self.manifest()?;
        let key = format!("section:{reference}");
        let copies = format!("{key}@");
        let mut changed = false;
        manifest.layout.overrides.retain(|target, entry| {
            if target == &key || target.starts_with(&copies) {
                changed |= entry.icon.take().is_some();
                *entry != Override::default()
            } else {
                true
            }
        });
        if changed {
            self.write_manifest(&manifest)?;
        }
        Ok((icon, label))
    }

    /// Répète pour chaque instance d’un client les pages qui sont pour ses comptes : celles d’une section par
    /// instance, ou qui le déclarent elles-mêmes. Chaque compte a sa copie de la section, avec les seules pages que
    /// l’utilisateur lui a ajoutées ; les autres pages de la section restent dans la section d’origine. Sans
    /// instance (ou sans client), la section reste seule et dit quoi faire.
    pub(crate) fn expand_instances(
        &self,
        sections: Vec<ResolvedSection>,
        manifest: &SpaceManifest,
        problems: &mut Vec<Problem>,
    ) -> (Vec<ResolvedSection>, Vec<AccountPage>, BTreeMap<String, Vec<String>>) {
        let overrides = &manifest.layout.overrides;
        let mut expanded = Vec::new();
        let mut account_pages = Vec::new();
        let mut accounts: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for mut section in sections {
            // Une section par instance rend chacune de ses pages pour chaque compte.
            if let Some(need) = &section.per_instance {
                for page in &mut section.pages {
                    page.per_instance.get_or_insert_with(|| need.clone());
                }
            }
            let Some(need) = section
                .per_instance
                .clone()
                .or_else(|| section.pages.iter().find_map(|page| page.per_instance.clone()))
            else {
                expanded.push(section);
                continue;
            };
            // Une section ne se répète que pour un seul client : une page qui en suit un autre y reste commune.
            for page in &mut section.pages {
                if page.per_instance.as_ref().is_some_and(|other| other != &need) {
                    problems.push(Problem {
                        module: page.module.clone(),
                        message: format!(
                            "La page « {} » est pour « {} », mais sa section « {} » se répète pour « {need} » : elle reste commune à tous les comptes. La ranger dans une autre section.",
                            page.reference,
                            page.per_instance.as_deref().unwrap_or_default(),
                            section.id
                        ),
                    });
                    page.per_instance = None;
                }
            }
            let declared = self
                .module(&section.module)
                .is_ok_and(|module| need.contains('/') || module.clients.iter().any(|client| client.id == need));
            if !declared {
                let what = if section.per_instance.is_some() { "La section" } else { "Une page de la section" };
                problems.push(Problem {
                    module: section.module.clone(),
                    message: format!(
                        "{what} « {} » suit les instances de « {need} », que le module ne déclare pas dans `clients`.",
                        section.id
                    ),
                });
            }
            let client = crate::clients::client_for(self, &section.module, &need);
            for page in section.pages.iter().filter(|page| page.per_instance.is_some()) {
                account_pages.push(AccountPage {
                    reference: page.reference.clone(),
                    module: page.module.clone(),
                    title: page.title.clone(),
                    section: section.label.clone(),
                    need: need.clone(),
                    client: client.as_ref().ok().map(|client| client.id.clone()),
                });
            }
            match client {
                Ok(client) if !client.instances.is_empty() && section.instances_as == InstancesAs::Tabs => {
                    // Une seule section : chaque page ajoutée à un compte y devient un onglet, nommé d’après le compte.
                    let added: Vec<Vec<&ResolvedPage>> = client
                        .instances
                        .iter()
                        .map(|instance| {
                            let key = account_key(&client.id, &instance.id);
                            let chosen: Vec<&ResolvedPage> = section
                                .pages
                                .iter()
                                .filter(|page| page.per_instance.is_some())
                                .filter(|page| match &manifest.account_pages {
                                    None => true,
                                    Some(chosen) => {
                                        chosen.get(&key).is_some_and(|pages| pages.contains(&page.reference))
                                    }
                                })
                                .collect();
                            accounts.entry(key).or_default().extend(chosen.iter().map(|page| page.reference.clone()));
                            chosen
                        })
                        .collect();
                    let mut pages = Vec::new();
                    for page in &section.pages {
                        if page.per_instance.is_none() {
                            pages.push(page.clone());
                            continue;
                        }
                        for (instance, chosen) in client.instances.iter().zip(&added) {
                            if !chosen.iter().any(|candidate| candidate.reference == page.reference) {
                                continue;
                            }
                            let mut copy = page_for_instance(page, &instance.id, overrides);
                            let renamed = overrides.get(&format!("page:{}", copy.reference)).is_some_and(|o| o.label.is_some());
                            if !renamed {
                                copy.title = if chosen.len() > 1 {
                                    format!("{} — {}", copy.title, instance.display_label())
                                } else {
                                    instance.display_label().to_string()
                                };
                            }
                            pages.push(copy);
                        }
                    }
                    // Aucun compte n’a de page ni la section de page commune : elle n’a pas d’entrée.
                    if !pages.is_empty() {
                        expanded.push(ResolvedSection { pages, per_instance: Some(need.clone()), ..section });
                    }
                }
                Ok(client) if !client.instances.is_empty() => {
                    let (own, shared): (Vec<ResolvedPage>, Vec<ResolvedPage>) =
                        section.pages.iter().cloned().partition(|page| page.per_instance.is_some());
                    // Les pages communes restent dans la section d’origine, qui ne suit plus d’instance.
                    if !shared.is_empty() {
                        expanded.push(ResolvedSection { pages: shared, per_instance: None, ..section.clone() });
                    }
                    for instance in &client.instances {
                        let key = account_key(&client.id, &instance.id);
                        // Espace d’avant le choix par compte : chaque compte montre toutes ses pages.
                        let added = |page: &ResolvedPage| match &manifest.account_pages {
                            None => true,
                            Some(chosen) => chosen.get(&key).is_some_and(|pages| pages.contains(&page.reference)),
                        };
                        let pages: Vec<ResolvedPage> = own
                            .iter()
                            .filter(|page| added(page))
                            .map(|page| page_for_instance(page, &instance.id, overrides))
                            .collect();
                        accounts
                            .entry(key.clone())
                            .or_default()
                            .extend(own.iter().filter(|page| added(page)).map(|page| page.reference.clone()));
                        // Aucune page ajoutée à ce compte : il n’a pas d’entrée dans cette section.
                        if pages.is_empty() {
                            continue;
                        }
                        let id = format!("{}@{}", section.id, instance.id);
                        let own = overrides.get(&format!("section:{id}"));
                        let mut copy = section.clone();
                        copy.label = own
                            .and_then(|o| o.label.clone())
                            .unwrap_or_else(|| format!("{} — {}", section.label, instance.display_label()));
                        if let Some(icon) = own.and_then(|o| o.icon.clone()) {
                            // L’utilisateur a choisi une icône Lucide pour cette copie : elle prend le pas sur l’image.
                            copy.icon_url = None;
                            copy.icon = Some(icon);
                        }
                        copy.color = own.and_then(|o| o.color.clone()).or_else(|| section.color.clone());
                        copy.hidden = section.hidden || own.is_some_and(|o| o.hidden);
                        copy.pages = pages;
                        copy.per_instance = Some(need.clone());
                        copy.instance = Some(instance.id.clone());
                        copy.instance_of = Some(section.id.clone());
                        copy.id = id;
                        expanded.push(copy);
                    }
                }
                Ok(client) => expanded.push(ResolvedSection {
                    waiting: Some(format!(
                        "Le service « {} » n’a encore aucun compte. En ajouter un dans Réglages → Modules, fiche du module : ces pages apparaîtront pour chaque compte.",
                        client.label
                    )),
                    ..section
                }),
                Err(error) => expanded.push(ResolvedSection { waiting: Some(error.message), ..section }),
            }
        }
        // Chaque compte d’un client qui a des pages par compte figure, même sans page ajoutée.
        for page in &account_pages {
            if let Some(client) = page.client.as_deref() {
                if let Ok(Some(def)) = crate::clients::load(self, client) {
                    for instance in &def.instances {
                        accounts.entry(account_key(client, &instance.id)).or_default();
                    }
                }
            }
        }
        (expanded, account_pages, accounts)
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
        for module in &modules {
            for message in crate::python::env::problems(module) {
                problems.push(Problem { module: module.id.clone(), message });
            }
        }
        // Partage en équipe : une table partagée doit exister et avoir une clé texte, sinon deux membres s’écrasent.
        for module in modules.iter().filter(|module| !module.sync.tables.is_empty()) {
            for message in crate::team_sync::problems(self, module) {
                problems.push(Problem { module: module.id.clone(), message });
            }
        }
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
                    per_instance: page.per_instance.clone().filter(|need| !need.trim().is_empty()),
                    template: reference.clone(),
                    accounts: BTreeMap::new(),
                    waiting: None,
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
                let icon = overridden.and_then(|o| o.icon.clone()).or_else(|| section.icon.clone());
                let icon_url = match icon.as_deref().filter(|icon| crate::section_icons::is_image(icon)) {
                    Some(image) => match crate::section_icons::data_url(&self.module_dir(&module.id), image) {
                        Ok(url) => Some(url),
                        Err(reason) => {
                            problems.push(Problem {
                                module: module.id.clone(),
                                message: format!(
                                    "Icône de la section « {id} » : {reason}. L’icône par défaut s’affiche à sa place ; reposer le logo avec `set_section_icon`, ou mettre un nom d’icône Lucide."
                                ),
                            });
                            None
                        }
                    },
                    None => None,
                };
                sections.push(ResolvedSection {
                    module: module.id.clone(),
                    label: overridden.and_then(|o| o.label.clone()).unwrap_or_else(|| section.label.clone()),
                    icon,
                    icon_url,
                    color: overridden.and_then(|o| o.color.clone()).or_else(|| section.color.clone()),
                    hidden: overridden.is_some_and(|o| o.hidden) || module_hidden(&module.id),
                    pages: Vec::new(),
                    per_instance: section.per_instance.clone().filter(|need| !need.trim().is_empty()),
                    instances_as: section.instances_as,
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

        // Une section par instance donne son besoin à ses pages : ce sont des modèles qui montrent un compte.
        for section in &mut sections {
            if let Some(need) = &section.per_instance {
                for page in &mut section.pages {
                    page.per_instance.get_or_insert_with(|| need.clone());
                }
            }
        }
        let (templates, section_templates) = crate::menu::templates(&sections);
        let mut compatible_clients = BTreeMap::new();
        for template in &templates {
            for need in &template.needs {
                let key = if need.contains('/') { need.clone() } else { format!("{}/{need}", template.module) };
                compatible_clients.entry(key).or_insert_with(|| {
                    crate::menu::compatible_clients(self, &template.module, need).into_iter().map(|client| client.id).collect()
                });
            }
        }
        let (menu, known) = self.effective_menu(&manifest, &sections, &mut problems);
        let pending_menu = (manifest.layout.menu.as_ref() != Some(&menu) || manifest.layout.menu_templates != known)
            .then(|| (menu.clone(), known));
        let template_pages: Vec<ResolvedPage> =
            sections.iter().flat_map(|section| section.pages.iter().cloned()).collect();
        let elsewhere: BTreeSet<String> = pages.iter().map(|(page, _)| page.reference.clone()).collect();
        let resolved = self.resolve_menu(&menu, &sections, &template_pages, &elsewhere, &manifest, &mut problems);
        let mut sections = resolved.sections;
        // Ordre par défaut : celui des modules (leurs dossiers), puis celui du menu ; le layout passe ensuite devant.
        let module_order = self.module_ids();
        sections.sort_by_key(|section| {
            module_order.iter().position(|module| module == &section.module).unwrap_or(usize::MAX)
        });
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
                    state: function.state.clone(),
                    entity: function.entity.clone(),
                    param: function.param.clone(),
                    tests: function.tests.clone(),
                    examples: function.examples.len(),
                    kept: None,
                });
            }
        }

        // Sections créées par un module encore là : celles d’un module disparu attendent qu’il revienne.
        let created_sections: Vec<crate::menu_sections::CreatedSection> = manifest
            .created_sections
            .iter()
            .filter(|section| modules.iter().any(|module| module.id == section.module))
            .cloned()
            .collect();
        Ok(Snapshot {
            created_sections,
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
                    published: module.published.clone(),
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
                    sync: module.sync.tables.clone(),
                    code: code_fingerprint(&self.module_dir(&module.id)),
                })
                .collect(),
            functions,
            bindings: manifest.bindings,
            problems,
            // Les pages de l’utilisateur ne passent pas par le layout de la coquille : elle les lit dans `sections`.
            layout: Layout { menu: None, menu_templates: Vec::new(), ..manifest.layout },
            examples: Vec::new(),
            templates,
            section_templates,
            account_usage: resolved.usage,
            compatible_clients,
            pending_menu,
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
                        "Le module dépend de {}, absent de l’espace de travail : l’installer ou retirer la dépendance de `requires`.",
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
    fn the_code_fingerprint_changes_only_with_the_module_files() {
        let dir = tempfile::tempdir().unwrap();
        let module = dir.path().join("suivi");
        fs::create_dir_all(module.join("pages")).unwrap();
        fs::write(module.join("pages/taches.tsx"), "export default function Page() { return null; }").unwrap();
        let first = code_fingerprint(&module);
        assert_eq!(first, code_fingerprint(&module), "rien n’a changé");
        // Un dossier caché (git) n’est pas du code de page.
        fs::create_dir_all(module.join(".git")).unwrap();
        fs::write(module.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        assert_eq!(first, code_fingerprint(&module));
        fs::write(module.join("pages/liste.tsx"), "export default function Liste() { return null; }").unwrap();
        let added = code_fingerprint(&module);
        assert_ne!(first, added, "un fichier ajouté");
        fs::write(module.join("pages/liste.tsx"), "export default function Liste() { return <p />; }").unwrap();
        assert_ne!(added, code_fingerprint(&module), "un fichier réécrit");
    }

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
