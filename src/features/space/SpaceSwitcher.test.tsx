import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
// Le magasin de la coquille lit le thème du système à son chargement ; jsdom n’a pas `matchMedia`.
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke, onNativeEvent } from "../../lib/native";
import type { Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import type { ConversationHeader } from "../agent/model";
import { useAgents } from "../agent/store";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { renderWithSocle as render } from "./sections.test-helper";
import { switchConfirmation } from "./switchGuard";

// jsdom n’implémente pas les modales natives.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const ATELIER = "/Users/test/Espaces/Atelier";
const PERSO = "/Users/test/Espaces/Perso";

let snapshot: Snapshot;
let jobs: { running: unknown[]; queued: unknown[] };
let calls: Array<{ command: string; args: Record<string, unknown> }>;

const space = (path: string, name: string) =>
  ({
    path,
    name,
    accent: null,
    sections: [],
    settingsPages: [],
    modules: [],
    functions: [],
    bindings: {},
    problems: [],
  }) as unknown as Snapshot;

beforeEach(() => {
  calls = [];
  jobs = { running: [], queued: [] };
  snapshot = space(ATELIER, "Atelier");
  useShell.setState({
    snapshot,
    view: { kind: "agent" },
    sidebarCollapsed: false,
    recentSpaces: [
      { path: ATELIER, name: "Atelier", openedAt: "2026-11-16T09:00:00Z" },
      { path: PERSO, name: "Perso", openedAt: "2026-11-15T09:00:00Z" },
    ],
  });
  useAgents.setState({ headers: [], runtime: {}, loaded: {} });
  vi.mocked(onNativeEvent).mockImplementation(() => () => {});
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "space.open": {
        const path = String(args.path);
        snapshot = space(path, (args.name as string | undefined) ?? path.split("/").pop() ?? path);
        return snapshot;
      }
      case "jobs.list":
        return jobs[args.status as "running" | "queued"] ?? [];
      default:
        return null;
    }
  });
});

const opened = () => calls.filter((call) => call.command === "space.open").map((call) => call.args);

it("montre l’espace ouvert et liste les espaces récents, le courant coché", async () => {
  const user = userEvent.setup();
  render(<SpaceSwitcher />);
  const button = screen.getByRole("button", { name: /Espace de travail : Atelier/ });
  expect(button).toHaveTextContent("Atelier");
  expect(button).toHaveAttribute("aria-haspopup", "menu");

  await user.click(button);
  const menu = screen.getByRole("menu", { name: "Espaces de travail" });
  const recent = within(menu).getByRole("group", { name: "Espaces de travail récents" });
  const items = within(recent).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual(["Atelier", "Perso"]);
  expect(items[0]).toHaveAttribute("aria-current", "true");
  expect(items[1]).not.toHaveAttribute("aria-current");
  expect(within(menu).getByRole("menuitem", { name: "Ouvrir un autre dossier…" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Créer un espace de travail…" })).toBeInTheDocument();

  // L’espace ouvert ne se rouvre pas.
  await user.click(items[0]);
  expect(opened()).toEqual([]);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("ouvre aussitôt l’espace choisi, sans redémarrer, et le place en tête des récents", async () => {
  const user = userEvent.setup();
  render(<SpaceSwitcher />);
  await user.click(screen.getByRole("button", { name: /Espace de travail : Atelier/ }));
  await user.click(screen.getByRole("menuitem", { name: "Perso" }));

  await waitFor(() => expect(opened()).toEqual([{ path: PERSO, existing: true }]));
  await waitFor(() => expect(screen.getByRole("button", { name: /Espace de travail : Perso/ })).toBeInTheDocument());
  expect(useShell.getState().snapshot?.path).toBe(PERSO);
  expect(useShell.getState().recentSpaces.map((recent) => recent.path)).toEqual([PERSO, ATELIER]);
});

it("prévient avant de partir quand un import est en route", async () => {
  jobs.running = [{ id: "j1" }];
  const user = userEvent.setup();
  render(<SpaceSwitcher />);
  await user.click(screen.getByRole("button", { name: /Espace de travail : Atelier/ }));
  await user.click(screen.getByRole("menuitem", { name: "Perso" }));

  let dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("Passer à « Perso » ?");
  expect(dialog).toHaveTextContent(/Une tâche de fond est en route/);
  await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
  expect(opened()).toEqual([]);
  expect(useShell.getState().snapshot?.path).toBe(ATELIER);

  await user.click(screen.getByRole("button", { name: /Espace de travail : Atelier/ }));
  await user.click(screen.getByRole("menuitem", { name: "Perso" }));
  dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Changer d’espace de travail" }));
  await waitFor(() => expect(opened()).toEqual([{ path: PERSO, existing: true }]));
});

it("arrête la conversation d’agent en cours une fois le changement accepté", async () => {
  const cancel = vi.fn(async () => {});
  useAgents.setState({
    headers: [
      { id: "c1", title: "Tableau", archived: false, started: true, lastStatus: "running" } as ConversationHeader,
    ],
    cancel,
  });
  const user = userEvent.setup();
  render(<SpaceSwitcher />);
  await user.click(screen.getByRole("button", { name: /Espace de travail : Atelier/ }));
  await user.click(screen.getByRole("menuitem", { name: "Perso" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent(/Une conversation de l’agent est en cours : elle sera arrêtée/);
  await user.click(within(dialog).getByRole("button", { name: "Changer d’espace de travail" }));
  await waitFor(() => expect(opened()).toEqual([{ path: PERSO, existing: true }]));
  expect(cancel).toHaveBeenCalledWith("c1");
});

it("crée un espace à côté de l’espace ouvert, dans un dossier qui suit son nom", async () => {
  const user = userEvent.setup();
  render(<SpaceSwitcher />);
  await user.click(screen.getByRole("button", { name: /Espace de travail : Atelier/ }));
  await user.click(screen.getByRole("menuitem", { name: "Créer un espace de travail…" }));

  const dialog = screen.getByRole("dialog", { name: "Créer un espace de travail" });
  await user.type(within(dialog).getByLabelText("Nom"), "Essais");
  expect(within(dialog).getByLabelText(/Dossier/)).toHaveValue("/Users/test/Espaces/Essais");
  await user.click(within(dialog).getByRole("button", { name: "Créer l’espace de travail" }));

  await waitFor(() => expect(opened()).toEqual([{ path: "/Users/test/Espaces/Essais", name: "Essais" }]));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(useShell.getState().recentSpaces[0]).toMatchObject({ path: "/Users/test/Espaces/Essais", name: "Essais" });
});

it("ouvre un autre dossier en écrivant son chemin quand le sélecteur n’est pas disponible", async () => {
  const user = userEvent.setup();
  render(<SpaceSwitcher />);
  await user.click(screen.getByRole("button", { name: /Espace de travail : Atelier/ }));
  await user.click(screen.getByRole("menuitem", { name: "Ouvrir un autre dossier…" }));
  const dialog = screen.getByRole("dialog", { name: "Ouvrir un espace de travail" });
  const field = within(dialog).getByLabelText(/Dossier/);
  await user.clear(field);
  await user.type(field, "/Users/test/Autre");
  await user.click(within(dialog).getByRole("button", { name: "Ouvrir l’espace de travail" }));
  await waitFor(() => expect(opened()).toEqual([{ path: "/Users/test/Autre" }]));
});

it("s’ouvre au raccourci clavier, et le menu replié garde une infobulle", async () => {
  useShell.setState({ sidebarCollapsed: true });
  render(<SpaceSwitcher />);
  const button = screen.getByRole("button", { name: /Espace de travail : Atelier/ });
  expect(button).toHaveAttribute("aria-keyshortcuts");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  fireEvent.keyDown(window, { key: "O", shiftKey: true, metaKey: mac, ctrlKey: !mac });
  expect(await screen.findByRole("menu", { name: "Espaces de travail" })).toBeInTheDocument();
  // Sans Maj, la touche n’est pas le raccourci.
  fireEvent.keyDown(window, { key: "o", metaKey: mac, ctrlKey: !mac });
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

it("ne demande rien quand rien n’est en cours, et compte ce qui l’est", () => {
  expect(switchConfirmation({ conversations: [], jobs: 0 }, "Perso")).toBeNull();
  const options = switchConfirmation({ conversations: ["a", "b"], jobs: 3 }, "Perso");
  expect(options?.message).toMatch(/2 conversations de l’agent sont en cours : elles seront arrêtées/);
  expect(options?.message).toMatch(/3 tâches de fond sont en route .* elles s’interrompent et reprendront/);
});
