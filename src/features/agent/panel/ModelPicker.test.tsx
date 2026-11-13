import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../harness", async (original) => ({
  ...(await original<typeof import("../harness")>()),
  listModels: vi.fn(async () => []),
}));

import { ModelPicker } from "./ModelPicker";

beforeEach(() => {
  vi.clearAllMocks();
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
