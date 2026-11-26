import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native", async (original) => ({
  ...(await original<typeof import("../../lib/native")>()),
  invoke: vi.fn(),
  onNativeEvent: vi.fn(),
}));
vi.mock("../automations/agentRuns", () => ({ openConversation: vi.fn() }));

import { AlfredError, invoke, onNativeEvent } from "../../lib/native";
import { useNotifications } from "../../shell/notifications";
import { openConversation } from "../automations/agentRuns";
import { renderSections } from "../modules/settingsHarness";
import { callsLabel, duration, type KeptScript, suggestedName } from "./api";
import { useScriptsSections } from "./ScriptsSettings";

HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const now = new Date().toISOString();
let kept: KeptScript[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;
const lastCall = (command: string) => calls.filter((call) => call.command === command).at(-1)?.args;

const runs = [
  {
    id: "r1",
    at: now,
    conversation: "conv-1",
    ok: true,
    calls: ["notes/lister", "notes/lister", "crm/clients"],
    ms: 1240,
  },
  { id: "r2", at: now, conversation: "partie", ok: false, calls: [], ms: 30 },
];

beforeEach(() => {
  calls = [];
  useNotifications.getState().clear();
  kept = [
    {
      reference: "mes-scripts/bilan",
      module: "mes-scripts",
      moduleName: "Mes scripts",
      id: "bilan",
      description: "Bilan de la semaine.",
      effect: "read",
      status: "toValidate",
      conversation: "conv-1",
      createdAt: now,
      input: { semaine: 47 },
    },
  ];
  vi.mocked(onNativeEvent).mockImplementation(() => () => undefined);
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args: args as Record<string, unknown> });
    switch (command) {
      case "scripts.list":
        return { runs, kept: kept.map((entry) => ({ ...entry })), keepDays: 7 };
      case "conversations.list":
        return [{ id: "conv-1", title: "Ventes de novembre" }];
      case "scripts.run":
        return {
          ...runs[0],
          code: "const a = await api.notes.lister({});\nreturn a.length;",
          input: { jour: "lundi" },
          output: { result: 12, logs: ["ok"] },
          home: "notes",
          literals: [{ key: "equipe", value: "Data", function: "notes/lister", start: 33, end: 39 }],
          modules: [
            { id: "notes", name: "Notes" },
            { id: "mes-scripts", name: "Mes scripts" },
          ],
        };
      case "scripts.keep": {
        const draft = args as { module: string; name: string; new?: boolean };
        if (draft.name === "proche" && !draft.new)
          throw new AlfredError({
            message: "Proche de « mes-scripts/bilan » : généralise-le.",
            detail: { close: "mes-scripts/bilan" },
          });
        kept.push({ ...kept[0], reference: `${draft.module}/${draft.name}`, status: "accepted" } as KeptScript);
        return { function: `${draft.module}/${draft.name}`, status: "accepted" };
      }
      case "functions.acceptKept":
        kept = kept.map((entry) => ({ ...entry, status: "accepted" }));
        return null;
      case "functions.call":
        return { total: 4 };
      case "scripts.remove":
        kept = kept.filter((entry) => entry.reference !== (args as { reference: string }).reference);
        return null;
      case "automations.list":
        return {
          automations: [],
          functions: [
            {
              reference: "mes-scripts/bilan",
              module: "mes-scripts",
              moduleName: "Mes scripts",
              id: "bilan",
              description: "Bilan de la semaine.",
              instances: [],
            },
          ],
          maxAgentMinutes: 120,
        };
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

const notifications = () => useNotifications.getState().items.map((entry) => entry.title);
const region = (name: string) => screen.findByRole("region", { name });
async function menuItem(user: ReturnType<typeof userEvent.setup>, row: string, item: string) {
  const group = screen.getByRole("group", { name: `Actions sur ${row}` });
  await user.click(within(group).getByRole("button", { name: "Plus d'actions" }));
  return screen.findByRole("menuitem", { name: item });
}

it("résume les appels et la durée", () => {
  expect(callsLabel(["a/x", "a/x", "b/y"])).toBe("a/x, b/y");
  expect(callsLabel(["a/1", "a/2", "a/3", "a/4"])).toBe("a/1, a/2 et 2 autres");
  expect(callsLabel([])).toBe("Aucun appel");
  expect(duration(840)).toBe("840 ms");
  expect(duration(1240)).toBe("1,2 s");
  expect(duration(125_000)).toBe("2 min 5 s");
  expect(duration(null)).toBeUndefined();
  expect(suggestedName(["notes/lister"])).toBe("lister-script");
});

it("liste les exécutions : appels, conversation, durée, réussite ou échec, et ouvre le détail", async () => {
  const user = userEvent.setup();
  renderSections(useScriptsSections, "Scripts de l’agent");
  const list = await region("Exécutions");
  expect(await within(list).findByText("notes/lister, crm/clients")).toBeInTheDocument();
  expect(within(list).getByText(/conversation « Ventes de novembre » · 1,2 s/)).toBeInTheDocument();
  expect(within(list).getByText(/conversation supprimée · 30 ms/)).toBeInTheDocument();
  expect(within(list).getByText("Réussie")).toBeInTheDocument();
  expect(within(list).getByText("Échec")).toBeInTheDocument();

  // Un échec dans une conversation supprimée : seulement son détail, ni « Garder… » ni la conversation.
  const failed = screen.getByRole("group", { name: "Actions sur Aucun appel" });
  expect(within(failed).getByRole("button", { name: "Voir le détail" })).toBeInTheDocument();
  expect(within(failed).queryByRole("button", { name: "Plus d'actions" })).toBeNull();

  await user.click((await menuItem(user, "notes/lister, crm/clients", "Ouvrir la conversation")) as HTMLElement);
  expect(openConversation).toHaveBeenCalledWith("conv-1");

  await user.click(within(list).getAllByRole("button", { name: "Voir le détail" })[0] as HTMLElement);
  const dialog = await screen.findByRole("dialog");
  expect(lastCall("scripts.run")).toEqual({ id: "r1" });
  expect(within(dialog).getByRole("region", { name: "Code" })).toHaveTextContent("api.notes.lister");
  expect(within(dialog).getByRole("region", { name: "Entrée" })).toHaveTextContent('"jour": "lundi"');
  expect(within(dialog).getByRole("region", { name: "Sortie" })).toHaveTextContent("12");
});

it("garde une exécution réussie dans le module proposé : la fonction est créée et acceptée", async () => {
  const user = userEvent.setup();
  renderSections(useScriptsSections, "Scripts de l’agent");
  await screen.findByText("notes/lister, crm/clients");
  await user.click((await menuItem(user, "notes/lister, crm/clients", "Garder…")) as HTMLElement);
  const form = await screen.findByRole("dialog", { name: "Garder ce script" });
  expect(within(form).getByRole("button", { name: /Module/ })).toHaveTextContent("Notes (proposé)");
  const name = within(form).getByRole("textbox", { name: /Nom de la fonction/ });
  await user.clear(name);
  await user.type(name, "Mauvais nom");
  expect(within(form).getByText("Minuscules, chiffres et tirets, sans espace.")).toBeInTheDocument();
  expect(within(form).getByRole("button", { name: "Garder" })).toBeDisabled();
  await user.clear(name);
  await user.type(name, "total-notes");
  await user.type(within(form).getByRole("textbox", { name: /Description/ }), "Compte les notes.");
  await user.click(within(form).getByRole("button", { name: "Garder" }));
  await waitFor(() =>
    expect(lastCall("scripts.keep")).toEqual({
      id: "r1",
      module: "notes",
      name: "total-notes",
      description: "Compte les notes.",
      params: [],
    }),
  );
  await waitFor(() => expect(notifications()).toContain("Fonction « notes/total-notes » gardée"));
  const keptList = await region("Scripts gardés");
  expect(await within(keptList).findByText("notes/total-notes")).toBeInTheDocument();
});

it("liste les scripts gardés : Accepter, puis Relancer, Créer une automatisation et Retirer", async () => {
  const user = userEvent.setup();
  renderSections(useScriptsSections, "Scripts de l’agent");
  const list = await region("Scripts gardés");
  expect(await within(list).findByText("mes-scripts/bilan")).toBeInTheDocument();
  expect(within(list).getByText("À valider")).toBeInTheDocument();
  expect(within(list).queryByRole("button", { name: /Relancer/ })).toBeNull();

  await user.click(within(list).getByRole("button", { name: "Accepter" }));
  const confirm = await screen.findByRole("alertdialog");
  await user.click(within(confirm).getByRole("button", { name: "Accepter" }));
  await waitFor(() => expect(lastCall("functions.acceptKept")).toEqual({ reference: "mes-scripts/bilan" }));
  expect(await within(list).findByText("Acceptée")).toBeInTheDocument();

  await user.click(within(list).getByRole("button", { name: "Relancer mes-scripts/bilan" }));
  await waitFor(() =>
    expect(lastCall("functions.call")).toEqual({ function: "mes-scripts/bilan", input: { semaine: 47 } }),
  );
  await waitFor(() => expect(notifications()).toContain("mes-scripts/bilan : exécution réussie"));

  await user.click((await menuItem(user, "mes-scripts/bilan", "Créer une automatisation")) as HTMLElement);
  const form = await screen.findByRole("dialog", { name: "Nouvelle automatisation" });
  expect(within(form).getByRole("textbox", { name: /Nom/ })).toHaveValue("Bilan de la semaine.");
  expect(within(form).getByRole("button", { name: /Fonction/ })).toHaveTextContent("bilan");
  expect(within(form).getByRole("textbox", { name: /Entrée/ })).toHaveValue(JSON.stringify({ semaine: 47 }, null, 2));
  await user.click(within(form).getByRole("button", { name: "Annuler" }));

  await user.click((await menuItem(user, "mes-scripts/bilan", "Retirer")) as HTMLElement);
  const removal = await screen.findByRole("alertdialog");
  await user.click(within(removal).getByRole("button", { name: "Retirer" }));
  await waitFor(() => expect(lastCall("scripts.remove")).toEqual({ reference: "mes-scripts/bilan" }));
  expect(await within(list).findByText(/Aucun script gardé/)).toBeInTheDocument();
});

it("propose les valeurs en dur comme paramètres, et refuse un script proche sauf à le garder à part", async () => {
  const user = userEvent.setup();
  renderSections(useScriptsSections, "Scripts de l’agent");
  await screen.findByText("notes/lister, crm/clients");
  await user.click((await menuItem(user, "notes/lister, crm/clients", "Garder…")) as HTMLElement);
  const form = await screen.findByRole("dialog", { name: "Garder ce script" });
  const values = within(form).getByRole("group", { name: /Valeurs en dur/ });
  await user.click(within(values).getByRole("checkbox", { name: /equipe = "Data"/ }));
  const description = within(form).getByRole("textbox", { name: /Description du paramètre/ });
  expect(within(form).getByRole("textbox", { name: /Nom du paramètre/ })).toHaveValue("equipe");
  expect(within(form).getByRole("button", { name: "Garder" })).toBeDisabled();
  await user.type(description, "Équipe suivie");
  const name = within(form).getByRole("textbox", { name: /Nom de la fonction/ });
  await user.clear(name);
  await user.type(name, "proche");
  await user.click(within(form).getByRole("button", { name: "Garder" }));
  expect(await within(form).findByText(/Proche de « mes-scripts\/bilan »/)).toBeInTheDocument();
  expect(lastCall("scripts.keep")).toMatchObject({
    name: "proche",
    params: [{ id: "equipe", description: "Équipe suivie", default: "Data", at: 33 }],
  });
  await user.click(within(form).getByRole("button", { name: "Garder à part quand même" }));
  await waitFor(() => expect(lastCall("scripts.keep")).toMatchObject({ name: "proche", new: true }));
  await waitFor(() => expect(notifications()).toContain("Fonction « notes/proche » gardée"));
});
