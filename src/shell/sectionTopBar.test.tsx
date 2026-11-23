import { render, screen, within } from "@testing-library/react";
import { Sidebar, AppShell as SocleShell } from "socle-ui";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResolvedPage, Snapshot } from "../lib/types";
import { useSectionFrame } from "./AppShell";
import { useShell } from "./store";
import type { PageToolsRenderer } from "./types";

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
}));

function page(id: string, title: string): ResolvedPage {
  return {
    reference: `suivi/${id}`,
    module: "suivi",
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

const pages = [page("taches", "Tâches"), page("notes", "Notes")];

beforeEach(() => {
  const snapshot: Snapshot = {
    path: "/espace",
    name: "Espace",
    accent: null,
    sections: [
      { id: "suivi/principal", module: "suivi", label: "Suivi", icon: null, color: null, hidden: false, pages },
    ],
    settingsPages: [],
    modules: [],
    functions: [],
    bindings: {},
    problems: [],
    layout: { sections: [] },
  };
  useShell.setState({ snapshot, activeTab: {} });
});

function Harness({ tools }: { tools?: PageToolsRenderer }) {
  const frame = useSectionFrame({ title: "Suivi", sectionId: "suivi/principal", pages, renderPageTools: tools });
  return (
    <SocleShell
      sidebar={
        <Sidebar
          selectedId="s"
          onSelectionChange={() => undefined}
          account={<Sidebar.Account name="A" onSettings={() => undefined} />}
        >
          <Sidebar.Item id="s" icon={<span />} label="Suivi" />
        </Sidebar>
      }
      pageTitle={frame.pageTitle}
      views={frame.views}
      activeView={frame.activeView}
      onViewChange={frame.onViewChange}
      actions={frame.actions}
    >
      {frame.main}
    </SocleShell>
  );
}

it("montre les pages de la section en vues de la barre du haut, après son titre", () => {
  render(<Harness />);
  const bar = screen.getByRole("banner");
  const tablist = within(bar).getByRole("tablist");
  expect(
    within(tablist)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Tâches", "Notes"]);
  const heading = within(bar).getByRole("heading", { level: 1, name: "Suivi" });
  expect(heading.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("place les outils de la page avant la cloche du centre de notifications", () => {
  render(<Harness tools={() => <button type="button">Corriger l’interface</button>} />);
  const bar = screen.getByRole("banner");
  const tool = within(bar).getByRole("button", { name: "Corriger l’interface" });
  const bell = within(bar).getByRole("button", { name: /notification/i });
  expect(tool.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
