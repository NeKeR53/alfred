import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../lib/native";
import type { Commit, ResolvedPage, Snapshot } from "../../lib/types";
import { AppShell } from "../../shell/AppShell";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { NavigationSettings } from "./NavigationSettings";
import { undoScope } from "./PageHistory";

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
  frameBase: (base: string) => base,
}));

HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

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
    uses: { clients: [], functions: [] },
    panel: null,
  };
}

const snapshot: Snapshot = {
  path: "/espace",
  name: "Espace",
  accent: null,
  sections: [
    {
      id: "suivi/principal",
      module: "suivi",
      label: "Suivi",
      icon: null,
      color: null,
      hidden: false,
      pages: [page("taches", "Tâches"), page("notes", "Notes")],
    },
  ],
  settingsPages: [],
  modules: [],
  functions: [],
  bindings: {},
  problems: [],
  layout: { sections: [] },
};

/** Faux dépôt : deux modifications de la page Tâches ; annuler en ajoute une troisième. */
let history: Commit[];
const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  history = [
    {
      id: "c2",
      message: "Tour d’agent : colonne échéance",
      date: "2026-11-12T10:00:00Z",
      files: ["modules/suivi/pages/taches.tsx"],
    },
    {
      id: "c1",
      message: "Tour d’agent : page Tâches",
      date: "2026-11-11T09:00:00Z",
      files: ["modules/suivi/module.json", "modules/suivi/pages/taches.tsx"],
    },
  ];
  useNotifications.setState({ items: [], toasts: [] });
  useShell.setState({ snapshot, view: { kind: "section", id: "suivi/principal" }, activeTab: {} });
  mockedInvoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "space.history") {
      return args.path === "modules/suivi/pages/taches.tsx" ? history : [];
    }
    if (command === "space.undo") {
      const undone = history.find((commit) => commit.id === args.commit);
      history = [
        { id: "c3", message: `Annulation de « ${undone?.message} »`, date: "2026-11-13T08:00:00Z", files: [] },
        ...history,
      ];
      return { commit: "c3" };
    }
    if (command === "space.snapshot") return snapshot;
    return null;
  });
});

async function undoInDialog(dialog: HTMLElement, message: string) {
  await within(dialog).findByText(message);
  fireEvent.click(within(dialog).getByRole("button", { name: `Annuler « ${message} »` }));
  fireEvent.click(await screen.findByRole("button", { name: "Annuler la modification" }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("space.undo", { commit: "c2" }));
  await waitFor(() => expect(document.body.textContent).toContain(`Annulation de « ${message} »`));
}

describe("historique d’une page", () => {
  it("depuis le menu de l’onglet : liste les modifications de la page et en annule une", async () => {
    render(<AppShell agent={<p>Agent</p>} settingsTabs={[]} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Tâches" }), { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Actions de l’onglet Tâches" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Historique/ }));

    const dialog = screen.getByRole("dialog", { name: "Historique de « Tâches »" });
    expect(mockedInvoke).toHaveBeenCalledWith("space.history", { path: "modules/suivi/pages/taches.tsx", limit: 100 });
    await undoInDialog(dialog, "Tour d’agent : colonne échéance");
    expect(useNotifications.getState().items[0]?.title).toBe("Modification annulée");
  });

  it("depuis l’écran Navigation, avec un état vide pour une page jamais modifiée", async () => {
    render(<NavigationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Historique de la page Notes" }));
    const empty = screen.getByRole("dialog", { name: "Historique de « Notes »" });
    await within(empty).findByText("Aucune modification enregistrée");
    fireEvent.click(within(empty).getByRole("button", { name: "Fermer" }));

    fireEvent.click(screen.getByRole("button", { name: "Historique de la page Tâches" }));
    await undoInDialog(
      screen.getByRole("dialog", { name: "Historique de « Tâches »" }),
      "Tour d’agent : colonne échéance",
    );
  });
});

describe("portée d’une annulation depuis l’historique d’une page", () => {
  const page = "modules/suivi/pages/taches.tsx";
  it("ne mentionne d’autres fichiers que s’il y en a", () => {
    expect(undoScope({ files: [page] }, page)).toBe("");
    expect(undoScope({ files: [page, "modules/suivi/module.json"] }, page)).toBe(
      " Il défait aussi l’autre fichier touché par cette modification.",
    );
    expect(undoScope({ files: [page, "a.sql", "b.ts"] }, page)).toBe(
      " Il défait aussi les 2 autres fichiers touchés par cette modification.",
    );
  });
});
