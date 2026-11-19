import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import { useNotifications } from "../../shell/notifications";
import { cadence, type ScheduleItem, spokenTime } from "../schedules/api";
import type { WebhookItem } from "../webhooks/api";
import { MASK, ModuleAutomations } from "./ModuleAutomations";

// jsdom n’implémente pas les modales natives.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const URL_PAIEMENT = "http://127.0.0.1:14731/hooks/factures/paiement";
let schedules: ScheduleItem[];
let hooks: WebhookItem[];
let fail: boolean;
let secret: string;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
const listeners = new Map<string, (payload: unknown) => void>();

function schedule(extra: Partial<ScheduleItem>): ScheduleItem {
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
  schedules = [];
  hooks = [];
  fail = false;
  secret = "a".repeat(64);
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
        return schedules.map((entry) => ({ ...entry }));
      case "webhooks.list":
        return hooks.map((hook) => ({ ...hook }));
      case "webhooks.secret":
        return { secret };
      case "webhooks.rotate":
        secret = "b".repeat(64);
        return { secret };
      case "schedules.setEnabled": {
        const { schedule: key, enabled } = args as { schedule: string; enabled: boolean };
        schedules = schedules.map((entry) =>
          `${entry.module}/${entry.id}` === key
            ? { ...entry, enabled, nextRunAt: enabled ? "2026-11-12T10:15:00Z" : null }
            : entry,
        );
        return null;
      }
      case "schedules.runNow": {
        const key = (args as { schedule: string }).schedule;
        const result = fail ? { ok: false, error: "Le service ne répond pas." } : { ok: true, output: { relances: 3 } };
        schedules = schedules.map((entry) =>
          `${entry.module}/${entry.id}` === key
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

it("écrit les rythmes en français, l’heure comme on la dit", () => {
  expect(cadence({ everyMinutes: 15, at: null })).toBe("toutes les 15 minutes");
  expect(cadence({ everyMinutes: 1, at: null })).toBe("toutes les minutes");
  expect(cadence({ everyMinutes: 120, at: null })).toBe("toutes les 2 heures");
  expect(cadence({ everyMinutes: null, at: "07:00" })).toBe("tous les jours à 7 h");
  expect(spokenTime("18:05")).toBe("18 h 05");
});

it("tient une automatisation sur une ligne : nom, déclencheur en clair, état ; le reste dans son détail", async () => {
  const user = userEvent.setup();
  const { container } = render(<ModuleAutomations module="factures" />);
  // Sans automatisation, la fiche du module n’en parle pas.
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();

  schedules = [
    schedule({}),
    schedule({
      id: "rapport",
      description: "Rapport du matin",
      everyMinutes: null,
      at: "07:00",
      functionExists: false,
    }),
    schedule({ module: "autre", id: "x", description: "D’un autre module" }),
  ];
  hooks = [
    {
      module: "factures",
      id: "paiement",
      description: "Paiement reçu",
      function: "encaisser",
      url: URL_PAIEMENT,
      lastReceivedAt: null,
      functionExists: true,
    },
  ];
  listeners.get("space:changed")?.(null);
  const table = await screen.findByRole("table", { name: "Automatisations du module" });
  // Trois colonnes seulement.
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["Automatisation", "Déclencheur", "État"]);
  expect(within(table).getByText("Toutes les 15 minutes")).toBeInTheDocument();
  expect(within(table).getByText("Tous les jours à 7 h")).toBeInTheDocument();
  expect(within(table).getByText("À chaque appel de son adresse")).toBeInTheDocument();
  expect(within(table).getAllByText("jamais lancée")).toHaveLength(1);
  expect(within(table).getByText("À corriger")).toBeInTheDocument();
  expect(within(table).queryByText("D’un autre module")).not.toBeInTheDocument();
  // Ni fonction, ni identifiant, ni adresse dans le tableau.
  expect(within(table).queryByText("relancer")).not.toBeInTheDocument();
  expect(within(table).queryByText(URL_PAIEMENT)).not.toBeInTheDocument();

  // Le détail, au clic : la fonction, l’identifiant, la pause et l’exécution immédiate.
  await user.click(within(table).getByText("Relance des impayés"));
  const detail = await screen.findByRole("dialog", { name: "Relance des impayés" });
  expect(within(detail).getByText("relancer")).toBeInTheDocument();
  expect(within(detail).getByText("factures/relance")).toBeInTheDocument();
  const toggle = within(detail).getByRole("switch", { name: "Automatisation Relance des impayés active" });
  await user.click(toggle);
  await waitFor(() => expect(within(table).getByText("En pause")).toBeInTheDocument());
  expect(calls.find((call) => call.command === "schedules.setEnabled")?.args).toEqual({
    schedule: "factures/relance",
    enabled: false,
  });
  await user.click(within(detail).getByRole("button", { name: "Exécuter maintenant Relance des impayés" }));
  await waitFor(() => expect(notifications()).toContain("Relance des impayés : exécution réussie"));
  expect(await within(detail).findByText('Sortie : {"relances":3}')).toBeInTheDocument();
  fail = true;
  await user.click(within(detail).getByRole("button", { name: "Exécuter maintenant Relance des impayés" }));
  await waitFor(() => expect(notifications()).toContain("Relance des impayés : l’exécution a échoué"));
  expect((await within(detail).findAllByText("Le service ne répond pas.")).length).toBeGreaterThan(0);
  await user.click(within(detail).getByRole("button", { name: "Fermer" }));

  // Le webhook : son adresse et son secret, masqué puis révélé, régénéré après confirmation.
  await user.click(within(table).getByText("Paiement reçu"));
  const hook = await screen.findByRole("dialog", { name: "Paiement reçu" });
  expect(within(hook).getByText(URL_PAIEMENT)).toBeInTheDocument();
  expect(await within(hook).findByText(MASK)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(secret);
  await user.click(within(hook).getByRole("button", { name: "Révéler le secret" }));
  expect(within(hook).getByText(secret)).toBeInTheDocument();
  await user.click(within(hook).getByRole("button", { name: "Régénérer" }));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Régénérer" }));
  expect(await within(hook).findByText("b".repeat(64))).toBeInTheDocument();
  expect(calls.find((call) => call.command === "webhooks.rotate")?.args).toEqual({ hook: "factures/paiement" });
});
