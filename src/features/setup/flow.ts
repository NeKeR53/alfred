/**
 * Logique du parcours de configuration d’un module, sans écran : de la page vers le compte. Chaque page du menu qui
 * vient du module devient une étape quand ses onglets ont besoin d’un compte ; chaque besoin y est une question
 * (« À quel compte Prefect se connecter pour « Prefect » ? »). Tout se lit dans l’état réel (menu, comptes, tests) :
 * le parcours reprend toujours à la première étape incomplète.
 */
import type { PageTemplate, ResolvedPage, ResolvedSection, SectionTemplate, Snapshot } from "../../lib/types";
import type { ClientInstanceItem, ClientItem, ClientsOverview } from "../clients/api";
import { templateOfPage, templateOfSection, userPagesOf } from "../modules/menuApi";
import type { ModuleSetup } from "./api";

/** Clé `module/besoin` d’un besoin (`jira`, ou `autre-module/jira` pour une dépendance). */
export const needKey = (module: string, need: string) => (need.includes("/") ? need : `${module}/${need}`);

/** Un compte de l’espace qui peut servir à un besoin. */
export interface AccountOption {
  /**
   * Ce qu’on enregistre sur l’onglet : `instance` pour un compte du service du besoin, `client/instance` pour celui
   * d’un autre service du même type ; vide pour le compte unique d’un service à une seule adresse.
   */
  value: string;
  client: ClientItem;
  instance: ClientInstanceItem;
  /** Le compte vient d’un service créé pour un autre module. */
  shared: boolean;
}

/** Où en est un compte, en une valeur : de quoi choisir le texte de sa carte et ce qu’un clic fait. */
export type AccountState = "ready" | "untested" | "failed" | "approve" | "secret" | "connect" | "invalid";

export function accountState(instance: ClientInstanceItem): AccountState {
  switch (instance.status) {
    case "ready":
      return instance.lastTest?.ok ? "ready" : instance.lastTest ? "failed" : "untested";
    case "toValidate":
      return "approve";
    case "missingSecret":
      return "secret";
    case "toConnect":
      return "connect";
    default:
      return "invalid";
  }
}

/** Un besoin d’une page : ses onglets qui en ont besoin, et le compte qu’ils utilisent aujourd’hui. */
export interface NeedPlan {
  /** `module/besoin`. */
  key: string;
  /** Module du modèle de l’onglet, et besoin tel qu’il l’écrit (`jira`, `atlassian/jira`). */
  module: string;
  need: string;
  /** Nom du compte, tel que l’utilisateur le connaît : « Jira », « Prefect ». */
  label: string;
  optional: boolean;
  /** Onglets de la page qui ont besoin de ce compte. */
  tabs: ResolvedPage[];
  /** Un onglet de la page montre un compte par onglet (Prefect) : sans compte choisi, il attend. */
  followed: boolean;
}

export interface PagePlan {
  entry: ResolvedSection;
  needs: NeedPlan[];
}

/** Modèle d’un onglet de la page. */
export function templateOfTab(snapshot: Snapshot, page: ResolvedPage): PageTemplate | undefined {
  return snapshot.templates?.find((template) => template.reference === templateOfPage(page));
}

/** Pages du menu qui viennent du module, dans l’ordre du menu. */
export function entriesOf(snapshot: Snapshot, module: string): ResolvedSection[] {
  return userPagesOf(snapshot, module);
}

/** Les besoins d’une page, onglet par onglet, regroupés : une question par besoin. */
export function planOf(snapshot: Snapshot, entry: ResolvedSection, setup: ModuleSetup, overview?: ClientsOverview) {
  const needs = new Map<string, NeedPlan>();
  for (const page of entry.pages) {
    const template = templateOfTab(snapshot, page);
    if (!template) continue;
    for (const need of template.needs) {
      const key = needKey(template.module, need);
      const step = setup.steps.find((candidate) => candidate.key === key);
      const known = needs.get(key);
      const followed = page.perInstance === need || template.perInstance === need;
      if (known) {
        known.tabs.push(page);
        known.followed ||= followed;
        continue;
      }
      needs.set(key, {
        key,
        module: template.module,
        need,
        label: step?.label ?? overview?.needs.find((candidate) => candidate.key === key)?.label ?? need,
        optional: step?.optional ?? false,
        tabs: [page],
        followed,
      });
    }
  }
  return { entry, needs: [...needs.values()] } satisfies PagePlan;
}

/** Service qui répond au besoin aujourd’hui (le sien), s’il existe. */
export function ownClient(overview: ClientsOverview | undefined, key: string): ClientItem | undefined {
  const id = overview?.needs.find((candidate) => candidate.key === key)?.client;
  return id ? overview?.clients.find((client) => client.id === id) : undefined;
}

/**
 * Comptes de l’espace qui peuvent servir au besoin : ceux de son service d’abord, puis ceux des services du même
 * type, quel que soit le module qui les a créés (`compatibleClients`).
 */
export function optionsOf(snapshot: Snapshot, overview: ClientsOverview | undefined, key: string): AccountOption[] {
  const own = ownClient(overview, key);
  const ids = snapshot.compatibleClients?.[key] ?? (own ? [own.id] : []);
  const ordered = own && !ids.includes(own.id) ? [own.id, ...ids] : ids;
  return ordered.flatMap((id) => {
    const client = overview?.clients.find((candidate) => candidate.id === id);
    if (!client) return [];
    const mine = client.id === own?.id;
    return client.instances.map((instance) => ({
      value: mine ? (client.simple ? "" : instance.id) : `${client.id}/${instance.id}`,
      client,
      instance,
      shared: !mine,
    }));
  });
}

/**
 * Compte qu’utilisent aujourd’hui les onglets d’un besoin : celui choisi sur le premier onglet, sinon, pour un
 * onglet qui ne suit pas de compte, le compte par défaut de son service.
 */
export function currentOption(plan: NeedPlan, options: AccountOption[]): AccountOption | undefined {
  const chosen = plan.tabs.map((tab) => tab.accounts?.[plan.need]).find(Boolean);
  if (chosen) return options.find((option) => option.value === chosen);
  if (plan.followed) return undefined;
  return (
    options.find((option) => !option.shared && option.instance.default) ?? options.find((option) => !option.shared)
  );
}

/** Un besoin est réglé quand son compte est prêt et que son dernier test a réussi. */
export function needDone(plan: NeedPlan, options: AccountOption[]): boolean {
  const current = currentOption(plan, options);
  return current !== undefined && accountState(current.instance) === "ready";
}

export function pageDone(plan: PagePlan, snapshot: Snapshot, overview: ClientsOverview | undefined): boolean {
  return plan.needs.every((need) => need.optional || needDone(need, optionsOf(snapshot, overview, need.key)));
}

/**
 * Onglets dont on change le compte quand on en choisit un pour la page : ceux qui n’en ont pas encore, et ceux qui
 * ont le même que le premier. Un onglet ajouté pour un autre compte garde le sien.
 */
export function primaryTabs(plan: NeedPlan): ResolvedPage[] {
  const first = plan.tabs.map((tab) => tab.accounts?.[plan.need]).find(Boolean);
  return plan.tabs.filter((tab) => {
    const value = tab.accounts?.[plan.need];
    return !value || value === first;
  });
}

/** Besoin dont un second compte ferait un second onglet : celui que la page suit, sinon le premier. */
export function mainNeed(plan: PagePlan): NeedPlan | undefined {
  return plan.needs.find((need) => need.followed) ?? plan.needs[0];
}

/** Modèles de pages proposés par le module : une carte par section qui a au moins un modèle. */
export function sectionChoices(snapshot: Snapshot, module: string) {
  const templates = (snapshot.templates ?? []).filter((template) => template.module === module);
  return (snapshot.sectionTemplates ?? []).flatMap((section) => {
    const own = section.pages
      .map((reference) => templates.find((template) => template.reference === reference))
      .filter((template): template is PageTemplate => Boolean(template));
    return own.length > 0 ? [{ section, templates: own }] : [];
  });
}

export type SectionChoice = ReturnType<typeof sectionChoices>[number];

/** Une carte de l’étape « Quelles pages voulez-vous ? » : une page du menu, ou une page à ajouter. */
export interface PageDraft {
  key: string;
  section: SectionTemplate;
  templates: PageTemplate[];
  /** Page du menu qu’elle représente ; absente pour une page à ajouter. */
  entry?: string;
  label: string;
  checked: boolean;
}

/** Cartes de départ : les pages déjà au menu, et une carte décochée pour un modèle qui n’y est pas. */
export function initialDrafts(snapshot: Snapshot, module: string): PageDraft[] {
  const entries = entriesOf(snapshot, module);
  return sectionChoices(snapshot, module).flatMap(({ section, templates }): PageDraft[] => {
    const existing = entries.filter((entry) => templateOfSection(entry) === section.id);
    if (existing.length === 0) return [{ key: section.id, section, templates, label: section.label, checked: false }];
    return existing.map((entry) => ({
      key: entry.id,
      section,
      templates,
      entry: entry.id,
      label: entry.label,
      checked: true,
    }));
  });
}

/** Ce que les cartes changent au menu : pages à retirer, à renommer et à ajouter. */
export function draftChanges(drafts: PageDraft[], snapshot: Snapshot) {
  const remove: string[] = [];
  const rename: Array<{ entry: string; label: string }> = [];
  const add: Array<{ section: string; label: string; tabs: Array<{ page: string }> }> = [];
  for (const draft of drafts) {
    const label = draft.label.trim();
    if (draft.entry) {
      const current = snapshot.sections.find((section) => section.id === draft.entry);
      if (!draft.checked) remove.push(draft.entry);
      else if (current && label && label !== current.label) rename.push({ entry: draft.entry, label });
    } else if (draft.checked) {
      add.push({
        section: draft.section.id,
        label: label || draft.section.label,
        tabs: draft.templates.map((template) => ({ page: template.reference })),
      });
    }
  }
  return { remove, rename, add };
}

/** Nom libre pour une autre page du même modèle : « Prefect 2 », « Prefect 3 »… */
export function nextLabel(base: string, taken: string[]): string {
  for (let index = 2; ; index += 1) {
    const label = `${base} ${index}`;
    if (!taken.includes(label)) return label;
  }
}
