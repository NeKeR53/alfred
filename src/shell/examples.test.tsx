import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/native");

vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

import { ExampleModePart } from "../features/modules/ExampleModePart";
import type { SetupStep } from "../features/setup/api";
import { SetupGate } from "../features/setup/SetupGate";
import { invoke, onNativeEvent } from "../lib/native";
import type { ModuleSummary, ResolvedFunction, Snapshot } from "../lib/types";
import { ExampleIndicator } from "./ExampleIndicator";
import { useShell } from "./store";

/**
 * Mode « données d’exemple » : bouton de la page d’attente, interrupteur de la fiche du module, pastille de la barre.
 * Le faux backend garde la liste des modules en mode exemple, comme `src-tauri/src/examples.rs`.
 */
let examples: string[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;

const step: SetupStep = {
  key: "tickets/jira",
  module: "tickets",
  moduleName: "Tickets",
  need: "jira",
  label: "Jira",
  help: "",
  optional: false,
  hasTemplate: false,
  client: null,
  state: "missing",
};

const lister: ResolvedFunction = {
  reference: "tickets/lister",
  module: "tickets",
  id: "lister",
  description: "",
  input: {},
  output: {},
  tool: false,
  missing: false,
  errors: [],
  uses: { clients: ["jira"] },
  runtime: "ts",
  examples: 2,
};

const module: ModuleSummary = {
  id: "tickets",
  name: "Tickets",
  version: "0.1.0",
  description: "",
  readOnly: false,
  origin: null,
  hidden: false,
  requires: [],
  requiredBy: [],
  pages: 1,
  functions: 2,
  clients: [{ id: "jira", label: "Jira" } as ModuleSummary["clients"][number]],
  webhooks: [],
  schedules: [],
};

function snapshot(functions: ResolvedFunction[] = [lister]): Snapshot {
  return {
    path: "/tmp/espace",
    name: "Essai",
    accent: null,
    sections: [],
    settingsPages: [],
    modules: [module],
    functions,
    bindings: {},
    problems: [],
    examples,
  };
}

beforeEach(() => {
  examples = [];
  calls = [];
  useShell.setState({ snapshot: snapshot() });
  vi.mocked(onNativeEvent).mockImplementation(() => () => undefined);
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "modules.setup":
        return {
          modules: [
            {
              module: "tickets",
              name: "Tickets",
              description: "",
              welcome: "",
              installed: true,
              ready: false,
              steps: [step],
            },
          ],
        };
      case "examples.set": {
        const { module: id, on } = args as { module: string; on: boolean };
        examples = on ? [...examples.filter((item) => item !== id), id] : examples.filter((item) => item !== id);
        return examples;
      }
      default:
        return null;
    }
  });
});

it("la page d’attente propose les données d’exemple, qui affichent la page sans compte et sans bandeau", async () => {
  const user = userEvent.setup();
  render(
    <>
      <ExampleIndicator module="tickets" />
      <SetupGate module="tickets">
        <p>Vraie page</p>
      </SetupGate>
    </>,
  );
  expect(await screen.findByText("Il manque un compte à cette page")).toBeTruthy();
  expect(screen.queryByText("Vraie page")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Exemple/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Voir avec des données d’exemple" }));
  expect(calls.filter((call) => call.command === "examples.set").map((call) => call.args)).toEqual([
    { module: "tickets", on: true },
  ]);
  expect(await screen.findByText("Vraie page")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Exemple/ })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Il manque un compte à cette page")).toBeNull();
});

it("la pastille « Exemple » de la barre dit le mode et son menu le quitte", async () => {
  const user = userEvent.setup();
  examples = ["tickets"];
  useShell.setState({ snapshot: snapshot() });
  render(
    <>
      <ExampleIndicator module="tickets" />
      <SetupGate module="tickets">
        <p>Vraie page</p>
      </SetupGate>
    </>,
  );
  expect(screen.getByText("Vraie page")).toBeTruthy();
  const pill = screen.getByRole("button", { name: /^Exemple/ });
  expect(pill.getAttribute("title")).toBe("Cette page affiche des données d’exemple");
  await user.click(pill);
  await user.click(screen.getByRole("menuitem", { name: "Quitter les données d’exemple" }));
  expect(calls.filter((call) => call.command === "examples.set").map((call) => call.args)).toEqual([
    { module: "tickets", on: false },
  ]);
  // Hors du mode, la page d’attente revient (le compte manque toujours) et la pastille disparaît.
  expect(await screen.findByText("Il manque un compte à cette page")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Exemple/ })).toBeNull();
});

it("hors du mode, aucune pastille", () => {
  render(<ExampleIndicator module="tickets" />);
  expect(screen.queryByRole("button", { name: /^Exemple/ })).toBeNull();
});

it("l’interrupteur de la fiche du module active et quitte les données d’exemple", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<ExampleModePart module={module} snapshot={snapshot()} />);
  expect(screen.getByText(/aucune requête ne part vers les services/)).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "Données d’exemple" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  await user.click(toggle);
  await waitFor(() => expect(useShell.getState().snapshot?.examples).toEqual(["tickets"]));
  rerender(<ExampleModePart module={module} snapshot={useShell.getState().snapshot as Snapshot} />);
  const on = screen.getByRole("switch", { name: "Données d’exemple" }) as HTMLInputElement;
  expect(on.checked).toBe(true);
  await user.click(on);
  await waitFor(() => expect(useShell.getState().snapshot?.examples).toEqual([]));
  expect(calls.filter((call) => call.command === "examples.set").map((call) => call.args)).toEqual([
    { module: "tickets", on: true },
    { module: "tickets", on: false },
  ]);
});

it("la fiche signale une fonction de connecteur sans exemple", () => {
  render(<ExampleModePart module={module} snapshot={snapshot([{ ...lister, examples: 0 }])} />);
  expect(screen.getByText(/La fonction « lister » n’a pas encore d’exemple/)).toBeTruthy();
});
