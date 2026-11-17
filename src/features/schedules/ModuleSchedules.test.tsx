import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import { useNotifications } from "../../shell/notifications";
import { cadence, type ScheduleItem } from "./api";
import { ModuleSchedules } from "./ModuleSchedules";

let items: ScheduleItem[];
let fail: boolean;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
const listeners = new Map<string, (payload: unknown) => void>();

function item(extra: Partial<ScheduleItem>): ScheduleItem {
  return {
    module: "factures",
    id: "relance",
    description: "Relance des impayés",
    function: "relancer",
    everyMinutes: 15,
    at: null,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    nextRunAt: "2026-11-12T10:15:00Z",
    functionExists: true,
    ...extra,
  };
}

beforeEach(() => {
  items = [];
  fail = false;
  calls = [];
  listeners.clear();
  useNotifications.getState().clear();
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "schedules.list":
        return items.map((entry) => ({ ...entry }));
      case "schedules.setEnabled": {
        const { schedule, enabled } = args as { schedule: string; enabled: boolean };
        items = items.map((entry) =>
          `${entry.module}/${entry.id}` === schedule
            ? { ...entry, enabled, nextRunAt: enabled ? "2026-11-12T10:15:00Z" : null }
            : entry,
        );
        return null;
      }
      case "schedules.runNow": {
        const schedule = (args as { schedule: string }).schedule;
        const result = fail ? { ok: false, error: "Le service ne répond pas." } : { ok: true, output: { relances: 3 } };
        items = items.map((entry) =>
          `${entry.module}/${entry.id}` === schedule
            ? {
                ...entry,
                lastRunAt: "2026-11-12T10:00:00Z",
                lastStatus: fail ? "error" : "ok",
                lastError: fail ? "Le service ne répond pas." : null,
              }
            : entry,
        );
        return result;
      }
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

const notifications = () => useNotifications.getState().items.map((entry) => entry.title);

it("écrit les rythmes en français", () => {
  expect(cadence({ everyMinutes: 15, at: null })).toBe("toutes les 15 minutes");
  expect(cadence({ everyMinutes: 1, at: null })).toBe("toutes les minutes");
  expect(cadence({ everyMinutes: 120, at: null })).toBe("toutes les 2 heures");
  expect(cadence({ everyMinutes: null, at: "08:00" })).toBe("chaque jour à 08:00");
});

it("liste les planifications, les met en pause et les exécute tout de suite", async () => {
  const user = userEvent.setup();
  const { container } = render(<ModuleSchedules module="factures" />);
  // Sans planification, la fiche du module n’en parle pas.
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();

  items = [
    item({}),
    item({ id: "rapport", description: "Rapport du matin", everyMinutes: null, at: "08:00", functionExists: false }),
  ];
  listeners.get("space:changed")?.(null);
  const table = await screen.findByRole("table", { name: "Planifications du module" });
  expect(within(table).getByText("Toutes les 15 minutes")).toBeInTheDocument();
  expect(within(table).getByText("Chaque jour à 08:00")).toBeInTheDocument();
  expect(within(table).getAllByText("Jamais")).toHaveLength(2);
  expect(within(table).getByText(/Fonction introuvable/)).toBeInTheDocument();

  // Pause : appliquée tout de suite.
  const toggle = screen.getByRole("switch", { name: "Planification Relance des impayés active" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  await waitFor(() => expect(within(table).getByText("En pause")).toBeInTheDocument());
  expect(calls.find((call) => call.command === "schedules.setEnabled")?.args).toEqual({
    schedule: "factures/relance",
    enabled: false,
  });
  expect(toggle).not.toBeChecked();

  // Exécuter maintenant : résultat visible sur la ligne et notifié.
  await user.click(screen.getByRole("button", { name: "Exécuter maintenant Relance des impayés" }));
  await waitFor(() => expect(notifications()).toContain("Relance des impayés : exécution réussie"));
  expect(calls.find((call) => call.command === "schedules.runNow")?.args).toEqual({ schedule: "factures/relance" });
  expect(await within(table).findByText("Réussie")).toBeInTheDocument();
  expect(within(table).getByText('Sortie : {"relances":3}')).toBeInTheDocument();

  // Un échec est rapporté avec sa cause.
  fail = true;
  await user.click(screen.getByRole("button", { name: "Exécuter maintenant Relance des impayés" }));
  await waitFor(() => expect(notifications()).toContain("Relance des impayés : l’exécution a échoué"));
  expect(await within(table).findByText("Échec")).toBeInTheDocument();
  expect(within(table).getByText("Le service ne répond pas.")).toBeInTheDocument();

  // Reprise.
  await user.click(toggle);
  await waitFor(() => expect(within(table).queryByText("En pause")).not.toBeInTheDocument());
});
