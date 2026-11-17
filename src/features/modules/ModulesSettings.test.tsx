import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../lib/native";
import type { ModuleSummary, Snapshot } from "../../lib/types";
import { SETTINGS_SECTION } from "../../shell/navigationLayout";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import type { CatalogModule, Marketplace, ModulePublication, ModuleUpdate } from "./api";
import { MarketplaceSettings } from "./MarketplaceSettings";
import { MarketplaceSources } from "./MarketplaceSources";
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
    publications: [] as ModulePublication[],
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
      case "marketplace.publications":
        return state.publications;
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
        state.publications = [
          {
            module: args.module as string,
            marketplace: "equipe",
            marketplaceName: "Équipe",
            source,
            version: args.version as string,
            modified: false,
          },
        ];
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
      case "modules.setup":
        // Parcours de configuration : un service par besoin, aucun encore configuré.
        return {
          modules: state.modules.map((candidate) => ({
            module: candidate.id,
            name: candidate.name,
            description: candidate.description,
            welcome: "",
            installed: candidate.readOnly,
            ready: candidate.clients.length === 0,
            steps: candidate.clients.map((need) => ({
              key: `${candidate.id}/${need.id}`,
              module: candidate.id,
              moduleName: candidate.name,
              need: need.id,
              label: need.label,
              help: "",
              optional: false,
              hasTemplate: false,
              client: null,
              state: "missing",
            })),
          })),
        };
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  };

  vi.mocked(invoke).mockImplementation(backend as typeof invoke);
  useShell.setState({ snapshot: snapshot() });
  return state;
}

const moduleList = () => screen.getByRole("table", { name: /Modules de l.espace/ });
/** Ligne d’un tableau (modules installés, catalogue) ou d’une liste (marketplaces branchés). */
const rowOf = (list: HTMLElement, name: string) => within(list).getByText(name).closest("tr, li") as HTMLElement;
/** Noms des modules affichés dans un tableau, dans l’ordre. */
const namesIn = (table: HTMLElement) =>
  [...table.querySelectorAll(".modules-table__name")].map((element) => element.textContent);
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
    expect(within(row).getByText("Équipe")).toBeInTheDocument();
    expect(within(rowOf(moduleList(), "Notes")).getByText("Local")).toBeInTheDocument();
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
    expect(within(dialog).getByText(/modifié sur place depuis son import/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("marketplace.update", expect.anything());

    fireEvent.click(within(dialog).getByRole("button", { name: "Mettre à jour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("marketplace.update", { module: "suivi" });
    await waitFor(() => expect(screen.queryByText(/Mise à jour disponible/)).not.toBeInTheDocument());
    await waitFor(() =>
      expect(within(rowOf(moduleList(), "Suivi")).queryByText(/Mise à jour disponible/)).not.toBeInTheDocument(),
    );
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
    expect(await within(rowOf(moduleList(), "Suivi")).findByText("Détaché")).toBeInTheDocument();

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
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "marketplace.list")).toBe(true),
    );
    openModuleMenu("Notes", /Publier/);
    const dialog = screen.getByRole("dialog", { name: "Publier Notes" });
    // La version est proposée par le backend pour le marketplace cible.
    expect(await within(dialog).findByDisplayValue("0.1.0")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("marketplace.suggestVersion", {
      module: "notes",
      marketplace: "equipe",
      refresh: true,
    });
    expect(within(dialog).getByRole("combobox", { name: "Marketplace de destination" })).toHaveValue("equipe");
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
    // L’espace de travail se souvient de la publication : le module reste le sien, publié.
    expect(await within(rowOf(moduleList(), "Notes")).findByText("Local, publié")).toBeInTheDocument();
  });

  it("importe depuis le Marketplace : catalogue de tous les marketplaces, fiche du module, puis configuration", async () => {
    const state = desk();
    state.catalog.push({
      id: "notes",
      name: "Notes",
      version: "0.2.0",
      pages: [],
      functions: [],
      installed: null,
      conflict: false,
      own: { version: "0.2.0", local: "0.2.1" },
    });
    const { unmount } = render(<MarketplaceSettings />);
    const catalog = await screen.findByRole("table", { name: "Modules disponibles" });
    await within(catalog).findByText("Facturation");
    expect(within(rowOf(catalog, "Facturation")).getByText("Factures et relances")).toBeInTheDocument();
    expect(within(rowOf(catalog, "Suivi")).getByText("Installé (v1.0.0)")).toBeInTheDocument();
    expect(within(rowOf(catalog, "Suivi")).queryByRole("button", { name: /^Importer/ })).not.toBeInTheDocument();
    // Un module publié depuis cet espace de travail est le sien : ni conflit, ni import.
    expect(within(rowOf(catalog, "Notes")).getByText("Votre module")).toBeInTheDocument();
    expect(within(rowOf(catalog, "Notes")).queryByRole("button", { name: /^Importer/ })).not.toBeInTheDocument();

    // La fiche dit ce que fait le module avant de l’importer.
    fireEvent.click(within(catalog).getByText("Facturation"));
    expect(screen.getByRole("heading", { name: "Facturation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Services nécessaires" })).toBeInTheDocument();
    expect(screen.getByText("Banque")).toBeInTheDocument();
    expect(screen.getByText("relancer")).toBeInTheDocument();
    expect(screen.getByText("Paiement reçu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Importer" }));
    const dialog = screen.getByRole("dialog", { name: "Importer Facturation v2.0.0" });
    for (const access of [
      "Client : Banque",
      "Fonction proposée aux agents : Relance les impayés",
      "Webhook : Paiement reçu",
      "Planification : Rappel des échéances (toutes les 60 min)",
    ]) {
      expect(within(dialog).getByText(access)).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Importer" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("marketplace.install", { marketplace: "equipe", module: "facturation" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Juste après l’import, Alfred mène aux modules installés, où le parcours de configuration présente le module.
    expect(useShell.getState().activeTab[SETTINGS_SECTION]).toBe("modules");
    unmount();
    render(<ModulesSettings />);
    expect(await screen.findByRole("heading", { name: "Configurer Facturation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bienvenue dans Facturation" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Terminer plus tard/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Tous les modules" }));
    expect(await within(moduleList()).findByText("Facturation")).toBeInTheDocument();
  });

  it("les marketplaces branchés se gèrent depuis le Marketplace", async () => {
    desk();
    render(<MarketplaceSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Marketplaces branchés (1)" }));
    expect(await screen.findByLabelText("Adresse git du marketplace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Modules disponibles" }));
    expect(await screen.findByRole("table", { name: "Modules disponibles" })).toBeInTheDocument();
  });

  it("signale une nouvelle version majeure bloquée par un module qui demande l’ancienne", async () => {
    const state = desk();
    state.updates = state.updates.map((update) => ({
      ...update,
      available: "2.0.0",
      blocked: "Suivi v2.0.0 est une nouvelle version majeure : « Devis » demande « suivi » v1.0.0 ou plus (v1.x).",
    }));
    render(<ModulesSettings />);
    expect(await within(rowOf(moduleList(), "Suivi")).findByText("v2.0.0 bloquée")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tout mettre à jour/ })).not.toBeInTheDocument();
  });

  it("cherche et filtre les modules, puis ouvre la fiche de l’un d’eux", async () => {
    const state = desk();
    for (const index of [1, 2, 3, 4, 5]) state.modules.push(module({ id: `m${index}`, name: `Outil ${index}` }));
    state.modules.push(module({ id: "agenda", name: "Agenda", description: "Rendez-vous de l’équipe" }));
    useShell.setState({ snapshot: { ...(useShell.getState().snapshot as Snapshot), modules: state.modules } });
    render(<ModulesSettings />);
    expect(await screen.findByText("Mise à jour disponible : v1.1.0")).toBeInTheDocument();

    // La recherche ignore les accents et lit aussi la description.
    fireEvent.change(screen.getByLabelText("Rechercher un module"), { target: { value: "equipe" } });
    expect(namesIn(moduleList())).toEqual(["Agenda"]);
    fireEvent.change(screen.getByLabelText("Rechercher un module"), { target: { value: "" } });

    // Le filtre ne garde que les modules qui ont une mise à jour.
    fireEvent.click(screen.getByRole("radio", { name: "Mises à jour (1)" }));
    expect(namesIn(moduleList())).toEqual(["Suivi"]);

    // La fiche s’ouvre sur sa propre vue, et le retour ramène à la liste.
    fireEvent.click(within(moduleList()).getByText("Suivi"));
    expect(screen.getByRole("heading", { name: "Suivi" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pages" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Modules de l.espace/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tous les modules" }));
    expect(moduleList()).toBeInTheDocument();
  });
});

describe("MarketplacesSettings", () => {
  it("ajoute un marketplace pour tous les espaces de travail, puis le retire", async () => {
    desk();
    render(<MarketplaceSources />);
    const marketplaces = await screen.findByRole("list", { name: "Marketplaces" });
    await waitFor(() =>
      expect(
        within(rowOf(marketplaces, "Équipe")).getByText("1 module importé dans cet espace de travail"),
      ).toBeInTheDocument(),
    );

    // Accès refusé : le message du backend s’affiche sous le champ, rien n’est ajouté.
    const address = screen.getByLabelText("Adresse git du marketplace");
    fireEvent.change(address, { target: { value: "git@exemple.fr:commun.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));
    expect(await screen.findByText(/Accès refusé \(clonage\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));
    expect(await within(marketplaces).findByText("commun")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("marketplace.add", { url: "git@exemple.fr:commun.git" });
    expect(address).toHaveValue("");

    fireEvent.click(within(rowOf(marketplaces, "Équipe")).getByRole("button", { name: "Retirer" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(within(confirmation).getByText(/retiré pour tous vos espaces de travail/)).toBeInTheDocument();
    expect(within(confirmation).getByText(/1 module importé dans cet espace de travail reste/)).toBeInTheDocument();
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
