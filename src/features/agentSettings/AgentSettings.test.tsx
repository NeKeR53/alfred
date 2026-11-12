import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
vi.mock("../agent/harness");
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
import { listModels, type Provider, probe } from "../agent/harness";
import { useAgents } from "../agent/store";
import { AgentSettings } from "./AgentSettings";

let settings: Array<Record<string, unknown>>;
let codexModelsFail: boolean;
let settingsFail: boolean;

beforeEach(() => {
  settings = [];
  codexModelsFail = true;
  settingsFail = false;
  useNotifications.getState().clear();
  useShell.setState({ snapshot: { path: "/tmp/espace" } as never });
  useAgents.setState({ ready: true, defaults: { provider: "claude", autonomy: "ask", models: {} } });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
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

  // État des trois CLI, en toutes lettres.
  expect(await screen.findByText("Installé · 2.1.0")).toBeInTheDocument();
  expect(screen.getByText("Connecté")).toBeInTheDocument();
  expect(screen.getByText("Non connecté")).toBeInTheDocument();
  expect(screen.getByText("Non installé")).toBeInTheDocument();
  expect(screen.getByText(/Installez OpenCode, puis connectez-vous dans un terminal/)).toBeInTheDocument();
  expect(listModels).toHaveBeenCalledWith("codex", "/tmp/espace");

  // Un catalogue illisible est signalé sans bloquer le reste de l’écran.
  expect(await screen.findByText(/Les modèles de Codex n’ont pas pu être lus : Non connecté\./)).toBeInTheDocument();
  expect(screen.getByLabelText("Modèle de Codex")).toBeDisabled();

  // Harnais par défaut : appliqué dès le choix.
  await user.click(screen.getByRole("radio", { name: "Codex" }));
  await waitFor(() => expect(lastDefaults()).toMatchObject({ provider: "codex" }));
  expect(screen.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");

  // Modèle puis effort ; l’effort suit les niveaux du modèle choisi.
  const model = await screen.findByLabelText("Modèle de Claude Code");
  await waitFor(() => expect(model).toBeEnabled());
  expect(screen.getByLabelText("Effort de Claude Code")).toBeDisabled();
  await user.selectOptions(model, "opus");
  await user.selectOptions(screen.getByLabelText("Effort de Claude Code"), "high");
  await waitFor(() => expect(lastDefaults()).toMatchObject({ models: { claude: { model: "opus", effort: "high" } } }));
  await user.selectOptions(model, "haiku");
  await waitFor(() => expect(lastDefaults()).toMatchObject({ models: { claude: { model: "haiku" } } }));
  expect((lastDefaults() as { models: { claude: { effort?: string } } }).models.claude.effort).toBeUndefined();
  expect(screen.getByText("Ce modèle ne propose pas de niveau d’effort.")).toBeInTheDocument();

  // Réessayer le catalogue de Codex une fois connecté.
  codexModelsFail = false;
  const banner = screen.getByText(/Les modèles de Codex/).closest("[role]") ?? document.body;
  await user.click(within(banner as HTMLElement).getByRole("button", { name: "Réessayer" }));
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
