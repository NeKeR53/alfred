import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../harness", async (original) => ({
  ...(await original<typeof import("../harness")>()),
  listModels: vi.fn(async () => []),
}));
vi.mock("../../../lib/native", async (original) => ({
  ...(await original<typeof import("../../../lib/native")>()),
  invoke: vi.fn(async () => null),
}));

import { listModels } from "../harness";
import { ModelPicker, useAgentPreferences } from "./ModelPicker";

beforeEach(() => {
  vi.clearAllMocks();
  useAgentPreferences.setState({ values: { shownModels: {}, titling: null, textEditor: null }, status: "ready" });
});

// Les modèles masqués dans les réglages ne sont plus proposés, sauf celui déjà choisi, comme dans OneApp.
it("ne propose que les modèles affichés, plus le modèle déjà choisi", async () => {
  vi.mocked(listModels).mockResolvedValue([
    { id: "opus", name: "Opus", efforts: [] },
    { id: "sonnet", name: "Sonnet", efforts: [] },
    { id: "haiku", name: "Haiku", efforts: [] },
  ]);
  useAgentPreferences.setState({
    values: { shownModels: { claude: ["opus"] }, titling: null, textEditor: null },
    status: "ready",
  });
  render(<ModelPicker value={{ provider: "claude", model: "haiku" }} cwd="/tmp" onChange={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /Modèle de l’agent : Haiku/ }));
  const options = screen.getAllByRole("option").map((option) => option.textContent);
  expect(options).toEqual(["Modèle par défaut", "Opus", "Haiku"]);
});

// Une conversation commencée garde son harnais : le menu le dit en clair, pas seulement par un curseur interdit.
it("explique pourquoi les autres harnais sont grisés une fois la conversation commencée", async () => {
  render(<ModelPicker value={{ provider: "opencode" }} cwd="/tmp" providerLocked onChange={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /Modèle de l’agent/ }));
  expect(screen.getByText(/Harnais fixé : cette conversation a commencé avec OpenCode/)).toHaveTextContent(
    "Pour Claude Code ou Codex, ouvre une nouvelle conversation.",
  );
  expect(screen.getByRole("radio", { name: "Codex" })).toBeDisabled();
});

it("n’affiche aucune explication tant que la conversation n’a pas commencé", async () => {
  render(<ModelPicker value={{ provider: "opencode" }} cwd="/tmp" onChange={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /Modèle de l’agent/ }));
  expect(screen.queryByText(/Harnais fixé/)).toBeNull();
  expect(screen.getByRole("radio", { name: "Codex" })).toBeEnabled();
});
