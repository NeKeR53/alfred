import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResolvedPage, Snapshot } from "../lib/types";
import { SectionView } from "./AppShell";
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

it("place les onglets de la section à gauche, juste après son titre, et les actions à droite", () => {
  render(
    <SectionView
      title="Suivi"
      sectionId="suivi/principal"
      pages={pages}
      actions={<button type="button">Action</button>}
    />,
  );
  const bar = screen.getByRole("banner");
  const title = bar.querySelector(".page-topbar__title");
  const actions = bar.querySelector(".page-topbar__actions");
  if (!(title instanceof HTMLElement) || !(actions instanceof HTMLElement)) throw new Error("barre incomplète");
  const tablist = within(title).getByRole("tablist", { name: "Onglets de Suivi" });
  expect(
    within(tablist)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Tâches", "Notes"]);
  // Le titre d’abord, puis les onglets ; rien des onglets dans les actions.
  const heading = within(title).getByRole("heading", { level: 1, name: "Suivi" });
  expect(heading.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(actions).queryByRole("tablist")).toBeNull();
  expect(within(actions).getByRole("button", { name: "Action" })).toBeInTheDocument();
});

it("sépare d’un trait les outils de la page de ceux de la coquille, et fond le bord des onglets qui débordent", () => {
  render(
    <SectionView
      title="Suivi"
      sectionId="suivi/principal"
      pages={pages}
      renderPageTools={() => <button type="button">Corriger l’interface</button>}
    />,
  );
  const bar = screen.getByRole("banner");
  const tool = within(bar).getByRole("button", { name: "Corriger l’interface" });
  const separator = bar.querySelector(".page-topbar__separator");
  const bell = within(bar).getByRole("button", { name: /notification/i });
  if (!separator) throw new Error("trait absent");
  expect(tool.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(separator.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(bar.querySelector(".shell-tabs")?.classList.contains("overflow-fade")).toBe(true);
});
