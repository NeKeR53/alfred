import type { ResolvedPage, Snapshot } from "../lib/types";
import { findPage } from "./navigationLayout";
import { type OpenedView, useOpenViews, viewKey } from "./openViews";

/**
 * Pages visitées gardées montées (et masquées) : revenir sur une page la retrouve telle qu’on l’a laissée (filtres,
 * onglet, défilement, données chargées), sans la recharger. Son cadre continue de recevoir les événements de la
 * coquille (données changées, thème) et peut se rafraîchir en arrière-plan.
 *
 * Règles :
 * - `KEPT_PAGES` pages au plus, celle affichée comprise : au-delà, la moins récemment affichée est démontée ;
 * - un seul cadre par page (`reference`) : la coquille range par page la barre du haut, les flux et les objets
 *   Python d’un cadre. Un autre onglet de la même page remplace donc le cadre gardé ;
 * - l’ordre de rendu ne change jamais : déplacer un `<iframe>` dans le DOM le recharge. Seule la récence décide
 *   de qui part ;
 * - une page qui a quitté l’espace, masquée, ou un onglet fermé : son cadre est démonté ; changer d’espace les
 *   démonte tous.
 */
export const KEPT_PAGES = 6;

export interface KeptPage {
  /** Clé du cadre : l’onglet qui le montre (`module/page`, ou la clé d’un onglet ouvert sur un élément). */
  key: string;
  page: ResolvedPage;
  view: (OpenedView & { section: string }) | null;
}

export interface KeptState {
  space: string | null;
  /** Pages gardées, dans l’ordre de rendu (stable). */
  pages: KeptPage[];
  /** Clés, de la moins récente à la plus récente. */
  recency: string[];
}

export const emptyKept = (): KeptState => ({ space: null, pages: [], recency: [] });

/** Une page gardée est-elle encore dans l’espace ? Rend sa version à jour, sinon rien. */
function refreshed(entry: KeptPage, snapshot: Snapshot | null | undefined): KeptPage | null {
  if (!snapshot) return null;
  const page = findPage(snapshot, entry.page.reference)?.page;
  if (!page || page.hidden) return null;
  if (entry.view) {
    const open = useOpenViews.getState().views[entry.view.section] ?? [];
    if (!open.some((view) => viewKey(view) === entry.key)) return null;
  }
  return { ...entry, page };
}

/**
 * Met à jour les pages gardées pour la page affichée (`current`, ou `null` : aucune page à l’écran). Rend un
 * nouvel état, ou le même s’il n’y a rien à changer.
 */
export function keepPage(
  state: KeptState,
  current: KeptPage | null,
  snapshot: Snapshot | null | undefined,
  limit = KEPT_PAGES,
): KeptState {
  const space = snapshot?.path ?? null;
  const base = state.space === space ? state : emptyKept();
  let pages: KeptPage[] = [];
  for (const entry of base.pages) {
    if (current && entry.key === current.key) {
      pages.push(current);
      continue;
    }
    // Un seul cadre par page : l’onglet affiché l’emporte.
    if (current && entry.page.reference === current.page.reference) continue;
    const kept = refreshed(entry, snapshot);
    if (kept) pages.push(kept);
  }
  if (current && !pages.some((entry) => entry.key === current.key)) pages.push(current);
  const keys = new Set(pages.map((entry) => entry.key));
  let recency = base.recency.filter((key) => keys.has(key) && key !== current?.key);
  if (current) recency.push(current.key);
  while (pages.length > limit) {
    const oldest = recency.find((key) => key !== current?.key);
    if (!oldest) break;
    pages = pages.filter((entry) => entry.key !== oldest);
    recency = recency.filter((key) => key !== oldest);
  }
  const same =
    base === state &&
    pages.length === state.pages.length &&
    pages.every((entry, index) => {
      const before = state.pages[index];
      return before?.key === entry.key && before.page === entry.page && sameView(before.view, entry.view);
    }) &&
    recency.join("\u0000") === state.recency.join("\u0000");
  return same ? state : { space, pages, recency };
}

function sameView(a: KeptPage["view"], b: KeptPage["view"]) {
  return a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
}
