import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationSettings } from "../features/navigation/NavigationSettings";
import { invoke } from "../lib/native";
import type { ResolvedPage, ResolvedSection, Snapshot } from "../lib/types";
import { AppShell } from "./AppShell";
import { type FullLayout, project } from "./navigationLayout";
import { useNotifications } from "./notifications";
import { useShell } from "./store";

vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

vi.mock("../lib/native", () => ({
  invoke: vi.fn(),
  onNativeEvent: vi.fn(() => () => undefined),
  frameBase: (base: string) => base,
}));

HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

function page(module: string, id: string, title: string, extra: Partial<ResolvedPage> = {}): ResolvedPage {
  return {
    reference: `${module}/${id}`,
    module,
    id,
    title,
    icon: null,
    description: "",
    hidden: false,
    readOnly: false,
    missing: true,
    errors: [],
    uses: {},
    panel: null,
    ...extra,
  };
}

function section(
  id: string,
  label: string,
  pages: ResolvedPage[],
  extra: Partial<ResolvedSection> = {},
): ResolvedSection {
  return { id, module: id.split("/")[0], label, icon: "list-checks", color: null, hidden: false, pages, ...extra };
}

function fixture(): Snapshot {
  return {
    path: "/espace",
    name: "Espace",
    accent: null,
    sections: [
      section("suivi/principal", "Suivi", [page("suivi", "taches", "Tâches"), page("suivi", "notes", "Notes")]),
      section("crm/principal", "Clients", [page("crm", "contacts", "Contacts", { readOnly: true })]),
      section("compta/principal", "Compta", [page("compta", "factures", "Factures")]),
    ],
    settingsPages: [],
    modules: [
      {
        id: "crm",
        name: "CRM partagé",
        version: "1.0.0",
        description: "",
        readOnly: true,
        origin: null,
        pages: 1,
        functions: 0,
        clients: [],
        webhooks: [],
        schedules: [],
      },
    ],
    functions: [],
    bindings: {},
    problems: [],
    layout: { sections: [] },
  };
}

const mockedInvoke = vi.mocked(invoke);
/** Faux backend : il applique le `layout` reçu comme le ferait `snapshot()`. */
let backend: Snapshot;
let refuseLayout: string | null;

beforeEach(() => {
  backend = fixture();
  refuseLayout = null;
  useNotifications.setState({ items: [], toasts: [] });
  useShell.setState({ snapshot: fixture(), view: { kind: "section", id: "suivi/principal" }, activeTab: {} });
  mockedInvoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "space.updateLayout") {
      if (refuseLayout) throw new Error(refuseLayout);
      backend = project(backend, args.layout as FullLayout);
      return backend;
    }
    if (command === "space.deletePage") {
      const reference = args.reference as string;
      const found = backend.sections.flatMap((candidate) => candidate.pages).find((p) => p.reference === reference);
      if (found?.readOnly) throw new Error("Le module « crm » est installé en lecture seule.");
      backend = {
        ...backend,
        sections: backend.sections.map((s) => ({ ...s, pages: s.pages.filter((p) => p.reference !== reference) })),
      };
      return null;
    }
    if (command === "space.snapshot") return backend;
    return null;
  });
});

const lastLayoutCall = () => {
  const calls = mockedInvoke.mock.calls.filter(([command]) => command === "space.updateLayout");
  return calls.at(-1)?.[1] as { layout: FullLayout; message: string } | undefined;
};

const sidebarLabels = () =>
  within(screen.getByRole("navigation", { name: "Sections de l’espace" }))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"))
    .filter((label) => label && !label.startsWith("Actions"));

const renderShell = (settings = false) =>
  render(
    <AppShell
      agent={<p>Agent</p>}
      settingsTabs={settings ? [{ id: "navigation", label: "Navigation", render: () => <NavigationSettings /> }] : []}
    />,
  );

describe("réorganisation de la navigation", () => {
  it("réordonne les sections au clavier et enregistre l’ordre complet", async () => {
    renderShell();
    const entry = screen.getByRole("button", { name: "Suivi" });
    entry.focus();
    fireEvent.keyDown(entry, { key: "ArrowDown", altKey: true });
    expect(sidebarLabels()).toEqual(["Clients", "Suivi", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()).toBeDefined());
    expect(lastLayoutCall()).toEqual({
      layout: expect.objectContaining({ sections: ["crm/principal", "suivi/principal", "compta/principal"] }),
      message: "Déplacement de la section Suivi en position 2 du menu",
    });
    expect(screen.getByText("Section Suivi déplacée en position 2 sur 3.")).toBeInTheDocument();
  });

  it("réordonne les onglets au clavier sans changer l’onglet actif", async () => {
    renderShell();
    const tab = screen.getByRole("tab", { name: "Tâches" });
    fireEvent.keyDown(tab, { key: "ArrowRight", altKey: true });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Notes", "Tâches"]);
    expect(screen.getByRole("tab", { name: "Tâches" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(lastLayoutCall()?.layout.tabs).toEqual({ "suivi/principal": ["suivi/notes", "suivi/taches"] }),
    );
    expect(lastLayoutCall()?.message).toBe("Déplacement de l’onglet Tâches en position 2 de la section Suivi");
  });

  it("renomme une section depuis le bouton « … »", async () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Actions de la section Suivi" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Renommer/ }));
    const field = screen.getByRole("textbox", { name: "Nom" });
    fireEvent.change(field, { target: { value: "Projets" } });
    fireEvent.click(screen.getByRole("button", { name: "Renommer" }));
    expect(screen.getByRole("button", { name: "Projets" })).toBeInTheDocument();
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Renommage de la section Suivi en Projets"));
    expect(lastLayoutCall()?.layout.overrides).toEqual({ "section:suivi/principal": { label: "Projets" } });
  });

  it("change la couleur et refuse une icône inconnue", async () => {
    renderShell();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Compta" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Changer l’icône/ }));
    const field = screen.getByRole("textbox", { name: "Nom de l’icône" });
    fireEvent.change(field, { target: { value: "pas-une-icone-xyz" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(screen.getByText("Aucune icône Lucide ne s’appelle « pas-une-icone-xyz ».")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "wallet" } });
    expect(screen.getByText("Aperçu : wallet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Changement de l’icône de la section Compta en wallet"));

    fireEvent.contextMenu(screen.getByRole("button", { name: "Compta" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Vert" }));
    await waitFor(() =>
      expect(lastLayoutCall()?.message).toBe("Changement de la couleur de la section Compta en vert"),
    );
    expect(lastLayoutCall()?.layout.overrides["section:compta/principal"]).toEqual({ icon: "wallet", color: "green" });
  });

  it("masque une section puis la réaffiche depuis les Réglages", async () => {
    renderShell(true);
    fireEvent.click(screen.getByRole("button", { name: "Actions de la section Clients" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Masquer la section" }));
    expect(sidebarLabels()).toEqual(["Suivi", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Masquage de la section Clients"));

    act(() => useShell.getState().setView({ kind: "settings" }));
    const row = screen.getByText("Clients").closest("[data-nav-row]") as HTMLElement;
    expect(within(row).getByText("Masquée")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Réafficher la section Clients" }));
    expect(sidebarLabels()).toEqual(["Suivi", "Clients", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Réaffichage de la section Clients"));
    expect(lastLayoutCall()?.layout.overrides).toEqual({});
  });

  it("réordonne et renomme sans glisser-déposer depuis les Réglages", async () => {
    renderShell(true);
    act(() => useShell.getState().setView({ kind: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Descendre la page Tâches" }));
    await waitFor(() =>
      expect(lastLayoutCall()?.message).toBe("Déplacement de l’onglet Tâches en position 2 de la section Suivi"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Monter la section Compta" }));
    await waitFor(() =>
      expect(lastLayoutCall()?.layout.sections).toEqual(["suivi/principal", "compta/principal", "crm/principal"]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Renommer la page Notes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nom" }), { target: { value: "Carnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Renommer" }));
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Renommage de la page Notes en Carnet"));
  });

  it("déplace une page vers les Réglages par le menu de l’onglet", async () => {
    renderShell();
    const tab = screen.getByRole("tab", { name: "Notes" });
    fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Actions de l’onglet Notes" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Réglages/ }));
    expect(screen.queryByRole("tab", { name: "Notes" })).not.toBeInTheDocument();
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Déplacement de la page Notes vers les Réglages"));
    expect(lastLayoutCall()?.layout.overrides["page:suivi/notes"]).toEqual({ placement: { kind: "settings" } });
    expect(useShell.getState().snapshot?.settingsPages.map((p) => p.reference)).toEqual(["suivi/notes"]);
  });

  it("supprime une page après confirmation", async () => {
    renderShell();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Supprimer la page/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Supprimer la page « Notes » ?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("space.deletePage", { reference: "suivi/notes" }));
    await waitFor(() => expect(useShell.getState().snapshot?.sections[0].pages).toHaveLength(1));
  });

  it("propose de masquer une page d’un module en lecture seule, et rétablit si le backend refuse", async () => {
    act(() => useShell.setState({ view: { kind: "section", id: "crm/principal" } }));
    // Une section d’une seule page n’affiche pas d’onglets : la section Clients en reçoit une seconde.
    act(() =>
      useShell.setState((state) => ({
        snapshot: state.snapshot && {
          ...state.snapshot,
          sections: state.snapshot.sections.map((s) =>
            s.id === "crm/principal"
              ? { ...s, pages: [...s.pages, page("crm", "agenda", "Agenda", { readOnly: true })] }
              : s,
          ),
        },
      })),
    );
    renderShell();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Contacts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Supprimer la page/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("La page « Contacts » ne peut pas être supprimée");
    expect(dialog).toHaveTextContent("module installé « CRM partagé », en lecture seule");
    fireEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(mockedInvoke).not.toHaveBeenCalledWith("space.deletePage", expect.anything());

    // Refus du backend (état obsolète) : la page revient et l’erreur est notifiée.
    const { deletePage } = await import("./navigationEditing");
    await act(async () => {
      expect(await deletePage("crm/contacts")).toBe(false);
    });
    expect(screen.getByRole("tab", { name: "Contacts" })).toBeInTheDocument();
    expect(useNotifications.getState().items[0]).toMatchObject({
      tone: "error",
      title: "La page « Contacts » n’a pas été supprimée",
      description: "Le module « crm » est installé en lecture seule.",
    });
  });

  it("revient en arrière et notifie quand le backend refuse un changement", async () => {
    refuseLayout = "Écriture impossible.";
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Actions de la section Suivi" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Masquer la section" }));
    expect(sidebarLabels()).toEqual(["Clients", "Compta"]);
    await waitFor(() => expect(sidebarLabels()).toEqual(["Suivi", "Clients", "Compta"]));
    expect(useNotifications.getState().items[0]).toMatchObject({
      tone: "error",
      title: "La navigation n’a pas été modifiée",
      description: "Écriture impossible.",
    });
  });
});
