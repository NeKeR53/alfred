import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
// Seuls le catalogue des modèles et la détection des CLI sont simulés ; le reste des harnais est le vrai.
vi.mock("../agent/harness", async (original) => ({
  ...(await original<typeof import("../agent/harness")>()),
  listModels: vi.fn(),
}));
vi.mock("../agent/harness/native", async (original) => ({
  ...(await original<typeof import("../agent/harness/native")>()),
  probe: vi.fn(),
}));
// Le magasin de la coquille lit le thème du système à son chargement ; jsdom n’a pas `matchMedia`.
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke } from "../../lib/native";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { checkHarnesses, listModels, type Provider, useHarnesses } from "../agent/harness";
import { probe } from "../agent/harness/native";
import { useAgentPreferences } from "../agent/panel/ModelPicker";
import { useAgents } from "../agent/store";
import { optionsOf, pickOption, pressRowAction, renderSections, selectButton } from "../space/sections.test-helper";
import { useAgentSections, validateTextEditorCommand } from "./AgentSettings";

const renderAgent = () => renderSections(useAgentSections, "Agent");

let settings: Array<Record<string, unknown>>;
let codexModelsFail: boolean;
let settingsFail: boolean;

beforeEach(async () => {
  settings = [];
  codexModelsFail = true;
  settingsFail = false;
  useNotifications.getState().clear();
  useShell.setState({ snapshot: { path: "/tmp/espace" } as never });
  useAgents.setState({ ready: true, defaults: { provider: "claude", autonomy: "ask", models: {} } });
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, pageModel: null, textEditor: null },
    status: "idle",
  });
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false;
  };
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    if (command === "settings.get") return null;
    if (command === "conversations.list") return [];
    if (command === "settings.set") {
      if (settingsFail) throw new Error("Disque plein.");
      settings.push(args);
      return null;
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
  vi.mocked(probe).mockImplementation(async (provider: Provider) =>
    provider === "claude"
      ? { installed: true, version: "2.1.0", loggedIn: true }
      : provider === "codex"
        ? { installed: true, version: "0.50.0", loggedIn: false }
        : { installed: false },
  );
  // Alfred vérifie les harnais à son démarrage : Claude Code et Codex sont installés, OpenCode ne l’est pas.
  useHarnesses.setState({ probes: {} });
  await checkHarnesses();
  vi.mocked(listModels).mockImplementation(async (provider: Provider) => {
    if (provider === "codex" && codexModelsFail) throw new Error("Non connecté.");
    if (provider === "opencode") throw new Error("CLI introuvable.");
    return provider === "claude"
      ? [
          { id: "opus", name: "Opus", efforts: ["low", "medium", "high"] },
          { id: "haiku", name: "Haiku", efforts: [] },
        ]
      : [{ id: "gpt-5", name: "GPT-5", efforts: ["minimal", "high"] }];
  });
});

const lastDefaults = () => settings.filter((item) => item.key === "agents.defaults").at(-1)?.value;
const lastSetting = (key: string) => settings.filter((item) => item.key === key).at(-1)?.value;

it("montre l’état des harnais et enregistre harnais, modèle, effort et autonomie par défaut", async () => {
  const user = userEvent.setup();
  renderAgent();

  // État des CLI installés, en toutes lettres ; OpenCode, absent de ce poste, n’apparaît nulle part.
  expect(await screen.findByText("Installé · 2.1.0")).toBeInTheDocument();
  expect(screen.getByText("Connecté")).toBeInTheDocument();
  expect(screen.getByText("Non connecté")).toBeInTheDocument();
  expect(screen.queryByText("Non installé")).not.toBeInTheDocument();
  expect(screen.queryByText("OpenCode")).not.toBeInTheDocument();
  expect(listModels).not.toHaveBeenCalledWith("opencode", expect.anything());
  expect(listModels).toHaveBeenCalledWith("codex", "/tmp/espace");

  // Un catalogue illisible est signalé sans bloquer le reste de l’écran.
  expect(await screen.findByText(/Les modèles de Codex n’ont pas pu être lus : Non connecté\./)).toBeInTheDocument();
  expect(await selectButton("Modèle de Codex")).toBeDisabled();

  // Harnais par défaut : appliqué dès le choix.
  await pickOption(user, "Harnais par défaut", "Codex");
  await waitFor(() => expect(lastDefaults()).toMatchObject({ provider: "codex" }));

  // Modèle puis raisonnement, sur les seuls niveaux du modèle choisi.
  await waitFor(async () => expect(await selectButton("Modèle de Claude Code")).toBeEnabled());
  expect(screen.queryByRole("button", { name: /Raisonnement de Claude Code/ })).toBeNull();
  await pickOption(user, "Modèle de Claude Code", "Opus");
  await waitFor(() => expect(lastDefaults()).toMatchObject({ models: { claude: { model: "opus" } } }));
  expect(await optionsOf(user, "Raisonnement de Claude Code")).toHaveLength(4);
  await pickOption(user, "Raisonnement de Claude Code", /lev|haut/i);
  await waitFor(() => expect(lastDefaults()).toMatchObject({ models: { claude: { model: "opus", effort: "high" } } }));
  // Un autre modèle repart de son raisonnement par défaut.
  await pickOption(user, "Modèle de Claude Code", "Haiku");
  await waitFor(() => expect(lastDefaults()).toMatchObject({ models: { claude: { model: "haiku" } } }));
  expect((lastDefaults() as { models: { claude: { effort?: string } } }).models.claude.effort).toBeUndefined();

  // Réessayer le catalogue de Codex une fois connecté.
  codexModelsFail = false;
  await user.click(screen.getByRole("button", { name: "Réessayer" }));
  await waitFor(async () => expect(await selectButton("Modèle de Codex")).toBeEnabled());

  // Autonomie : le niveau choisi est expliqué.
  expect(
    screen.getByText(/carte d’accord pour lancer une commande, écrire ailleurs ou accéder au réseau/),
  ).toBeVisible();
  await pickOption(user, "Autonomie par défaut", "Accord à chaque action");
  await waitFor(() => expect(lastDefaults()).toMatchObject({ autonomy: "strict" }));

  // Un échec d’enregistrement remet la valeur précédente.
  settingsFail = true;
  await pickOption(user, "Autonomie par défaut", "Autonomie totale");
  await waitFor(() => expect(useAgents.getState().defaults.autonomy).toBe("strict"));
  await waitFor(async () =>
    expect(await selectButton("Autonomie par défaut")).toHaveTextContent("Accord à chaque action"),
  );
});

it("choisit les modèles affichés d’un harnais, depuis sa ligne d’état comme dans OneApp", async () => {
  const user = userEvent.setup();
  renderAgent();
  expect(await screen.findByText(/2 \/ 2 modèles affichés/)).toBeInTheDocument();
  // Vérifier les harnais relit aussi leurs modèles.
  vi.mocked(listModels).mockClear();
  await user.click(screen.getByRole("button", { name: "Vérifier de nouveau les harnais" }));
  await waitFor(() => expect(listModels).toHaveBeenCalledWith("claude", "/tmp/espace"));
  await pressRowAction(user, "Claude Code", "Choisir les modèles de Claude Code");
  const dialog = await screen.findByRole("dialog", { name: "Modèles Claude Code" });
  expect(within(dialog).getByText(/2 affichés sur 2/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("checkbox", { name: /Haiku/ }));
  await waitFor(() => expect(lastSetting("agents.shownModels")).toEqual({ claude: ["opus"] }));
  expect(within(dialog).getByText(/1 affiché sur 2/)).toBeInTheDocument();
  // La recherche filtre la liste sans rien changer.
  await user.type(within(dialog).getByRole("combobox", { name: /modèles Claude Code/ }), "opu");
  await waitFor(() => expect(within(dialog).queryByRole("checkbox", { name: /Haiku/ })).toBeNull());
  await user.click(within(dialog).getByRole("button", { name: "Tout afficher" }));
  await waitFor(() => expect(lastSetting("agents.shownModels")).toEqual({}));
  await user.click(within(dialog).getByRole("button", { name: "Tout masquer" }));
  await waitFor(() => expect(lastSetting("agents.shownModels")).toEqual({ claude: [] }));
  await user.click(within(dialog).getByRole("button", { name: "Fermer" }));
  expect(await screen.findByText(/0 \/ 2 modèles affichés/)).toBeInTheDocument();
  // Masqués, les modèles ne sont plus proposés comme modèle par défaut.
  expect(await optionsOf(user, "Modèle de Claude Code")).toEqual(["Modèle par défaut"]);
});

it("enregistre le modèle de nommage, « Comme les conversations » par défaut", async () => {
  const user = userEvent.setup();
  renderAgent();
  expect(await selectButton("Harnais du nommage")).toHaveTextContent("Comme les conversations");
  expect(screen.queryByRole("button", { name: /Modèle du nommage/ })).toBeNull();
  await waitFor(async () => expect(await selectButton("Modèle de Claude Code")).toBeEnabled());
  await pickOption(user, "Harnais du nommage", "Claude Code");
  await waitFor(() => expect(lastSetting("agents.titling")).toEqual({ provider: "claude", model: "opus" }));
  await pickOption(user, "Raisonnement du nommage", /bas|faible|low/i);
  await waitFor(() =>
    expect(lastSetting("agents.titling")).toEqual({ provider: "claude", model: "opus", effort: "low" }),
  );
  await pickOption(user, "Harnais du nommage", "Comme les conversations");
  await waitFor(() => expect(lastSetting("agents.titling")).toBeNull());
});

it("enregistre le modèle des pages, « Comme l’agent » par défaut", async () => {
  const user = userEvent.setup();
  renderAgent();
  expect(screen.getByRole("heading", { name: "Dans les pages" })).toBeInTheDocument();
  expect(screen.getByText(/Pour résumer, classer ou rédiger depuis vos pages/)).toBeInTheDocument();
  expect(await optionsOf(user, "Harnais des pages")).toEqual(["Comme l’agent", "Claude Code", "Codex"]);
  await waitFor(async () => expect(await selectButton("Modèle de Claude Code")).toBeEnabled());
  await pickOption(user, "Harnais des pages", "Claude Code");
  await waitFor(() => expect(lastSetting("agents.pageModel")).toEqual({ provider: "claude", model: "opus" }));
  await pickOption(user, "Modèle des pages", "Haiku");
  await waitFor(() => expect(lastSetting("agents.pageModel")).toEqual({ provider: "claude", model: "haiku" }));
  // Le modèle des pages ne touche ni à celui de l’agent ni au nommage.
  expect(lastDefaults()).toBeUndefined();
  expect(lastSetting("agents.titling")).toBeUndefined();
  await pickOption(user, "Harnais des pages", "Comme l’agent");
  await waitFor(() => expect(lastSetting("agents.pageModel")).toBeNull());
});

it("garde visible un harnais réglé pour les pages puis désinstallé", async () => {
  const user = userEvent.setup();
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, pageModel: { provider: "opencode" }, textEditor: null },
    status: "ready",
  });
  renderAgent();
  expect(await selectButton("Harnais des pages")).toHaveTextContent("OpenCode (non installé)");
  expect(await optionsOf(user, "Harnais des pages")).toContain("OpenCode (non installé)");
});

it("enregistre la commande de l’éditeur quand elle est valide, et la désactive", async () => {
  const user = userEvent.setup();
  renderAgent();
  const input = screen.getByRole("textbox", { name: "Commande de lancement" });
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, "code{Enter}");
  expect(await screen.findByText("Ajoutez {{directory}} pour transmettre le dossier à l’éditeur.")).toBeInTheDocument();
  expect(lastSetting("agents.textEditor")).toBeUndefined();
  await user.clear(input);
  await user.type(input, 'code -n "{{{{directory}}"{Enter}');
  await waitFor(() => expect(lastSetting("agents.textEditor")).toEqual({ command: 'code -n "{{directory}}"' }));
  await user.click(await screen.findByRole("button", { name: "Désactiver l’éditeur de texte" }));
  await waitFor(() => expect(lastSetting("agents.textEditor")).toBeNull());
});

it("valide la commande de l’éditeur comme OneApp", () => {
  expect(validateTextEditorCommand("")).toBe("Saisissez la commande de lancement de l’éditeur.");
  expect(validateTextEditorCommand('code "{{directory}}')).toBe("Fermez les guillemets de la commande de l’éditeur.");
  expect(validateTextEditorCommand('code "{{directory}}"')).toBeUndefined();
});
