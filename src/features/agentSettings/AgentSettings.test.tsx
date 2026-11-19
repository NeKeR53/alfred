import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
// Seuls le catalogue des modèles et la détection des CLI sont simulés ; le reste des harnais est le vrai.
vi.mock("../agent/harness", async (original) => ({
  ...(await original<typeof import("../agent/harness")>()),
  listModels: vi.fn(),
}));
vi.mock("../agent/harness/process", async (original) => ({
  ...(await original<typeof import("../agent/harness/process")>()),
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
import { probe } from "../agent/harness/process";
import { useAgentPreferences } from "../agent/panel/ModelPicker";
import { useAgents } from "../agent/store";
import { AgentSettings, validateTextEditorCommand } from "./AgentSettings";

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

it("montre l’état des harnais et enregistre harnais, modèle, effort et autonomie par défaut", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />);

  // État des CLI installés, en toutes lettres ; OpenCode, absent de ce poste, n’apparaît nulle part.
  expect(await screen.findByText("Installé · 2.1.0")).toBeInTheDocument();
  expect(screen.getByText("Connecté")).toBeInTheDocument();
  expect(screen.getByText("Non connecté")).toBeInTheDocument();
  expect(screen.queryByText("Non installé")).not.toBeInTheDocument();
  expect(screen.queryByText("OpenCode")).not.toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "OpenCode" })).not.toBeInTheDocument();
  expect(listModels).not.toHaveBeenCalledWith("opencode", expect.anything());
  expect(listModels).toHaveBeenCalledWith("codex", "/tmp/espace");

  // Un catalogue illisible est signalé sans bloquer le reste de l’écran.
  expect(await screen.findByText(/Les modèles de Codex n’ont pas pu être lus : Non connecté\./)).toBeInTheDocument();
  expect(screen.getByLabelText("Modèle de Codex")).toBeDisabled();

  // Harnais par défaut : appliqué dès le choix.
  await user.click(screen.getByRole("radio", { name: "Codex" }));
  await waitFor(() => expect(lastDefaults()).toMatchObject({ provider: "codex" }));
  expect(screen.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");

  // Modèle puis raisonnement en curseur, comme dans OneApp : sur les seuls niveaux du modèle choisi.
  const model = await screen.findByLabelText("Modèle de Claude Code");
  await waitFor(() => expect(model).toBeEnabled());
  expect(screen.queryByRole("slider", { name: "Raisonnement de Claude Code" })).toBeNull();
  await user.selectOptions(model, "opus");
  const slider = await screen.findByRole("slider", { name: "Raisonnement de Claude Code" });
  expect(slider).toHaveAttribute("max", "3");
  fireEvent.change(slider, { target: { value: "3" } });
  await waitFor(() => expect(lastDefaults()).toMatchObject({ models: { claude: { model: "opus", effort: "high" } } }));
  // Un autre modèle repart de son raisonnement par défaut.
  await user.selectOptions(model, "haiku");
  await waitFor(() => expect(lastDefaults()).toMatchObject({ models: { claude: { model: "haiku" } } }));
  expect((lastDefaults() as { models: { claude: { effort?: string } } }).models.claude.effort).toBeUndefined();
  expect(screen.getAllByText("Par défaut du modèle").length).toBeGreaterThan(0);

  // Réessayer le catalogue de Codex une fois connecté.
  codexModelsFail = false;
  await user.click(screen.getByRole("button", { name: "Relire les modèles de Codex" }));
  await waitFor(() => expect(screen.getByLabelText("Modèle de Codex")).toBeEnabled());

  // Autonomie : chaque niveau est expliqué.
  expect(
    screen.getByText(/carte d’accord pour lancer une commande, écrire ailleurs ou accéder au réseau/),
  ).toBeVisible();
  await user.click(screen.getByRole("radio", { name: /Accord à chaque action/ }));
  await waitFor(() => expect(lastDefaults()).toMatchObject({ autonomy: "strict" }));

  // Un échec d’enregistrement remet la valeur précédente et le signale.
  settingsFail = true;
  await user.click(screen.getByRole("radio", { name: /Autonomie totale/ }));
  await waitFor(() =>
    expect(useNotifications.getState().items.map((item) => item.title)).toContain(
      "Le réglage des agents n’a pas été enregistré",
    ),
  );
  expect(useAgents.getState().defaults.autonomy).toBe("strict");
  expect(screen.getByRole("radio", { name: /Accord à chaque action/ })).toBeChecked();
});

const lastSetting = (key: string) => settings.filter((item) => item.key === key).at(-1)?.value;

it("choisit les modèles affichés d’un harnais, depuis sa ligne d’état comme dans OneApp", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />);
  expect(await screen.findByText("2 / 2 modèles affichés")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Modèles affichés" })).toBeNull();
  // Vérifier les harnais relit aussi leurs modèles.
  vi.mocked(listModels).mockClear();
  await user.click(screen.getByRole("button", { name: "Vérifier de nouveau les harnais" }));
  await waitFor(() => expect(listModels).toHaveBeenCalledWith("claude", "/tmp/espace"));
  await user.click(screen.getByRole("button", { name: "Choisir les modèles de Claude Code" }));
  const dialog = await screen.findByRole("dialog", { name: "Modèles Claude Code" });
  expect(within(dialog).getByText("2 affichés sur 2")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("checkbox", { name: "Afficher Haiku" }));
  await waitFor(() => expect(lastSetting("agents.shownModels")).toEqual({ claude: ["opus"] }));
  expect(within(dialog).getByText("1 affiché sur 2")).toBeInTheDocument();
  // La recherche filtre la liste sans rien changer.
  await user.type(within(dialog).getByRole("searchbox", { name: "Rechercher un modèle Claude Code" }), "opu");
  expect(within(dialog).queryByRole("checkbox", { name: "Afficher Haiku" })).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Tout afficher" }));
  await waitFor(() => expect(lastSetting("agents.shownModels")).toEqual({}));
  await user.click(within(dialog).getByRole("button", { name: "Tout masquer" }));
  await waitFor(() => expect(lastSetting("agents.shownModels")).toEqual({ claude: [] }));
  await user.click(within(dialog).getByRole("button", { name: "Fermer" }));
  expect(screen.getByText("0 / 2 modèles affichés")).toBeInTheDocument();
  // Masqués, les modèles ne sont plus proposés comme modèle par défaut.
  const options = within(screen.getByLabelText("Modèle de Claude Code"))
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(options).toEqual(["Modèle par défaut"]);
});

it("enregistre le modèle de nommage, « Comme les conversations » par défaut", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />);
  const provider = screen.getByLabelText("Harnais du nommage");
  expect(provider).toHaveValue("");
  expect(screen.getByLabelText("Modèle du nommage")).toBeDisabled();
  await waitFor(() => expect(screen.getByLabelText("Modèle de Claude Code")).toBeEnabled());
  await user.selectOptions(provider, "claude");
  await waitFor(() => expect(lastSetting("agents.titling")).toEqual({ provider: "claude", model: "opus" }));
  fireEvent.change(await screen.findByRole("slider", { name: "Raisonnement du nommage" }), { target: { value: "1" } });
  await waitFor(() =>
    expect(lastSetting("agents.titling")).toEqual({ provider: "claude", model: "opus", effort: "low" }),
  );
  await user.selectOptions(provider, "");
  await waitFor(() => expect(lastSetting("agents.titling")).toBeNull());
});

it("enregistre le modèle des pages, « Comme l’agent » par défaut", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />);
  expect(screen.getByRole("heading", { name: "Dans les pages" })).toBeInTheDocument();
  expect(screen.getByText(/Pour résumer, classer ou rédiger depuis vos pages/)).toBeInTheDocument();
  const provider = screen.getByLabelText("Harnais des pages");
  expect(provider).toHaveValue("");
  expect(
    within(provider)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Comme l’agent", "Claude Code", "Codex"]);
  expect(screen.getByLabelText("Modèle des pages")).toBeDisabled();
  await waitFor(() => expect(screen.getByLabelText("Modèle de Claude Code")).toBeEnabled());
  await user.selectOptions(provider, "claude");
  await waitFor(() => expect(lastSetting("agents.pageModel")).toEqual({ provider: "claude", model: "opus" }));
  await user.selectOptions(screen.getByLabelText("Modèle des pages"), "haiku");
  await waitFor(() => expect(lastSetting("agents.pageModel")).toEqual({ provider: "claude", model: "haiku" }));
  await user.selectOptions(screen.getByLabelText("Modèle des pages"), "opus");
  fireEvent.change(await screen.findByRole("slider", { name: "Raisonnement des pages" }), { target: { value: "3" } });
  await waitFor(() =>
    expect(lastSetting("agents.pageModel")).toEqual({ provider: "claude", model: "opus", effort: "high" }),
  );
  // Le modèle des pages ne touche ni à celui de l’agent ni au nommage.
  expect(lastDefaults()).toBeUndefined();
  expect(lastSetting("agents.titling")).toBeUndefined();
  await user.selectOptions(provider, "");
  await waitFor(() => expect(lastSetting("agents.pageModel")).toBeNull());
});

it("garde visible un harnais réglé pour les pages puis désinstallé", async () => {
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, pageModel: { provider: "opencode" }, textEditor: null },
    status: "ready",
  });
  render(<AgentSettings />);
  expect(screen.getByLabelText("Harnais des pages")).toHaveValue("opencode");
  expect(screen.getByRole("option", { name: "OpenCode (non installé)" })).toBeInTheDocument();
});

it("enregistre la commande de l’éditeur dès qu’elle est valide, et la désactive", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />);
  const input = screen.getByRole("textbox", { name: "Commande de lancement" });
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, "code");
  expect(await screen.findByText("Ajoutez {{directory}} pour transmettre le dossier à l’éditeur.")).toBeInTheDocument();
  await user.clear(input);
  await user.type(input, 'code -n "{{{{directory}}"');
  await waitFor(() => expect(lastSetting("agents.textEditor")).toEqual({ command: 'code -n "{{directory}}"' }), {
    timeout: 2000,
  });
  await user.click(screen.getByRole("button", { name: "Désactiver" }));
  await waitFor(() => expect(lastSetting("agents.textEditor")).toBeNull());
  expect(input).toHaveValue("");
});

it("valide la commande de l’éditeur comme OneApp", () => {
  expect(validateTextEditorCommand("")).toBe("Saisissez la commande de lancement de l’éditeur.");
  expect(validateTextEditorCommand('code "{{directory}}')).toBe("Fermez les guillemets de la commande de l’éditeur.");
  expect(validateTextEditorCommand('code "{{directory}}"')).toBeUndefined();
});
