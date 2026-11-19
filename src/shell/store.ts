import { create } from "zustand";
import { invoke, onNativeEvent } from "../lib/native";
import type { AppInfo, Snapshot } from "../lib/types";
import { pageWindowReference } from "./pageWindowMode";

/** Espace déjà ouvert sur ce poste, proposé pour y revenir en un clic. */
export interface RecentSpace {
  path: string;
  name: string;
  openedAt: string;
}

const RECENT_KEY = "spaces.recent";
const RECENT_LIMIT = 10;

/** Préférence secondaire : une lecture ou une écriture qui échoue ne gêne rien. */
const quietly = <T>(run: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(run)
    .catch(() => null);

export type View = { kind: "agent" } | { kind: "section"; id: string } | { kind: "settings" };
export type Theme = "light" | "dark";

interface ShellState {
  info: AppInfo | null;
  /** `undefined` tant que le backend n’a pas répondu ; `null` quand aucun espace n’est ouvert. */
  snapshot: Snapshot | null | undefined;
  /** Change à chaque modification de l’espace : les cadres se rechargent sur cette valeur. */
  revision: number;
  startupError: string | null;
  view: View;
  /** Vue restée derrière la fenêtre des Réglages, rendue quand on la ferme. */
  behind: Exclude<View, { kind: "settings" }>;
  /** Onglet affiché par section (`module/section` → `module/page`) ; « réglages » pour les Réglages. */
  activeTab: Record<string, string>;
  panelHidden: Record<string, boolean>;
  /** Conversation d’agent affichée dans le panneau de droite d’une page (`module/page` → conversation). */
  agentPanel: Record<string, string>;
  sidebarCollapsed: boolean;
  /** Espaces ouverts récemment, le plus récent d’abord (celui ouvert compris). */
  recentSpaces: RecentSpace[];
  /** Retire un espace de la liste des récents, sans rien supprimer sur le disque. */
  forgetSpace: (path: string) => void;
  /** Nouveau nom d’un espace de la liste des récents (renommé sans être ouvert). */
  renameRecent: (path: string, name: string) => void;
  theme: Theme;
  /** Vrai quand le thème suit celui du système plutôt qu’un choix de l’utilisateur. */
  themeFollowsSystem: boolean;
  start: () => Promise<void>;
  refresh: () => Promise<void>;
  /** `existing` : un espace déjà connu (liste des récents), refusé si son dossier n’en est plus un. */
  openSpace: (path: string, name?: string, options?: { existing?: boolean }) => Promise<void>;
  closeSpace: () => Promise<void>;
  setView: (view: View) => void;
  /** Ferme la fenêtre des Réglages et revient à la vue d’où elle a été ouverte. */
  closeSettings: () => void;
  setActiveTab: (section: string, page: string) => void;
  openPage: (reference: string) => void;
  togglePanel: (page: string) => void;
  setPanelVisible: (page: string, visible: boolean) => void;
  showAgentPanel: (page: string, conversation: string) => void;
  closeAgentPanel: (page: string) => void;
  toggleSidebar: () => void;
  /** `null` : suivre le thème du système. */
  setTheme: (theme: Theme | null) => void;
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme, accent: string | null | undefined) {
  document.documentElement.dataset.theme = theme;
  if (accent) document.documentElement.dataset.accent = accent;
  else delete document.documentElement.dataset.accent;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useShell = create<ShellState>((set, get) => ({
  info: null,
  snapshot: undefined,
  revision: 0,
  startupError: null,
  view: { kind: "agent" },
  behind: { kind: "agent" },
  activeTab: {},
  panelHidden: {},
  agentPanel: {},
  sidebarCollapsed: false,
  recentSpaces: [],
  theme: systemTheme(),
  themeFollowsSystem: true,

  async start() {
    try {
      const info = await invoke<AppInfo>("app.info");
      const [snapshot, theme, collapsed, recent] = await Promise.all([
        // Une fenêtre de page relit l’espace que la fenêtre principale a ouvert, sans le rouvrir.
        pageWindowReference()
          ? invoke<Snapshot | null>("space.snapshot").catch(() => null)
          : invoke<Snapshot | null>("space.restore"),
        invoke<Theme | null>("settings.get", { key: "appearance.theme" }),
        invoke<boolean | null>("settings.get", { key: "shell.sidebarCollapsed" }),
        quietly(() => invoke<RecentSpace[] | null>("settings.get", { key: RECENT_KEY })),
      ]);
      const resolved = theme ?? systemTheme();
      applyTheme(resolved, snapshot?.accent);
      set({
        info,
        snapshot,
        theme: resolved,
        themeFollowsSystem: theme === null,
        sidebarCollapsed: collapsed ?? false,
        recentSpaces: Array.isArray(recent) ? recent : [],
        startupError: null,
      });
      if (snapshot && !pageWindowReference()) rememberSpace(snapshot);
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (!get().themeFollowsSystem) return;
        applyTheme(systemTheme(), get().snapshot?.accent);
        set({ theme: systemTheme() });
      });
      // Les écritures de l’agent arrivent en rafale : une seule relecture une fois le dossier au calme.
      onNativeEvent("space:changed", () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void get().refresh(), 150);
      });
      // Un autre espace ouvert (ou fermé) ailleurs, par le pont de développement par exemple : la fenêtre le suit,
      // plutôt que de montrer encore l’ancien pendant que ses écritures vont dans le nouveau.
      onNativeEvent("space:switched", () => {
        if (pageWindowReference()) return;
        void invoke<Snapshot>("space.snapshot").then(
          (snapshot) => {
            if (snapshot.path === get().snapshot?.path) return;
            applyTheme(get().theme, snapshot.accent);
            set((state) => ({ snapshot, revision: state.revision + 1, view: { kind: "agent" } }));
          },
          () => set({ snapshot: null, view: { kind: "agent" } }),
        );
      });
      // Données d’exemple activées ou quittées ailleurs (fiche du module, autre fenêtre) : la vue est relue, et seules
      // les pages du module se rechargent (leur adresse change).
      onNativeEvent("examples:changed", () => {
        if (!get().snapshot) return;
        void invoke<Snapshot>("space.snapshot").then(
          (snapshot) => set({ snapshot }),
          () => undefined,
        );
      });
      // Une instance ajoutée ou retirée change les sections par instance : le menu est relu, sans recharger les
      // pages ouvertes.
      onNativeEvent("clients:changed", () => {
        if (!get().snapshot) return;
        void invoke<Snapshot>("space.snapshot").then(
          (snapshot) => set({ snapshot }),
          () => undefined,
        );
      });
    } catch (error) {
      set({ startupError: error instanceof Error ? error.message : String(error), snapshot: null });
    }
  },

  async refresh() {
    if (!get().snapshot) return;
    // Les migrations écrites par l’agent passent dès qu’elles apparaissent : la page qui en dépend peut s’afficher.
    await invoke("db.applyMigrations").catch(() => undefined);
    const snapshot = await invoke<Snapshot>("space.snapshot");
    applyTheme(get().theme, snapshot.accent);
    set((state) => ({ snapshot, revision: state.revision + 1 }));
    // Un espace renommé garde son nouveau nom dans la liste des récents.
    const known = get().recentSpaces.find((space) => space.path === snapshot.path);
    if (known && known.name !== snapshot.name) rememberSpace(snapshot);
  },

  async openSpace(path, name, options) {
    const snapshot = await invoke<Snapshot>(
      "space.open",
      options?.existing ? { path, name, existing: true } : { path, name },
    );
    applyTheme(get().theme, snapshot.accent);
    set((state) => ({ snapshot, revision: state.revision + 1, view: { kind: "agent" } }));
    rememberSpace(snapshot);
  },

  forgetSpace(path) {
    updateRecents((spaces) => spaces.filter((space) => space.path !== path));
  },

  renameRecent(path, name) {
    updateRecents((spaces) => spaces.map((space) => (space.path === path ? { ...space, name } : space)));
  },

  async closeSpace() {
    await invoke("space.close");
    set({ snapshot: null, view: { kind: "agent" } });
  },

  setView: (view) => set((state) => ({ view, behind: state.view.kind === "settings" ? state.behind : state.view })),
  closeSettings: () => set((state) => (state.view.kind === "settings" ? { view: state.behind } : {})),
  setActiveTab: (section, page) => set((state) => ({ activeTab: { ...state.activeTab, [section]: page } })),

  openPage(reference) {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const find = (wanted: (page: string) => boolean) =>
      snapshot.sections.find((candidate) => candidate.pages.some((page) => wanted(page.reference)));
    // Une page d’une section par instance s’ouvre aussi sans instance : celle de la première copie.
    const section =
      find((page) => page === reference) ??
      (reference.includes("@") ? undefined : find((page) => page.startsWith(`${reference}@`)));
    if (section) {
      const target =
        section.pages.find((page) => page.reference === reference)?.reference ??
        section.pages.find((page) => page.reference.startsWith(`${reference}@`))?.reference ??
        reference;
      set((state) => ({
        view: { kind: "section", id: section.id },
        activeTab: { ...state.activeTab, [section.id]: target },
      }));
    } else if (snapshot.settingsPages.some((page) => page.reference === reference)) {
      set((state) => ({
        view: { kind: "settings" },
        behind: state.view.kind === "settings" ? state.behind : state.view,
        activeTab: { ...state.activeTab, réglages: reference },
      }));
    }
  },

  togglePanel: (page) => set((state) => ({ panelHidden: { ...state.panelHidden, [page]: !state.panelHidden[page] } })),
  setPanelVisible: (page, visible) => set((state) => ({ panelHidden: { ...state.panelHidden, [page]: !visible } })),

  showAgentPanel: (page, conversation) =>
    set((state) => ({
      agentPanel: { ...state.agentPanel, [page]: conversation },
      panelHidden: { ...state.panelHidden, [page]: false },
    })),
  closeAgentPanel: (page) =>
    set((state) => {
      const { [page]: _closed, ...agentPanel } = state.agentPanel;
      return { agentPanel };
    }),

  toggleSidebar() {
    const sidebarCollapsed = !get().sidebarCollapsed;
    set({ sidebarCollapsed });
    void invoke("settings.set", { key: "shell.sidebarCollapsed", value: sidebarCollapsed });
  },

  setTheme(theme) {
    const resolved = theme ?? systemTheme();
    applyTheme(resolved, get().snapshot?.accent);
    set({ theme: resolved, themeFollowsSystem: theme === null });
    void invoke("settings.set", { key: "appearance.theme", value: theme });
  },
}));

/** Place l’espace ouvert en tête des récents, avec son nom du moment. */
function rememberSpace(snapshot: Pick<Snapshot, "path" | "name">) {
  updateRecents((spaces) =>
    [
      { path: snapshot.path, name: snapshot.name, openedAt: new Date().toISOString() },
      ...spaces.filter((space) => space.path !== snapshot.path),
    ].slice(0, RECENT_LIMIT),
  );
}

let recentWrites: Promise<unknown> = Promise.resolve();

/**
 * Change la liste des récents : tout de suite à l’écran, puis sur la liste enregistrée relue juste avant d’écrire.
 * Une autre interface (fenêtre de page, navigateur de développement) a pu la changer depuis : sa modification reste,
 * au lieu d’être écrasée par la copie gardée ici. Les écritures passent l’une après l’autre.
 */
function updateRecents(change: (spaces: RecentSpace[]) => RecentSpace[]) {
  useShell.setState({ recentSpaces: change(useShell.getState().recentSpaces) });
  recentWrites = recentWrites.then(async () => {
    const stored = await quietly(() => invoke<RecentSpace[] | null>("settings.get", { key: RECENT_KEY }));
    const recentSpaces = change(Array.isArray(stored) ? stored : useShell.getState().recentSpaces);
    useShell.setState({ recentSpaces });
    await quietly(() => invoke("settings.set", { key: RECENT_KEY, value: recentSpaces }));
  });
}
