import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../lib/native";
import type { ResolvedFunction, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { renderWithSocle as render } from "../space/sections.test-helper";
import { CommandPalette, fold, usePalette } from "./CommandPalette";

vi.mock("../../lib/native", () => ({
  invoke: vi.fn(),
  onNativeEvent: vi.fn(() => () => undefined),
}));

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
    runtime: "ts",
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
  });

  it("s’ouvre et se ferme au raccourci", async () => {
    render(<CommandPalette />);
    open();
    expect(await screen.findByRole("dialog", { name: "Palette de commandes" })).toBeInTheDocument();
    expect(search()).toBeInTheDocument();
    open();
    expect(usePalette.getState().open).toBe(false);
  });

  it("trouve une page créée par l’agent et y mène", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    open();
    await user.type(search(), "echeances");
    expect(screen.queryByRole("option", { name: /Tâches/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /Échéances créées par l’agent/ }));
    expect(useShell.getState().view).toEqual({ kind: "section", id: "suivi/principal" });
    expect(useShell.getState().activeTab["suivi/principal"]).toBe("suivi/echeances");
    expect(usePalette.getState().open).toBe(false);
  });

  it("propose les pages des Réglages et masque les fonctions non écrites", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    open();
    await user.type(search(), "jetons");
    expect(await screen.findByRole("option", { name: /Jetons/ })).toBeInTheDocument();
    await user.clear(search());
    await user.type(search(), "brouillon");
    expect(screen.queryByRole("option", { name: /brouillon/ })).not.toBeInTheDocument();
  });

  it("lance directement une fonction sans entrée requise et notifie son résultat", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    open();
    await user.type(search(), "synchro");
    await screen.findByRole("option", { name: /suivi\/synchroniser/ });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(mockedInvoke).toHaveBeenCalledWith("functions.call", { function: "suivi/synchroniser", input: {} });
    await waitFor(() =>
      expect(useNotifications.getState().items[0]).toMatchObject({
        tone: "success",
        title: "Fonction suivi/synchroniser terminée",
      }),
    );
  });

  it("demande l’entrée JSON d’une fonction qui en exige une", async () => {
    const user = userEvent.setup();
    mockedInvoke.mockRejectedValueOnce(new Error("Client inconnu."));
    render(<CommandPalette />);
    open();
    await user.type(search(), "relancer");
    await user.click(await screen.findByRole("option", { name: /suivi\/relancer/ }));
    const field = await screen.findByRole("textbox", { name: /Entrée de suivi\/relancer/ });
    expect(field).toHaveValue('{\n  "client": ""\n}');
    fireEvent.change(field, { target: { value: "{ client: " } });
    await user.click(screen.getByRole("button", { name: "Lancer" }));
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

  it("bascule le thème", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    useShell.setState({ setTheme });
    render(<CommandPalette />);
    act(() => usePalette.getState().setOpen(true));
    await user.type(search(), "theme");
    await user.click(await screen.findByRole("option", { name: /Passer au thème sombre/ }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });
});
