/**
 * Réorganisation manuelle de la navigation : chaque geste de l’utilisateur produit le `layout` complet suivant et
 * le message du commit de l’espace. `project` applique ce `layout` au snapshot affiché, pour un retour immédiat
 * avant la réponse du backend (voir `snapshot()` dans `src-tauri/src/space.rs`, qui fait le même calcul).
 */
import type { Layout, Override, ResolvedPage, ResolvedSection, SectionColor, Snapshot } from "../lib/types";

/** Clé des Réglages dans `activeTab` et pour l’ordre de leurs onglets. */
export const SETTINGS_SECTION = "réglages";

export interface FullLayout {
  sections: string[];
  tabs: Record<string, string[]>;
  settings: string[];
  overrides: Record<string, Override>;
}

export interface LayoutChange {
  layout: FullLayout;
  /** Message du commit de l’espace. */
  message: string;
  /** Annonce faite aux lecteurs d’écran une fois le geste appliqué. */
  announce?: string;
}

/** Destination d’une page déplacée : l’onglet d’une section ou les Réglages. */
export type PageDestination = { kind: "tab"; section: string } | { kind: "settings" };

export const COLOR_LABELS: Record<SectionColor, string> = {
  steel: "acier",
  blue: "bleu",
  violet: "violet",
  pink: "rose",
  red: "rouge",
  orange: "orange",
  green: "vert",
  teal: "bleu-vert",
};

const sectionKey = (id: string) => `section:${id}`;
const pageKey = (reference: string) => `page:${reference}`;
const moduleKey = (id: string) => `module:${id}`;

/** Le module est-il masqué du menu, avec toutes ses sections et ses pages ? */
export function isModuleHidden(snapshot: Snapshot, module: string): boolean {
  return Boolean(snapshot.layout?.overrides?.[moduleKey(module)]?.hidden);
}

/** Copie modifiable du `layout` enregistré, avec toutes ses rubriques. */
export function readLayout(snapshot: Snapshot): FullLayout {
  const layout: Layout = snapshot.layout ?? { sections: [] };
  return {
    sections: [...(layout.sections ?? [])],
    tabs: Object.fromEntries(Object.entries(layout.tabs ?? {}).map(([key, pages]) => [key, [...pages]])),
    settings: [...(layout.settings ?? [])],
    overrides: Object.fromEntries(Object.entries(layout.overrides ?? {}).map(([key, value]) => [key, { ...value }])),
  };
}

/** Fusionne une modification dans une surcharge ; une valeur `undefined` ou vide revient à celle du module. */
function patchOverride(layout: FullLayout, key: string, patch: Partial<Override>): FullLayout {
  const next: Override = { ...layout.overrides[key], ...patch };
  for (const field of Object.keys(next) as Array<keyof Override>) {
    const value = next[field];
    if (value === undefined || value === "" || value === false) delete next[field];
  }
  const overrides = { ...layout.overrides };
  if (Object.keys(next).length === 0) delete overrides[key];
  else overrides[key] = next;
  return { ...layout, overrides };
}

export function findSection(snapshot: Snapshot, id: string): ResolvedSection | undefined {
  return snapshot.sections.find((section) => section.id === id);
}

/** Page de la navigation (onglet d’une section ou des Réglages) et l’emplacement où elle est affichée. */
export function findPage(
  snapshot: Snapshot,
  reference: string,
): { page: ResolvedPage; section: ResolvedSection | null } | undefined {
  for (const section of snapshot.sections) {
    const page = section.pages.find((candidate) => candidate.reference === reference);
    if (page) return { page, section };
  }
  const page = snapshot.settingsPages.find((candidate) => candidate.reference === reference);
  if (page) return { page, section: null };
  // Une page déclarée dont seules des copies par instance sont affichées : la première copie la représente.
  if (!reference.includes("@"))
    for (const section of snapshot.sections) {
      const copy = section.pages.find((candidate) => baseReference(candidate.reference) === reference);
      if (copy) return { page: copy, section };
    }
  return undefined;
}

/** Pages d’un emplacement, masquées comprises, dans leur ordre affiché. */
export function pagesOf(snapshot: Snapshot, sectionId: string): ResolvedPage[] {
  if (sectionId === SETTINGS_SECTION) return snapshot.settingsPages;
  return findSection(snapshot, sectionId)?.pages ?? [];
}

function placeName(snapshot: Snapshot, sectionId: string): string {
  return sectionId === SETTINGS_SECTION
    ? "des Réglages"
    : `de la section ${findSection(snapshot, sectionId)?.label ?? sectionId}`;
}

/**
 * Remplace, dans l’ordre complet, les éléments visibles par leur nouvel ordre : un élément masqué garde sa place
 * parmi les autres quand on réordonne ce qui est affiché.
 */
export function mergeVisibleOrder(all: string[], visibleOrder: string[]): string[] {
  const visible = new Set(visibleOrder);
  const queue = [...visibleOrder];
  return all.map((id) => (visible.has(id) ? (queue.shift() ?? id) : id));
}

/** Déplace un élément d’un cran dans une liste ; `null` s’il est déjà au bord. */
export function shift(order: string[], id: string, offset: -1 | 1): string[] | null {
  const index = order.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= order.length) return null;
  const next = [...order];
  next.splice(index, 1);
  next.splice(target, 0, id);
  return next;
}

export function reorderSections(snapshot: Snapshot, order: string[], moved: string): LayoutChange | null {
  const current = snapshot.sections.map((section) => section.id);
  if (order.join("\n") === current.join("\n")) return null;
  const label = findSection(snapshot, moved)?.label ?? moved;
  const position = order.indexOf(moved) + 1;
  return {
    layout: { ...readLayout(snapshot), sections: order },
    message: `Déplacement de la section ${label} en position ${position} du menu`,
    announce: `Section ${label} déplacée en position ${position} sur ${order.length}.`,
  };
}

export function reorderTabs(
  snapshot: Snapshot,
  sectionId: string,
  order: string[],
  moved: string,
): LayoutChange | null {
  const current = pagesOf(snapshot, sectionId).map((page) => page.reference);
  if (order.join("\n") === current.join("\n")) return null;
  const layout = readLayout(snapshot);
  if (sectionId === SETTINGS_SECTION) layout.settings = order;
  else layout.tabs = { ...layout.tabs, [sectionId]: order };
  const title = findPage(snapshot, moved)?.page.title ?? moved;
  const position = order.indexOf(moved) + 1;
  return {
    layout,
    message: `Déplacement de l’onglet ${title} en position ${position} ${placeName(snapshot, sectionId)}`,
    announce: `Onglet ${title} déplacé en position ${position} sur ${order.length}.`,
  };
}

export function renameSection(snapshot: Snapshot, id: string, label: string): LayoutChange | null {
  const section = findSection(snapshot, id);
  const value = label.trim();
  if (!section || value === section.label) return null;
  return {
    layout: patchOverride(readLayout(snapshot), sectionKey(id), { label: value || undefined }),
    message: value
      ? `Renommage de la section ${section.label} en ${value}`
      : `Retour au nom d’origine de la section ${section.label}`,
    announce: value ? `Section renommée en ${value}.` : "Nom d’origine rétabli.",
  };
}

export function setSectionIcon(snapshot: Snapshot, id: string, icon: string): LayoutChange | null {
  const section = findSection(snapshot, id);
  const value = icon.trim();
  if (!section || value === (section.icon ?? "")) return null;
  return {
    layout: patchOverride(readLayout(snapshot), sectionKey(id), { icon: value || undefined }),
    message: value
      ? `Changement de l’icône de la section ${section.label} en ${value}`
      : `Retour à l’icône d’origine de la section ${section.label}`,
  };
}

export function setSectionColor(snapshot: Snapshot, id: string, color: SectionColor): LayoutChange | null {
  const section = findSection(snapshot, id);
  if (!section || (section.color ?? "steel") === color) return null;
  return {
    layout: patchOverride(readLayout(snapshot), sectionKey(id), { color }),
    message: `Changement de la couleur de la section ${section.label} en ${COLOR_LABELS[color]}`,
    announce: `Couleur de la section ${section.label} : ${COLOR_LABELS[color]}.`,
  };
}

export function setSectionHidden(snapshot: Snapshot, id: string, hidden: boolean): LayoutChange | null {
  const section = findSection(snapshot, id);
  if (!section || section.hidden === hidden) return null;
  return {
    layout: patchOverride(readLayout(snapshot), sectionKey(id), { hidden }),
    message: `${hidden ? "Masquage" : "Réaffichage"} de la section ${section.label}`,
    announce: `Section ${section.label} ${hidden ? "masquée" : "réaffichée"}.`,
  };
}

export function setModuleHidden(snapshot: Snapshot, id: string, hidden: boolean): LayoutChange | null {
  const module = snapshot.modules.find((candidate) => candidate.id === id);
  if (!module || isModuleHidden(snapshot, id) === hidden) return null;
  const name = module.name || module.id;
  return {
    layout: patchOverride(readLayout(snapshot), moduleKey(id), { hidden }),
    message: `${hidden ? "Masquage" : "Réaffichage"} du module ${name}`,
    announce: `Module ${name} ${hidden ? "masqué" : "réaffiché"}.`,
  };
}

export function renamePage(snapshot: Snapshot, reference: string, label: string): LayoutChange | null {
  const found = findPage(snapshot, reference);
  const value = label.trim();
  if (!found || value === found.page.title) return null;
  return {
    layout: patchOverride(readLayout(snapshot), pageKey(reference), { label: value || undefined }),
    message: value
      ? `Renommage de la page ${found.page.title} en ${value}`
      : `Retour au nom d’origine de la page ${found.page.title}`,
    announce: value ? `Page renommée en ${value}.` : "Nom d’origine rétabli.",
  };
}

export function setPageHidden(snapshot: Snapshot, reference: string, hidden: boolean): LayoutChange | null {
  const found = findPage(snapshot, reference);
  if (!found || found.page.hidden === hidden) return null;
  return {
    layout: patchOverride(readLayout(snapshot), pageKey(reference), { hidden }),
    message: `${hidden ? "Masquage" : "Réaffichage"} de la page ${found.page.title}`,
    announce: `Page ${found.page.title} ${hidden ? "masquée" : "réaffichée"}.`,
  };
}

export function movePage(snapshot: Snapshot, reference: string, destination: PageDestination): LayoutChange | null {
  const found = findPage(snapshot, reference);
  if (!found) return null;
  const from = found.section ? found.section.id : SETTINGS_SECTION;
  const to = destination.kind === "settings" ? SETTINGS_SECTION : destination.section;
  if (from === to) return null;
  let layout = patchOverride(readLayout(snapshot), pageKey(reference), { placement: destination });
  // La page quitte l’ordre de son ancien emplacement et se range en dernier dans le nouveau.
  const tabs = Object.fromEntries(
    Object.entries(layout.tabs).map(([key, pages]) => [key, pages.filter((page) => page !== reference)]),
  );
  let settings = layout.settings.filter((page) => page !== reference);
  if (to === SETTINGS_SECTION) {
    if (settings.length) settings = [...settings, reference];
  } else if (tabs[to]?.length) {
    tabs[to] = [...tabs[to], reference];
  }
  layout = { ...layout, tabs, settings };
  const where = to === SETTINGS_SECTION ? "les Réglages" : `la section ${findSection(snapshot, to)?.label ?? to}`;
  return {
    layout,
    message: `Déplacement de la page ${found.page.title} vers ${where}`,
    announce: `Page ${found.page.title} déplacée vers ${where}.`,
  };
}

/** Référence d’une page sans l’instance qu’elle montre (`module/page@instance` → `module/page`). */
export function baseReference(reference: string): string {
  return reference.split("@")[0];
}

/** Classe d’après la clé de l’élément, sinon d’après celle dont il est la copie (section ou page par instance). */
function orderBy<T>(items: T[], order: string[], key: (item: T) => string | Array<string | null | undefined>): T[] {
  const rank = (item: T) => {
    const keys = [key(item)].flat();
    for (const candidate of keys) {
      const index = candidate ? order.indexOf(candidate) : -1;
      if (index >= 0) return index;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => rank(left.item) - rank(right.item) || left.index - right.index)
    .map(({ item }) => item);
}

/**
 * Applique un `layout` au snapshot affiché, comme le fait le backend. Un nom rendu au module garde l’ancien
 * libellé jusqu’à la réponse du backend, seul à connaître celui d’origine.
 */
export function project(snapshot: Snapshot, layout: FullLayout): Snapshot {
  const overrideOf = (key: string) => layout.overrides[key];
  const moduleHidden = (module: string) => Boolean(overrideOf(moduleKey(module))?.hidden);
  const located: Array<{ page: ResolvedPage; at: string }> = [
    ...snapshot.sections.flatMap((section) => section.pages.map((page) => ({ page, at: section.id }))),
    ...snapshot.settingsPages.map((page) => ({ page, at: SETTINGS_SECTION })),
  ];
  const sections: ResolvedSection[] = snapshot.sections.map((section) => {
    const override = overrideOf(sectionKey(section.id));
    // La copie d’une section par instance hérite de ce que l’utilisateur a réglé pour la section déclarée.
    const declared = section.instanceOf ? overrideOf(sectionKey(section.instanceOf)) : undefined;
    return {
      ...section,
      label: override?.label ?? section.label,
      icon: override?.icon ?? section.icon,
      color: override?.color ?? section.color,
      hidden: Boolean(override?.hidden) || Boolean(declared?.hidden) || moduleHidden(section.module),
      pages: [],
    };
  });
  const settingsPages: ResolvedPage[] = [];
  for (const { page, at } of located) {
    const override = overrideOf(pageKey(page.reference));
    const declared = page.instance ? overrideOf(pageKey(baseReference(page.reference))) : undefined;
    const next: ResolvedPage = {
      ...page,
      title: override?.label ?? page.title,
      hidden: Boolean(override?.hidden) || Boolean(declared?.hidden) || moduleHidden(page.module),
    };
    // Une page d’une copie par instance reste dans sa copie : elle ne se déplace pas seule.
    const placement = page.instance ? undefined : override?.placement;
    let target = at;
    if (placement?.kind === "settings") target = SETTINGS_SECTION;
    else if (placement?.kind === "tab" && sections.some((section) => section.id === placement.section))
      target = placement.section;
    if (target === SETTINGS_SECTION) settingsPages.push(next);
    else sections.find((section) => section.id === target)?.pages.push(next);
  }
  return {
    ...snapshot,
    layout,
    sections: orderBy(sections, layout.sections, (section) => [section.id, section.instanceOf]).map((section) => ({
      ...section,
      pages: orderBy(
        section.pages,
        layout.tabs[section.id] ?? (section.instanceOf ? layout.tabs[section.instanceOf] : undefined) ?? [],
        (page) => [page.reference, baseReference(page.reference)],
      ),
    })),
    settingsPages: orderBy(settingsPages, layout.settings, (page) => page.reference),
  };
}
