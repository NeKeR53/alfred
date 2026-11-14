import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../lib/native";
import type { ModuleSummary, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import type { CatalogModule, Marketplace, ModuleUpdate } from "./api";
import { ModulesSettings, useModuleUpdates } from "./ModulesSettings";
import { useModuleUpdatesStore } from "./useModuleUpdates";

vi.hoisted(() => {
  // La coquille lit le thème du système dès son chargement, et jsdom n’a pas `matchMedia`.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

vi.mock("../../lib/native", () => ({
  invoke: vi.fn(),
  onNativeEvent: vi.fn(() => () => undefined),
}));

// jsdom ne sait pas ouvrir une modale native : l’attribut `open` suffit à ce que les tests la voient.
HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const noChanges = { pagesAdded: [], pagesRemoved: [], functionsAdded: [], functionsRemoved: [], newAccesses: [] };

function module(summary: Partial<ModuleSummary> & { id: string; name: string }): ModuleSummary {
  return {
    version: "0.1.0",
    description: "",
    readOnly: false,
    origin: null,
    hidden: false,
    requires: [],
    requiredBy: [],
    pages: 1,
    functions: 0,
    clients: [],
    webhooks: [],
    schedules: [],
    ...summary,
  };
}

/** Faux backend : l’état d’un poste avec un module installé en retard d’une version et un module local. */
function desk() {
  const source = "git@exemple.fr:equipe/modules.git";
  const state = {
    marketplaces: [
      {
        id: "equipe",
        url: source,
        name: "Équipe",
        addedAt: "2026-11-01T08:00:00Z",
        lastChecked: "2026-11-12T08:00:00Z",
      },
    ] as Marketplace[],
    modules: [
      module({
        id: "suivi",
        name: "Suivi",
        version: "1.0.0",
        readOnly: true,
        origin: { marketplace: source, version: "1.0.0", commit: "abc" },
        pages: 1,
        functions: 1,
      }),
      module({ id: "notes", name: "Notes" }),
    ],
    updates: [
      {
        module: "suivi",
        name: "Suivi",
        current: "1.0.0",
        available: "1.1.0",
        pinned: false,
        sourceMissing: false,
        withdrawn: false,
        marketplace: "equipe",
        marketplaceName: "Équipe",
        source,
        notes: "Ajout de la page Détails et du CRM.",
        changes: {
          ...noChanges,
          pagesAdded: ["Détails"],
          newAccesses: [{ kind: "client", id: "crm", label: "CRM de l’équipe" }],
        },
        dependencies: [],
        blocked: null,
        locallyModified: true,
      },
    ] as ModuleUpdate[],
    catalog: [
      { id: "suivi", name: "Suivi", version: "1.1.0", pages: [], functions: [], installed: "1.0.0", conflict: false },
      {
        id: "facturation",
        name: "Facturation",
        version: "2.0.0",
        description: "Factures et relances",
        pages: [{ id: "factures", title: "Factures", description: "" }],
        functions: [{ id: "relancer", description: "Relance les impayés", tool: true }],
        clients: [{ id: "banque", label: "Banque" }],
        tools: [{ id: "relancer", description: "Relance les impayés" }],
        webhooks: [{ id: "paiement", description: "Paiement reçu", function: "encaisser" }],
        schedules: [{ id: "rappel", description: "Rappel des échéances", function: "relancer", everyMinutes: 60 }],
        installed: null,
        conflict: false,
        notes: "",
      },
    ] as CatalogModule[],
    publishAttempts: 0,
    addAttempts: 0,
  };

  const snapshot = (): Snapshot => ({
    path: "/espace",
    name: "Démo",
    accent: null,
    sections: [],
    settingsPages: [],
    modules: state.modules,
    functions: [],
    bindings: {},
    problems: [],
  });

  const backend = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    switch (command) {
      case "space.snapshot":
        return snapshot();
      case "marketplace.list":
        return state.marketplaces;
      case "marketplace.updates":
        return state.updates;
      case "marketplace.modules":
        return state.catalog;
      case "marketplace.update": {
        state.modules = state.modules.map((candidate) =>
          candidate.id === args.module && candidate.origin
            ? { ...candidate, version: "1.1.0", origin: { ...candidate.origin, version: "1.1.0" } }
            : candidate,
        );
        state.updates = state.updates.map((update) => ({
          ...update,
          current: "1.1.0",
          available: null,
          changes: noChanges,
          dependencies: [],
          blocked: null,
          locallyModified: false,
        }));
        return { from: "1.0.0", to: "1.1.0" };
      }
      case "marketplace.pin":
        state.updates = state.updates.map((update) => ({ ...update, pinned: args.pinned as boolean }));
        state.modules = state.modules.map((candidate) =>
          candidate.id === args.module && candidate.origin
            ? { ...candidate, origin: { ...candidate.origin, pinned: args.pinned as boolean } }
            : candidate,
        );
        return null;
      case "marketplace.detach":
        state.updates = [];
        state.modules = state.modules.map((candidate) =>
          candidate.id === args.module && candidate.origin
            ? { ...candidate, readOnly: false, origin: { ...candidate.origin, detached: true } }
            : candidate,
        );
        return null;
      case "marketplace.uninstall":
        state.modules = state.modules.filter((candidate) => candidate.id !== args.module);
        return null;
      case "marketplace.suggestVersion":
        return { version: "0.1.0", published: null, local: "0.1.0" };
      case "marketplace.publish":
        state.publishAttempts += 1;
        if (state.publishAttempts === 1) {
          throw Object.assign(new Error("Publication bloquée : 1 problème à corriger avant de partager ce module."), {
            detail: {
              problems: [{ file: "functions/exporter.ts", line: 4, message: "Jeton écrit en clair après « Bearer »." }],
            },
          });
        }
        return { version: args.version, commit: "def" };
      case "marketplace.add": {
        state.addAttempts += 1;
        if (state.addAttempts === 1) {
          throw new Error(
            "Accès refusé (clonage). Les identifiants git configurés sur ce poste ne donnent pas accès à ce dépôt.",
          );
        }
        const added = { id: "commun", url: args.url as string, name: "commun", addedAt: "", lastChecked: null };
        state.marketplaces = [...state.marketplaces, added];
        return added;
      }
      case "marketplace.remove":
        state.marketplaces = state.marketplaces.filter((marketplace) => marketplace.id !== args.id);
        return null;
      case "marketplace.install":
        state.modules = [
          ...state.modules,
          module({ id: "facturation", name: "Facturation", version: "2.0.0", readOnly: true }),
        ];
        state.catalog = state.catalog.map((entry) =>
          entry.id === args.module ? { ...entry, installed: "2.0.0" } : entry,
        );
        return null;
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  };

  vi.mocked(invoke).mockImplementation(backend as typeof invoke);
  useShell.setState({ snapshot: snapshot() });
  return state;
}

const moduleList = () => screen.getByRole("list", { name: /Modules de l.espace/ });
const rowOf = (list: HTMLElement, name: string) => within(list).getByText(name).closest("li") as HTMLElement;
const lastNotification = () => useNotifications.getState().items[0]?.title;

function openModuleMenu(name: string, action: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: `Actions du module ${name}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

beforeEach(() => {
  useModuleUpdatesStore.setState({ updates: [], checking: false });
  useNotifications.getState().clear();
});

describe("ModulesSettings", () => {
  it("signale une mise à jour, en montre le détail, puis l’applique sur accord", async () => {
    desk();
    render(<ModulesSettings />);

    const row = rowOf(moduleList(), "Suivi");
    expect(await within(row).findByText("Mise à jour disponible : v1.1.0")).toBeInTheDocument();
    expect(within(row).getByText("Modifié sur place")).toBeInTheDocument();
    expect(within(row).getByText(/Installé depuis Équipe/)).toBeInTheDocument();
    expect(within(rowOf(moduleList(), "Notes")).getByText(/^Local/)).toBeInTheDocument();
    // L’ouverture de l’écran interroge les marketplaces distants.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("marketplace.updates", { refresh: true }));
    expect(screen.getByRole("button", { name: "Tout mettre à jour (1)" })).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Mettre à jour" }));
    const dialog = screen.getByRole("dialog", { name: "Mettre à jour Suivi" });
    expect(within(dialog).getByText(/Version 1\.0\.0 → 1\.1\.0, depuis Équipe/)).toBeInTheDocument();
    expect(within(dialog).getByText("Ajout de la page Détails et du CRM.")).toBeInTheDocument();
    expect(within(dialog).getByText("Détails")).toBeInTheDocument();
    expect(within(dialog).getByText("Cette version demande de nouveaux accès")).toBeInTheDocument();
    expect(within(dialog).getByText("Client : CRM de l’équipe")).toBeInTheDocument();
    expect(within(dialog).getByText(/modifié sur place depuis son installation/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("marketplace.update", expect.anything());

    fireEvent.click(within(dialog).getByRole("button", { name: "Mettre à jour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("marketplace.update", { module: "suivi" });
    await waitFor(() => expect(screen.queryByText(/Mise à jour disponible/)).not.toBeInTheDocument());
    expect(within(rowOf(moduleList(), "Suivi")).getByText("v1.1.0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tout mettre à jour/ })).not.toBeInTheDocument();
    expect(lastNotification()).toBe("Suivi mis à jour");
  });

  it("fige, détache après confirmation, et demande le sort des données à la suppression", async () => {
    desk();
    render(<ModulesSettings />);
    await screen.findByText("Mise à jour disponible : v1.1.0");

    openModuleMenu("Suivi", /Figer sur cette version/);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("marketplace.pin", { module: "suivi", pinned: true }));
    expect(await within(rowOf(moduleList(), "Suivi")).findByText("Figé")).toBeInTheDocument();
    // Figé : la mise à jour reste signalée, mais ne compte plus pour « Tout mettre à jour ».
    expect(screen.getByText("Mise à jour disponible : v1.1.0")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Tout mettre à jour/ })).not.toBeInTheDocument());

    openModuleMenu("Suivi", /Détacher/);
    const confirmation = screen.getByRole("alertdialog");
    expect(within(confirmation).getByText(/ne recevra plus aucune mise à jour/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("marketplace.detach", expect.anything());
    fireEvent.click(within(confirmation).getByRole("button", { name: "Détacher" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("marketplace.detach", { module: "suivi" }));
    expect(await within(rowOf(moduleList(), "Suivi")).findByText(/^Détaché de git@exemple\.fr/)).toBeInTheDocument();

    openModuleMenu("Notes", /Supprimer/);
    const removal = screen.getByRole("dialog", { name: "Supprimer Notes" });
    expect(within(removal).getByRole("radio", { name: /Garder les données/ })).toBeChecked();
    fireEvent.click(within(removal).getByRole("radio", { name: /Supprimer les données/ }));
    fireEvent.click(within(removal).getByRole("button", { name: "Supprimer" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("marketplace.uninstall", { module: "notes", deleteData: true }),
    );
    await waitFor(() => expect(within(moduleList()).queryByText("Notes")).not.toBeInTheDocument());
  });

  it("publie un module local et liste les problèmes quand la vérification échoue", async () => {
    desk();
    render(<ModulesSettings />);
    await screen.findByText("Équipe");

    openModuleMenu("Notes", /Publier/);
    const dialog = screen.getByRole("dialog", { name: "Publier Notes" });
    // La version est proposée par le backend pour le marketplace cible.
    expect(await within(dialog).findByDisplayValue("0.1.0")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("marketplace.suggestVersion", {
      module: "notes",
      marketplace: "equipe",
      refresh: true,
    });
    expect(within(dialog).getByRole("combobox", { name: "Marketplace cible" })).toHaveValue("equipe");
    fireEvent.change(within(dialog).getByLabelText("Notes de version"), { target: { value: "Première version" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Publier" }));
    const problems = await within(dialog).findByRole("list", { name: "Problèmes à corriger" });
    expect(within(dialog).getByText(/Publication bloquée : 1 problème/)).toBeInTheDocument();
    expect(within(problems).getByText("functions/exporter.ts:4")).toBeInTheDocument();
    expect(within(problems).getByText(/Jeton écrit en clair/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Publier" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const publications = vi.mocked(invoke).mock.calls.filter(([command]) => command === "marketplace.publish");
    expect(publications).toEqual(
      Array(2).fill([
        "marketplace.publish",
        { module: "notes", marketplace: "equipe", version: "0.1.0", notes: "Première version" },
      ]),
    );
    expect(lastNotification()).toBe("Notes v0.1.0 publié");
  });

  it("branche un marketplace, installe depuis son catalogue après avoir listé les accès, puis le retire", async () => {
    desk();
    render(<ModulesSettings />);
    const catalog = await screen.findByRole("list", { name: "Modules proposés par Équipe" });
    const offered = rowOf(catalog, "Facturation");
    expect(within(offered).getByText(/1 page · 1 fonction · demande Banque, Relance les impayés/)).toBeInTheDocument();
    expect(within(rowOf(catalog, "Suivi")).getByText("Installé (v1.0.0)")).toBeInTheDocument();
    expect(within(rowOf(catalog, "Suivi")).queryByRole("button", { name: "Installer" })).not.toBeInTheDocument();

    fireEvent.click(within(offered).getByRole("button", { name: "Installer" }));
    const dialog = screen.getByRole("dialog", { name: "Installer Facturation v2.0.0" });
    for (const access of [
      "Client : Banque",
      "Fonction proposée aux agents : Relance les impayés",
      "Webhook : Paiement reçu",
      "Planification : Rappel des échéances (toutes les 60 min)",
    ]) {
      expect(within(dialog).getByText(access)).toBeInTheDocument();
    }
    expect(within(dialog).getByText("Factures")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Installer" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("marketplace.install", { marketplace: "equipe", module: "facturation" }),
    );
    expect(await within(moduleList()).findByText("Facturation")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Accès refusé : le message du backend s’affiche sous le champ, rien n’est ajouté.
    const address = screen.getByLabelText("Adresse git du marketplace");
    fireEvent.change(address, { target: { value: "git@exemple.fr:commun.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Brancher" }));
    expect(await screen.findByText(/Accès refusé \(clonage\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Brancher" }));
    const marketplaces = screen.getByRole("list", { name: "Marketplaces branchés" });
    expect(await within(marketplaces).findByText("commun")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("marketplace.add", { url: "git@exemple.fr:commun.git" });
    expect(address).toHaveValue("");

    fireEvent.click(within(rowOf(marketplaces, "Équipe")).getByRole("button", { name: "Retirer" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(
      within(confirmation).getByText(/1 module installé depuis ce marketplace reste dans l.espace, sans source/),
    ).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Retirer" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("marketplace.remove", { id: "equipe" }));
    await waitFor(() => expect(within(marketplaces).queryByText("Équipe")).not.toBeInTheDocument());
  });
});

describe("useModuleUpdates", () => {
  it("vérifie à l’ouverture puis toutes les 30 minutes, sans compter les modules figés", async () => {
    vi.useFakeTimers();
    try {
      const state = desk();
      const checks = () =>
        vi
          .mocked(invoke)
          .mock.calls.filter(([command, args]) => command === "marketplace.updates" && args?.refresh === true).length;
      const { result, unmount } = renderHook(() => useModuleUpdates());
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(checks()).toBe(1);
      expect(result.current).toBe(1);

      state.updates = state.updates.map((update) => ({ ...update, pinned: true }));
      await act(() => vi.advanceTimersByTimeAsync(29 * 60 * 1000));
      expect(checks()).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(60 * 1000));
      expect(checks()).toBe(2);
      expect(result.current).toBe(0);

      unmount();
      await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
      expect(checks()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
