/**
 * Une conversation d’agent complète dans l’application entière : le vrai harnais Claude Code de l’interface parle à
 * un faux agent (derrière les commandes `agents.*`) et les outils d’Alfred posent leurs questions par le faux backend.
 */
import "./support/dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { render } from "../src/features/agent/socle.test-helper";
import { useNotifications } from "../src/shell/notifications";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";
import { findNavigation, getNavigation } from "./support/shell";

it("message, activités, accord, carte de placement, fin de tour enregistrée, puis annulation", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  const user = userEvent.setup();
  render(<App />);

  // L’espace du lancement précédent est rouvert ; une conversation vide attend le premier message.
  const composer = await screen.findByRole("textbox", { name: /^Message à / });
  expect(screen.getByText("Que puis-je faire pour vous ?")).toBeVisible();
  await user.type(composer, "Ajoute une page pour les recettes de la famille");
  await user.click(screen.getByRole("button", { name: "Envoyer" }));

  // Le harnais est lancé dans l’espace, relié aux outils d’Alfred par la conversation.
  await waitFor(() => expect(backend.agent.spawned).toHaveLength(1));
  const spawned = backend.agent.spawned[0] as {
    provider: string;
    cwd: string;
    conversation: string;
    autonomy: string;
    instructions: string;
  };
  expect(spawned.provider).toBe("claude");
  expect(spawned.cwd).toBe("/Users/lea/Maison");
  // Libre dans ses dossiers : Rust le traduit en `acceptEdits` pour Claude Code.
  expect(spawned.autonomy).toBe("ask");
  expect(String(spawned.instructions)).toContain("/Users/lea/Maison/AGENTS.md");
  const sent = backend.agent.written.find((message) => message.type === "user") as {
    message: { content: Array<{ text: string }> };
  };
  expect(sent.message.content[0]?.text).toBe("Ajoute une page pour les recettes de la famille");

  // Le message et les activités défilent ; une commande attend l’accord de l’utilisateur.
  expect(await screen.findByText("Je regarde ce que contient l’espace.")).toBeVisible();
  const approval = await screen.findByRole("region", { name: "Autorisation demandée" });
  expect(within(approval).getByText("ls modules")).toBeVisible();
  expect(screen.getByText("Autorisation requise")).toBeVisible();
  await user.click(within(approval).getByRole("button", { name: "Autoriser" }));
  await waitFor(() => expect(backend.agent.approvalAnswer).toBe("allow"));
  const response = backend.agent.written.find((message) => message.type === "control_response") as {
    response: { request_id: string; response: { behavior: string } };
  };
  expect(response.response).toMatchObject({ request_id: "controle-1", response: { behavior: "allow" } });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Autorisation demandée" })).not.toBeInTheDocument());

  // `place_page` sans emplacement : la carte demande où mettre la page. L’utilisateur choisit le menu.
  const card = await screen.findByRole("form", { name: "Emplacement de la nouvelle page" });
  expect(within(card).getByRole("textbox", { name: "Titre de la page" })).toHaveValue("Recettes");
  await user.click(within(card).getByRole("radio", { name: "Nouvelle entrée du menu de gauche" }));
  const label = within(card).getByRole("textbox", { name: "Nom dans le menu" });
  await user.clear(label);
  await user.type(label, "Cuisine");
  await user.click(within(card).getByRole("button", { name: "Placer la page" }));
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: "Emplacement de la nouvelle page" })).not.toBeInTheDocument(),
  );
  const placement = backend.calls.find(
    (call) => call.command === "ui.resolve" && (call.args.result as { target?: unknown } | undefined)?.target,
  );
  expect(placement?.args.result).toMatchObject({ title: "Recettes", target: { kind: "menu", label: "Cuisine" } });

  // Fin de tour : la réponse finale, la nouvelle entrée du menu, et le tour enregistré dans un commit.
  expect(await screen.findByText("cuisine/recettes")).toBeVisible();
  const navigation = getNavigation();
  expect(await within(navigation).findByRole("row", { name: "Cuisine" })).toBeVisible();
  const summary = await screen.findByRole("region", { name: "Bilan des modifications" });
  expect(within(summary).getByText("2 fichiers de l’espace de travail modifiés")).toBeVisible();
  expect(backend.lastCall("space.commit")?.message).toMatch(/recettes/i);
  expect(backend.commits.at(-1)?.files).toEqual(["modules/cuisine/module.json", "modules/cuisine/pages/recettes.tsx"]);
  await waitFor(() => {
    const saved = [...backend.conversations.values()][0] as { title: string; turns: Array<{ commit?: string }> };
    expect(saved.turns[0]?.commit).toBe(backend.commits.at(-1)?.id);
  });

  // Annuler ce tour : confirmation, commit inverse, l’entrée disparaît du menu.
  await user.click(within(summary).getByRole("button", { name: "Annuler cette modification" }));
  const confirm = await screen.findByRole("alertdialog");
  await user.click(within(confirm).getByRole("button", { name: "Annuler la modification" }));
  await waitFor(() => expect(backend.lastCall("space.undo")).toEqual({ commit: backend.commits[0]?.id }));
  await waitFor(() => expect(within(navigation).queryByRole("row", { name: "Cuisine" })).not.toBeInTheDocument());
  expect(screen.queryByRole("region", { name: "Bilan des modifications" })).not.toBeInTheDocument();
  await waitFor(() =>
    expect(useNotifications.getState().items.some((item) => item.title === "Modification annulée")).toBe(true),
  );
  expect(backend.commits.at(-1)?.message).toMatch(/^Revert/);
  expect(backend.unknown, "commandes absentes du faux backend").toEqual([]);
});
