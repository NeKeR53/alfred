import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationSettings } from "../features/navigation/NavigationSettings";
import { MODULE_FOCUS } from "../features/settings/open";
import { invoke, openPageWindow } from "../lib/native";
import type { ResolvedPage, ResolvedSection, Snapshot } from "../lib/types";
import { AppShell } from "./AppShell";
import { applyLayoutChange } from "./navigationEditing";
import { type FullLayout, project, SETTINGS_SECTION, setModuleHidden } from "./navigationLayout";
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
  inTauri: true,
  openPageWindow: vi.fn(async () => undefined),
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
        hidden: false,
        requires: [],
        requiredBy: [],
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
  within(screen.getByRole("navigation", { name: "Sections de l’espace de travail" }))
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

  it("ouvre les Réglages sur la fiche du module de la section, et seulement s’il est connu", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Actions de la section Clients" }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Configurer le module…");
    fireEvent.click(items[0]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const { view, activeTab } = useShell.getState();
    expect(view).toEqual({ kind: "settings" });
    expect(activeTab[SETTINGS_SECTION]).toBe("modules");
    expect(activeTab[MODULE_FOCUS]).toBe("crm");

    // « Suivi » n’a pas de module dans l’espace : pas de fiche à ouvrir.
    act(() => useShell.getState().setView({ kind: "section", id: "suivi/principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions de la section Suivi" }));
    expect(
      within(screen.getByRole("menu")).queryByRole("menuitem", { name: /Configurer le module/ }),
    ).not.toBeInTheDocument();
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

  it("masque un module entier, puis le réaffiche depuis sa section dans l’ordre du menu", async () => {
    renderShell(true);
    act(() => useShell.getState().setView({ kind: "settings" }));
    // Le module se désactive depuis sa fiche (onglet Modules) : même changement de présentation.
    await act(async () => {
      await applyLayoutChange((current) => setModuleHidden(current, "crm", true));
    });
    expect(sidebarLabels()).toEqual(["Suivi", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Masquage du module CRM partagé"));
    expect(lastLayoutCall()?.layout.overrides).toEqual({ "module:crm": { hidden: true } });

    // La section du module dit qui la masque ; son bouton réaffiche le module. Sa page unique ne fait pas de
    // ligne à part : la section et sa page tiennent sur une seule ligne.
    const sectionRow = screen.getByText("Clients").closest("[data-nav-row]") as HTMLElement;
    expect(within(sectionRow).getByText("Module CRM partagé masqué")).toBeInTheDocument();
    expect(screen.queryByText("Contacts")).not.toBeInTheDocument();
    expect(within(sectionRow).getByRole("button", { name: "Historique de la section Clients" })).toBeInTheDocument();
    fireEvent.click(within(sectionRow).getByRole("button", { name: "Réafficher le module CRM partagé" }));
    expect(sidebarLabels()).toEqual(["Suivi", "Clients", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Réaffichage du module CRM partagé"));
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

describe("sections par instance", () => {
  /** Une section Jira par instance du client, et une section Mail qui attend encore la sienne. */
  function withInstances(): Snapshot {
    const copy = (instance: string, label: string) =>
      section(
        `jira/principal@${instance}`,
        `Jira — ${label}`,
        [
          page("jira", "tickets", "Tickets", { reference: `jira/tickets@${instance}`, instance }),
          page("jira", "projets", "Projets", { reference: `jira/projets@${instance}`, instance }),
        ],
        { perInstance: "jira", instance, instanceOf: "jira/principal" },
      );
    return {
      ...fixture(),
      sections: [
        section("suivi/principal", "Suivi", [page("suivi", "taches", "Tâches")]),
        copy("acme", "Acme"),
        copy("cloud", "Cloud"),
        section("mail/principal", "Mail", [page("mail", "boite", "Boîte")], {
          perInstance: "mail",
          waiting: "Le client « Mail » n’a encore aucune instance.",
        }),
      ],
    };
  }

  beforeEach(() => {
    backend = withInstances();
    useShell.setState({ snapshot: withInstances(), view: { kind: "section", id: "suivi/principal" }, activeTab: {} });
  });

  it("montre une entrée par instance, et une section en attente qui mène à la fiche du module", () => {
    renderShell();
    expect(sidebarLabels()).toEqual(["Suivi", "Jira — Acme", "Jira — Cloud", "Mail"]);
    fireEvent.click(screen.getByRole("button", { name: "Mail" }));
    expect(screen.getByText("En attente d’un compte")).toBeInTheDocument();
    expect(screen.getByText("Le client « Mail » n’a encore aucune instance.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un compte" }));
    expect(useShell.getState().view).toEqual({ kind: "settings" });
    // La fiche du module Mail s’ouvre dans l’onglet Modules.
    expect(useShell.getState().activeTab.réglages).toBe("modules");
    expect(useShell.getState().activeTab["réglages:module"]).toBe("mail");
  });

  it("sans compte, montre les pages communes d’une section et fait attendre seulement ses pages par compte", () => {
    const waiting = withInstances();
    waiting.sections[3] = section(
      "mail/principal",
      "Mail",
      [
        page("mail", "accueil", "Accueil", { perInstance: null }),
        page("mail", "boite", "Boîte", { perInstance: "mail" }),
      ],
      { waiting: "Le client « Mail » n’a encore aucune instance." },
    );
    useShell.setState({ snapshot: waiting });
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Mail" }));
    expect(screen.queryByText("En attente d’un compte")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Boîte" }));
    expect(screen.getByText("En attente d’un compte")).toBeInTheDocument();
  });

  it("ouvre la page déclarée dans la première copie, ou celle de l’instance nommée", () => {
    useShell.getState().openPage("jira/tickets");
    expect(useShell.getState().view).toEqual({ kind: "section", id: "jira/principal@acme" });
    expect(useShell.getState().activeTab["jira/principal@acme"]).toBe("jira/tickets@acme");
    useShell.getState().openPage("jira/tickets@cloud");
    expect(useShell.getState().view).toEqual({ kind: "section", id: "jira/principal@cloud" });
  });

  it("applique aux copies ce qui est réglé pour la section déclarée, sauf ce que chacune règle elle-même", () => {
    const projected = project(withInstances(), {
      sections: ["mail/principal", "jira/principal", "suivi/principal"],
      tabs: {},
      settings: [],
      overrides: {
        "section:jira/principal": { hidden: true },
        "section:jira/principal@cloud": { label: "Mon cloud" },
      },
    });
    expect(projected.sections.map((s) => [s.label, s.hidden])).toEqual([
      ["Mail", false],
      ["Jira — Acme", true],
      ["Mon cloud", true],
      ["Suivi", false],
    ]);
  });

  it("ne propose pas de déplacer la page d’une copie", () => {
    useShell.setState({ view: { kind: "section", id: "jira/principal@acme" } });
    renderShell();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Tickets" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("Déplacer vers")).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Masquer l’onglet/ })).toBeInTheDocument();
    // Ouvrir la copie seule dans sa fenêtre garde son instance.
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Ouvrir dans une nouvelle fenêtre/ }));
    expect(vi.mocked(openPageWindow)).toHaveBeenCalledWith("jira/tickets@acme");
  });
});

describe("logo d’un service comme icône d’une entrée du menu", () => {
  const LOGO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
  const withLogo = (extra: Partial<ResolvedSection> = {}): Snapshot => {
    const snapshot = fixture();
    snapshot.sections[2] = {
      ...snapshot.sections[2],
      label: "Jira",
      icon: "icons/principal.svg",
      iconUrl: LOGO,
      ...extra,
    };
    return snapshot;
  };
  const entryIcon = (label: string) => {
    const entry = within(screen.getByRole("navigation", { name: "Sections de l’espace de travail" })).getByRole(
      "button",
      { name: label },
    );
    return { image: entry.querySelector("img.section-icon-image"), lucide: entry.querySelector("svg.lucide") };
  };

  it("affiche le logo dans le menu, et revient à une icône Lucide depuis « Changer l’icône… »", async () => {
    backend = withLogo();
    useShell.setState({ snapshot: withLogo() });
    renderShell();
    const { image, lucide } = entryIcon("Jira");
    expect(image).toHaveAttribute("src", LOGO);
    expect(image).toHaveAttribute("width", "15");
    expect(lucide).toBeNull();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Jira" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Changer l’icône/ }));
    const field = screen.getByRole("textbox", { name: "Nom de l’icône" });
    expect(field).toHaveValue("");
    expect(screen.getByText(/pour revenir à une icône Lucide/)).toBeInTheDocument();
    expect(screen.getByText("Aperçu : logo du service")).toBeInTheDocument();
    // Vide, le champ garde le logo : rien n’est enregistré.
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(lastLayoutCall()).toBeUndefined();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Jira" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Changer l’icône/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nom de l’icône" }), { target: { value: "bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Changement de l’icône de la section Jira en bug"));
    expect(lastLayoutCall()?.layout.overrides["section:compta/principal"]).toEqual({ icon: "bug" });
    expect(entryIcon("Jira").image).toBeNull();
    expect(entryIcon("Jira").lucide).toHaveClass("lucide-bug");
  });

  it("retombe sur l’icône par défaut quand l’image manque ou ne se lit pas", () => {
    useShell.setState({ snapshot: withLogo({ iconUrl: null }) });
    const { unmount } = renderShell();
    expect(entryIcon("Jira").image).toBeNull();
    expect(entryIcon("Jira").lucide).toHaveClass("lucide-square");
    unmount();

    useShell.setState({ snapshot: withLogo() });
    renderShell();
    const image = entryIcon("Jira").image as HTMLImageElement;
    fireEvent.error(image);
    expect(entryIcon("Jira").image).toBeNull();
    expect(entryIcon("Jira").lucide).toHaveClass("lucide-square");
  });
});
