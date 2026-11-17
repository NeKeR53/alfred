import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke, onNativeEvent } from "../../lib/native";
import { advancement, type JobItem, ModuleJobs } from "./ModuleJobs";

const job = (patch: Partial<JobItem>): JobItem => ({
  id: "j1",
  module: "import",
  function: "lire",
  title: "Import des contacts",
  step: 3,
  status: "running",
  progress: 0.45,
  message: "Page 3 sur 7",
  error: null,
  attempts: 0,
  cancelRequested: false,
  createdAt: "2026-11-16T08:00:00Z",
  updatedAt: "2026-11-16T08:01:00Z",
  finishedAt: null,
  ...patch,
});

let jobs: JobItem[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  jobs = [job({}), job({ id: "j2", title: "Relevé", status: "failed", error: "Service indisponible", progress: null })];
  vi.mocked(onNativeEvent).mockImplementation(() => () => {});
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "jobs.list") return jobs;
    if (command === "jobs.cancel") {
      jobs = jobs.map((item) => (item.id === args.id ? { ...item, cancelRequested: true } : item));
      return null;
    }
    if (command === "jobs.resume") {
      jobs = jobs.map((item) => (item.id === args.id ? { ...item, status: "queued", error: null } : item));
      return null;
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("montre la progression, annule une tâche en cours et reprend une tâche en échec", async () => {
  const user = userEvent.setup();
  render(<ModuleJobs module="import" />);
  const table = await screen.findByRole("table", { name: "Tâches de fond du module" });
  expect(within(table).getByText("Page 3 sur 7")).toBeInTheDocument();
  expect(within(table).getByText("45 % · 3 étapes")).toBeInTheDocument();
  expect(within(table).getByText("Service indisponible")).toBeInTheDocument();

  await user.click(within(table).getByRole("button", { name: "Annuler la tâche Import des contacts" }));
  await waitFor(() => expect(within(table).getByText("Annulation…")).toBeInTheDocument());

  await user.click(within(table).getByRole("button", { name: "Reprendre la tâche Relevé" }));
  await waitFor(() => expect(within(table).getByText("En attente")).toBeInTheDocument());
  expect(calls.filter((call) => call.command !== "jobs.list")).toEqual([
    { command: "jobs.cancel", args: { id: "j1" } },
    { command: "jobs.resume", args: { id: "j2" } },
  ]);
});

it("dit l’avancement sans pourcentage quand la fonction n’en donne pas", () => {
  expect(advancement(job({ progress: null, step: 1 }))).toBe("1 étape");
});
