import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../lib/native";
import type { ResolvedFunction, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { CommandPalette, fold, paletteFilter, usePalette } from "./CommandPalette";

vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  // cmdk mesure sa liste et fait défiler l’entrée choisie : jsdom n’a ni l’un ni l’autre.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});

vi.mock("../../lib/native", () => ({
  invoke: vi.fn(),
  onNativeEvent: vi.fn(() => () => undefined),
}));

HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

function fn(reference: string, input: unknown): ResolvedFunction {
  const [module, id] = reference.split("/");
  return {
    reference,
    module,
    id,
    description: "",
    input,
    output: null,
    tool: false,
    missing: false,
    errors: [],
    uses: {},
  };
}

function snapshot(): Snapshot {
  const page = (module: string, id: string, title: string) => ({
    reference: `${module}/${id}`,
    module,
    id,
    title,
    icon: null,
    description: "",
    hidden: false,
    readOnly: false,
    missing: false,
    errors: [],
    uses: {},
    panel: null,
  });
  return {
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
        pages: [page("suivi", "taches", "Tâches"), page("suivi", "echeances", "Échéances créées par l’agent")],
      },
    ],
    settingsPages: [page("outils", "jetons", "Jetons")],
    modules: [],
    functions: [
      fn("suivi/synchroniser", { type: "object", properties: {} }),
      fn("suivi/relancer", { type: "object", required: ["client"], properties: { client: { type: "string" } } }),
      { ...fn("suivi/brouillon", null), missing: true },
    ],
    bindings: {},
    problems: [],
  };
}

const mockedInvoke = vi.mocked(invoke);
const open = () => fireEvent.keyDown(window, { key: "k", ctrlKey: true });
const search = () => screen.getByRole("combobox", { name: "Rechercher une page, une fonction ou une commande" });

beforeEach(() => {
  usePalette.setState({ open: false });
  useNotifications.setState({ items: [], toasts: [] });
  useShell.setState({ snapshot: snapshot(), view: { kind: "agent" }, activeTab: {}, info: null, theme: "light" });
  mockedInvoke.mockResolvedValue({ envoyés: 3 });
});

describe("palette de commandes", () => {
  it("cherche sans tenir compte des accents", () => {
    expect(fold("Échéances")).toBe("echeances");
    expect(paletteFilter("x", "echeance agent", ["Échéances créées par l’agent", "Suivi"])).toBeGreaterThan(0);
    expect(paletteFilter("x", "factures", ["Tâches"])).toBe(0);
  });

  it("s’ouvre et se ferme au raccourci, et rend le focus", async () => {
    render(
      <>
        <button type="button">Avant</button>
        <CommandPalette />
      </>,
    );
    const before = screen.getByRole("button", { name: "Avant" });
    before.focus();
    open();
    expect(search()).toHaveFocus();
    open();
    expect(usePalette.getState().open).toBe(false);
    await waitFor(() => expect(before).toHaveFocus());
  });

  it("trouve une page créée par l’agent et y mène", () => {
    render(<CommandPalette />);
    open();
    fireEvent.change(search(), { target: { value: "echeances" } });
    expect(screen.queryByRole("option", { name: /Tâches/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Échéances créées par l’agent/ }));
    expect(useShell.getState().view).toEqual({ kind: "section", id: "suivi/principal" });
    expect(useShell.getState().activeTab["suivi/principal"]).toBe("suivi/echeances");
    expect(usePalette.getState().open).toBe(false);
  });

  it("propose les pages des Réglages et masque les fonctions non écrites", () => {
    render(<CommandPalette />);
    open();
    expect(screen.getByRole("option", { name: /Jetons/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /brouillon/ })).not.toBeInTheDocument();
  });

  it("lance directement une fonction sans entrée requise et notifie son résultat", async () => {
    render(<CommandPalette />);
    open();
    fireEvent.change(search(), { target: { value: "synchro" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(mockedInvoke).toHaveBeenCalledWith("functions.call", { function: "suivi/synchroniser", input: {} });
    await waitFor(() =>
      expect(useNotifications.getState().items[0]).toMatchObject({
        tone: "success",
        title: "Fonction suivi/synchroniser terminée",
      }),
    );
  });

  it("demande l’entrée JSON d’une fonction qui en exige une", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("Client inconnu."));
    render(<CommandPalette />);
    open();
    fireEvent.click(screen.getByRole("option", { name: /suivi\/relancer/ }));
    const field = screen.getByRole("textbox", { name: "Entrée de suivi/relancer" });
    expect(field).toHaveValue('{\n  "client": ""\n}');
    fireEvent.change(field, { target: { value: "{ client: " } });
    fireEvent.click(screen.getByRole("button", { name: "Lancer" }));
    expect(screen.getByText(/JSON invalide/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '{ "client": "ACME" }' } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(mockedInvoke).toHaveBeenCalledWith("functions.call", {
      function: "suivi/relancer",
      input: { client: "ACME" },
    });
    await waitFor(() =>
      expect(useNotifications.getState().items[0]).toMatchObject({
        tone: "error",
        title: "La fonction suivi/relancer a échoué",
        description: "Client inconnu.",
      }),
    );
  });

  it("bascule le thème", () => {
    const setTheme = vi.fn();
    useShell.setState({ setTheme });
    render(<CommandPalette />);
    act(() => usePalette.getState().setOpen(true));
    fireEvent.click(screen.getByRole("option", { name: /Passer au thème sombre/ }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });
});
