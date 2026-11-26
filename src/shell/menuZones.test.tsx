import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationHeader } from "../features/agent/model";
import { invoke } from "../lib/native";
import type { ResolvedPage, Snapshot } from "../lib/types";
import { AppShell } from "./AppShell";
import { agentZoneRows } from "./agentZone";
import { frameContext, handleFrameRequest } from "./frameBridge";
import { entryTarget, type MenuZone, moveEntry, orderedEntries, useMenuZones } from "./menuZones";
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
  inTauri: false,
  openPageWindow: vi.fn(async () => undefined),
  notifySystem: vi.fn(async () => false),
  AlfredError: class extends Error {
    constructor({ message }: { message: string }) {
      super(message);
    }
  },
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

function fixture(): Snapshot {
  return {
    path: "/espace",
    name: "Espace",
    accent: null,
    sections: [
      {
        id: "produits/principal",
        module: "produits",
        label: "Catalogue",
        icon: "box",
        color: null,
        hidden: false,
        pages: [page("produits", "liste", "Produits"), page("produits", "vue", "Vue produit")],
      },
      {
        id: "notes/principal",
        module: "notes",
        label: "Notes",
        icon: "notebook",
        color: null,
        hidden: false,
        pages: [page("notes", "carnet", "Carnet", { hidden: true })],
      },
    ],
    settingsPages: [],
    modules: [],
    functions: [],
    bindings: {},
    problems: [],
    layout: { sections: [] },
  };
}

const zone: MenuZone = {
  title: "Produits",
  order: "user",
  visible: 2,
  entries: [
    { id: "atlas", label: "Atlas", status: "ok", page: "vue" },
    {
      id: "borea",
      label: "Boréa",
      status: "error",
      badge: 3,
      actions: [{ id: "rename", label: "Renommer", icon: "pencil" }],
    },
    { id: "cirrus", label: "Cirrus", status: "running" },
  ],
};

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  localStorage.clear();
  useShell.setState({
    snapshot: fixture(),
    view: { kind: "agent" },
    activeTab: {},
    activeEntry: {},
    sidebarCollapsed: false,
  });
  useMenuZones.setState({ zones: { "produits/liste": zone, "notes/carnet": zone } });
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (command: string) => {
    if (command === "menuZones.list") return useMenuZones.getState().zones;
    if (command === "badges.list") return {};
    return null;
  });
});

describe("ordre et cible d’une entrée", () => {
  it("suit l’ordre de l’utilisateur, les nouvelles entrées à la fin", () => {
    const ordered = orderedEntries({ ...zone, userOrder: ["cirrus", "atlas"] });
    expect(ordered.map((entry) => entry.id)).toEqual(["cirrus", "atlas", "borea"]);
    expect(orderedEntries({ ...zone, order: "page", userOrder: ["cirrus"] }).map((entry) => entry.id)).toEqual([
      "atlas",
      "borea",
      "cirrus",
    ]);
  });

  it("ouvre la page nommée par l’entrée, dans la même copie", () => {
    expect(entryTarget("produits/liste", { id: "a", label: "A" })).toBe("produits/liste");
    expect(entryTarget("produits/liste", { id: "a", label: "A", page: "vue" })).toBe("produits/vue");
    expect(entryTarget("produits/liste@recette", { id: "a", label: "A", page: "vue" })).toBe("produits/vue@recette");
  });

  it("déplace une entrée d’un cran et l’enregistre", () => {
    expect(moveEntry("produits/liste", zone, "atlas", -1)).toBe(false);
    expect(moveEntry("produits/liste", zone, "atlas", 1)).toBe(true);
    expect(useMenuZones.getState().zones["produits/liste"].userOrder).toEqual(["borea", "atlas", "cirrus"]);
    expect(mockedInvoke).toHaveBeenCalledWith("menuZones.reorder", {
      page: "produits/liste",
      order: ["borea", "atlas", "cirrus"],
    });
  });
});

describe("menu.* depuis une page ou une fonction", () => {
  const pageFrame = { kind: "page" as const, module: "produits", reference: "produits/liste" };

  it("vise la zone de la page, ou celle d’une page nommée du module", async () => {
    await handleFrameRequest(pageFrame, "menu.update", { op: "setEntries", entries: [], subject: "falsifié" });
    expect(mockedInvoke).toHaveBeenLastCalledWith("frame.menuZones.update", {
      op: "setEntries",
      entries: [],
      subject: { kind: "page", module: "produits", reference: "produits/liste" },
      page: "produits/liste",
    });
    const fn = { kind: "function" as const, module: "produits", reference: "produits/synchroniser" };
    await expect(handleFrameRequest(fn, "menu.update", { op: "clear" })).rejects.toThrow(/page nommée/);
    await handleFrameRequest(fn, "menu.update", { op: "clear", page: "liste" });
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "frame.menuZones.update",
      expect.objectContaining({ page: "produits/liste", op: "clear" }),
    );
    await expect(handleFrameRequest(fn, "menu.update", { op: "clear", page: "absente" })).rejects.toThrow(
      /Menu refusé/,
    );
  });

  it("donne l’entrée ouverte dans le contexte de la page et de son panneau", () => {
    expect(frameContext(pageFrame).entry).toBeNull();
    useShell.setState({ activeEntry: { "produits/liste": { id: "atlas", label: "Atlas", zone: "produits/liste" } } });
    expect(frameContext(pageFrame).entry).toEqual({ id: "atlas", label: "Atlas" });
    expect(
      frameContext({ kind: "panel", module: "produits", reference: "produits/detail", host: "produits/liste" }).entry,
    ).toEqual({ id: "atlas", label: "Atlas" });
  });
});

describe("zone dans le menu de gauche", () => {
  const renderShell = () => render(<AppShell agent={<div>Agent</div>} settingsTabs={[]} agentAvailable={false} />);
  const navigation = () => screen.getAllByRole("treegrid", { name: "Navigation principale" })[0];
  const row = (name: string) => within(navigation()).getByRole("row", { name });

  it("conversations : point vert au travail, alerte si une réponse est attendue, point de non-lu à consulter", async () => {
    const conv = (id: string, title: string, createdAt: number) =>
      ({
        id,
        title,
        createdAt,
        updatedAt: "2026-11-24T08:00:00Z",
        archived: false,
        started: true,
      }) as unknown as ConversationHeader;
    const states: Record<string, "working" | "attention" | "done" | "idle"> = {
      a: "working",
      b: "attention",
      c: "done",
      d: "idle",
    };
    const rows = agentZoneRows(
      [conv("a", "Au travail", 4), conv("b", "Question", 3), conv("c", "Finie", 2), conv("d", "En veille", 1)],
      (h) => states[h.id],
      false,
    );
    render(
      <AppShell
        agent={<div>Agent</div>}
        settingsTabs={[]}
        agentAvailable
        agentZone={{ rows, onOpen: vi.fn(), onAction: vi.fn() }}
      />,
    );
    const row = async (name: RegExp) => screen.findByRole("row", { name });
    expect((await row(/^Au travail/)).querySelector("[data-activity]")).not.toBeNull();
    expect(within(await row(/^Question/)).getByRole("img", { name: "À traiter" })).toBeTruthy();
    expect(within(await row(/^Finie/)).getByRole("img", { name: "Non lu" })).toBeTruthy();
    const idle = await row(/^En veille/);
    expect(idle.querySelector("[data-activity]")).toBeNull();
    expect(within(idle).queryByRole("img")).toBeNull();
  });

  it("conversations : les délégués se rangent sous leur coordinatrice, et un clic ouvre le délégué", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const conv = (id: string, title: string, createdAt: number, extra: Partial<ConversationHeader> = {}) =>
      ({
        id,
        title,
        provider: "claude",
        createdAt,
        updatedAt: createdAt,
        archived: false,
        started: true,
        ...extra,
      }) as unknown as ConversationHeader;
    const headers = [
      conv("demo", "Préparer la démo", 1),
      conv("vq3", "Ventes Q3", 2, { coordinator: true }),
      conv("d1", "ventes · délégué", 3, { parent: "vq3" }),
      conv("d2", "demandes · délégué", 4, { parent: "vq3" }),
      conv("d3", "documentation · délégué", 5, { parent: "vq3" }),
    ];
    render(
      <AppShell
        agent={<div>Agent</div>}
        settingsTabs={[]}
        agentAvailable
        agentZone={{ rows: agentZoneRows(headers, () => "idle", false), onOpen, onAction: vi.fn() }}
      />,
    );
    // Au premier niveau, la coordinatrice et la conversation ordinaire seulement ; repliée, la coordinatrice résume.
    const coordinator = await screen.findByRole("row", { name: /^Ventes Q3/ });
    expect(coordinator).toHaveAttribute("aria-level", "2");
    expect(screen.queryByRole("row", { name: /^ventes/ })).toBeNull();
    await user.click(within(coordinator).getByRole("button", { name: /^Déplier Ventes Q3/, hidden: true }));
    // Dépliée : ses délégués dessous, sans « · délégué », dans l’ordre où elle les a lancés.
    const delegates = screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-level") === "3")
      .map((row) => row.getAttribute("aria-label"));
    expect(delegates).toEqual(["ventes", "demandes", "documentation"]);
    await user.click(screen.getByRole("row", { name: /^demandes/ }));
    expect(onOpen).toHaveBeenCalledWith("d2");
  });

  it("conversations : un délégué dont la coordinatrice est archivée reste en haut et dit de qui il est le délégué", async () => {
    const headers = [
      { id: "vq3", title: "Ventes Q3", provider: "claude", createdAt: 1, archived: true, started: true },
      {
        id: "d1",
        title: "ventes · délégué",
        provider: "claude",
        createdAt: 2,
        archived: false,
        started: true,
        parent: "vq3",
      },
    ] as unknown as ConversationHeader[];
    render(
      <AppShell
        agent={<div>Agent</div>}
        settingsTabs={[]}
        agentAvailable
        agentZone={{ rows: agentZoneRows(headers, () => "idle", false), onOpen: vi.fn(), onAction: vi.fn() }}
      />,
    );
    const orphan = await screen.findByRole("row", { name: /^ventes/ });
    expect(orphan).toHaveAttribute("aria-level", "2");
    expect(orphan).toHaveTextContent("Délégué de Ventes Q3 · En veille");
    expect(screen.queryByRole("row", { name: /^Ventes Q3/ })).toBeNull();
  });

  it("conversations : le « + » du titre de la section lance une nouvelle conversation", async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    const rows = agentZoneRows(
      [
        {
          id: "c1",
          title: "Factures",
          updatedAt: "2026-11-24T08:00:00Z",
          archived: false,
          started: true,
        } as unknown as ConversationHeader,
      ],
      () => "idle",
      false,
    );
    render(
      <AppShell
        agent={<div>Agent</div>}
        settingsTabs={[]}
        agentAvailable
        agentZone={{ rows, onOpen: vi.fn(), onAction: vi.fn(), onNew }}
      />,
    );
    const header = await screen.findByRole("row", { name: /^Conversations/ });
    await user.click(within(header).getByRole("button", { name: "Nouvelle conversation", hidden: true }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("conversation : « Archiver » est un bouton-icône au survol, absent du menu « … »", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const rows = agentZoneRows(
      [
        {
          id: "c1",
          title: "Factures",
          updatedAt: "2026-11-24T08:00:00Z",
          archived: false,
          started: true,
          unread: false,
        } as unknown as ConversationHeader,
      ],
      () => "idle",
      false,
    );
    render(
      <AppShell
        agent={<div>Agent</div>}
        settingsTabs={[]}
        agentAvailable
        agentZone={{ rows, onOpen: vi.fn(), onAction }}
      />,
    );
    const conversations = await screen.findByRole("row", { name: /^Factures/ });
    const archive = within(conversations).getByRole("button", { name: "Archiver Factures", hidden: true });
    await user.click(archive);
    expect(onAction).toHaveBeenCalledWith("c1", "archive");
    await user.click(within(conversations).getByRole("button", { name: /^Actions sur Factures/, hidden: true }));
    expect(await screen.findByRole("menuitem", { name: /Renommer/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Archiver/ })).toBeNull();
  });

  it("range les entrées en sous-pages de la section, et ouvre la page avec l’entrée", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(within(row("Catalogue")).getByRole("button", { name: /^Déplier/ }));
    // Toutes les entrées de la zone, avec leur compteur ; une page masquée masque sa zone.
    expect(row("Atlas")).toBeTruthy();
    expect(row("Boréa")).toHaveTextContent("3");
    expect(row("Cirrus")).toBeTruthy();
    expect(within(navigation()).getAllByRole("row", { name: "Atlas" })).toHaveLength(1);

    await user.click(row("Atlas"));
    const state = useShell.getState();
    expect(state.view).toEqual({ kind: "section", id: "produits/principal" });
    expect(state.activeTab["produits/principal"]).toBe("produits/vue");
    expect(state.activeEntry["produits/vue"]).toEqual({ id: "atlas", label: "Atlas", zone: "produits/liste" });
    await waitFor(() => expect(row("Atlas")).toHaveAttribute("aria-selected", "true"));

    // L’entrée de la section rouvre ses pages sans entrée.
    await user.click(row("Catalogue"));
    expect(useShell.getState().activeEntry["produits/vue"]).toBeUndefined();
  });

  it("renomme une entrée par son action, et la page reçoit le nouveau libellé", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(within(row("Catalogue")).getByRole("button", { name: /^Déplier/ }));
    await user.click(within(row("Boréa")).getByRole("button", { name: "Renommer Boréa" }));
    const input = await screen.findByRole("textbox", { name: /Nom/ });
    await user.clear(input);
    await user.type(input, "Boréa 2");
    await user.click(screen.getByRole("button", { name: "Renommer" }));
    await waitFor(async () => {
      const actions = await handleFrameRequest(
        { kind: "page", module: "produits", reference: "produits/liste" },
        "menu.takeActions",
        {},
      );
      expect(actions).toEqual([{ entry: "borea", action: "rename", value: "Boréa 2" }]);
    });
  });
});

describe("zone de la page Agent", () => {
  const header = (id: string, createdAt: number, extra: Partial<ConversationHeader> = {}) =>
    ({
      id,
      title: id,
      provider: "codex",
      createdAt,
      updatedAt: createdAt,
      archived: false,
      started: true,
      unread: false,
      ...extra,
    }) as unknown as ConversationHeader;

  it("met réponse attendue et échec en tête, puis la plus récente, sans les archivées", () => {
    const states = { a: "idle", b: "error", c: "attention", d: "working" } as const;
    const rows = agentZoneRows(
      [header("a", 4), header("b", 1), header("c", 2), header("d", 3), header("e", 5, { archived: true })],
      (h) => states[h.id as keyof typeof states],
    );
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["c", "waiting"],
      ["b", "error"],
      ["a", undefined],
      ["d", "running"],
    ]);
    expect(rows[0].actions?.map((action) => action.id)).toEqual(["rename", "window", "archive"]);
    expect(agentZoneRows([header("a", 1)], () => "idle", false)[0].actions?.map((a) => a.id)).toEqual([
      "rename",
      "archive",
    ]);
  });
});
