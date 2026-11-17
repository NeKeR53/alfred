import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native", () => ({
  invoke: vi.fn(),
  onNativeEvent: vi.fn(() => () => undefined),
}));
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke } from "../../lib/native";
import type { ModuleSummary, ResolvedFunction } from "../../lib/types";
import { useShell } from "../../shell/store";
import { FunctionGroup } from "./ModuleFunctions";
import type { FunctionTests } from "./tests";

HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const fn = (id: string, patch: Partial<ResolvedFunction>): ResolvedFunction => ({
  reference: `jira/${id}`,
  module: "jira",
  id,
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

const jira: ModuleSummary = {
  id: "jira",
  name: "Jira",
  version: "1.0.0",
  description: "",
  readOnly: false,
  origin: null,
  hidden: false,
  requires: [],
  requiredBy: ["sprint"],
  pages: 0,
  functions: 3,
  clients: [{ id: "jira", label: "Jira" }],
  webhooks: [],
  schedules: [],
};

let runs: Array<Record<string, unknown>>;

beforeEach(() => {
  runs = [];
  useShell.setState({
    snapshot: {
      path: "/tmp/espace",
      name: "Atelier",
      accent: null,
      sections: [],
      settingsPages: [],
      modules: [jira],
      functions: [
        fn("lister", { effect: "read", tests: [{ name: "Tickets ouverts", input: {} }] }),
        fn("lire", { effect: "read", tests: [{ name: "Un ticket", input: {} }] }),
        fn("commenter", {
          effect: "write",
          tests: [{ name: "Commente", input: {}, target: { field: "issue", label: "Ticket de test" } }],
        }),
      ],
      bindings: {},
      problems: [],
    },
  });
  vi.mocked(invoke).mockImplementation((async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "functions.tests":
        return {
          functions: [
            { function: "jira/lister", effect: "read", state: "passed", passed: 1, failed: 0, pending: 0, tests: [] },
            { function: "jira/lire", effect: "read", state: "toVerify", passed: 0, failed: 0, pending: 1, tests: [] },
            {
              function: "jira/commenter",
              effect: "write",
              state: "toVerify",
              passed: 0,
              failed: 0,
              pending: 1,
              tests: [],
            },
          ],
        };
      case "functions.runTest":
        runs.push(args);
        if (args.function === "jira/lire")
          return { status: "failed", message: "« key » est absent.", output: '{\n  "id": 1\n}' };
        return { status: "passed", message: "Sortie conforme.", output: "{}" };
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  }) as typeof invoke);
});

const statuses: FunctionTests[] = [
  { function: "jira/lister", effect: "read", state: "passed", passed: 1, failed: 0, pending: 0, tests: [] },
  { function: "jira/lire", effect: "read", state: "toVerify", passed: 0, failed: 0, pending: 1, tests: [] },
  { function: "jira/commenter", effect: "write", state: "toVerify", passed: 0, failed: 0, pending: 1, tests: [] },
];

const functions = () => useShell.getState().snapshot?.functions ?? [];

it("montre ce que le module fait avec un service, puis vérifie les lectures d’office et les écritures avec accord", async () => {
  const user = userEvent.setup();
  render(
    <FunctionGroup module={jira} functions={functions()} tests={statuses} label="Ce que le module fait avec Jira" />,
  );

  // Un groupe court est ouvert : son titre porte le nombre de fonctions, son bilan les lectures, écritures et tests.
  expect(screen.getByText("Ce que le module fait avec Jira")).toBeInTheDocument();
  expect(screen.getByText("(3)")).toBeInTheDocument();
  expect(screen.getByText("2 en lecture · 1 en écriture · 1 vérifiée, 2 à vérifier")).toBeInTheDocument();
  // Pastilles discrètes : seulement l’écriture et ce qui reste à vérifier, jamais « Lecture » ni « Vérifiée ».
  expect(screen.getAllByText("Écriture")).toHaveLength(1);
  expect(screen.queryByText("Lecture")).not.toBeInTheDocument();
  expect(screen.queryByText("Vérifiée")).not.toBeInTheDocument();
  expect(screen.getAllByText("À vérifier")).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "Vérifier : Ce que le module fait avec Jira" }));
  const dialog = screen.getByRole("dialog");
  // Les deux lectures partent seules, l’une après l’autre ; l’écriture attend.
  await waitFor(() => expect(runs).toHaveLength(2));
  expect(runs.map((run) => [run.function, run.approved])).toEqual([
    ["jira/lister", false],
    ["jira/lire", false],
  ]);
  await within(dialog).findByText("« key » est absent.");
  expect(within(dialog).getByText("Réussi")).toBeInTheDocument();
  expect(within(dialog).getByText("Sortie reçue")).toBeInTheDocument();

  const launch = within(dialog).getByRole("button", { name: "Lancer les écritures" });
  expect(launch).toBeDisabled();
  await user.type(within(dialog).getByRole("textbox", { name: "Ticket de test pour « Commente »" }), "TEST-1");
  await user.click(launch);
  await user.click(await screen.findByRole("button", { name: "Lancer" }));
  await waitFor(() => expect(runs).toHaveLength(3));
  expect(runs[2]).toEqual({ function: "jira/commenter", test: "Commente", approved: true, target: "TEST-1" });
});

it("replie un groupe long, et ne montre rien pour un groupe vide", () => {
  const many = Array.from({ length: 6 }, (_, index) => ({
    ...functions()[0],
    reference: `jira/f${index}`,
    id: `f${index}`,
  }));
  const { container, rerender } = render(
    <FunctionGroup module={jira} functions={many} tests={[]} label="Ce que le module fait avec Jira" />,
  );
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(screen.getByText("(6)")).toBeInTheDocument();
  rerender(<FunctionGroup module={jira} functions={[]} tests={[]} label="Autres fonctions" />);
  expect(container).toBeEmptyDOMElement();
});
