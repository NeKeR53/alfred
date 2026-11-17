import { render, screen, waitFor, within } from "@testing-library/react";
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
import type { ModuleSummary, ResolvedFunction, Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { skeleton } from "./FunctionParts";
import { ModuleFunctions } from "./ModuleFunctions";

HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const fn = (reference: string, patch: Partial<ResolvedFunction> = {}): ResolvedFunction => ({
  reference,
  module: reference.split("/")[0],
  id: reference.split("/")[1],
  description: "",
  input: null,
  output: null,
  tool: false,
  missing: false,
  errors: [],
  uses: {},
  runtime: "ts",
  ...patch,
});

const module = (id: string, name: string, readOnly = false): ModuleSummary => ({
  id,
  name,
  version: "1.0.0",
  description: "",
  readOnly,
  origin: null,
  hidden: false,
  requires: [],
  requiredBy: [],
  pages: 0,
  functions: 1,
  clients: [],
  webhooks: [],
  schedules: [],
});

let snapshot: Snapshot;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let callResult: { output?: unknown; error?: string };

beforeEach(() => {
  calls = [];
  callResult = { output: { total: 1280 } };
  useNotifications.getState().clear();
  snapshot = {
    path: "/tmp/espace",
    name: "Atelier",
    accent: null,
    sections: [],
    settingsPages: [],
    modules: [module("ventes", "Ventes"), module("meteo", "Météo", true)],
    functions: [
      fn("ventes/total", {
        description: "Total des ventes d’une période.",
        input: {
          type: "object",
          properties: {
            mois: { type: "string", default: "2026-11" },
            net: { type: "boolean" },
            max: { type: "integer" },
          },
        },
      }),
      fn("ventes/relance", { missing: true }),
      fn("ventes/export", { errors: [{ message: "Cannot find name 'rows'.", line: 12, column: 3 }] }),
      fn("meteo/prevision", { tool: true, description: "Prévision à trois jours." }),
    ],
    bindings: {},
    problems: [],
  };
  useShell.setState({ snapshot });
  vi.mocked(onNativeEvent).mockImplementation(() => () => undefined);
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "functions.setTool": {
        const { reference, tool } = args as { reference: string; tool: boolean };
        snapshot = {
          ...snapshot,
          functions: snapshot.functions.map((item) => (item.reference === reference ? { ...item, tool } : item)),
        };
        return null;
      }
      case "functions.remove":
        snapshot = { ...snapshot, functions: snapshot.functions.filter((item) => item.reference !== args.reference) };
        return null;
      case "functions.call":
        if (callResult.error) throw new Error(callResult.error);
        return callResult.output;
      case "space.snapshot":
        return snapshot;
      case "functions.tests":
        return { functions: [] };
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

const lastCall = (command: string) => calls.filter((call) => call.command === command).at(-1)?.args;

it("tire un squelette d’entrée du schéma", () => {
  expect(skeleton({ type: "object", properties: { a: { type: "number" }, b: { enum: ["x", "y"] } } })).toEqual({
    a: 0,
    b: "x",
  });
  expect(skeleton(null)).toEqual({});
});

/** Fiche d’un module : sa partie « Fonctions », comme dans Réglages → Modules. */
function renderModule(id: string) {
  const summary = snapshot.modules.find((candidate) => candidate.id === id) as ModuleSummary;
  return render(<ModuleFunctions module={summary} clientLabels={[]} />);
}

it("montre l’état de chaque fonction du module, l’expose aux agents, l’essaie et la supprime", async () => {
  const user = userEvent.setup();
  const { rerender } = renderModule("ventes");

  // Une ligne par fonction ; l’état n’est écrit que s’il y a quelque chose à corriger.
  expect(screen.queryByText("Prête")).not.toBeInTheDocument();
  expect(screen.getByText("Pas encore écrite")).toBeInTheDocument();
  expect(screen.getByText("Ne compile pas")).toBeInTheDocument();
  expect(screen.getByText("Ligne 12, colonne 3 : Cannot find name 'rows'.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Essayer la fonction relance" })).toBeDisabled();

  // Exposer « total » aux agents.
  const toolSwitch = screen.getByRole("switch", { name: "Proposer la fonction total aux agents comme outil" });
  await user.click(toolSwitch);
  await waitFor(() => expect(lastCall("functions.setTool")).toEqual({ reference: "ventes/total", tool: true }));
  useShell.setState({ snapshot });
  rerender(<ModuleFunctions module={snapshot.modules[0]} clientLabels={[]} />);
  await waitFor(() => expect(toolSwitch).toBeChecked());

  // Essayer : entrée préremplie, JSON invalide refusé, sortie à chasse fixe.
  await user.click(screen.getByRole("button", { name: "Essayer la fonction total" }));
  const dialog = screen.getByRole("dialog", { name: "Essayer « total »" });
  const input = within(dialog).getByLabelText("Entrée (JSON)");
  expect(JSON.parse((input as HTMLTextAreaElement).value)).toEqual({ mois: "2026-11", net: false, max: 0 });
  await user.clear(input);
  await user.type(input, "{{ mois: ");
  await user.click(within(dialog).getByRole("button", { name: "Exécuter" }));
  expect(within(dialog).getByText(/Saisissez une entrée en JSON valide/)).toBeInTheDocument();
  expect(lastCall("functions.call")).toBeUndefined();

  await user.clear(input);
  await user.type(input, '{{ "mois": "2026-10" }');
  await user.click(within(dialog).getByRole("button", { name: "Exécuter" }));
  await waitFor(() => expect(dialog.querySelector("pre code")?.textContent).toContain('"total": 1280'));
  expect(lastCall("functions.call")).toEqual({ function: "ventes/total", input: { mois: "2026-10" } });

  callResult = { error: "Le client Jira a répondu 401." };
  await user.click(within(dialog).getByRole("button", { name: "Exécuter" }));
  expect(await within(dialog).findByText("Échec de l’exécution")).toBeInTheDocument();
  expect(dialog.querySelector("pre code")?.textContent).toContain("Le client Jira a répondu 401.");
  await user.click(within(dialog).getAllByRole("button", { name: "Fermer" }).at(-1) as HTMLElement);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  // Supprimer : confirmé.
  await user.click(screen.getByRole("button", { name: "Supprimer la fonction relance" }));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Supprimer" }));
  await waitFor(() => expect(lastCall("functions.remove")).toEqual({ reference: "ventes/relance" }));
});

it("dans un module en lecture seule, l’exposition aux agents suit sa version d’origine", () => {
  renderModule("meteo");
  expect(screen.getByRole("switch", { name: "Proposer la fonction prevision aux agents comme outil" })).toBeDisabled();
});

it("indique le langage d’un script et l’absence de son interpréteur", () => {
  snapshot = {
    ...snapshot,
    functions: [
      fn("ventes/archiver", { runtime: "python" }),
      fn("ventes/sauver", {
        runtime: "pwsh",
        errors: [{ message: "Interpréteur PowerShell introuvable : installer PowerShell 7." }],
      }),
    ],
  };
  useShell.setState({ snapshot });
  renderModule("ventes");
  expect(screen.getByText("Python")).toBeInTheDocument();
  expect(screen.getByText("PowerShell")).toBeInTheDocument();
  expect(screen.getByText("Interpréteur absent")).toBeInTheDocument();
  expect(screen.getByText("Interpréteur PowerShell introuvable : installer PowerShell 7.")).toBeInTheDocument();
  expect(screen.queryByText("TypeScript")).not.toBeInTheDocument();
});
