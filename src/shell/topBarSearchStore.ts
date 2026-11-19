/**
 * Recherche qu’une page place dans la barre du haut (`useTopBarSearch` du SDK). La page, dans son cadre isolé, la
 * déclare ; la coquille affiche le champ et renvoie chaque frappe au cadre. Le texte est retenu par page affichée
 * tant qu’Alfred est ouvert, comme `usePageState` : en revenant sur la page, la recherche est là.
 */
import { create } from "zustand";

export interface TopBarSearchDeclaration {
  label: string;
  placeholder: string;
}

interface TopBarSearchState {
  /** Recherche déclarée par la page affichée, par référence (« module/page », instance comprise). */
  declared: Record<string, TopBarSearchDeclaration>;
  queries: Record<string, string>;
}

export const useTopBarSearches = create<TopBarSearchState>(() => ({ declared: {}, queries: {} }));

const MAX_QUERY = 500;
const listeners = new Map<string, Set<(query: string) => void>>();

const text = (value: unknown, fallback: string, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;

export function declareTopBarSearch(reference: string, options: { label?: unknown; placeholder?: unknown }) {
  const declaration = {
    label: text(options.label, "Rechercher dans la page", 120),
    placeholder: text(options.placeholder, "Rechercher…", 120),
  };
  useTopBarSearches.setState((state) => ({ declared: { ...state.declared, [reference]: declaration } }));
  return { query: topBarQueryOf(reference) };
}

export function removeTopBarSearch(reference: string) {
  if (!useTopBarSearches.getState().declared[reference]) return;
  useTopBarSearches.setState((state) => {
    const { [reference]: _, ...declared } = state.declared;
    return { declared };
  });
}

export function topBarQueryOf(reference: string): string {
  return useTopBarSearches.getState().queries[reference] ?? "";
}

/**
 * Change le texte de la recherche d’une page. Venant de la coquille (frappe dans la barre), il part au cadre de la
 * page ; venant de la page (« Effacer la recherche »), le champ de la barre le montre.
 */
export function setTopBarQuery(reference: string, value: unknown, from: "shell" | "page") {
  const query = typeof value === "string" ? value.slice(0, MAX_QUERY) : "";
  if (topBarQueryOf(reference) !== query)
    useTopBarSearches.setState((state) => ({ queries: { ...state.queries, [reference]: query } }));
  if (from === "shell") for (const listener of listeners.get(reference) ?? []) listener(query);
}

/** Le cadre d’une page reçoit les frappes faites dans la barre du haut ; renvoie le désabonnement. */
export function onTopBarQuery(reference: string, listener: (query: string) => void): () => void {
  const set = listeners.get(reference) ?? new Set();
  set.add(listener);
  listeners.set(reference, set);
  return () => {
    set.delete(listener);
  };
}

/** Pour les tests. */
export function clearTopBarSearches() {
  useTopBarSearches.setState({ declared: {}, queries: {} });
  listeners.clear();
}
