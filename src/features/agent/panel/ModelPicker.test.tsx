import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "../socle.test-helper";

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
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, pageModel: null, textEditor: null },
    status: "ready",
  });
});

// Les modèles masqués dans les réglages ne sont plus proposés, sauf celui déjà choisi, comme dans OneApp.
it("ne propose que les modèles affichés, plus le modèle déjà choisi", async () => {
  vi.mocked(listModels).mockResolvedValue([
    { id: "opus", name: "Opus", efforts: [] },
    { id: "sonnet", name: "Sonnet", efforts: [] },
    { id: "haiku", name: "Haiku", efforts: [] },
  ]);
  useAgentPreferences.setState({
    values: { shownModels: { claude: ["opus"] }, titling: null, pageModel: null, textEditor: null },
    status: "ready",
  });
  render(<ModelPicker value={{ provider: "claude", model: "haiku" }} cwd="/tmp" onChange={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Haiku : modèle de l’agent" }));
  // Le champ « Modèle » du volet montre le modèle choisi ; il ouvre la liste.
  await userEvent.click(await screen.findByRole("button", { name: /Haiku/ }));
  const options = screen.getAllByRole("option").map((option) => option.textContent);
  expect(options).toEqual(["Modèle par défaut", "Opus", "Haiku"]);
});

// Une conversation commencée garde son harnais : le menu le dit en clair, pas seulement par un curseur interdit.
it("explique pourquoi les autres harnais sont grisés une fois la conversation commencée", async () => {
  render(<ModelPicker value={{ provider: "opencode" }} cwd="/tmp" providerLocked onChange={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /: modèle de l’agent$/ }));
  expect(screen.getByText(/Harnais fixé : cette conversation a commencé avec OpenCode/)).toHaveTextContent(
    "Pour Claude Code ou Codex, ouvrez une nouvelle conversation.",
  );
  expect(screen.getByRole("radio", { name: "Codex" })).toBeDisabled();
});

it("n’affiche aucune explication tant que la conversation n’a pas commencé", async () => {
  render(<ModelPicker value={{ provider: "opencode" }} cwd="/tmp" onChange={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /: modèle de l’agent$/ }));
  expect(screen.queryByText(/Harnais fixé/)).toBeNull();
  expect(screen.getByRole("radio", { name: "Codex" })).toBeEnabled();
});

// D-380 : le raisonnement est un curseur à crans, sa valeur écrite en mots ; un cran au clavier enregistre le niveau.
it("règle le raisonnement au curseur à crans, sur les seuls niveaux du modèle", async () => {
  vi.mocked(listModels).mockResolvedValue([{ id: "opus", name: "Opus", efforts: ["low", "high"] }]);
  const onChange = vi.fn();
  render(<ModelPicker value={{ provider: "claude", model: "opus" }} cwd="/tmp" onChange={onChange} />);
  await userEvent.click(await screen.findByRole("button", { name: "Opus : modèle de l’agent" }));
  const slider = await screen.findByRole("slider", { name: "Raisonnement" });
  expect(slider).toHaveAttribute("aria-valuetext", "Par défaut");
  expect(slider).toHaveAttribute("max", "2");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ provider: "claude", model: "opus", effort: "low" }));
});
