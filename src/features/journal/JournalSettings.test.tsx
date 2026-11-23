import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import { renderSections } from "../modules/settingsHarness";
import { type JournalEntry, useJournalSections } from "./JournalSettings";

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

const log = () => screen.findByRole("log", { name: /^Journal d’exécution/ });

it("fait ressortir les échecs, montre le détail technique et suit les nouvelles exécutions", async () => {
  renderSections(useJournalSections, "Journal");
  const lines = await log();
  expect(journalCalls()[0]).toEqual({ limit: 200 });
  // L’échec est écrit en toutes lettres, pas seulement en couleur, et compté au-dessus du journal.
  expect(within(lines).getByText(/Client · jira · Échec · 1,3 s · HTTP 401 : jeton refusé/)).toBeInTheDocument();
  expect(within(lines).getAllByText(/Réussi · 42 ms/)).toHaveLength(2);
  expect(screen.getByText(/1 échec parmi les 3 dernières exécutions/)).toBeInTheDocument();
  // Le détail technique suit la ligne, en JSON lisible.
  expect(within(lines).getByText(/"status": 401/)).toBeInTheDocument();
  expect(within(lines).getByText(/"method": "GET"/)).toBeInTheDocument();

  // Une nouvelle exécution arrive : le journal se relit.
  entries = [entry({ id: 4, subject: "ventes/relance", summary: "Relance envoyée" }), ...entries];
  listeners.get("journal:changed")?.(null);
  expect(await within(lines).findByText(/Relance envoyée/)).toBeInTheDocument();
});

it("filtre par type, signale un échec de lecture et propose de réessayer", async () => {
  const user = userEvent.setup();
  renderSections(useJournalSections, "Journal");
  await log();

  await user.click(screen.getByRole("button", { name: /^Tout/ }));
  await user.click(await screen.findByRole("option", { name: "Webhooks" }));
  await waitFor(() => expect(journalCalls().at(-1)).toEqual({ kind: "webhook", limit: 200 }));
  await waitFor(() => expect(screen.queryByText(/jira/)).not.toBeInTheDocument());
  expect(screen.getByText(/ventes\/stripe/)).toBeInTheDocument();

  // Aucun appel d’agent : l’état vide le dit.
  await user.click(screen.getByRole("button", { name: /^Webhooks/ }));
  await user.click(await screen.findByRole("option", { name: "Agents" }));
  expect(await screen.findByText("Aucune exécution de type « Agents »")).toBeInTheDocument();

  // Échec du backend, puis Réessayer.
  failNext = "La base d’Alfred est indisponible.";
  await user.click(screen.getByRole("button", { name: "Actualiser" }));
  expect(await screen.findByText(/Le journal n’a pas pu être relu : La base d’Alfred est indisponible/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Réessayer" }));
  await waitFor(() => expect(screen.queryByText(/n’a pas pu être relu/)).not.toBeInTheDocument());
});
