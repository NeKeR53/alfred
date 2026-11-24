import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar, AppShell as SocleShell } from "socle-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: vi.fn(() => () => undefined),
  frameBase: (base: string) => base,
  inTauri: false,
}));

import type { ResolvedPage, Snapshot } from "../lib/types";
import { views as sdkViews } from "../sdk";
import type { FrameRequest } from "../sdk/protocol";
import { useSectionFrame } from "./AppShell";
import { type FrameIdentity, frameContext, handleFrameRequest } from "./frameBridge";
import { resetOpenViews, startOpenViews, useOpenViews, VIEW_LIMIT, viewKey } from "./openViews";
import { useShell } from "./store";

function page(id: string, title: string): ResolvedPage {
  return {
    reference: `jira/${id}`,
    module: "jira",
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
  };
}

const pages = [page("tickets", "Tickets"), page("tableau", "Tableau")];
const ticketPage = { ...page("ticket", "Ticket"), hidden: true };
const SECTION = "jira/travail";
const tickets: FrameIdentity = { kind: "page", module: "jira", reference: "jira/tickets" };

function snapshot(path = "/espace"): Snapshot {
  return {
    path,
    name: "Espace",
    accent: null,
    sections: [
      {
        id: SECTION,
        module: "jira",
        label: "Jira",
        icon: null,
        color: null,
        hidden: false,
        pages: [...pages, ticketPage],
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

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(null);
  resetOpenViews();
  useShell.setState({ snapshot: snapshot(), activeTab: {}, activeView: {}, view: { kind: "section", id: SECTION } });
});

const open = (id: string, label = id, extra: Record<string, unknown> = {}) =>
  handleFrameRequest(tickets, "views.open", { id, label, ...extra });

describe("views.open et views.close (pont)", () => {
  it("ouvre un onglet après les fixes, l’active, et ne crée pas de doublon", async () => {
    await open("PROJ-1", "PROJ-1 Paiement refusé", { params: { key: "PROJ-1" } });
    await open("PROJ-2");
    await open("PROJ-1", "PROJ-1 Paiement accepté");
    const list = useOpenViews.getState().views[SECTION];
    expect(list.map((view) => [view.id, view.label])).toEqual([
      ["PROJ-1", "PROJ-1 Paiement accepté"],
      ["PROJ-2", "PROJ-2"],
    ]);
    const state = useShell.getState();
    expect(state.activeView[SECTION]).toBe(viewKey({ page: "jira/tickets", id: "PROJ-1" }));
    expect(state.activeTab[SECTION]).toBe("jira/tickets");
  });

  it("ouvre une autre page du module, même cachée, et refuse une page d’un autre module", async () => {
    await open("PROJ-3", "PROJ-3", { page: "ticket" });
    expect(useOpenViews.getState().views[SECTION][0].page).toBe("jira/ticket");
    await expect(open("X", "X", { page: "banque/comptes" })).rejects.toThrow(/propre module/);
    await expect(open("X", "X", { page: "absente" })).rejects.toThrow(/n’existe pas/);
  });

  it("refuse un onglet sans identifiant, sans libellé, ou demandé par une fonction", async () => {
    await expect(open("", "x")).rejects.toThrow(/identifiant/);
    await expect(handleFrameRequest(tickets, "views.open", { id: "a" })).rejects.toThrow(/libellé/);
    await expect(open("a", "a", { params: [1] })).rejects.toThrow(/objet/);
    const fn: FrameIdentity = { kind: "function", module: "jira", reference: "jira/sync" };
    await expect(handleFrameRequest(fn, "views.open", { id: "a", label: "a" })).rejects.toThrow(/page affichée/);
  });

  it(`garde ${VIEW_LIMIT} onglets au plus : le plus ancien se ferme`, async () => {
    for (let index = 1; index <= VIEW_LIMIT + 2; index++) await open(`T-${index}`);
    const ids = useOpenViews.getState().views[SECTION].map((view) => view.id);
    expect(ids).toHaveLength(VIEW_LIMIT);
    expect(ids[0]).toBe("T-3");
    expect(ids.at(-1)).toBe(`T-${VIEW_LIMIT + 2}`);
  });

  it("fermer l’onglet actif affiche celui de gauche, puis le dernier onglet fixe", async () => {
    await open("A");
    await open("B");
    expect(await handleFrameRequest(tickets, "views.close", { id: "B" })).toBe(true);
    expect(useShell.getState().activeView[SECTION]).toBe(viewKey({ page: "jira/tickets", id: "A" }));
    // Sans identifiant, le cadre ferme l’onglet qu’il montre.
    const shown = { ...tickets, view: { ...useOpenViews.getState().views[SECTION][0], section: SECTION } };
    expect(await handleFrameRequest(shown, "views.close", {})).toBe(true);
    expect(useShell.getState().activeView[SECTION]).toBeUndefined();
    expect(useShell.getState().activeTab[SECTION]).toBe("jira/tableau");
    expect(await handleFrameRequest(tickets, "views.close", { id: "absent" })).toBe(false);
  });

  it("donne l’élément à la page et à son panneau dans le contexte, et rien dans un onglet fixe", async () => {
    await open("PROJ-9", "PROJ-9", { params: { key: "PROJ-9" } });
    const view = { ...useOpenViews.getState().views[SECTION][0], section: SECTION };
    expect(frameContext({ ...tickets, view }).view).toEqual({
      id: "PROJ-9",
      label: "PROJ-9",
      params: { key: "PROJ-9" },
    });
    const panel: FrameIdentity = {
      kind: "panel",
      module: "jira",
      reference: "jira/detail",
      host: "jira/tickets",
      view,
    };
    expect(frameContext(panel).view?.id).toBe("PROJ-9");
    expect(frameContext(tickets).view).toBeNull();
  });

  it("choisir un onglet fixe, ou naviguer vers une page, quitte l’onglet d’élément", async () => {
    await open("A");
    useShell.getState().setActiveTab(SECTION, "jira/tableau");
    expect(useShell.getState().activeView[SECTION]).toBeUndefined();
    await open("A");
    useShell.getState().openPage("jira/tickets");
    expect(useShell.getState().activeView[SECTION]).toBeUndefined();
    expect(useOpenViews.getState().views[SECTION]).toHaveLength(1);
  });
});

describe("mémoire des onglets", () => {
  afterEach(() => resetOpenViews());

  it("les relit par espace au démarrage et les enregistre à chaque changement", async () => {
    const stored = {
      [SECTION]: {
        views: [{ id: "PROJ-5", label: "PROJ-5", params: null, page: "jira/tickets" }],
        active: viewKey({ page: "jira/tickets", id: "PROJ-5" }),
      },
    };
    native.invoke.mockImplementation((command: string, args: { key?: string }) =>
      Promise.resolve(command === "settings.get" && args.key === "shell.views:/espace" ? stored : null),
    );
    startOpenViews();
    await vi.waitFor(() => expect(useOpenViews.getState().views[SECTION]).toHaveLength(1));
    expect(useShell.getState().activeView[SECTION]).toBe(stored[SECTION].active);
    await open("PROJ-6");
    const saved = native.invoke.mock.calls.filter(([command]) => command === "settings.set").at(-1)?.[1] as {
      key: string;
      value: Record<string, { views: { id: string }[]; active: string }>;
    };
    expect(saved.key).toBe("shell.views:/espace");
    expect(saved.value[SECTION].views.map((view) => view.id)).toEqual(["PROJ-5", "PROJ-6"]);
    expect(saved.value[SECTION].active).toBe(viewKey({ page: "jira/tickets", id: "PROJ-6" }));
  });

  it("change d’onglets avec l’espace", async () => {
    startOpenViews();
    await open("A");
    act(() => useShell.setState({ snapshot: snapshot("/autre") }));
    expect(useOpenViews.getState().views).toEqual({});
  });
});

function Harness() {
  const frame = useSectionFrame({ title: "Jira", sectionId: SECTION, pages });
  return (
    <SocleShell
      sidebar={
        <Sidebar
          selectedId="s"
          onSelectionChange={() => undefined}
          account={<Sidebar.Account name="A" onSettings={() => undefined} />}
        >
          <Sidebar.Item id="s" icon={<span />} label="Jira" />
        </Sidebar>
      }
      pageTitle={frame.pageTitle}
      views={frame.views}
      activeView={frame.activeView}
      onViewChange={frame.onViewChange}
      onViewClose={frame.onViewClose}
      actions={frame.actions}
    >
      {frame.main}
    </SocleShell>
  );
}

describe("onglets dans la barre du haut (coquille)", () => {
  it("montre les onglets ouverts après les fixes ; seuls eux ont une croix", async () => {
    await open("PROJ-1", "PROJ-1 Paiement refusé");
    render(<Harness />);
    const tablist = within(screen.getByRole("banner")).getByRole("tablist");
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(["Tickets", "Tableau", "PROJ-1 Paiement refusé"]);
    expect(
      within(tablist)
        .getByRole("tab", { name: /PROJ-1/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "Fermer la vue Tickets" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fermer la vue PROJ-1 Paiement refusé" }));
    expect(useOpenViews.getState().views[SECTION]).toEqual([]);
    expect(within(tablist).getByRole("tab", { name: "Tableau" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("SDK", () => {
  it("envoie views.open et views.close au pont", () => {
    const sent: FrameRequest[] = [];
    const spy = vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
      if ((message as FrameRequest).kind === "request") sent.push(message as FrameRequest);
    });
    void sdkViews.open({ id: "PROJ-1", label: "PROJ-1", params: { key: "PROJ-1" }, page: "ticket" });
    void sdkViews.close("PROJ-1");
    void sdkViews.close();
    expect(sent.map((request) => [request.method, request.params])).toEqual([
      ["views.open", { id: "PROJ-1", label: "PROJ-1", params: { key: "PROJ-1" }, page: "ticket" }],
      ["views.close", { id: "PROJ-1" }],
      ["views.close", {}],
    ]);
    spy.mockRestore();
  });
});
