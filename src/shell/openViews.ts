/**
 * Onglets ouverts sur un élément (`views.open` du SDK, D-021) : une page ouvre un ticket, un client, un document
 * dans un onglet fermable, après les onglets fixes de sa section. L’onglet rouvre la même page (ou une autre page du
 * module) sur l’élément, que la page lit dans `usePageContext().view`.
 *
 * Règles :
 * - un onglet par élément et par page : rouvrir le même `id` active l’onglet existant (son libellé et ses paramètres
 *   suivent la dernière ouverture) ;
 * - `VIEW_LIMIT` onglets ouverts au plus par section : au-delà, le plus ancien se ferme ;
 * - fermer l’onglet actif active celui de gauche (spec Tabs, D-021) ;
 * - les onglets ouverts et l’onglet actif sont mémorisés par espace et par section, sur ce poste (réglages d’Alfred),
 *   d’un lancement à l’autre. Les fenêtres de page gardent les leurs le temps de la fenêtre.
 */
import { create } from "zustand";
import { invoke } from "../lib/native";
import { useShell } from "./store";

/**
 * Au-delà de dix onglets d’éléments, la rangée ne montre plus qu’une partie des onglets et le chevron « Toutes les
 * vues » devient le seul moyen de s’y retrouver (D-027) ; c’est aussi la limite des raccourcis Mod+1 à 9. Dix suffit
 * pour comparer quelques tickets ou clients ; le plus ancien se ferme, comme dans un navigateur à onglets limités.
 */
export const VIEW_LIMIT = 10;
/** Libellé d’un onglet : une ligne, coupée à 120 caractères (Tabs le tronque à l’écran au-delà de 200 px). */
const LABEL_MAX = 120;
/** Paramètres d’un onglet : un objet JSON de 16 Kio au plus, comme ceux d’une fenêtre de page. */
const PARAMS_MAX = 16 * 1024;

export interface OpenedView {
  /** Identifiant de l’élément, donné par la page (`PROJ-42`). */
  id: string;
  label: string;
  params: Record<string, unknown> | null;
  /** Page affichée dans l’onglet (`module/page`, ou une copie `module/page@suffixe`). */
  page: string;
}

/** Identifiant de l’onglet dans la rangée : unique par page et par élément. */
export function viewKey(view: Pick<OpenedView, "page" | "id">): string {
  return `view:${view.page}\u0000${view.id}`;
}

interface ViewsState {
  /** Section (`module/section`, ou `fenêtre:<page>`) → onglets ouverts, dans l’ordre d’ouverture. */
  views: Record<string, OpenedView[]>;
}

export const useOpenViews = create<ViewsState>(() => ({ views: {} }));

const NO_VIEWS: OpenedView[] = [];

/** Onglets ouverts d’une section. */
export function useSectionViews(section: string): OpenedView[] {
  return useOpenViews((state) => state.views[section] ?? NO_VIEWS);
}

/** Vérifie et nettoie un onglet demandé par une page ; une erreur dit quoi corriger. */
export function cleanView(raw: { id?: unknown; label?: unknown; params?: unknown }, page: string): OpenedView {
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id).trim() : "";
  if (!id || id.length > 200)
    throw new Error('Un onglet a un identifiant (200 caractères au plus) : { id: "PROJ-42" }.');
  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  if (!label) throw new Error(`L’onglet « ${id} » a un libellé : le nom de l’élément.`);
  let params: Record<string, unknown> | null = null;
  if (raw.params !== undefined && raw.params !== null) {
    if (typeof raw.params !== "object" || Array.isArray(raw.params))
      throw new Error('Les paramètres d’un onglet sont un objet : { params: { key: "PROJ-42" } }.');
    const text = JSON.stringify(raw.params);
    if (text.length > PARAMS_MAX) throw new Error("Les paramètres d’un onglet tiennent en 16 Kio.");
    params = JSON.parse(text) as Record<string, unknown>;
  }
  return { id, label, params, page };
}

let persisted: string | null = null;

/** Sections dont les onglets se mémorisent : celles de la fenêtre principale, pas celles d’une fenêtre de page. */
const remembered = (section: string) => !section.startsWith("fenêtre:");

function save() {
  const path = useShell.getState().snapshot?.path;
  if (!path || persisted !== path) return;
  const { views } = useOpenViews.getState();
  const active = useShell.getState().activeView;
  const stored: Record<string, { views: OpenedView[]; active?: string }> = {};
  for (const [section, list] of Object.entries(views)) {
    if (!remembered(section) || !list.length) continue;
    stored[section] = { views: list, ...(active[section] ? { active: active[section] } : {}) };
  }
  void invoke("settings.set", { key: `shell.views:${path}`, value: Object.keys(stored).length ? stored : null }).catch(
    () => undefined,
  );
}

/** Ouvre (ou active) l’onglet d’un élément dans une section, et l’affiche. */
export function openView(section: string, view: OpenedView) {
  const key = viewKey(view);
  useOpenViews.setState((state) => {
    const list = state.views[section] ?? [];
    const known = list.findIndex((candidate) => viewKey(candidate) === key);
    let next: OpenedView[];
    if (known >= 0) {
      next = list.slice();
      next[known] = view;
    } else {
      next = [...list, view];
      // Le plus ancien se ferme ; le nouvel onglet, le dernier, reste.
      while (next.length > VIEW_LIMIT) next.shift();
    }
    return { views: { ...state.views, [section]: next } };
  });
  useShell.getState().showView(section, key, view.page);
  save();
}

/**
 * Ferme un onglet. S’il était actif, l’onglet de gauche s’affiche : l’onglet ouvert précédent, sinon le dernier
 * onglet fixe (`fixedBefore`). Renvoie faux si l’onglet n’est pas ouvert.
 */
export function closeView(section: string, key: string, fixedBefore?: string): boolean {
  const list = useOpenViews.getState().views[section] ?? [];
  const index = list.findIndex((candidate) => viewKey(candidate) === key);
  if (index < 0) return false;
  const next = list.filter((_, position) => position !== index);
  useOpenViews.setState((state) => ({ views: { ...state.views, [section]: next } }));
  const shell = useShell.getState();
  if (shell.activeView[section] === key) {
    const left = next[index - 1];
    if (left) shell.showView(section, viewKey(left), left.page);
    else if (fixedBefore) shell.setActiveTab(section, fixedBefore);
    else shell.clearActiveView(section);
  }
  save();
  return true;
}

/** Onglet ouvert d’une section, par sa clé. */
export function findView(section: string, key: string | undefined): OpenedView | undefined {
  if (!key) return undefined;
  return (useOpenViews.getState().views[section] ?? []).find((view) => viewKey(view) === key);
}

/** Section où une page affichée ouvre ses onglets : celle de sa fenêtre, celle affichée, sinon la première qui la montre. */
export function sectionOfPage(page: string, windowPage: string | null): string | null {
  if (windowPage) return `fenêtre:${windowPage}`;
  const { snapshot, view } = useShell.getState();
  const sections = snapshot?.sections ?? [];
  const shows = (id: string) =>
    sections.find((section) => section.id === id)?.pages.some((candidate) => candidate.reference === page) ?? false;
  if (view.kind === "section" && shows(view.id)) return view.id;
  return sections.find((section) => section.pages.some((candidate) => candidate.reference === page))?.id ?? null;
}

let started = false;

/** Relit les onglets mémorisés de l’espace ouvert, et les suit ; à appeler une fois dans la fenêtre principale. */
export function startOpenViews() {
  if (started) return;
  started = true;
  const load = (path: string) => {
    persisted = null;
    void invoke<Record<string, { views?: OpenedView[]; active?: string }> | null>("settings.get", {
      key: `shell.views:${path}`,
    })
      .catch(() => null)
      .then((stored) => {
        if (useShell.getState().snapshot?.path !== path) return;
        const views: Record<string, OpenedView[]> = {};
        const active: Record<string, string> = {};
        for (const [section, entry] of Object.entries(stored ?? {})) {
          const list = (entry?.views ?? [])
            .filter((view) => view && typeof view.id === "string" && typeof view.page === "string")
            .slice(-VIEW_LIMIT);
          if (!list.length) continue;
          views[section] = list;
          if (entry.active && list.some((view) => viewKey(view) === entry.active)) active[section] = entry.active;
        }
        useOpenViews.setState({ views });
        for (const [section, key] of Object.entries(active)) {
          const view = findView(section, key);
          if (view) useShell.getState().showView(section, key, view.page);
        }
        persisted = path;
      });
  };
  let path = useShell.getState().snapshot?.path;
  if (path) load(path);
  useShell.subscribe((state, previous) => {
    if (state.snapshot?.path !== path) {
      path = state.snapshot?.path;
      useOpenViews.setState({ views: {} });
      if (path) load(path);
      return;
    }
    // L’onglet actif change (onglet fixe choisi, navigation) : il est mémorisé avec les onglets.
    if (state.activeView !== previous.activeView) save();
  });
}

/** Pour les tests : oublie l’état chargé. */
export function resetOpenViews() {
  started = false;
  persisted = null;
  useOpenViews.setState({ views: {} });
}
