import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import { useNotifications } from "../../shell/notifications";
import { renderSections } from "../modules/settingsHarness";
import { useAutomationsSections } from "./AutomationsSettings";
import { type AutomationItem, curlCommand } from "./api";

HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const URL = "http://127.0.0.1:14731/automations/paiement";
let automations: AutomationItem[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;
const listeners = new Map<string, (payload: unknown) => void>();

function automation(extra: Partial<AutomationItem>): AutomationItem {
  return {
    id: "releve",
    name: "Relevé du matin",
    action: { kind: "steps", steps: [{ function: "banque/relever", input: {} }] },
    summary: "banque/relever",
    trigger: { kind: "cron", cron: "0 8 * * 1-5" },
    enabled: true,
    status: "active",
    problem: null,
    createdBy: "user",
    running: false,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastTrigger: null,
    nextRunAt: null,
    lastConversation: null,
    scriptFile: null,
    url: null,
    ...extra,
  };
}

beforeEach(() => {
  calls = [];
  listeners.clear();
  useNotifications.getState().clear();
  automations = [
    automation({}),
    automation({
      id: "paiement",
      name: "Paiement reçu",
      action: { kind: "steps", steps: [{ function: "ventes/encaisser", input: {} }] },
      trigger: { kind: "webhook" },
      enabled: false,
      status: "toValidate",
      createdBy: "agent",
      url: URL,
    }),
  ];
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args: args as Record<string, unknown> });
    const id = (args as { id?: string }).id;
    switch (command) {
      case "automations.list":
        return {
          automations: automations.map((entry) => ({ ...entry })),
          functions: [
            {
              reference: "banque/relever",
              module: "banque",
              moduleName: "Banque",
              id: "relever",
              description: "Relève les comptes",
              instances: [{ client: "banque", id: "pro", label: "Compte pro" }],
            },
            {
              reference: "ventes/encaisser",
              module: "ventes",
              moduleName: "Ventes",
              id: "encaisser",
              description: "",
              instances: [],
            },
          ],
          baseUrl: "http://127.0.0.1:14731/automations/",
        };
      case "automations.history":
        return [];
      case "automations.validate":
        automations = automations.map((entry) =>
          entry.id === id ? { ...entry, status: "active", enabled: true } : entry,
        );
        return null;
      case "automations.runNow":
        automations = automations.map((entry) =>
          entry.id === id ? { ...entry, lastRunAt: new Date().toISOString(), lastStatus: "ok" } : entry,
        );
        return { ok: true, output: { lignes: 3 } };
      case "automations.save":
        automations.push(automation({ id: "nouvelle", name: String((args as { name: string }).name) }));
        return { id: "nouvelle" };
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

const notifications = () => useNotifications.getState().items.map((entry) => entry.title);

it("montre à part ce que l’agent a préparé, et ne l’active qu’après la validation de l’utilisateur", async () => {
  const user = userEvent.setup();
  renderSections(useAutomationsSections);
  const pending = await screen.findByRole("region", { name: "À valider" });
  expect(within(pending).getByText("Paiement reçu")).toBeInTheDocument();
  expect(within(pending).getAllByText("À valider").length).toBeGreaterThan(1);
  expect(
    within(pending).getByText(/Appel HTTP local · fonction ventes\/encaisser · jamais lancée · créée par l’agent/),
  ).toBeInTheDocument();
  // Elle ne s’exécute pas tant qu’elle n’est pas validée.
  expect(within(pending).queryByRole("button", { name: /Exécuter maintenant/ })).toBeNull();

  await user.click(within(pending).getByRole("button", { name: "Valider et activer" }));
  const confirm = await screen.findByRole("alertdialog");
  expect(confirm.textContent).toContain("ventes/encaisser");
  await user.click(within(confirm).getByRole("button", { name: "Valider et activer" }));
  await waitFor(() => expect(calls.some((call) => call.command === "automations.validate")).toBe(true));
  await waitFor(() => expect(screen.queryByRole("region", { name: "À valider" })).toBeNull());
  const list = screen.getByRole("region", { name: "Automatisations" });
  expect(within(list).getByText("Paiement reçu")).toBeInTheDocument();
  expect(within(list).getAllByText("Active")).toHaveLength(2);
});

it("exécute maintenant, et crée une automatisation par le formulaire", async () => {
  const user = userEvent.setup();
  renderSections(useAutomationsSections);
  const list = await screen.findByRole("region", { name: "Automatisations" });
  expect(
    within(list).getByText(/^Planning 0 8 \* \* 1-5 · fonction banque\/relever · jamais lancée/),
  ).toBeInTheDocument();
  await user.click(within(list).getByRole("button", { name: "Exécuter maintenant Relevé du matin" }));
  await waitFor(() => expect(notifications()).toContain("Relevé du matin : passage réussi"));

  await user.click(within(list).getByRole("button", { name: "Nouvelle automatisation" }));
  const form = await screen.findByRole("dialog", { name: "Nouvelle automatisation" });
  const save = within(form).getByRole("button", { name: "Enregistrer" });
  expect(save).toBeDisabled();
  await user.type(within(form).getByRole("textbox", { name: /Nom/ }), "Relevé du soir");
  await user.click(within(form).getByRole("button", { name: /Fonction/ }));
  await user.click(await screen.findByRole("option", { name: /relever — Relève les comptes/ }));
  // La fonction utilise un client à plusieurs comptes : le choix du compte apparaît.
  expect(within(form).getByRole("button", { name: /Compte/ })).toBeInTheDocument();
  const cron = within(form).getByRole("textbox", { name: /Planning \(cron\)/ });
  await user.clear(cron);
  await user.type(cron, "0 18 * * *");
  const entry = within(form).getByRole("textbox", { name: /Entrée/ });
  await user.clear(entry);
  await user.type(entry, '{{"event": 1}');
  expect(within(form).getByText(/La clé « event » est réservée/)).toBeInTheDocument();
  expect(save).toBeDisabled();
  await user.clear(entry);
  await user.type(entry, '{{"jours": 1}');
  await user.click(save);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find((call) => call.command === "automations.save")?.args).toEqual({
    name: "Relevé du soir",
    action: { kind: "steps", steps: [{ function: "banque/relever", input: { jours: 1 } }] },
    trigger: { kind: "cron", cron: "0 18 * * *" },
    enabled: true,
  });
  expect(await within(list).findByText("Relevé du soir")).toBeInTheDocument();
});

it("donne une commande curl prête à copier", () => {
  expect(curlCommand(URL, "abc")).toBe(
    `curl -X POST '${URL}' -H 'X-Alfred-Secret: abc' -H 'Content-Type: application/json' -d '{}'`,
  );
});

it("crée une action agentique : consigne et durée maximale", async () => {
  const user = userEvent.setup();
  renderSections(useAutomationsSections);
  const list = await screen.findByRole("region", { name: "Automatisations" });
  await user.click(within(list).getByRole("button", { name: "Nouvelle automatisation" }));
  const form = await screen.findByRole("dialog", { name: "Nouvelle automatisation" });
  await user.type(within(form).getByRole("textbox", { name: /Nom/ }), "Tri du courrier");
  await user.click(within(form).getByRole("radio", { name: /Agent/ }));
  await user.type(within(form).getByRole("textbox", { name: /Consigne/ }), "Classe les messages reçus.");
  await user.click(within(form).getByRole("radio", { name: /Appel HTTP local/ }));
  await user.click(within(form).getByRole("button", { name: "Enregistrer" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find((call) => call.command === "automations.save")?.args).toEqual({
    name: "Tri du courrier",
    action: { kind: "agent", instruction: "Classe les messages reçus.", maxMinutes: 15 },
    trigger: { kind: "webhook" },
    enabled: true,
  });
});

it("enchaîne des étapes : références, condition, et une étape retirée", async () => {
  const user = userEvent.setup();
  renderSections(useAutomationsSections);
  const list = await screen.findByRole("region", { name: "Automatisations" });
  await user.click(within(list).getByRole("button", { name: "Nouvelle automatisation" }));
  const form = await screen.findByRole("dialog", { name: "Nouvelle automatisation" });
  await user.type(within(form).getByRole("textbox", { name: /Nom/ }), "Chaîne");
  const pick = async (index: number, option: RegExp) => {
    await user.click(within(form).getAllByRole("button", { name: /Fonction/ })[index] as HTMLElement);
    await user.click(await screen.findByRole("option", { name: option }));
  };
  await pick(0, /relever/);
  await user.click(within(form).getByRole("button", { name: "Ajouter une étape" }));
  await user.click(within(form).getByRole("button", { name: "Ajouter une étape" }));
  await pick(1, /encaisser/);
  const second = within(form).getByRole("group", { name: "Étape 2" });
  const entry = within(second).getByRole("textbox", { name: /Entrée/ });
  await user.clear(entry);
  await user.type(entry, '{{"total": "$prev.total"}');
  await user.type(within(second).getByRole("textbox", { name: /Lancer seulement si/ }), "$prev.total > 0");
  await user.click(within(form).getByRole("button", { name: "Retirer l’étape 3" }));
  await user.click(within(form).getByRole("button", { name: "Enregistrer" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find((call) => call.command === "automations.save")?.args.action).toEqual({
    kind: "steps",
    steps: [
      { function: "banque/relever", input: {} },
      { function: "ventes/encaisser", input: { total: "$prev.total" }, when: "$prev.total > 0" },
    ],
  });
});
