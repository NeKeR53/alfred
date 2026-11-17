/**
 * Poste sans agent : ni Claude Code, ni Codex, ni OpenCode. L’entrée Agent quitte le menu, la première section
 * s’affiche à la place de la page Agent, et Réglages → Agent dit quoi installer sans lister d’agent absent.
 */
import "./support/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { useHarnesses } from "../src/features/agent/harness";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";

it("sans agent installé, ni entrée Agent ni harnais absents : la première section s’affiche", async () => {
  useHarnesses.setState({ probes: {} });
  const backend = new FakeBackend().install();
  backend.agentsInstalled = false;
  backend.withSpace("/Users/lea/Maison", "Maison", builtModules());
  const user = userEvent.setup();
  render(<App />);

  const navigation = await screen.findByRole("navigation", { name: "Sections de l’espace de travail" });
  const first = await within(navigation).findByRole("button", { name: "Suivi" });
  // La vérification finie, l’entrée Agent disparaît et la première section prend sa place.
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Agent/ })).not.toBeInTheDocument());
  expect(first).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText("Que puis-je faire pour vous ?")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Réglages" }));
  const settings = await screen.findByRole("dialog", { name: "Réglages" });
  await user.click(within(settings).getByRole("button", { name: "Agent" }));
  expect(await within(settings).findByText("Aucun agent installé")).toBeVisible();
  for (const name of ["Claude Code", "Codex", "OpenCode"]) {
    expect(within(settings).queryByText(name)).not.toBeInTheDocument();
  }
});
