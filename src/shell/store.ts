import { create } from "zustand";
import { invoke, onNativeEvent } from "../lib/native";
import type { AppInfo, Snapshot } from "../lib/types";

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
  /** Onglet affiché par section (`module/section` → `module/page`) ; « réglages » pour les Réglages. */
  activeTab: Record<string, string>;
  panelHidden: Record<string, boolean>;
  /** Conversation d’agent affichée dans le panneau de droite d’une page (`module/page` → conversation). */
  agentPanel: Record<string, string>;
  sidebarCollapsed: boolean;
  theme: Theme;
  /** Vrai quand le thème suit celui du système plutôt qu’un choix de l’utilisateur. */
  themeFollowsSystem: boolean;
  start: () => Promise<void>;
  refresh: () => Promise<void>;
  openSpace: (path: string, name?: string) => Promise<void>;
  closeSpace: () => Promise<void>;
  setView: (view: View) => void;
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
  activeTab: {},
  panelHidden: {},
  agentPanel: {},
  sidebarCollapsed: false,
  theme: systemTheme(),
  themeFollowsSystem: true,

  async start() {
    try {
      const info = await invoke<AppInfo>("app.info");
      const [snapshot, theme, collapsed] = await Promise.all([
        invoke<Snapshot | null>("space.restore"),
        invoke<Theme | null>("settings.get", { key: "appearance.theme" }),
        invoke<boolean | null>("settings.get", { key: "shell.sidebarCollapsed" }),
      ]);
      const resolved = theme ?? systemTheme();
      applyTheme(resolved, snapshot?.accent);
      set({
        info,
        snapshot,
        theme: resolved,
        themeFollowsSystem: theme === null,
        sidebarCollapsed: collapsed ?? false,
        startupError: null,
      });
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
  },

  async openSpace(path, name) {
    const snapshot = await invoke<Snapshot>("space.open", { path, name });
    applyTheme(get().theme, snapshot.accent);
    set((state) => ({ snapshot, revision: state.revision + 1, view: { kind: "agent" } }));
  },

  async closeSpace() {
    await invoke("space.close");
    set({ snapshot: null, view: { kind: "agent" } });
  },

  setView: (view) => set({ view }),
  setActiveTab: (section, page) => set((state) => ({ activeTab: { ...state.activeTab, [section]: page } })),

  openPage(reference) {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const section = snapshot.sections.find((candidate) => candidate.pages.some((page) => page.reference === reference));
    if (section) {
      set((state) => ({
        view: { kind: "section", id: section.id },
        activeTab: { ...state.activeTab, [section.id]: reference },
      }));
    } else if (snapshot.settingsPages.some((page) => page.reference === reference)) {
      set((state) => ({ view: { kind: "settings" }, activeTab: { ...state.activeTab, réglages: reference } }));
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
