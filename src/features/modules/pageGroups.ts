/**
 * Les pages d’un module et les comptes dont chacune se sert, pour la fiche du module et son onboarding : « page
 * d’abord, puis ses comptes ». Un groupe par entrée du menu (ou par page rangée ailleurs : dans une autre entrée,
 * dans les Réglages). Les copies d’une section par compte (`module/section@compte`) et les onglets d’un compte
 * (`module/page@compte`) se replient sur leur section et leur page déclarées : le groupe ne paraît qu’une fois, et ses
 * comptes s’affichent dessous. Rien n’est écrit ici : on lit le snapshot et la liste des services.
 */
import type { ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";

/** `module/page@compte` → `module/page` ; `module/section@compte` → `module/section`. */
export const baseOf = (reference: string) => reference.replace(/@[^@/]*$/, "");

/** Clé `module/besoin` du besoin qu’une page déclare (`jira`, ou `autre-module/jira` pour une dépendance). */
export const needKey = (module: string, need: string) => (need.includes("/") ? need : `${module}/${need}`);

export interface PageEntry {
  /** Référence de la page déclarée (`module/page`), sans compte. */
  reference: string;
  title: string;
  icon: string | null;
  /** Page masquée du menu par l’utilisateur. */
  hidden: boolean;
  /** Référence telle que le layout la connaît (celle à masquer) : la page déclarée, ou sa seule copie. */
  layoutReference: string;
  panel: ResolvedPage | null;
  /** Besoins dont la page se sert (`module/besoin`), panneau compris. */
  needs: string[];
  /** Besoin dont la page existe pour chaque compte (`module/besoin`) ; `null` pour une page commune. */
  perInstance: string | null;
}

export interface PageGroup {
  /** Section déclarée (`module/section`), `réglages`, ou l’entrée d’un autre module qui accueille la page. */
  key: string;
  /** Section du module (sa copie de base quand elle a des comptes) ; absente pour une page rangée ailleurs. */
  section?: ResolvedSection;
  /** Où vivent les pages quand le groupe n’est pas une entrée du module : « Réglages », « Outils »… */
  place?: string;
  title: string;
  pages: PageEntry[];
  /** Besoins de toutes les pages du groupe, sans doublon, dans l’ordre des pages. */
  needs: string[];
  /** La section suit les comptes d’un besoin : une entrée, ou un onglet, par compte. */
  perInstance: string | null;
  instancesAs: "sections" | "tabs";
}

function needsOf(page: ResolvedPage): string[] {
  const own = page.uses?.clients ?? [];
  const panel = page.panel?.uses?.clients ?? [];
  const declared = [...own, ...panel, ...(page.perInstance ? [page.perInstance] : [])];
  return [...new Set(declared.map((need) => needKey(page.module, need)))];
}

/** Pages d’une ou plusieurs copies d’une section, chacune une fois, sous sa référence déclarée. */
function entriesOf(pages: ResolvedPage[], sectionNeed: string | null): PageEntry[] {
  const byBase = new Map<string, { pages: ResolvedPage[] }>();
  for (const page of pages) {
    const base = baseOf(page.reference);
    const known = byBase.get(base);
    if (known) known.pages.push(page);
    else byBase.set(base, { pages: [page] });
  }
  return [...byBase].map(([reference, { pages: copies }]) => {
    const first = copies.find((page) => !page.instance) ?? copies[0];
    const perInstance = first.perInstance ?? sectionNeed;
    const needs = [...new Set(copies.flatMap(needsOf))];
    if (perInstance && !needs.includes(needKey(first.module, perInstance)))
      needs.push(needKey(first.module, perInstance));
    return {
      reference,
      // Un onglet de compte porte le nom du compte : le groupe montre le titre déclaré quand il le connaît.
      title: copies.find((page) => !page.instance)?.title ?? first.title,
      icon: first.icon,
      hidden: copies.every((page) => page.hidden),
      layoutReference: copies.length === 1 ? first.reference : reference,
      panel: first.panel,
      needs,
      perInstance: perInstance ? needKey(first.module, perInstance) : null,
    };
  });
}

function group(
  key: string,
  title: string,
  pages: PageEntry[],
  extra: Partial<PageGroup> & Pick<PageGroup, "perInstance" | "instancesAs">,
): PageGroup {
  return { key, title, pages, needs: [...new Set(pages.flatMap((page) => page.needs))], ...extra };
}

export function pageGroups(snapshot: Snapshot, module: string): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  const order: string[] = [];
  // Titres déclarés des pages par compte : un onglet de compte n’en porte que le nom du compte.
  const declared = new Map((snapshot.accountPages ?? []).map((page) => [page.reference, page.title]));
  const retitle = (entries: PageEntry[]) =>
    entries.map((entry) => ({ ...entry, title: declared.get(entry.reference) ?? entry.title }));

  // Les sections du module, copies par compte réunies sous leur section déclarée.
  const copies = new Map<string, ResolvedSection[]>();
  for (const section of snapshot.sections ?? []) {
    if (section.module !== module) continue;
    const base = section.instanceOf ?? baseOf(section.id);
    if (!copies.has(base)) {
      copies.set(base, []);
      order.push(base);
    }
    copies.get(base)?.push(section);
  }
  for (const base of order) {
    const sections = copies.get(base) ?? [];
    const main = sections.find((section) => !section.instance) ?? sections[0];
    const need = main.perInstance ?? null;
    groups.set(
      base,
      group(
        base,
        main.label,
        retitle(
          entriesOf(
            sections.flatMap((section) => section.pages.filter((page) => page.module === module)),
            need,
          ),
        ),
        {
          section: main,
          perInstance: need ? needKey(module, need) : null,
          instancesAs: main.instancesAs ?? "sections",
        },
      ),
    );
  }

  // Les pages du module rangées dans l’entrée d’un autre module, puis dans les Réglages.
  for (const section of snapshot.sections ?? []) {
    if (section.module === module) continue;
    const pages = section.pages.filter((page) => page.module === module);
    if (pages.length === 0) continue;
    const key = `ailleurs:${baseOf(section.id)}`;
    const known = groups.get(key);
    const entries = retitle(entriesOf(pages, null));
    if (known) {
      known.pages.push(...entries.filter((entry) => !known.pages.some((page) => page.reference === entry.reference)));
      known.needs = [...new Set(known.pages.flatMap((page) => page.needs))];
    } else {
      groups.set(
        key,
        group(key, section.label, entries, { place: section.label, perInstance: null, instancesAs: "sections" }),
      );
      order.push(key);
    }
  }
  const settings = (snapshot.settingsPages ?? []).filter((page) => page.module === module);
  if (settings.length > 0) {
    groups.set(
      "réglages",
      group("réglages", "Réglages", retitle(entriesOf(settings, null)), {
        place: "Réglages",
        perInstance: null,
        instancesAs: "sections",
      }),
    );
    order.push("réglages");
  }
  return order.flatMap((key) => groups.get(key) ?? []);
}

/** Besoins (`module/besoin`) qu’aucune page n’utilise : ceux des fonctions, des automatismes, des dépendances. */
export function needsWithoutPage(groups: PageGroup[], needs: string[]): string[] {
  const used = new Set(groups.flatMap((item) => item.needs));
  return needs.filter((need) => !used.has(need));
}

/** Groupes, autres que `except`, qui se servent aussi du besoin : pour dire qu’un compte est partagé. */
export function otherGroupsUsing(groups: PageGroup[], need: string, except: string): PageGroup[] {
  return groups.filter((item) => item.key !== except && item.needs.includes(need));
}

/**
 * Comptes qui ont ajouté une page par compte : `client/compte` → pages. `null` pour une page commune (tous les comptes
 * du service lui servent).
 */
export function accountsWithPage(accounts: Snapshot["accounts"], client: string, page: PageEntry): Set<string> | null {
  if (!page.perInstance) return null;
  const chosen = new Set<string>();
  for (const [key, pages] of Object.entries(accounts ?? {})) {
    const [owner, instance] = key.split("/");
    if (owner === client && instance && pages.includes(page.reference)) chosen.add(instance);
  }
  return chosen;
}
