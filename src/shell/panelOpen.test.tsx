import { act, render, screen, waitFor } from "@testing-library/react";
import { Sidebar, AppShell as SocleShell } from "socle-ui";
import { beforeEach, expect, it, vi } from "vitest";

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
import { useSectionFrame } from "./AppShell";
import { type FrameIdentity, handleFrameRequest } from "./frameBridge";
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

const detailPanel = { ...page("detail", "Détail du ticket"), missing: false };
const pages = [{ ...page("tickets", "Tickets"), panel: detailPanel }, page("tableau", "Tableau")];
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
  useShell.setState({
    snapshot: snapshot(),
    activeTab: {},
    activeView: {},
    panelHidden: {},
    view: { kind: "section", id: SECTION },
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
      actions={frame.actions}
      detail={frame.detail}
      isDetailOpen={frame.isDetailOpen}
      onDetailOpenChange={frame.onDetailOpenChange}
    >
      {frame.main}
    </SocleShell>
  );
}

/** Une page ouvre ou ferme son panneau (`shell.setPanelVisible`, par exemple au clic sur un élément) : l’AppShell suit. */
it("une page ouvre et ferme son panneau de détail, une fois un élément choisi", async () => {
  render(<Harness />);
  const detail = () => screen.queryByRole("complementary", { name: "Détail" });
  await act(() => handleFrameRequest(tickets, "shell.publish", { selection: { key: "T-1" } }));
  await act(() => handleFrameRequest(tickets, "shell.setPanelVisible", { visible: false }));
  await waitFor(() => expect(detail()).toBeNull());
  await act(() => handleFrameRequest(tickets, "shell.setPanelVisible", { visible: true }));
  await waitFor(() => expect(detail()).not.toBeNull());
  await act(() => handleFrameRequest(tickets, "shell.publish", { selection: null }));
});

/** Par design, le panneau n’existe pas : sans élément choisi, ni colonne ni bouton, même si la page l’ouvre. */
it("sans élément choisi, la page n’a ni panneau ni bouton de panneau", async () => {
  render(<Harness />);
  const detail = () => screen.queryByRole("complementary", { name: "Détail" });
  await act(() => handleFrameRequest(tickets, "shell.setPanelVisible", { visible: true }));
  expect(detail()).toBeNull();
  expect(screen.queryByRole("button", { name: /panneau|détail/i })).toBeNull();
  await act(() => handleFrameRequest(tickets, "shell.publish", { selection: { key: "T-2" } }));
  await waitFor(() => expect(detail()).not.toBeNull());
  // La sélection retirée, le panneau disparaît avec son bouton.
  await act(() => handleFrameRequest(tickets, "shell.publish", { selection: null }));
  await waitFor(() => expect(detail()).toBeNull());
  expect(screen.queryByText(/Configurer un compte|Sélectionnez/)).toBeNull();
});
