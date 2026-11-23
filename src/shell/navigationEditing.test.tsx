import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigationSections } from "../features/navigation/NavigationSettings";
import { MODULE_FOCUS } from "../features/settings/open";
import { pressRowAction } from "../features/space/sections.test-helper";
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

const navigation = () => screen.getAllByRole("treegrid", { name: "Navigation principale" })[0];
const sidebarLabels = () =>
  // `hidden` : la modale des Réglages, quand elle est ouverte, cache le menu aux technologies d’assistance.
  within(screen.getAllByRole("treegrid", { name: "Navigation principale", hidden: true })[0])
    .getAllByRole("row", { hidden: true })
    .map((row) => row.getAttribute("aria-label"));
const sidebarRow = (label: string) => within(navigation()).getByRole("row", { name: label });

const renderShell = (settings = false) =>
  render(
    <AppShell
      agent={<p>Agent</p>}
      settingsTabs={settings ? [{ id: "navigation", label: "Navigation", useSections: useNavigationSections }] : []}
    />,
  );

/** Ouvre le menu « … » d’une section de la navigation. */
async function openSectionMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: `Actions de la section ${label}` }));
  return screen.findByRole("menu");
}

/** Ouvre le « … » des actions de la page affichée, dans la barre du haut. */
async function openPageMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Plus d'actions" }));
  return screen.findByRole("menu");
}

describe("réorganisation de la navigation", () => {
  it("monte et descend une section depuis son menu, et enregistre l’ordre complet", async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = await openSectionMenu(user, "Suivi");
    expect(within(menu).getByRole("menuitem", { name: "Monter" })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(menu).getByRole("menuitem", { name: "Descendre" }));
    expect(sidebarLabels()).toEqual(["Clients", "Suivi", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()).toBeDefined());
    expect(lastLayoutCall()).toEqual({
      layout: expect.objectContaining({ sections: ["crm/principal", "suivi/principal", "compta/principal"] }),
      message: "Déplacement de la section Suivi en position 2 du menu",
    });
    expect(screen.getByText("Section Suivi déplacée en position 2 sur 3.")).toBeInTheDocument();
  });

  it("déplace l’onglet actif vers la droite depuis les actions de la page, sans en changer", async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = await openPageMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Déplacer l’onglet vers la droite" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Notes", "Tâches"]);
    expect(screen.getByRole("tab", { name: "Tâches" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(lastLayoutCall()?.layout.tabs).toEqual({ "suivi/principal": ["suivi/notes", "suivi/taches"] }),
    );
    expect(lastLayoutCall()?.message).toBe("Déplacement de l’onglet Tâches en position 2 de la section Suivi");
  });

  it("renomme une section depuis le bouton « … »", async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = await openSectionMenu(user, "Suivi");
    await user.click(within(menu).getByRole("menuitem", { name: /Renommer/ }));
    const field = await screen.findByRole("textbox", { name: /Nom/ });
    await user.clear(field);
    await user.type(field, "Projets");
    await user.click(screen.getByRole("button", { name: "Renommer" }));
    await waitFor(() => expect(sidebarLabels()).toContain("Projets"));
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Renommage de la section Suivi en Projets"));
    expect(lastLayoutCall()?.layout.overrides).toEqual({ "section:suivi/principal": { label: "Projets" } });
  });

  it("ouvre les Réglages sur la fiche du module de la section, et seulement s’il est connu", async () => {
    const user = userEvent.setup();
    renderShell();
    let menu = await openSectionMenu(user, "Clients");
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Configurer le module…");
    await user.click(items[0]);
    const { view, activeTab } = useShell.getState();
    expect(view).toEqual({ kind: "settings" });
    expect(activeTab[SETTINGS_SECTION]).toBe("modules");
    expect(activeTab[MODULE_FOCUS]).toBe("crm");

    // « Suivi » n’a pas de module dans l’espace : pas de fiche à ouvrir.
    act(() => useShell.getState().setView({ kind: "section", id: "suivi/principal" }));
    menu = await openSectionMenu(user, "Suivi");
    expect(within(menu).queryByRole("menuitem", { name: /Configurer le module/ })).not.toBeInTheDocument();
  });

  it("change l’icône dans une grille, avec une recherche", async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = await openSectionMenu(user, "Compta");
    await user.click(within(menu).getByRole("menuitem", { name: /Changer l’icône/ }));
    const search = await screen.findByRole("combobox", { name: /icônes/ });
    fireEvent.change(search, { target: { value: "pas-une-icone-xyz" } });
    expect(await screen.findByText(/Aucune icône ne correspond/)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "wallet" } });
    fireEvent.click(await screen.findByRole("radio", { name: "wallet" }));
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Changement de l’icône de la section Compta en wallet"));
    expect(lastLayoutCall()?.layout.overrides["section:compta/principal"]).toEqual({ icon: "wallet" });
  });

  it("déplace une page vers les Réglages par les actions de la page", async () => {
    const user = userEvent.setup();
    useShell.setState({ activeTab: { "suivi/principal": "suivi/notes" } });
    renderShell();
    const menu = await openPageMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Déplacer vers une autre section…" }));
    const dialog = await screen.findByRole("dialog", { name: "Déplacer « Notes »" });
    await user.click(within(dialog).getByRole("button", { name: /Section/ }));
    await user.click(await screen.findByRole("option", { name: "Réglages" }));
    await user.click(within(dialog).getByRole("button", { name: "Déplacer" }));
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Déplacement de la page Notes vers les Réglages"));
    expect(lastLayoutCall()?.layout.overrides["page:suivi/notes"]).toEqual({ placement: { kind: "settings" } });
    expect(useShell.getState().snapshot?.settingsPages.map((p) => p.reference)).toEqual(["suivi/notes"]);
  });

  it("supprime une page après confirmation", async () => {
    const user = userEvent.setup();
    useShell.setState({ activeTab: { "suivi/principal": "suivi/notes" } });
    renderShell();
    const menu = await openPageMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Supprimer la page/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Supprimer la page « Notes » ?");
    await user.click(within(dialog).getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("space.deletePage", { reference: "suivi/notes" }));
    await waitFor(() => expect(useShell.getState().snapshot?.sections[0].pages).toHaveLength(1));
  });

  it("propose de masquer une page d’un module en lecture seule, et rétablit si le backend refuse", async () => {
    const user = userEvent.setup();
    act(() => useShell.setState({ view: { kind: "section", id: "crm/principal" } }));
    renderShell();
    const menu = await openPageMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Supprimer la page/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("La page « Contacts » ne peut pas être supprimée");
    expect(dialog).toHaveTextContent("module installé « CRM partagé », en lecture seule");
    await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(mockedInvoke).not.toHaveBeenCalledWith("space.deletePage", expect.anything());

    // Refus du backend (état obsolète) : la page revient et l’erreur est notifiée.
    const { deletePage } = await import("./navigationEditing");
    await act(async () => {
      expect(await deletePage("crm/contacts")).toBe(false);
    });
    expect(useShell.getState().snapshot?.sections[1].pages.map((p) => p.reference)).toEqual(["crm/contacts"]);
    expect(useNotifications.getState().items[0]).toMatchObject({
      tone: "error",
      title: "La page « Contacts » n’a pas été supprimée",
      description: "Le module « crm » est installé en lecture seule.",
    });
  });

  it("masque une section puis la réaffiche depuis les Réglages", async () => {
    const user = userEvent.setup();
    renderShell(true);
    const menu = await openSectionMenu(user, "Clients");
    await user.click(within(menu).getByRole("menuitem", { name: "Masquer la section" }));
    expect(sidebarLabels()).toEqual(["Suivi", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Masquage de la section Clients"));

    act(() => useShell.getState().setView({ kind: "settings" }));
    expect(await screen.findByText("Masquée")).toBeInTheDocument();
    await pressRowAction(user, "Clients", "Réafficher la section Clients");
    expect(sidebarLabels()).toEqual(["Suivi", "Clients", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Réaffichage de la section Clients"));
    expect(lastLayoutCall()?.layout.overrides).toEqual({});
  });

  it("masque un module entier, puis le réaffiche depuis sa section dans l’ordre du menu", async () => {
    renderShell(true);
    act(() => useShell.getState().setView({ kind: "settings" }));
    await act(async () => {
      await applyLayoutChange((current) => setModuleHidden(current, "crm", true));
    });
    expect(sidebarLabels()).toEqual(["Suivi", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Masquage du module CRM partagé"));
    expect(lastLayoutCall()?.layout.overrides).toEqual({ "module:crm": { hidden: true } });
    expect(await screen.findByText("Module CRM partagé masqué")).toBeInTheDocument();
    await pressRowAction(userEvent.setup(), "Clients", "Réafficher le module CRM partagé");
    expect(sidebarLabels()).toEqual(["Suivi", "Clients", "Compta"]);
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Réaffichage du module CRM partagé"));
    expect(lastLayoutCall()?.layout.overrides).toEqual({});
  });

  it("réordonne et renomme sans glisser-déposer depuis les Réglages", async () => {
    renderShell(true);
    act(() => useShell.getState().setView({ kind: "settings" }));
    const user = userEvent.setup();
    await pressRowAction(user, "Tâches", "Descendre la page Tâches");
    await waitFor(() =>
      expect(lastLayoutCall()?.message).toBe("Déplacement de l’onglet Tâches en position 2 de la section Suivi"),
    );
    await pressRowAction(user, "Compta", "Monter la section Compta");
    await waitFor(() =>
      expect(lastLayoutCall()?.layout.sections).toEqual(["suivi/principal", "compta/principal", "crm/principal"]),
    );
    await pressRowAction(user, "Notes", "Renommer la page Notes");
    const form = within(await screen.findByRole("dialog", { name: /Renommer la page/ }));
    await user.clear(form.getByRole("textbox", { name: /Nom/ }));
    await user.type(form.getByRole("textbox", { name: /Nom/ }), "Carnet");
    await user.click(form.getByRole("button", { name: "Renommer" }));
    await waitFor(() => expect(lastLayoutCall()?.message).toBe("Renommage de la page Notes en Carnet"));
  });

  it("revient en arrière et notifie quand le backend refuse un changement", async () => {
    const user = userEvent.setup();
    refuseLayout = "Écriture impossible.";
    renderShell();
    const menu = await openSectionMenu(user, "Suivi");
    await user.click(within(menu).getByRole("menuitem", { name: "Masquer la section" }));
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
    act(() => useShell.getState().setView({ kind: "section", id: "mail/principal" }));
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
    act(() => useShell.getState().setView({ kind: "section", id: "mail/principal" }));
    expect(screen.queryByText("En attente d’un compte")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Boîte" }));
    expect(screen.getByText("En attente d’un compte")).toBeInTheDocument();
  });

  it("montre les comptes d’une section en onglets dans une seule entrée, et ouvre l’onglet du compte nommé", () => {
    const tabs = withInstances();
    tabs.sections.push(
      section(
        "prefect/principal",
        "Prefect",
        [
          page("prefect", "deploiements", "Prod", { reference: "prefect/deploiements@prod", instance: "prod" }),
          page("prefect", "deploiements", "Recette", {
            reference: "prefect/deploiements@recette",
            instance: "recette",
          }),
        ],
        { perInstance: "prefect", instancesAs: "tabs" },
      ),
    );
    useShell.setState({ snapshot: tabs });
    renderShell();
    expect(sidebarLabels()).toEqual(["Suivi", "Jira — Acme", "Jira — Cloud", "Mail", "Prefect"]);
    act(() => useShell.getState().setView({ kind: "section", id: "prefect/principal" }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Prod", "Recette"]);
    useShell.getState().openPage("prefect/deploiements@recette");
    expect(useShell.getState().view).toEqual({ kind: "section", id: "prefect/principal" });
    expect(useShell.getState().activeTab["prefect/principal"]).toBe("prefect/deploiements@recette");
    useShell.getState().openPage("prefect/deploiements");
    expect(useShell.getState().activeTab["prefect/principal"]).toBe("prefect/deploiements@prod");
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

  it("déplace la page d’une copie vers une autre section, jamais dans les Réglages", async () => {
    const user = userEvent.setup();
    useShell.setState({ view: { kind: "section", id: "jira/principal@acme" } });
    renderShell();
    const menu = await openPageMenu(user);
    expect(within(menu).getByRole("menuitem", { name: /Masquer l’onglet/ })).toBeInTheDocument();
    // Ouvrir la copie seule dans sa fenêtre garde sa référence.
    await user.click(within(menu).getByRole("menuitem", { name: /Ouvrir dans une nouvelle fenêtre/ }));
    expect(vi.mocked(openPageWindow)).toHaveBeenCalledWith("jira/tickets@acme");
    await user.click(await openPageMenu(user).then((m) => within(m).getByRole("menuitem", { name: /Déplacer vers/ })));
    const dialog = await screen.findByRole("dialog", { name: "Déplacer « Tickets »" });
    await user.click(within(dialog).getByRole("button", { name: /Section/ }));
    expect(screen.queryByRole("option", { name: "Réglages" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Suivi" })).toBeInTheDocument();
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
    const entry = sidebarRow(label);
    return {
      image: entry.querySelector("img.section-icon-image"),
      lucide: entry.querySelector("svg.lucide:not(.lucide-ellipsis)"),
    };
  };

  it("affiche le logo dans le menu, et revient à une icône Lucide depuis « Changer l’icône… »", async () => {
    const user = userEvent.setup();
    backend = withLogo();
    useShell.setState({ snapshot: withLogo() });
    renderShell();
    const { image, lucide } = entryIcon("Jira");
    expect(image).toHaveAttribute("src", LOGO);
    expect(image).toHaveAttribute("width", "16");
    expect(lucide).toBeNull();

    await user.click(within(await openSectionMenu(user, "Jira")).getByRole("menuitem", { name: /Changer l’icône/ }));
    // « Par défaut », choisi d’office, montre le logo et le garde : rien n’est enregistré.
    const byDefault = screen.getByRole("radio", { name: "Par défaut" });
    expect(byDefault).toBeChecked();
    expect(byDefault.closest("label")?.querySelector("img.section-icon-image")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(lastLayoutCall()).toBeUndefined();

    await user.click(within(await openSectionMenu(user, "Jira")).getByRole("menuitem", { name: /Changer l’icône/ }));
    fireEvent.click(screen.getByRole("radio", { name: "bug" }));
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
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
