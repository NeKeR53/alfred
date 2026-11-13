import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../lib/native";
import type { ModuleSummary, ResolvedPage, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { ModulesSettings } from "./ModulesSettings";
import type { SplitPlan } from "./reorganize";

vi.hoisted(() => {
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

HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

function module(summary: Partial<ModuleSummary> & { id: string; name: string }): ModuleSummary {
  return {
    version: "0.1.0",
    description: "",
    readOnly: false,
    origin: null,
    pages: 1,
    functions: 0,
    clients: [],
    webhooks: [],
    schedules: [],
    ...summary,
  };
}

function page(module: string, id: string, title: string): ResolvedPage {
  return {
    reference: `${module}/${id}`,
    module,
    id,
    title,
    icon: null,
    description: "",
    hidden: false,
    readOnly: false,
    missing: false,
    errors: [],
    uses: { clients: [], functions: [] },
    panel: null,
  };
}

/** Faux backend : deux modules locaux (Ventes, Notes) et un module installé (Achats). */
function desk() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let modules = [
    module({ id: "ventes", name: "Ventes", pages: 2 }),
    module({ id: "notes", name: "Notes" }),
    module({
      id: "achats",
      name: "Achats",
      readOnly: true,
      origin: { marketplace: "equipe", version: "1.0.0", commit: "abc", detached: false, pinned: false },
    }),
  ];
  const snapshot = (): Snapshot => ({
    path: "/espace",
    name: "Démo",
    accent: null,
    sections: [
      {
        id: "ventes/principal",
        module: "ventes",
        label: "Ventes",
        icon: null,
        color: null,
        hidden: false,
        pages: [page("ventes", "factures", "Factures"), page("ventes", "archives", "Archives")],
      },
    ],
    settingsPages: [],
    modules,
    functions: [],
    bindings: {},
    problems: [],
  });
  const plan = (pages: string[]): SplitPlan => ({
    pages: pages.map((id) => `ventes/${id}`),
    functions: pages.includes("archives") ? ["archiver"] : [],
    sharedFunctions: ["formater"],
    sections: [],
    tables: pages.includes("archives") ? ["ventes_archives"] : [],
    problems: pages.includes("factures")
      ? [
          "La table « ventes_lignes » sert aux pages déplacées et à ce qui reste : une table n’appartient qu’à un module.",
        ]
      : [],
  });
  const backend = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ command, args });
    switch (command) {
      case "space.snapshot":
        return snapshot();
      case "marketplace.list":
      case "marketplace.updates":
      case "marketplace.modules":
        return [];
      case "modules.merge":
        modules = modules.filter((candidate) => candidate.id !== args.source);
        return { module: args.target, commit: "c1" };
      case "modules.splitPlan":
        return plan(args.pages as string[]);
      case "modules.split":
        modules = [...modules, module({ id: "archives", name: args.name as string })];
        return { module: "archives", commit: "c2" };
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  };
  vi.mocked(invoke).mockImplementation(backend as typeof invoke);
  useShell.setState({ snapshot: snapshot() });
  return calls;
}

const list = () => screen.getByRole("list", { name: /Modules de l.espace/ });

function openModuleMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions du module ${name}` }));
}

beforeEach(() => useNotifications.getState().clear());

describe("fusionner et scinder des modules", () => {
  it("fusionne un module local dans un autre, choisi parmi les modules locaux seulement", async () => {
    const calls = desk();
    render(<ModulesSettings />);
    await waitFor(() => within(list()).getByText("Notes"));

    openModuleMenu("Notes");
    fireEvent.click(screen.getByRole("menuitem", { name: "Fusionner avec…" }));
    const dialog = screen.getByRole("dialog", { name: "Fusionner Notes" });
    const target = within(dialog).getByRole("combobox", { name: "Module qui l’accueille" });
    expect(within(target).queryByRole("option", { name: "Achats" })).toBeNull();
    expect(within(target).getByRole("option", { name: "Ventes" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fusionner" }));

    await waitFor(() => expect(useNotifications.getState().items[0]?.title).toBe("Notes fusionné dans Ventes"));
    expect(calls).toContainEqual({ command: "modules.merge", args: { source: "notes", target: "ventes" } });
  });

  it("un module installé ne propose ni fusion ni scission", async () => {
    desk();
    render(<ModulesSettings />);
    await waitFor(() => within(list()).getByText("Achats"));
    openModuleMenu("Achats");
    expect(screen.queryByRole("menuitem", { name: "Fusionner avec…" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Scinder…" })).toBeNull();
  });

  it("scinde un module : montre ce qui part, bloque ce qui n’est pas sûr, puis crée le module", async () => {
    const calls = desk();
    render(<ModulesSettings />);
    await waitFor(() => within(list()).getByText("Ventes"));

    openModuleMenu("Ventes");
    fireEvent.click(screen.getByRole("menuitem", { name: "Scinder…" }));
    const dialog = screen.getByRole("dialog", { name: "Scinder Ventes" });
    const create = within(dialog).getByRole("button", { name: "Créer le module" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Nom du nouveau module" }), {
      target: { value: "Archives" },
    });

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Factures" }));
    await within(dialog).findByText(/ventes_lignes/);
    expect(create).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Factures" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Archives" }));
    await within(dialog).findByText("Table ventes_archives (avec ses données)");
    expect(within(dialog).getByText("Fonction archiver")).toBeTruthy();
    expect(within(dialog).getByText("Fonction formater")).toBeTruthy();
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);

    await waitFor(() => expect(useNotifications.getState().items[0]?.title).toBe("Module Archives créé"));
    expect(calls).toContainEqual({
      command: "modules.split",
      args: { module: "ventes", pages: ["archives"], name: "Archives" },
    });
  });
});
