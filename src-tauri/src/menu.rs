//! Pages de l’utilisateur. Un module fournit des modèles de pages (ses pages placées en onglet d’une section) ;
//! l’utilisateur crée ses pages, les entrées du menu, à partir de ces modèles, chacune avec ses onglets, et chaque
//! onglet avec ses comptes. Tout est écrit dans `alfred.json` (`layout.menu`) ; les noms, les icônes, l’ordre et le
//! masquage restent dans le reste du layout, comme pour toute entrée du menu.
//!
//! Identifiants : la première copie d’un modèle garde la référence déclarée (`module/page`, et `module/section` pour
//! l’entrée), les suivantes y ajoutent un suffixe (`module/page@recette`). L’état d’une page, ses compteurs et ses
//! réglages d’affichage suivent cette référence ; la migration garde donc celles d’avant (`…@compte`).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::space::{
    account_key, slug, valid_id, Override, Problem, ResolvedPage, ResolvedSection, Space, SpaceManifest,
};

/// Page de l’utilisateur : une entrée du menu, avec ses onglets.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuPage {
    /// `module/section`, ou `module/section@suffixe` pour une copie.
    pub id: String,
    /// Section déclarée qui donne son apparence par défaut (nom, icône, couleur).
    pub section: String,
    /// Nom choisi à la création ; un nom donné ensuite dans le menu (`layout.overrides`) passe devant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub tabs: Vec<MenuTab>,
}

/// Onglet d’une page de l’utilisateur : un modèle de page avec ses comptes.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuTab {
    /// Référence de l’onglet : `module/page`, ou `module/page@suffixe`.
    pub id: String,
    /// Modèle : la page déclarée, `module/page`.
    pub page: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Compte choisi pour chaque besoin du modèle (`jira` → `acme`). Un besoin absent prend le compte par défaut.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub accounts: BTreeMap<String, String>,
}

/// Modèle de page proposé par un module.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTemplate {
    /// `module/page`.
    pub reference: String,
    pub module: String,
    pub title: String,
    pub icon: Option<String>,
    pub description: String,
    /// Section déclarée où le module le range (`module/section`).
    pub section: String,
    /// Besoins clients du modèle (et de son panneau), dans l’ordre de déclaration.
    pub needs: Vec<String>,
    /// Besoin dont la page montre un compte (`perInstance`) : sans compte, elle attend.
    pub per_instance: Option<String>,
}

/// Section déclarée par un module : l’apparence d’une page et ses onglets par défaut.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionTemplate {
    pub id: String,
    pub module: String,
    pub label: String,
    pub icon: Option<String>,
    pub icon_url: Option<String>,
    pub color: Option<String>,
    /// Modèles rangés dans cette section, dans leur ordre de déclaration.
    pub pages: Vec<String>,
}

/// Onglet demandé à la création d’une page ou d’un onglet.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewTab {
    pub page: String,
    pub label: Option<String>,
    pub accounts: BTreeMap<String, String>,
}

/// Services dont un compte peut servir au besoin `need` du module `module` : le sien d’abord (sa liaison, ou le
/// client de même nom), puis ceux du même type. Un service est du même type quand il porte l’identifiant du besoin,
/// quand un autre module le reçoit pour un besoin de même identifiant, ou quand il a l’adresse que le module décrit
/// pour ce service (`clients[].client.baseUrl`). Un compte Bitbucket connecté pour un module sert ainsi à un autre.
pub fn compatible_clients(space: &Space, module: &str, need: &str) -> Vec<crate::clients::ClientDef> {
    let (owner, id) = need.split_once('/').unwrap_or((module, need));
    let own = crate::clients::client_for(space, module, need).ok();
    let described = space
        .module(owner)
        .ok()
        .and_then(|manifest| manifest.clients.into_iter().find(|candidate| candidate.id == id))
        .and_then(|declared| declared.client)
        .and_then(|client| client.get("baseUrl").and_then(|url| url.as_str()).map(str::to_string))
        .filter(|url| !url.trim().is_empty());
    let mut same_need: BTreeSet<String> = BTreeSet::new();
    for other in space.module_ids() {
        let Ok(manifest) = space.module(&other) else { continue };
        for declared in manifest.clients.iter().filter(|declared| declared.id == id) {
            if let Ok(client) = crate::clients::client_for(space, &other, &declared.id) {
                same_need.insert(client.id);
            }
        }
    }
    let mut found: Vec<crate::clients::ClientDef> = own.clone().into_iter().collect();
    for client in crate::clients::all(space) {
        if found.iter().any(|known| known.id == client.id) {
            continue;
        }
        let same_type = client.id == id
            || same_need.contains(&client.id)
            || described.as_deref().is_some_and(|url| url.trim_end_matches('/') == client.base_url.trim_end_matches('/'));
        if same_type {
            found.push(client);
        }
    }
    found
}

/// Compte choisi pour un besoin : `instance` (un compte de son propre service) ou `client/instance` (le compte d’un
/// autre service du même type).
pub fn split_account(value: &str) -> (Option<&str>, &str) {
    match value.split_once('/') {
        Some((client, instance)) => (Some(client), instance),
        None => (None, value),
    }
}

/// Référence déclarée, sans le suffixe d’une copie.
pub fn base(reference: &str) -> &str {
    reference.split('@').next().unwrap_or(reference)
}

fn suffix(reference: &str) -> Option<&str> {
    reference.split_once('@').map(|(_, suffix)| suffix)
}

/// Besoins d’un modèle : celui que suit la page, puis ceux de la page et de son panneau.
pub fn needs_of(page: &ResolvedPage) -> Vec<String> {
    let mut needs: Vec<String> = Vec::new();
    let candidates = page
        .per_instance
        .iter()
        .chain(page.uses.clients.iter())
        .chain(page.panel.iter().flat_map(|panel| panel.uses.clients.iter()));
    for need in candidates {
        let need = need.trim();
        if !need.is_empty() && !needs.iter().any(|known| known == need) {
            needs.push(need.to_string());
        }
    }
    needs
}

/// Identifiants déjà pris (entrées, onglets, réglages d’affichage restés) : une copie nouvelle n’hérite de rien.
fn used_ids(menu: &[MenuPage], overrides: &BTreeMap<String, Override>) -> BTreeSet<String> {
    let mut used = BTreeSet::new();
    for entry in menu {
        used.insert(entry.id.clone());
        for tab in &entry.tabs {
            used.insert(tab.id.clone());
        }
    }
    for key in overrides.keys() {
        if let Some((_, reference)) = key.split_once(':') {
            used.insert(reference.to_string());
        }
    }
    used
}

/// Référence libre pour une copie de `declared` : elle-même si personne ne l’a, sinon avec un suffixe tiré du nom
/// demandé (ou d’un numéro).
fn unique(declared: &str, wanted: Option<&str>, used: &BTreeSet<String>) -> String {
    if !used.contains(declared) {
        return declared.to_string();
    }
    let stem = wanted.map(slug).filter(|stem| valid_id(stem) && stem != "element");
    if let Some(stem) = &stem {
        let candidate = format!("{declared}@{stem}");
        if !used.contains(&candidate) {
            return candidate;
        }
    }
    let stem = stem.unwrap_or_default();
    (2..)
        .map(|index| if stem.is_empty() { format!("{declared}@{index}") } else { format!("{declared}@{stem}-{index}") })
        .find(|candidate| !used.contains(candidate))
        .unwrap_or_default()
}

/// Ce que la vue calculée tire du menu : sections du menu et usage des comptes.
pub struct ResolvedMenu {
    pub sections: Vec<ResolvedSection>,
    /// `client/instance` → onglets qui s’en servent.
    pub usage: BTreeMap<String, Vec<String>>,
}

impl Space {
    /// Menu à afficher : celui de l’utilisateur, complété des modèles qu’il n’a encore jamais vus (un module installé,
    /// une page ajoutée par l’agent ou par une mise à jour), chacun ajouté une fois. Un espace d’avant ce menu le
    /// reçoit d’après les règles d’alors (pages par compte, comptes en onglets), pour que rien ne bouge.
    pub(crate) fn effective_menu(
        &self,
        manifest: &SpaceManifest,
        declared: &[ResolvedSection],
        problems: &mut Vec<Problem>,
    ) -> (Vec<MenuPage>, Vec<String>) {
        let (mut menu, mut known) = match &manifest.layout.menu {
            Some(menu) => (menu.clone(), manifest.layout.menu_templates.clone()),
            None => {
                let (legacy, _, _) = self.expand_instances(declared.to_vec(), manifest, problems);
                let known = declared.iter().flat_map(|section| section.pages.iter().map(|page| page.reference.clone()));
                (self.legacy_menu(&legacy, declared), known.collect())
            }
        };
        for section in declared {
            for page in &section.pages {
                if known.contains(&page.reference) {
                    continue;
                }
                known.push(page.reference.clone());
                let used = used_ids(&menu, &manifest.layout.overrides);
                let tab = MenuTab {
                    id: unique(&page.reference, None, &used),
                    page: page.reference.clone(),
                    ..MenuTab::default()
                };
                match menu.iter_mut().find(|entry| entry.section == section.id) {
                    Some(entry) => entry.tabs.push(tab),
                    None => menu.push(MenuPage {
                        id: unique(&section.id, None, &used),
                        section: section.id.clone(),
                        tabs: vec![tab],
                        ..MenuPage::default()
                    }),
                }
            }
        }
        (menu, known)
    }

    /// Menu d’un espace d’avant : chaque entrée et chaque onglet que montraient les règles d’alors, avec leurs
    /// références, leur compte et leur nom par défaut.
    fn legacy_menu(&self, legacy: &[ResolvedSection], declared: &[ResolvedSection]) -> Vec<MenuPage> {
        let label_of = |module: &str, need: &str, instance: &str| -> String {
            crate::clients::client_for(self, module, need)
                .ok()
                .and_then(|client| {
                    client.instances.iter().find(|known| known.id == instance).map(|known| known.display_label().to_string())
                })
                .unwrap_or_else(|| instance.to_string())
        };
        legacy
            .iter()
            .map(|section| {
                let template = section.instance_of.clone().unwrap_or_else(|| section.id.clone());
                let base_label =
                    declared.iter().find(|known| known.id == template).map(|known| known.label.clone()).unwrap_or_default();
                // Une copie par compte s’appelait « Section — Compte ».
                let label = match (&section.instance, &section.per_instance) {
                    (Some(instance), Some(need)) => {
                        Some(format!("{base_label} — {}", label_of(&section.module, need, instance)))
                    }
                    _ => None,
                };
                // Comptes en onglets : l’onglet portait le nom du compte, ou « Page — Compte ».
                let tabs_mode = section.instance.is_none() && section.pages.iter().any(|page| page.instance.is_some());
                let tabs = section
                    .pages
                    .iter()
                    .map(|page| {
                        let mut accounts = BTreeMap::new();
                        let mut label = None;
                        if let (Some(instance), Some(need)) = (&page.instance, &page.per_instance) {
                            accounts.insert(need.clone(), instance.clone());
                            if tabs_mode {
                                let declared_title = declared
                                    .iter()
                                    .flat_map(|known| known.pages.iter())
                                    .find(|known| known.reference == base(&page.reference))
                                    .map(|known| known.title.clone())
                                    .unwrap_or_default();
                                let account = label_of(&page.module, need, instance);
                                let same = section.pages.iter().filter(|other| other.instance == page.instance).count();
                                label = Some(if same > 1 { format!("{declared_title} — {account}") } else { account });
                            }
                        }
                        MenuTab {
                            id: page.reference.clone(),
                            page: base(&page.reference).to_string(),
                            label,
                            icon: None,
                            accounts,
                        }
                    })
                    .collect();
                MenuPage { id: section.id.clone(), section: template, label, icon: None, tabs }
            })
            .collect()
    }

    /// Sections du menu : chaque page de l’utilisateur avec ses onglets, leurs comptes et ce qu’ils attendent.
    pub(crate) fn resolve_menu(
        &self,
        menu: &[MenuPage],
        declared: &[ResolvedSection],
        templates: &[ResolvedPage],
        elsewhere: &BTreeSet<String>,
        manifest: &SpaceManifest,
        problems: &mut Vec<Problem>,
    ) -> ResolvedMenu {
        let overrides = &manifest.layout.overrides;
        let mut usage: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut sections = Vec::new();
        for entry in menu {
            let mut pages = Vec::new();
            for tab in &entry.tabs {
                // Un modèle supprimé (ou rangé dans les Réglages) : l’onglet attend, caché, qu’il revienne ; annuler la
                // suppression le remet à sa place.
                let Some(template) = templates.iter().find(|page| page.reference == tab.page) else { continue };
                let page = self.tab_page(template, tab, overrides, &mut usage);
                pages.push(page);
            }
            // Une page dont tous les modèles ont disparu n’a plus rien à montrer ; une page vidée par un
            // déplacement reste, comme une section sans onglet.
            if pages.is_empty() && !entry.tabs.is_empty() && entry.tabs.iter().all(|tab| !elsewhere.contains(&tab.page)) {
                continue;
            }
            let _ = &problems;
            let own = overrides.get(&format!("section:{}", entry.id));
            let mut section = match declared.iter().find(|known| known.id == entry.section) {
                Some(known) => known.clone(),
                None => ResolvedSection {
                    id: entry.section.clone(),
                    module: pages.first().map(|page| page.module.clone()).unwrap_or_else(|| base(&entry.section).split('/').next().unwrap_or_default().to_string()),
                    label: pages.first().map(|page| page.title.clone()).unwrap_or_else(|| entry.section.clone()),
                    icon: None,
                    icon_url: None,
                    color: None,
                    hidden: false,
                    pages: Vec::new(),
                    per_instance: None,
                    instances_as: Default::default(),
                    instance: None,
                    instance_of: None,
                    waiting: None,
                },
            };
            let base_override = overrides.get(&format!("section:{}", entry.section));
            if entry.id != entry.section {
                section.hidden = section.hidden || own.is_some_and(|o| o.hidden);
                section.color = own.and_then(|o| o.color.clone()).or(section.color);
                section.instance_of = Some(entry.section.clone());
            }
            // Le nom : celui donné dans le menu, sinon celui choisi à la création, sinon celui de la section.
            if let Some(label) = own.and_then(|o| o.label.clone()) {
                section.label = label;
            } else if let Some(label) = &entry.label {
                section.label = label.clone();
            }
            let own_icon = own.and_then(|o| o.icon.clone());
            if let Some(icon) = own_icon.or_else(|| {
                // L’icône choisie à la création passe après celle donnée dans le menu à la section elle-même.
                let base_icon = if entry.id == entry.section { base_override.and_then(|o| o.icon.clone()) } else { None };
                base_icon.is_none().then(|| entry.icon.clone()).flatten()
            }) {
                section.icon_url = None;
                section.icon = Some(icon);
            }
            section.per_instance = pages.iter().find_map(|page| page.per_instance.clone());
            section.instance = None;
            section.waiting = None;
            section.pages = pages;
            section.id = entry.id.clone();
            sections.push(section);
        }
        ResolvedMenu { sections, usage }
    }

    /// Onglet d’une page de l’utilisateur : la copie du modèle sous sa référence, avec ses comptes.
    fn tab_page(
        &self,
        template: &ResolvedPage,
        tab: &MenuTab,
        overrides: &BTreeMap<String, Override>,
        usage: &mut BTreeMap<String, Vec<String>>,
    ) -> ResolvedPage {
        let own = overrides.get(&format!("page:{}", tab.id));
        let mut page = template.clone();
        if tab.id != template.reference {
            page.title = own.and_then(|o| o.label.clone()).or_else(|| tab.label.clone()).unwrap_or(page.title);
            page.icon = own.and_then(|o| o.icon.clone()).or_else(|| tab.icon.clone()).or(page.icon);
            page.hidden = page.hidden || own.is_some_and(|o| o.hidden);
        } else {
            // Première copie : son réglage d’affichage est celui de la page déclarée, déjà appliqué.
            if own.and_then(|o| o.label.as_ref()).is_none() {
                if let Some(label) = &tab.label {
                    page.title = label.clone();
                }
            }
            if own.and_then(|o| o.icon.as_ref()).is_none() {
                if let Some(icon) = &tab.icon {
                    page.icon = Some(icon.clone());
                }
            }
        }
        page.reference = tab.id.clone();
        page.panel = template.panel.as_ref().map(|panel| {
            let mut copy = (**panel).clone();
            if let Some(suffix) = suffix(&tab.id) {
                copy.reference = format!("{}@{suffix}", panel.reference);
                let own = overrides.get(&format!("page:{}", copy.reference));
                copy.title = own.and_then(|o| o.label.clone()).unwrap_or(copy.title);
                copy.hidden = copy.hidden || own.is_some_and(|o| o.hidden);
            }
            Box::new(copy)
        });

        let mut accounts = BTreeMap::new();
        let mut waiting = None;
        for need in needs_of(template) {
            let follows = template.per_instance.as_deref() == Some(need.as_str());
            match crate::clients::client_for(self, &template.module, &need) {
                // Sans compte à lui, sauf si l’utilisateur a choisi celui d’un autre service du même type.
                Ok(client) if client.instances.is_empty() && !tab.accounts.get(&need).is_some_and(|value| value.contains('/')) => {
                    if follows && waiting.is_none() {
                        waiting = Some(format!(
                            "Le service « {} » n’a encore aucun compte. En ajouter un dans Réglages → Modules, fiche du module, puis le choisir pour cette page.",
                            client.label
                        ));
                    }
                }
                Ok(client) => {
                    let chosen = match tab.accounts.get(&need).map(|value| (value, split_account(value))) {
                        Some((value, (None, instance))) if client.instances.iter().any(|known| known.id == instance) => {
                            Some((client.id.clone(), value.clone(), instance.to_string()))
                        }
                        // Le compte d’un autre service du même type.
                        Some((value, (Some(other), instance)))
                            if compatible_clients(self, &template.module, &need).iter().any(|candidate| {
                                candidate.id == other && candidate.instances.iter().any(|known| known.id == instance)
                            }) =>
                        {
                            Some((other.to_string(), value.clone(), instance.to_string()))
                        }
                        Some((value, _)) => {
                            if waiting.is_none() {
                                waiting = Some(format!(
                                    "Le compte « {value} » choisi pour cette page n’existe plus. Choisir un autre compte dans Réglages → Modules, fiche du module."
                                ));
                            }
                            None
                        }
                        // Pas de choix : le seul compte du service ; s’il en a plusieurs, rien n’est deviné.
                        None if follows && client.instances.len() == 1 => {
                            let only = client.instances[0].id.clone();
                            Some((client.id.clone(), only.clone(), only))
                        }
                        None if follows => {
                            if waiting.is_none() {
                                waiting = Some(format!(
                                    "Le service « {} » a plusieurs comptes : choisir celui de cette page dans Réglages → Modules, fiche du module.",
                                    client.label
                                ));
                            }
                            None
                        }
                        // Ailleurs, les fonctions appellent le compte par défaut : la page s’en sert aussi.
                        None => {
                            if let Some(first) = client.instances.first() {
                                usage.entry(account_key(&client.id, &first.id)).or_default().push(tab.id.clone());
                            }
                            None
                        }
                    };
                    if let Some((owner, value, instance)) = chosen {
                        usage.entry(account_key(&owner, &instance)).or_default().push(tab.id.clone());
                        accounts.insert(need.clone(), value);
                    }
                }
                Err(error) => {
                    if follows && waiting.is_none() {
                        waiting = Some(error.message);
                    }
                }
            }
        }
        // Compatibilité : `instance` reste le compte d’une page qui n’en a qu’un, ou celui qu’elle suit.
        page.instance = match &template.per_instance {
            Some(need) => accounts.get(need).cloned(),
            None if accounts.len() == 1 => accounts.values().next().cloned(),
            None => None,
        };
        if let Some(panel) = page.panel.as_mut() {
            panel.instance = page.instance.clone();
            panel.accounts = accounts.clone();
            panel.template = template.panel.as_ref().map(|panel| panel.reference.clone()).unwrap_or_default();
        }
        page.template = template.reference.clone();
        page.accounts = accounts;
        page.waiting = waiting;
        page
    }

    /// Écrit le menu calculé quand il diffère de celui du disque (espace d’avant, modèles nouveaux). Renvoie vrai
    /// s’il a changé.
    pub fn persist_menu(&self) -> AppResult<bool> {
        let snapshot = self.snapshot()?;
        let Some((menu, known)) = snapshot.pending_menu else { return Ok(false) };
        let mut manifest = self.manifest()?;
        manifest.layout.menu = Some(menu);
        manifest.layout.menu_templates = known;
        self.write_manifest(&manifest)?;
        Ok(true)
    }

    /// Menu écrit sur le disque, après y avoir repris ce qui manquait.
    fn stored_manifest(&self) -> AppResult<SpaceManifest> {
        self.persist_menu()?;
        self.manifest()
    }

    /// Vérifie les comptes demandés pour un modèle : des besoins du modèle, des comptes qui existent.
    fn check_accounts(&self, template: &PageTemplate, accounts: &BTreeMap<String, String>) -> AppResult<()> {
        for (need, value) in accounts {
            if !template.needs.contains(need) {
                return Err(AppError::new(format!(
                    "La page « {} » n’a pas besoin du service « {need} ».",
                    template.title
                )));
            }
            let (other, instance) = split_account(value);
            let client = match other {
                None => crate::clients::client_for(self, &template.module, need)?,
                Some(other) => compatible_clients(self, &template.module, need)
                    .into_iter()
                    .find(|candidate| candidate.id == other)
                    .ok_or_else(|| {
                        AppError::new(format!("Le service « {other} » ne peut pas servir au besoin « {need} » de cette page."))
                    })?,
            };
            if !client.instances.iter().any(|known| known.id == instance) {
                return Err(AppError::new(format!(
                    "Le service « {} » n’a pas de compte « {instance} ».",
                    client.label
                )));
            }
        }
        Ok(())
    }

    fn new_tabs(
        &self,
        templates: &[PageTemplate],
        tabs: Vec<NewTab>,
        used: &mut BTreeSet<String>,
    ) -> AppResult<Vec<MenuTab>> {
        let mut created = Vec::new();
        for tab in tabs {
            let template = templates
                .iter()
                .find(|known| known.reference == tab.page)
                .ok_or_else(|| AppError::new(format!("Le modèle de page « {} » n’existe pas.", tab.page)))?;
            self.check_accounts(template, &tab.accounts)?;
            let label = tab.label.map(|label| label.trim().to_string()).filter(|label| !label.is_empty());
            let wanted = label.clone().or_else(|| tab.accounts.values().next().cloned());
            let id = unique(&template.reference, wanted.as_deref(), used);
            used.insert(id.clone());
            created.push(MenuTab { id, page: template.reference.clone(), label, icon: None, accounts: tab.accounts });
        }
        Ok(created)
    }

    /// Ajoute une page de l’utilisateur : une entrée du menu, avec l’apparence de la section `section` et les
    /// onglets demandés. Renvoie son identifiant.
    pub fn add_menu_page(
        &self,
        section: &str,
        tabs: Vec<NewTab>,
        label: Option<String>,
        icon: Option<String>,
    ) -> AppResult<String> {
        let mut manifest = self.stored_manifest()?;
        let snapshot = self.snapshot()?;
        if !snapshot.section_templates.iter().any(|known| known.id == section) {
            return Err(AppError::new(format!("La section « {section} » n’existe pas.")));
        }
        if tabs.is_empty() {
            return Err(AppError::new("Une page a au moins un onglet : choisir un modèle."));
        }
        let menu = manifest.layout.menu.get_or_insert_with(Vec::new);
        let mut used = used_ids(menu, &manifest.layout.overrides);
        let label = label.map(|label| label.trim().to_string()).filter(|label| !label.is_empty());
        let wanted = label.clone().or_else(|| tabs.iter().find_map(|tab| tab.accounts.values().next().cloned()));
        let id = unique(section, wanted.as_deref(), &used);
        used.insert(id.clone());
        let tabs = self.new_tabs(&snapshot.templates, tabs, &mut used)?;
        let icon = icon.map(|icon| icon.trim().to_string()).filter(|icon| !icon.is_empty());
        menu.push(MenuPage { id: id.clone(), section: section.to_string(), label, icon, tabs });
        self.write_manifest(&manifest)?;
        Ok(id)
    }

    /// Ajoute un onglet à une page de l’utilisateur. Renvoie sa référence.
    pub fn add_menu_tab(&self, entry: &str, tab: NewTab) -> AppResult<String> {
        let mut manifest = self.stored_manifest()?;
        let snapshot = self.snapshot()?;
        let overrides = manifest.layout.overrides.clone();
        let menu = manifest.layout.menu.get_or_insert_with(Vec::new);
        let mut used = used_ids(menu, &overrides);
        let created = self.new_tabs(&snapshot.templates, vec![tab], &mut used)?;
        let page = menu
            .iter_mut()
            .find(|known| known.id == entry)
            .ok_or_else(|| AppError::new(format!("La page « {entry} » n’existe pas.")))?;
        let id = created[0].id.clone();
        page.tabs.extend(created);
        self.write_manifest(&manifest)?;
        Ok(id)
    }

    /// Renomme une page ou un onglet, change son icône ou, pour un onglet, ses comptes. Un nom vide rend celui du
    /// modèle.
    pub fn configure_menu_item(
        &self,
        target: &str,
        label: Option<String>,
        icon: Option<String>,
        accounts: Option<BTreeMap<String, String>>,
    ) -> AppResult<()> {
        let mut manifest = self.stored_manifest()?;
        let snapshot = self.snapshot()?;
        let clean = |value: Option<String>| value.map(|text| text.trim().to_string());
        let (label, icon) = (clean(label), clean(icon));
        let menu = manifest.layout.menu.get_or_insert_with(Vec::new);
        let key;
        if let Some(entry) = menu.iter_mut().find(|known| known.id == target) {
            if accounts.is_some() {
                return Err(AppError::new("Les comptes se choisissent onglet par onglet."));
            }
            if let Some(label) = label.clone() {
                entry.label = Some(label).filter(|label| !label.is_empty());
            }
            if let Some(icon) = icon.clone() {
                entry.icon = Some(icon).filter(|icon| !icon.is_empty());
            }
            key = format!("section:{target}");
        } else {
            let tab = menu
                .iter_mut()
                .flat_map(|entry| entry.tabs.iter_mut())
                .find(|known| known.id == target)
                .ok_or_else(|| AppError::new(format!("La page ou l’onglet « {target} » n’existe pas.")))?;
            if let Some(accounts) = accounts {
                let template = snapshot
                    .templates
                    .iter()
                    .find(|known| known.reference == tab.page)
                    .ok_or_else(|| AppError::new(format!("Le modèle de page « {} » n’existe plus.", tab.page)))?;
                self.check_accounts(template, &accounts)?;
                tab.accounts = accounts;
            }
            if let Some(label) = label.clone() {
                tab.label = Some(label).filter(|label| !label.is_empty());
            }
            if let Some(icon) = icon.clone() {
                tab.icon = Some(icon).filter(|icon| !icon.is_empty());
            }
            key = format!("page:{target}");
        }
        // Le nom ou l’icône donnés ici remplacent ceux donnés dans le menu.
        if let Some(entry) = manifest.layout.overrides.get_mut(&key) {
            if label.is_some() {
                entry.label = None;
            }
            if icon.is_some() {
                entry.icon = None;
            }
            if *entry == Override::default() {
                manifest.layout.overrides.remove(&key);
            }
        }
        self.write_manifest(&manifest)
    }

    /// Retire une page de l’utilisateur ou l’un de ses onglets (une page sans onglet disparaît). Les données du
    /// module restent ; seuls ses réglages d’affichage s’en vont.
    pub fn remove_menu_item(&self, target: &str) -> AppResult<()> {
        let mut manifest = self.stored_manifest()?;
        let snapshot = self.snapshot()?;
        let menu = manifest.layout.menu.get_or_insert_with(Vec::new);
        let mut gone_sections = Vec::new();
        let mut gone_pages = Vec::new();
        if let Some(index) = menu.iter().position(|known| known.id == target) {
            let entry = menu.remove(index);
            gone_sections.push(entry.id);
            gone_pages.extend(entry.tabs.into_iter().map(|tab| tab.id));
        } else {
            let entry = menu
                .iter_mut()
                .find(|entry| entry.tabs.iter().any(|tab| tab.id == target))
                .ok_or_else(|| AppError::new(format!("La page ou l’onglet « {target} » n’existe pas.")))?;
            entry.tabs.retain(|tab| tab.id != target);
            gone_pages.push(target.to_string());
            if entry.tabs.is_empty() {
                gone_sections.push(entry.id.clone());
                let id = entry.id.clone();
                menu.retain(|known| known.id != id);
            }
        }
        // Le panneau d’une copie porte son suffixe : ses réglages s’en vont avec elle.
        let panels: Vec<String> = snapshot
            .sections
            .iter()
            .flat_map(|section| section.pages.iter())
            .filter(|page| gone_pages.contains(&page.reference) && page.reference.contains('@'))
            .filter_map(|page| page.panel.as_ref().map(|panel| panel.reference.clone()))
            .collect();
        let layout = &mut manifest.layout;
        layout.sections.retain(|id| !gone_sections.contains(id));
        for id in &gone_sections {
            layout.tabs.remove(id);
            layout.overrides.remove(&format!("section:{id}"));
        }
        for pages in layout.tabs.values_mut() {
            pages.retain(|page| !gone_pages.contains(page));
        }
        for page in gone_pages.iter().chain(&panels) {
            layout.overrides.remove(&format!("page:{page}"));
        }
        self.write_manifest(&manifest)
    }

    /// Déplace une page de l’utilisateur dans le menu, ou un onglet dans sa page, de `delta` places.
    pub fn move_menu_item(&self, target: &str, delta: i64) -> AppResult<()> {
        let mut manifest = self.stored_manifest()?;
        let snapshot = self.snapshot()?;
        let shift = |order: &mut Vec<String>| -> bool {
            let Some(index) = order.iter().position(|id| id == target) else { return false };
            let next = (index as i64 + delta).clamp(0, order.len() as i64 - 1) as usize;
            let item = order.remove(index);
            order.insert(next, item);
            true
        };
        let mut sections: Vec<String> = snapshot.sections.iter().map(|section| section.id.clone()).collect();
        if shift(&mut sections) {
            manifest.layout.sections = sections;
            return self.write_manifest(&manifest);
        }
        for section in &snapshot.sections {
            let mut pages: Vec<String> = section.pages.iter().map(|page| page.reference.clone()).collect();
            if shift(&mut pages) {
                manifest.layout.tabs.insert(section.id.clone(), pages);
                return self.write_manifest(&manifest);
            }
        }
        Err(AppError::new(format!("La page ou l’onglet « {target} » n’est pas dans le menu.")))
    }

    /// Emplacements changés par la coquille (« Déplacer vers ») : l’onglet suit la page dans le menu. Une page qui
    /// rejoint les Réglages quitte le menu ; une page qui en revient devient un onglet de sa nouvelle section.
    pub fn apply_placements(&self, before: &crate::space::Layout) -> AppResult<()> {
        let manifest = self.stored_manifest()?;
        for (key, value) in &manifest.layout.overrides {
            let Some(reference) = key.strip_prefix("page:") else { continue };
            let previous = before.overrides.get(key).and_then(|o| o.placement.as_ref());
            if value.placement.as_ref() == previous {
                continue;
            }
            match &value.placement {
                Some(crate::space::Placement::Tab { section }) => {
                    let manifest = self.manifest()?;
                    let menu = manifest.layout.menu.clone().unwrap_or_default();
                    let target = menu
                        .iter()
                        .find(|entry| &entry.id == section)
                        .or_else(|| menu.iter().find(|entry| &entry.section == section))
                        .map(|entry| entry.id.clone());
                    let present = menu.iter().any(|entry| entry.tabs.iter().any(|tab| tab.id == reference));
                    match target {
                        Some(target) if present => self.move_menu_tab(reference, &target)?,
                        Some(target) => {
                            let mut manifest = manifest;
                            if let Some(entry) =
                                manifest.layout.menu.get_or_insert_with(Vec::new).iter_mut().find(|entry| entry.id == target)
                            {
                                entry.tabs.push(MenuTab {
                                    id: reference.to_string(),
                                    page: base(reference).to_string(),
                                    ..MenuTab::default()
                                });
                            }
                            self.write_manifest(&manifest)?;
                        }
                        None => {}
                    }
                }
                Some(_) => {
                    let mut manifest = self.manifest()?;
                    if let Some(menu) = manifest.layout.menu.as_mut() {
                        for entry in menu.iter_mut() {
                            entry.tabs.retain(|tab| tab.id != reference);
                        }
                    }
                    self.write_manifest(&manifest)?;
                }
                None => {}
            }
        }
        Ok(())
    }

    /// Déplace un onglet vers une autre page de l’utilisateur ; sa référence ne change pas.
    pub fn move_menu_tab(&self, tab: &str, to: &str) -> AppResult<()> {
        let mut manifest = self.stored_manifest()?;
        let menu = manifest.layout.menu.get_or_insert_with(Vec::new);
        if !menu.iter().any(|entry| entry.id == to) {
            return Err(AppError::new(format!("La page « {to} » n’existe pas.")));
        }
        let from = menu
            .iter_mut()
            .find(|entry| entry.tabs.iter().any(|known| known.id == tab))
            .ok_or_else(|| AppError::new(format!("L’onglet « {tab} » n’existe pas.")))?;
        if from.id == to {
            return Ok(());
        }
        let index = from.tabs.iter().position(|known| known.id == tab).unwrap_or_default();
        let moved = from.tabs.remove(index);
        if let Some(target) = menu.iter_mut().find(|entry| entry.id == to) {
            target.tabs.push(moved);
        }
        // Une page vidée par le déplacement reste, sans onglet, comme une section : on la retire à part. L’ordre
        // des onglets de la page d’arrivée, s’il nomme déjà l’onglet, est gardé.
        for (entry, pages) in manifest.layout.tabs.iter_mut() {
            if entry != to {
                pages.retain(|page| page != tab);
            }
        }
        self.write_manifest(&manifest)
    }
}

/// Oublie dans le menu ce qui vient d’un module retiré.
pub fn forget_module(manifest: &mut SpaceManifest, module: &str) {
    let prefix = format!("{module}/");
    if let Some(menu) = manifest.layout.menu.as_mut() {
        for entry in menu.iter_mut() {
            entry.tabs.retain(|tab| !tab.page.starts_with(&prefix));
        }
        menu.retain(|entry| !entry.tabs.is_empty() && !entry.section.starts_with(&prefix));
    }
    manifest.layout.menu_templates.retain(|template| !template.starts_with(&prefix));
}

/// Réécrit les références du menu après une fusion ou une scission de modules.
pub fn rewrite(manifest: &mut SpaceManifest, map: &dyn Fn(&str) -> String) {
    if let Some(menu) = manifest.layout.menu.as_mut() {
        for entry in menu.iter_mut() {
            entry.id = map(&entry.id);
            entry.section = map(&entry.section);
            for tab in entry.tabs.iter_mut() {
                tab.id = map(&tab.id);
                tab.page = map(&tab.page);
            }
        }
    }
    manifest.layout.menu_templates = manifest.layout.menu_templates.iter().map(|template| map(template)).collect();
}

/// Modèles de la vue : les pages déclarées en onglet d’une section, avec leurs besoins.
pub fn templates(declared: &[ResolvedSection]) -> (Vec<PageTemplate>, Vec<SectionTemplate>) {
    let mut pages = Vec::new();
    let mut sections = Vec::new();
    for section in declared {
        for page in &section.pages {
            pages.push(PageTemplate {
                reference: page.reference.clone(),
                module: page.module.clone(),
                title: page.title.clone(),
                icon: page.icon.clone(),
                description: page.description.clone(),
                section: section.id.clone(),
                needs: needs_of(page),
                per_instance: page.per_instance.clone(),
            });
        }
        sections.push(SectionTemplate {
            id: section.id.clone(),
            module: section.module.clone(),
            label: section.label.clone(),
            icon: section.icon.clone(),
            icon_url: section.icon_url.clone(),
            color: section.color.clone(),
            pages: section.pages.iter().map(|page| page.reference.clone()).collect(),
        });
    }
    (pages, sections)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::clients::testing::*;
    use crate::space::{ClientNeed, InstancesAs, PlaceTarget};

    /// Ce que montre le menu : chaque entrée (identifiant, nom, masquée) et ses onglets (référence, titre, compte,
    /// masqué, en attente).
    type Shown = Vec<(String, String, bool, Vec<(String, String, Option<String>, bool, bool)>)>;

    fn shown(space: &Space) -> Shown {
        space
            .snapshot()
            .unwrap()
            .sections
            .into_iter()
            .map(|section| {
                let pages = section
                    .pages
                    .into_iter()
                    .map(|page| (page.reference, page.title, page.instance, page.hidden, page.waiting.is_some()))
                    .collect();
                (section.id, section.label, section.hidden, pages)
            })
            .collect()
    }

    fn tab(reference: &str, title: &str, instance: Option<&str>) -> (String, String, Option<String>, bool, bool) {
        (reference.into(), title.into(), instance.map(str::to_string), false, false)
    }

    /// Le fichier d’un client à plusieurs comptes, tel qu’un espace l’a écrit.
    fn write_client(space: &Space, id: &str, instances: &[(&str, &str)]) {
        let instances: Vec<Value> = instances
            .iter()
            .map(|(id, label)| json!({ "id": id, "label": label, "url": "https://service.example.com", "method": "web" }))
            .collect();
        std::fs::create_dir_all(space.root.join("clients")).unwrap();
        std::fs::write(
            space.root.join(format!("clients/{id}.json")),
            json!({ "id": id, "label": id, "methods": [{ "id": "web", "label": "Web", "type": "none" }], "instances": instances })
                .to_string(),
        )
        .unwrap();
    }

    /// Un module « jira » : Accueil commune, Tickets et Sprints pour chaque compte (`perInstance`).
    fn jira_module(space: &Space) {
        let menu = PlaceTarget::Menu { label: "Jira".into(), icon: None, color: None };
        space.place_page("Accueil", None, "", &menu, None).unwrap();
        let tab = PlaceTarget::Tab { section: "jira/principal".into() };
        for title in ["Tickets", "Sprints"] {
            space.place_page(title, None, "", &tab, Some("jira")).unwrap();
        }
        let mut module = space.module("jira").unwrap();
        for page in module.pages.iter_mut().filter(|page| page.id != "accueil") {
            page.per_instance = Some("jira".into());
            page.uses.clients = vec!["jira".into()];
        }
        module.clients.push(ClientNeed { id: "jira".into(), label: "Jira".into(), ..Default::default() });
        space.write_module(&module).unwrap();
    }

    /// Un module « prefect » : Accueil commune, Déploiements (avec son panneau Historique) et Files pour chaque
    /// compte, dans une section aux comptes en onglets.
    fn prefect_module(space: &Space, tabs: bool) {
        let menu = PlaceTarget::Menu { label: "Prefect".into(), icon: None, color: None };
        space.place_page("Accueil", None, "", &menu, None).unwrap();
        let tab = PlaceTarget::Tab { section: "prefect/principal".into() };
        for title in ["Déploiements", "Files"] {
            space.place_page(title, None, "", &tab, Some("prefect")).unwrap();
        }
        let panel = PlaceTarget::Panel { page: "prefect/deploiements".into() };
        space.place_page("Historique", None, "", &panel, Some("prefect")).unwrap();
        let mut module = space.module("prefect").unwrap();
        if tabs {
            module.sections[0].instances_as = InstancesAs::Tabs;
        }
        for page in module.pages.iter_mut().filter(|page| ["deploiements", "files"].contains(&page.id.as_str())) {
            page.per_instance = Some("prefect".into());
        }
        module.clients.push(ClientNeed { id: "prefect".into(), label: "Prefect".into(), ..Default::default() });
        space.write_module(&module).unwrap();
    }

    /// `alfred.json` d’un espace d’avant les pages de l’utilisateur.
    fn legacy(space: &Space, account_pages: Option<Value>, layout: Value) {
        let mut manifest = json!({ "name": "Test", "layout": layout });
        if let Some(pages) = account_pages {
            manifest["accountPages"] = pages;
        }
        std::fs::write(space.root.join("alfred.json"), manifest.to_string()).unwrap();
        assert!(space.manifest().unwrap().layout.menu.is_none());
    }

    /// Pages par compte (`perInstance` + `accountPages`) : une entrée par compte qui a des pages, nommée
    /// « Section — Compte », plus la section des pages communes. Après la migration, le menu est le même, avec les
    /// mêmes références, noms, masquages et rangements ; il ne se refait pas.
    #[tokio::test]
    async fn migration_of_pages_per_account_keeps_the_menu() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        jira_module(&space);
        write_client(&space, "jira", &[("acme", "Acme"), ("desk", "Jira Desk")]);
        legacy(
            &space,
            Some(json!({ "jira/acme": ["jira/tickets", "jira/sprints"], "jira/desk": ["jira/tickets"] })),
            json!({
                "sections": ["jira/principal@desk"],
                "tabs": { "jira/principal@acme": ["jira/sprints@acme"] },
                "overrides": {
                    "page:jira/sprints@acme": { "label": "Mes sprints" },
                    "section:jira/principal@desk": { "hidden": true }
                }
            }),
        );
        let expected: Shown = vec![
            ("jira/principal@desk".into(), "Jira — Jira Desk".into(), true, vec![tab("jira/tickets@desk", "Tickets", Some("desk"))]),
            ("jira/principal".into(), "Jira".into(), false, vec![tab("jira/accueil", "Accueil", None)]),
            (
                "jira/principal@acme".into(),
                "Jira — Acme".into(),
                false,
                vec![tab("jira/sprints@acme", "Mes sprints", Some("acme")), tab("jira/tickets@acme", "Tickets", Some("acme"))],
            ),
        ];
        assert_eq!(shown(&space), expected);

        assert!(space.persist_menu().unwrap());
        assert!(!space.persist_menu().unwrap(), "la migration ne se refait pas");
        assert_eq!(shown(&space), expected);
        let manifest = space.manifest().unwrap();
        let menu = manifest.layout.menu.unwrap();
        let acme = menu.iter().find(|entry| entry.id == "jira/principal@acme").unwrap();
        assert_eq!((acme.section.as_str(), acme.label.as_deref()), ("jira/principal", Some("Jira — Acme")));
        assert_eq!(acme.tabs[0].accounts, BTreeMap::from([("jira".to_string(), "acme".to_string())]));
        assert_eq!(manifest.layout.menu_templates, ["jira/accueil", "jira/tickets", "jira/sprints"]);
        assert!(manifest.account_pages.is_some(), "accountPages reste pour une version d’avant");

        // Un compte ajouté ensuite n’entre dans aucune page ; le menu ne bouge pas.
        write_client(&space, "jira", &[("acme", "Acme"), ("desk", "Jira Desk"), ("neuf", "Neuf")]);
        assert_eq!(shown(&space), expected);
        let snapshot = space.snapshot().unwrap();
        assert_eq!(snapshot.account_usage["jira/acme"], ["jira/tickets@acme", "jira/sprints@acme"]);
        assert!(!snapshot.account_usage.contains_key("jira/neuf"));

        // Un compte supprimé : ses pages attendent, sans passer à un autre compte.
        write_client(&space, "jira", &[("acme", "Acme"), ("neuf", "Neuf")]);
        let desk = &space.snapshot().unwrap().sections[0];
        assert!(desk.pages[0].waiting.as_deref().unwrap().contains("n’existe plus"), "{:?}", desk.pages[0].waiting);
        assert_eq!(desk.pages[0].instance, None);
    }

    /// La migration s’écrit une seule fois, à l’ouverture de l’espace, dans son propre commit ; une autre ouverture
    /// n’écrit plus rien, et la vue ne fait jamais d’écriture.
    #[tokio::test]
    async fn the_migration_is_written_once_at_opening_in_its_own_commit() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        prefect_module(&space, true);
        write_client(&space, "prefect", &[("prod", "Prod")]);
        legacy(&space, Some(json!({ "prefect/prod": ["prefect/deploiements"] })), json!({ "sections": [] }));
        crate::git::commit_all(&space.root, "Espace d’avant").unwrap();
        let log = |space: &Space| crate::git::run(&space.root, &["log", "--format=%s"]).unwrap();
        invoke(&state, "space.snapshot", json!({})).await.unwrap();
        assert!(space.manifest().unwrap().layout.menu.is_none(), "la vue n’écrit rien");
        let path = space.root.to_string_lossy().to_string();
        invoke(&state, "space.open", json!({ "path": path, "existing": true })).await.unwrap();
        let history = log(&space);
        assert_eq!(history.lines().take(2).collect::<Vec<_>>(), ["Menu repris en pages personnalisables", "Ouverture de l’espace de travail"]);
        assert!(space.manifest().unwrap().layout.menu.is_some());
        invoke(&state, "space.open", json!({ "path": path, "existing": true })).await.unwrap();
        assert_eq!(log(&space).matches("Menu repris").count(), 1);
    }

    /// Comptes en onglets (`instancesAs: "tabs"`) : une seule entrée, un onglet par page de chaque compte, nommé
    /// d’après le compte (« Page — Compte » quand il en a plusieurs) ; le panneau suit le compte de son onglet.
    #[tokio::test]
    async fn migration_of_accounts_as_tabs_keeps_one_entry_with_its_tabs() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        prefect_module(&space, true);
        write_client(&space, "prefect", &[("prod", "Prod"), ("recette", "Recette")]);
        legacy(
            &space,
            Some(json!({ "prefect/prod": ["prefect/deploiements", "prefect/files"], "prefect/recette": ["prefect/deploiements"] })),
            json!({ "sections": [], "overrides": { "page:prefect/files@prod": { "hidden": true } } }),
        );
        let mut hidden_files = tab("prefect/files@prod", "Files — Prod", Some("prod"));
        hidden_files.3 = true;
        let expected: Shown = vec![(
            "prefect/principal".into(),
            "Prefect".into(),
            false,
            vec![
                tab("prefect/accueil", "Accueil", None),
                tab("prefect/deploiements@prod", "Déploiements — Prod", Some("prod")),
                tab("prefect/deploiements@recette", "Recette", Some("recette")),
                hidden_files,
            ],
        )];
        assert_eq!(shown(&space), expected);
        assert!(space.persist_menu().unwrap());
        assert_eq!(shown(&space), expected);
        let snapshot = space.snapshot().unwrap();
        let recette = &snapshot.sections[0].pages[2];
        let panel = recette.panel.as_ref().unwrap();
        assert_eq!((panel.reference.as_str(), panel.instance.as_deref()), ("prefect/historique@recette", Some("recette")));
        assert_eq!(recette.template, "prefect/deploiements");
        assert_eq!(recette.accounts, BTreeMap::from([("prefect".to_string(), "recette".to_string())]));
    }

    /// Un espace d’avant le choix par compte (`accountPages` absent) : chaque compte montre toutes ses pages. Un
    /// service sans compte : la page attend, et dit quoi faire.
    #[tokio::test]
    async fn migration_of_an_old_space_and_of_a_section_without_account() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        jira_module(&space);
        prefect_module(&space, false);
        write_client(&space, "jira", &[("acme", "Acme")]);
        write_client(&space, "prefect", &[]);
        legacy(&space, None, json!({ "sections": [] }));
        let before = shown(&space);
        let ids: Vec<&str> = before.iter().map(|(id, ..)| id.as_str()).collect();
        assert_eq!(ids, ["jira/principal", "jira/principal@acme", "prefect/principal"]);
        assert_eq!(before[1].3.len(), 2, "le compte d’avant garde toutes ses pages");
        let waiting: Vec<(&str, bool)> =
            before[2].3.iter().map(|(reference, _, _, _, waiting)| (reference.as_str(), *waiting)).collect();
        assert_eq!(
            waiting,
            [("prefect/accueil", false), ("prefect/deploiements", true), ("prefect/files", true)],
            "les pages qui montrent un compte attendent"
        );
        assert!(space.persist_menu().unwrap());
        assert_eq!(shown(&space), before);

        // Le premier compte arrive : la page qui l’attendait le montre, sans rien écrire.
        write_client(&space, "prefect", &[("prod", "Prod")]);
        let prefect = shown(&space).pop().unwrap();
        assert_eq!(prefect.3[1], tab("prefect/deploiements", "Déploiements", Some("prod")));
    }

    async fn prefect_with_two_accounts(state: &std::sync::Arc<crate::state::AppState>) -> (Remote, Remote) {
        let space = state.space().unwrap();
        prefect_module(&space, false);
        let mut module = space.module("prefect").unwrap();
        for page in module.pages.iter_mut() {
            page.uses.clients = vec!["prefect".into()];
        }
        space.write_module(&module).unwrap();
        space.persist_menu().unwrap();
        let (prod, recette) = (remote().await, remote().await);
        invoke(
            state,
            "clients.save",
            json!({ "client": { "id": "prefect", "label": "Prefect", "methods": [{ "id": "pat", "label": "PAT", "type": "bearer" }] } }),
        )
        .await
        .unwrap();
        let token = crate::clients::testing::unique("pat");
        invoke(state, "vault.save", json!({ "id": token, "label": "PAT", "kind": "token", "secrets": { "value": "jeton" } }))
            .await
            .unwrap();
        for (id, label, origin) in [("prod", "Prod", &prod.origin), ("recette", "Recette", &recette.origin)] {
            invoke(
                state,
                "clients.saveInstance",
                json!({ "client": "prefect", "create": true,
                    "instance": { "id": id, "label": label, "url": origin, "method": "pat", "secret": token } }),
            )
            .await
            .unwrap();
        }
        (prod, recette)
    }

    fn new_tab(page: &str, label: Option<&str>, account: Option<&str>) -> NewTab {
        NewTab {
            page: page.into(),
            label: label.map(str::to_string),
            accounts: account.map(|account| BTreeMap::from([("prefect".to_string(), account.to_string())])).unwrap_or_default(),
        }
    }

    /// Les pages de l’utilisateur : le même modèle ajouté deux fois avec deux comptes, une page à deux onglets qui
    /// ont chacun leur compte, puis renommer, changer de compte, ranger et retirer. Une fonction appelée depuis une
    /// page vise d’office le compte de la page.
    #[tokio::test]
    async fn user_pages_are_made_from_templates_each_with_its_accounts() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        let (prod, recette) = prefect_with_two_accounts(&state).await;

        // Deux comptes : rien n’est deviné, la page d’origine attend qu’on choisisse le sien.
        let first = &space.snapshot().unwrap().sections[0];
        assert_eq!(first.pages[1].instance, None);
        assert!(first.pages[1].waiting.as_deref().unwrap().contains("plusieurs comptes"), "{:?}", first.pages[1].waiting);
        let on_prod = || Some(BTreeMap::from([("prefect".to_string(), "prod".to_string())]));
        space.configure_menu_item("prefect/deploiements", None, None, on_prod()).unwrap();
        space.configure_menu_item("prefect/files", None, None, on_prod()).unwrap();
        let first = &space.snapshot().unwrap().sections[0];
        assert_eq!((first.pages[1].instance.as_deref(), first.pages[1].waiting.is_none()), (Some("prod"), true));
        assert!(!space.snapshot().unwrap().account_usage.contains_key("prefect/recette"));

        // Une deuxième page Prefect, pour le compte Recette.
        let id = space
            .add_menu_page(
                "prefect/principal",
                vec![new_tab("prefect/deploiements", None, Some("recette"))],
                Some("Prefect Recette".into()),
                Some("flask-conical".into()),
            )
            .unwrap();
        assert_eq!(id, "prefect/principal@prefect-recette");
        let snapshot = space.snapshot().unwrap();
        let added = snapshot.sections.iter().find(|section| section.id == id).unwrap();
        assert_eq!((added.label.as_str(), added.icon.as_deref()), ("Prefect Recette", Some("flask-conical")));
        assert_eq!(added.instance_of.as_deref(), Some("prefect/principal"));
        let page = &added.pages[0];
        assert_eq!((page.reference.as_str(), page.id.as_str()), ("prefect/deploiements@recette", "deploiements"));
        assert_eq!(page.instance.as_deref(), Some("recette"));
        assert_eq!(page.panel.as_ref().unwrap().reference, "prefect/historique@recette");
        assert_eq!(snapshot.account_usage["prefect/recette"], ["prefect/deploiements@recette"]);

        // Un onglet de plus dans la page d’origine, avec son propre compte.
        let tab_id = space
            .add_menu_tab("prefect/principal", new_tab("prefect/deploiements", Some("Recette"), Some("recette")))
            .unwrap();
        assert_eq!(tab_id, "prefect/deploiements@recette-2");
        let titles: Vec<(String, Option<String>)> = space.snapshot().unwrap().sections[0]
            .pages
            .iter()
            .map(|page| (page.title.clone(), page.instance.clone()))
            .collect();
        assert_eq!(
            titles,
            [
                ("Accueil".to_string(), None),
                ("Déploiements".to_string(), Some("prod".to_string())),
                ("Files".to_string(), Some("prod".to_string())),
                ("Recette".to_string(), Some("recette".to_string())),
            ]
        );

        // Une fonction appelée depuis l’onglet Recette joint le compte Recette, sans le nommer.
        let mut subject = function_subject("prefect");
        subject.reference = "prefect/deploiements".into();
        grant(&state, &subject, "prefect");
        subject.accounts = BTreeMap::from([("prefect".to_string(), "recette".to_string())]);
        request(&state, &subject, "prefect", json!({ "path": "/api/echo" })).await.unwrap();
        assert_eq!((prod.seen_paths().len(), recette.seen_paths().len()), (0, 1));
        // Elle peut toujours en nommer un autre.
        request(&state, &subject, "prefect", json!({ "path": "/api/echo", "instance": "prod" })).await.unwrap();
        assert_eq!(prod.seen_paths().len(), 1);

        // Renommer, changer de compte ; un compte inconnu ou un besoin étranger est refusé.
        space.configure_menu_item("prefect/principal", Some("Prefect Prod".into()), None, None).unwrap();
        let accounts = |instance: &str| Some(BTreeMap::from([("prefect".to_string(), instance.to_string())]));
        space.configure_menu_item("prefect/deploiements@recette-2", Some("Rec".into()), None, accounts("prod")).unwrap();
        let refused = space.configure_menu_item("prefect/deploiements", None, None, accounts("nope")).unwrap_err();
        assert!(refused.message.contains("pas de compte « nope »"), "{}", refused.message);
        let foreign = Some(BTreeMap::from([("jira".to_string(), "acme".to_string())]));
        let refused = space.configure_menu_item("prefect/deploiements", None, None, foreign).unwrap_err();
        assert!(refused.message.contains("n’a pas besoin"), "{}", refused.message);
        let snapshot = space.snapshot().unwrap();
        assert_eq!(snapshot.sections[0].label, "Prefect Prod");
        assert_eq!(snapshot.sections[0].pages[3].title, "Rec");
        assert_eq!(snapshot.sections[0].pages[3].instance.as_deref(), Some("prod"));

        // Un nom donné dans la fiche remplace celui donné dans le menu.
        let mut manifest = space.manifest().unwrap();
        manifest.layout.overrides.entry("page:prefect/files".into()).or_default().label = Some("Ancien".into());
        space.write_manifest(&manifest).unwrap();
        space.configure_menu_item("prefect/files", Some("Files Prod".into()), None, None).unwrap();
        assert_eq!(space.snapshot().unwrap().sections[0].pages[2].title, "Files Prod");
        assert!(!space.manifest().unwrap().layout.overrides.contains_key("page:prefect/files"));

        // Ranger : l’onglet Rec passe devant Files, la page Recette devant la page d’origine.
        space.move_menu_item("prefect/deploiements@recette-2", -1).unwrap();
        space.move_menu_item(&id, -1).unwrap();
        let snapshot = space.snapshot().unwrap();
        assert_eq!(snapshot.sections[0].id, id);
        let order: Vec<&str> = snapshot.sections[1].pages.iter().map(|page| page.reference.as_str()).collect();
        assert_eq!(
            order,
            ["prefect/accueil", "prefect/deploiements", "prefect/deploiements@recette-2", "prefect/files"]
        );

        // Déplacer un onglet vers l’autre page.
        space.move_menu_tab("prefect/files", &id).unwrap();
        assert_eq!(space.snapshot().unwrap().sections[0].pages.len(), 2);

        // Retirer un onglet, puis une page : leurs réglages d’affichage s’en vont ; le modèle ne revient pas.
        space.set_visibility("page:prefect/deploiements@recette-2", true).unwrap();
        space.remove_menu_item("prefect/deploiements@recette-2").unwrap();
        space.remove_menu_item(&id).unwrap();
        let manifest = space.manifest().unwrap();
        assert!(!manifest.layout.overrides.contains_key("page:prefect/deploiements@recette-2"));
        assert!(!manifest.layout.sections.contains(&id));
        let ids: Vec<String> = space.snapshot().unwrap().sections.into_iter().map(|section| section.id).collect();
        assert_eq!(ids, ["prefect/principal"]);
        assert!(!space.snapshot().unwrap().sections[0].pages.iter().any(|page| page.template == "prefect/files"));
        assert!(!space.persist_menu().unwrap(), "Files, retirée, ne revient pas");
    }

    /// Un compte créé pour un module (Bitbucket pour Atlassian) sert à la page d’un autre module qui a besoin de
    /// Bitbucket, même si ce module a son propre service : le choix de l’utilisateur vaut accord, et la fonction de
    /// l’autre module joint ce compte-là.
    #[tokio::test]
    async fn an_account_made_for_one_module_serves_a_page_of_another() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        let equipe = remote().await;
        // Module A, Atlassian : le service bitbucket et son compte « Équipe ».
        let menu = PlaceTarget::Menu { label: "Atlassian".into(), icon: None, color: None };
        space.place_page("Dépôts", None, "", &menu, None).unwrap();
        let mut atlassian = space.module("atlassian").unwrap();
        atlassian.clients.push(ClientNeed { id: "bitbucket".into(), label: "Bitbucket".into(), ..Default::default() });
        atlassian.pages[0].uses.clients = vec!["bitbucket".into()];
        space.write_module(&atlassian).unwrap();
        invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "bitbucket", "label": "Bitbucket", "methods": [{ "id": "pat", "label": "PAT", "type": "bearer" }] } }),
        )
        .await
        .unwrap();
        let token = crate::clients::testing::unique("pat");
        invoke(&state, "vault.save", json!({ "id": token, "label": "PAT", "kind": "token", "secrets": { "value": "jeton" } }))
            .await
            .unwrap();
        invoke(
            &state,
            "clients.saveInstance",
            json!({ "client": "bitbucket", "create": true,
                "instance": { "id": "equipe", "label": "Équipe", "url": equipe.origin, "method": "pat", "secret": token } }),
        )
        .await
        .unwrap();
        // Module B, Revues : il a besoin de Bitbucket, relié à un service à lui, sans compte.
        let menu = PlaceTarget::Menu { label: "Revues".into(), icon: None, color: None };
        space.place_page("Revues", None, "", &menu, None).unwrap();
        let mut revues = space.module("revues").unwrap();
        revues.clients.push(ClientNeed { id: "bitbucket".into(), label: "Bitbucket".into(), ..Default::default() });
        revues.pages[0].uses.clients = vec!["bitbucket".into()];
        revues.pages[0].per_instance = Some("bitbucket".into());
        space.write_module(&revues).unwrap();
        invoke(
            &state,
            "clients.save",
            json!({ "client": { "id": "bb-revues", "label": "Bitbucket (revues)", "methods": [{ "id": "pat", "label": "PAT", "type": "bearer" }] } }),
        )
        .await
        .unwrap();
        let mut manifest = space.manifest().unwrap();
        manifest.bindings.insert("revues/bitbucket".into(), "bb-revues".into());
        space.write_manifest(&manifest).unwrap();
        space.persist_menu().unwrap();

        // Le compte d’Atlassian est proposé à Revues, après son propre service.
        let snapshot = space.snapshot().unwrap();
        assert_eq!(snapshot.compatible_clients["revues/bitbucket"], ["bb-revues", "bitbucket"]);
        let waiting = snapshot.sections.iter().find(|section| section.id == "revues/principal").unwrap();
        assert!(waiting.pages[0].waiting.is_some(), "son propre service n’a aucun compte");

        // L’utilisateur le choisit : la page le montre, la fiche du compte le dit, et l’accord est donné du même geste.
        invoke(
            &state,
            "space.menu.configure",
            json!({ "target": "revues/revues", "accounts": { "bitbucket": "bitbucket/equipe" } }),
        )
        .await
        .unwrap();
        let snapshot = space.snapshot().unwrap();
        let page = &snapshot.sections.iter().find(|section| section.id == "revues/principal").unwrap().pages[0];
        assert_eq!((page.waiting.as_ref(), page.instance.as_deref()), (None, Some("bitbucket/equipe")));
        assert!(snapshot.account_usage["bitbucket/equipe"].contains(&"revues/revues".to_string()));

        // La fonction de Revues joint le compte d’Atlassian, sans question.
        let mut subject = function_subject("revues");
        subject.accounts = page.accounts.clone();
        request(&state, &subject, "bitbucket", json!({ "path": "/api/echo" })).await.unwrap();
        assert_eq!(equipe.seen_paths().len(), 1);
        // Ou en le nommant, comme le fait une page qui passe son `instance` à la fonction.
        let plain = function_subject("revues");
        request(&state, &plain, "bitbucket", json!({ "path": "/api/echo", "instance": "bitbucket/equipe" })).await.unwrap();
        assert_eq!(equipe.seen_paths().len(), 2);

        // Un service d’un autre type ne s’accepte pas.
        let foreign = Some(BTreeMap::from([("bitbucket".to_string(), "prefect/prod".to_string())]));
        assert!(space.configure_menu_item("revues/revues", None, None, foreign).is_err());
    }

    /// Un modèle nouveau (une page que l’agent ajoute au module) entre une fois au menu, dans sa section ; un module
    /// installé reçoit ses pages ; un modèle supprimé quitte le menu.
    #[tokio::test]
    async fn new_templates_enter_the_menu_once() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        jira_module(&space);
        space.persist_menu().unwrap();
        // Une copie de la page existe : le modèle nouveau rejoint la première page de sa section.
        space.add_menu_page("jira/principal", vec![NewTab { page: "jira/accueil".into(), ..NewTab::default() }], Some("Autre".into()), None).unwrap();
        let tab = PlaceTarget::Tab { section: "jira/principal".into() };
        space.place_page("Rapports", None, "", &tab, Some("jira")).unwrap();
        let rapports = |space: &Space| -> Vec<(String, String)> {
            space
                .snapshot()
                .unwrap()
                .sections
                .iter()
                .flat_map(|section| {
                    section.pages.iter().filter(|page| page.template == "jira/rapports").map(|page| (section.id.clone(), page.reference.clone()))
                })
                .collect()
        };
        assert_eq!(rapports(&space), [("jira/principal".to_string(), "jira/rapports".to_string())]);
        assert!(space.persist_menu().unwrap());
        space.remove_menu_item("jira/rapports").unwrap();
        assert!(rapports(&space).is_empty());
        assert!(!space.persist_menu().unwrap());

        // Un autre module : sa section devient une page.
        let menu = PlaceTarget::Menu { label: "Notes".into(), icon: None, color: None };
        space.place_page("Notes", None, "", &menu, None).unwrap();
        assert!(space.snapshot().unwrap().sections.iter().any(|section| section.id == "notes/principal"));

        // Le modèle supprimé : sa page quitte le menu ; son onglet reste écrit, pour revenir à sa place si l’on
        // annule la suppression.
        space.persist_menu().unwrap();
        space.delete_page("notes/notes").unwrap();
        assert!(!space.snapshot().unwrap().sections.iter().any(|section| section.id == "notes/principal"));
        let manifest = space.manifest().unwrap();
        assert!(manifest.layout.menu.unwrap().iter().any(|entry| entry.id == "notes/principal"));
        assert!(space.snapshot().unwrap().problems.is_empty(), "{:?}", space.snapshot().unwrap().problems);
    }

    /// La coquille renvoie le layout sans les pages de l’utilisateur : elles restent.
    #[tokio::test]
    async fn saving_the_layout_keeps_the_user_pages() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        jira_module(&space);
        space.persist_menu().unwrap();
        let before = space.manifest().unwrap().layout.menu;
        invoke(&state, "space.updateLayout", json!({ "layout": { "sections": ["jira/principal"] } })).await.unwrap();
        assert_eq!(space.manifest().unwrap().layout.menu, before);
        // Et les commandes du menu passent par le dispatch.
        let snapshot = invoke(
            &state,
            "space.menu.addPage",
            json!({ "section": "jira/principal", "label": "Jira Bis", "tabs": [{ "page": "jira/accueil" }] }),
        )
        .await
        .unwrap();
        assert_eq!(snapshot["created"], json!("jira/principal@jira-bis"));
    }

    /// Un module à plusieurs sections, chacune avec une seule page du même nom (comme Atlassian : Jira, Bitbucket,
    /// Confluence, Support), l’une avec son panneau.
    fn atlassian_module(space: &Space) {
        let dir = space.module_dir("atlassian");
        std::fs::create_dir_all(dir.join("pages")).unwrap();
        let mut sections = Vec::new();
        let mut pages = Vec::new();
        for name in ["jira", "bitbucket", "confluence", "support"] {
            sections.push(json!({ "id": name, "label": name }));
            pages.push(json!({ "id": name, "title": name, "placement": { "kind": "tab", "section": name } }));
            std::fs::write(dir.join(format!("pages/{name}.tsx")), "export default function Page() { return null; }\n").unwrap();
        }
        pages.push(json!({ "id": "details", "title": "Détails", "placement": { "kind": "panel", "page": "atlassian/jira" } }));
        std::fs::write(dir.join("pages/details.tsx"), "export default function Page() { return null; }\n").unwrap();
        let module = json!({ "id": "atlassian", "name": "Atlassian", "version": "1.0.0", "sections": sections, "pages": pages });
        std::fs::write(dir.join("module.json"), module.to_string()).unwrap();
    }

    /// Chaque section d’un tel module : une page de plus alors qu’elle existe, un onglet dans la page existante, la
    /// page d’origine retirée puis rajoutée. Rien ne manque, et le panneau suit chaque copie.
    #[tokio::test]
    async fn each_section_of_a_module_is_added_again_retired_and_added_back() {
        let (state, _dir) = test_state();
        let space = state.space().unwrap();
        atlassian_module(&space);
        assert!(space.persist_menu().unwrap());
        for name in ["jira", "bitbucket", "confluence", "support"] {
            let section = format!("atlassian/{name}");
            let tab = || vec![NewTab { page: section.clone(), ..NewTab::default() }];
            let copy = space.add_menu_page(&section, tab(), None, None).unwrap();
            assert_eq!(copy, format!("{section}@2"));
            let extra = space
                .add_menu_tab(&section, NewTab { page: section.clone(), label: Some("Autre".into()), ..NewTab::default() })
                .unwrap();
            assert_eq!(extra, format!("{section}@autre"));
            space.remove_menu_item(&section).unwrap();
            assert!(!space.snapshot().unwrap().sections.iter().any(|known| known.id == section));
            assert_eq!(space.add_menu_page(&section, tab(), None, None).unwrap(), section);

            let snapshot = space.snapshot().unwrap();
            assert!(snapshot.problems.is_empty(), "{:?}", snapshot.problems);
            let copies: Vec<_> = snapshot.sections.iter().filter(|known| known.id.starts_with(&section)).collect();
            assert_eq!(copies.len(), 2, "{section}");
            for copy in copies {
                assert_eq!(copy.pages.len(), 1);
                assert_eq!(copy.pages[0].panel.is_some(), name == "jira", "{}", copy.pages[0].reference);
            }
        }
    }

    /// Les écritures du menu disent l’espace que montrait la fenêtre : un autre, ouvert entre-temps ailleurs, les
    /// refuse sans rien écrire.
    #[tokio::test]
    async fn the_menu_is_not_written_into_another_space_than_the_shown_one() {
        let (state, dir) = test_state();
        let space = state.space().unwrap();
        atlassian_module(&space);
        space.persist_menu().unwrap();
        let before = space.manifest().unwrap().layout.menu;
        let other = dir.path().join("autre").to_string_lossy().to_string();
        let add = |shown: String| json!({ "section": "atlassian/jira", "tabs": [{ "page": "atlassian/jira" }], "space": shown });
        let refused = invoke(&state, "space.menu.addPage", add(other)).await.unwrap_err();
        assert!(refused.message.contains("Un autre espace de travail est ouvert"), "{}", refused.message);
        assert_eq!(space.manifest().unwrap().layout.menu, before);
        let shown = space.root.to_string_lossy().to_string();
        let snapshot = invoke(&state, "space.menu.addPage", add(shown)).await.unwrap();
        assert_eq!(snapshot["created"], json!("atlassian/jira@2"));
    }
}

/// Migration d’une copie d’espace réel, à la main : `ALFRED_MIGRATION_COPY=<dossier> cargo test -- --ignored
/// migration_of_a_copy`. Le menu avant et après est imprimé, puis comparé.
#[cfg(test)]
#[test]
#[ignore]
fn migration_of_a_copy() {
    let Ok(path) = std::env::var("ALFRED_MIGRATION_COPY") else { return };
    let space = Space { root: std::path::PathBuf::from(path) };
    let show = |space: &Space| -> Vec<String> {
        space
            .snapshot()
            .unwrap()
            .sections
            .iter()
            .map(|section| {
                let pages: Vec<String> = section
                    .pages
                    .iter()
                    .map(|page| format!("{} « {} »{}{}", page.reference, page.title, if page.hidden { " (masquée)" } else { "" }, page.waiting.as_ref().map(|_| " (attend un compte)").unwrap_or_default()))
                    .collect();
                format!("{} « {} »{} : {}", section.id, section.label, if section.hidden { " (masquée)" } else { "" }, pages.join(", "))
            })
            .collect()
    };
    let before = show(&space);
    println!("AVANT\n{}", before.join("\n"));
    println!("migré : {}", space.persist_menu().unwrap());
    let after = show(&space);
    println!("APRÈS\n{}", after.join("\n"));
    assert_eq!(before, after);
}
