/** Pages d’un module rangées par section, et les phrases qui disent à quoi sert un service. */
import type { ResolvedPage, ResolvedSection, Snapshot } from "../../lib/types";

interface Group {
  key: string;
  /** Section dont le module est propriétaire : son interrupteur masque toute la section. */
  section?: ResolvedSection;
  /** Libellé de l’endroit où vivent les pages quand la section appartient à un autre module. */
  place?: string;
  pages: ResolvedPage[];
}

/** Pages du module, rangées par section, Réglages compris. */
export function moduleGroups(snapshot: Snapshot, module: string): Group[] {
  const groups: Group[] = [];
  for (const section of snapshot.sections) {
    const pages = section.pages.filter((page) => page.module === module);
    if (section.module === module) groups.push({ key: section.id, section, pages: section.pages });
    else if (pages.length > 0) groups.push({ key: section.id, place: section.label, pages });
  }
  const settings = snapshot.settingsPages.filter((page) => page.module === module);
  if (settings.length > 0) groups.push({ key: "réglages", place: "Réglages", pages: settings });
  return groups;
}

/** Toutes les pages du module, panneaux compris, une fois chacune (les copies d’une section par compte comptent une fois). */
function modulePagesFlat(snapshot: Snapshot, module: string): ResolvedPage[] {
  const pages = [...snapshot.sections.flatMap((section) => section.pages), ...snapshot.settingsPages].flatMap((page) =>
    page.panel ? [page, page.panel] : [page],
  );
  const seen = new Set<string>();
  return pages.filter((page) => {
    if (page.module !== module || seen.has(page.id)) return false;
    seen.add(page.id);
    return true;
  });
}

/** Titres des pages du module qui passent par un service (`uses.clients`), pour dire à quoi il sert. */
export function pagesUsing(snapshot: Snapshot, module: string, need: string): string[] {
  return [
    ...new Set(
      modulePagesFlat(snapshot, module)
        .filter((page) => page.uses.clients?.includes(need))
        .map((page) => page.title),
    ),
  ];
}

/** « A », « A et B », « A, B et C ». */
export function listing(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items.at(-1)}`;
}
