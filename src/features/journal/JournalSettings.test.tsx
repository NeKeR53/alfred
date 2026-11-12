import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import { type JournalEntry, JournalSettings } from "./JournalSettings";

let entries: JournalEntry[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let failNext: string | undefined;
const listeners = new Map<string, (payload: unknown) => void>();

const entry = (patch: Partial<JournalEntry> & { id: number }): JournalEntry => ({
  at: "2026-11-12T09:15:00Z",
  kind: "function",
  subject: "ventes/total",
  status: "ok",
  durationMs: 42,
  summary: "Terminé",
  detail: null,
  ...patch,
});

beforeEach(() => {
  calls = [];
  failNext = undefined;
  listeners.clear();
  entries = [
    entry({
      id: 3,
      kind: "client",
      subject: "jira",
      status: "error",
      durationMs: 1250,
      summary: "HTTP 401 : jeton refusé",
      detail: { request: { method: "GET", url: "https://jira.example/rest/api/2/search" }, status: 401 },
    }),
    entry({ id: 2, kind: "function", subject: "ventes/total", summary: "12 lignes" }),
    entry({ id: 1, kind: "webhook", subject: "ventes/stripe", summary: "Reçu" }),
  ];
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "journal.list") {
      if (failNext) {
        const message = failNext;
        failNext = undefined;
        throw new Error(message);
      }
      const kind = (args as { kind?: string }).kind;
      return entries.filter((item) => !kind || item.kind === kind);
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

const journalCalls = () => calls.filter((call) => call.command === "journal.list").map((call) => call.args);

it("fait ressortir les échecs, ouvre le détail et le garde ouvert quand le journal change", async () => {
  const user = userEvent.setup();
  render(<JournalSettings />);

  const table = await screen.findByRole("table", { name: "Journal d’exécution" });
  expect(journalCalls()[0]).toEqual({ limit: 200 });
  // L’échec est écrit en toutes lettres, pas seulement en couleur, et compté au-dessus du tableau.
  expect(within(table).getByText("Échec")).toBeInTheDocument();
  expect(within(table).getAllByText("Réussi")).toHaveLength(2);
  expect(screen.getByText(/1 échec parmi les 3 dernières exécutions/)).toBeInTheDocument();
  expect(within(table).getByText("1,3 s")).toBeInTheDocument();
  expect(within(table).getAllByText("42 ms")).toHaveLength(2);

  // Une ligne s’ouvre au clavier et montre le détail technique en JSON lisible.
  const failedRow = within(table).getByText("HTTP 401 : jeton refusé").closest("tr") as HTMLElement;
  failedRow.focus();
  await user.keyboard("{Enter}");
  const detail = await screen.findByRole("heading", { name: "Détail : jira" });
  expect(detail).toBeInTheDocument();
  const code = document.querySelector("pre code");
  expect(code?.textContent).toContain('"status": 401');
  expect(code?.textContent).toContain('"method": "GET"');
  expect(failedRow).toHaveAttribute("aria-selected", "true");

  // Une nouvelle exécution arrive : la liste se relit, la ligne ouverte reste ouverte.
  entries = [entry({ id: 4, subject: "ventes/relance", summary: "Relance envoyée" }), ...entries];
  listeners.get("journal:changed")?.(null);
  expect(await within(table).findByText("Relance envoyée")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Détail : jira" })).toBeInTheDocument();

  // « Échecs seulement » ne garde que les lignes en échec.
  await user.click(screen.getByRole("button", { name: "Échecs seulement" }));
  expect(within(table).queryByText("Relance envoyée")).not.toBeInTheDocument();
  expect(within(table).getByText("HTTP 401 : jeton refusé")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Échecs seulement" }));

  // Fermer le détail.
  await user.click(screen.getByRole("button", { name: "Fermer le détail de jira" }));
  expect(screen.queryByRole("heading", { name: "Détail : jira" })).not.toBeInTheDocument();
});

it("filtre par type, signale un échec de lecture et propose de réessayer", async () => {
  const user = userEvent.setup();
  render(<JournalSettings />);
  await screen.findByRole("table", { name: "Journal d’exécution" });

  await user.selectOptions(screen.getByLabelText("Type"), "webhook");
  await waitFor(() => expect(journalCalls().at(-1)).toEqual({ kind: "webhook", limit: 200 }));
  const table = screen.getByRole("table", { name: "Journal d’exécution" });
  await waitFor(() => expect(within(table).queryByText("jira")).not.toBeInTheDocument());
  expect(within(table).getByText("ventes/stripe")).toBeInTheDocument();

  // Aucun appel d’agent : l’état vide le dit.
  await user.selectOptions(screen.getByLabelText("Type"), "agent");
  expect(await screen.findByText("Aucune exécution de type « Agents »")).toBeInTheDocument();

  // Échec du backend, puis Réessayer.
  failNext = "La base d’Alfred est indisponible.";
  await user.click(screen.getByRole("button", { name: "Actualiser" }));
  expect(await screen.findByText(/Le journal n’a pas pu être relu : La base d’Alfred est indisponible/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Réessayer" }));
  await waitFor(() => expect(screen.queryByText(/n’a pas pu être relu/)).not.toBeInTheDocument());
});
