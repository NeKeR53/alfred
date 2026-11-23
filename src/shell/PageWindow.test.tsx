import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResolvedPage, Snapshot } from "../lib/types";
import { PageWindow, pageWindowReference } from "./PageWindow";
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

function page(reference: string, title: string, extra: Partial<ResolvedPage> = {}): ResolvedPage {
  const [module, id] = reference.split("@")[0].split("/");
  return {
    reference,
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

const snapshot = (): Snapshot => ({
  path: "/espace",
  name: "Espace",
  accent: null,
  sections: [
    {
      id: "jira/principal@acme",
      module: "jira",
      label: "Jira — Acme",
      icon: null,
      color: null,
      hidden: false,
      pages: [page("jira/tickets@acme", "Tickets", { instance: "acme" })],
      instance: "acme",
      instanceOf: "jira/principal",
    },
    {
      id: "mail/principal",
      module: "mail",
      label: "Mail",
      icon: null,
      color: null,
      hidden: false,
      pages: [page("mail/boite", "Boîte")],
      waiting: "Le client « Mail » n’a encore aucune instance.",
    },
  ],
  settingsPages: [],
  modules: [],
  functions: [],
  bindings: {},
  problems: [],
  layout: { sections: [] },
});

beforeEach(() => {
  useShell.setState({ snapshot: snapshot(), activeTab: {} });
  delete (window as { __ALFRED_PAGE_WINDOW__?: unknown }).__ALFRED_PAGE_WINDOW__;
});

it("reconnaît une fenêtre de page à la référence posée par Rust", () => {
  expect(pageWindowReference()).toBeNull();
  (window as { __ALFRED_PAGE_WINDOW__?: unknown }).__ALFRED_PAGE_WINDOW__ = { reference: "jira/tickets@acme" };
  expect(pageWindowReference()).toBe("jira/tickets@acme");
});

it("affiche la page seule, sans le menu de l’espace de travail", () => {
  render(<PageWindow reference="jira/tickets@acme" />);
  expect(screen.getByRole("heading", { name: "Tickets" })).toBeInTheDocument();
  expect(screen.getByText("Page en cours de création")).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: "Mail" })).not.toBeInTheDocument();
});

it("garde l’attente d’une section par instance, et dit quand la page a disparu", () => {
  const { unmount } = render(<PageWindow reference="mail/boite" />);
  expect(screen.getByText("Le client « Mail » n’a encore aucune instance.")).toBeInTheDocument();
  unmount();
  render(<PageWindow reference="jira/tickets@autre" />);
  expect(screen.getAllByText("Page introuvable").length).toBeGreaterThan(0);
});
