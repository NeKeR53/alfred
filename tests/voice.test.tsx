/**
 * La voix dans l’application entière : une demande dictée part comme un message, et la réponse finale de l’agent
 * est lue à voix haute ; une demande tapée ne l’est pas.
 */
import "./support/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";

async function finishTurn(user: ReturnType<typeof userEvent.setup>, turns = 1) {
  const approval = await screen.findByRole("region", { name: "Autorisation demandée" });
  await user.click(within(approval).getByRole("button", { name: "Autoriser" }));
  const card = await screen.findByRole("form", { name: "Emplacement de la nouvelle page" });
  await user.click(within(card).getByRole("radio", { name: "Nouvelle entrée du menu de gauche" }));
  await user.click(within(card).getByRole("button", { name: "Placer la page" }));
  await waitFor(() => expect(screen.getAllByRole("region", { name: "Bilan des modifications" })).toHaveLength(turns));
}

it("dicter une demande l’envoie, et la réponse de l’agent est lue", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  backend.voice.configured = true;
  backend.voice.transcript = "Ajoute une page pour les recettes";
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "Dicter un message" }));
  const stop = await screen.findByRole("button", { name: "Terminer la dictée et envoyer" });
  expect(screen.getByRole("textbox", { name: "Message à l’agent" })).toHaveAttribute(
    "aria-placeholder",
    "Je vous écoute…",
  );
  await user.click(stop);

  await waitFor(() => expect(backend.agent.written.some((message) => message.type === "user")).toBe(true));
  const sent = backend.agent.written.find((message) => message.type === "user") as {
    message: { content: Array<{ text: string }> };
  };
  expect(sent.message.content[0]?.text).toBe("Ajoute une page pour les recettes");

  await finishTurn(user);
  await waitFor(() => expect(backend.voice.spoken).toEqual(["La page recettes/recettes est prête."]));

  // Une demande tapée ensuite n’est pas lue.
  await user.type(screen.getByRole("textbox", { name: "Message à l’agent" }), "Et une page pour les courses");
  await user.click(screen.getByRole("button", { name: "Envoyer" }));
  await waitFor(() => expect(backend.agent.written.filter((message) => message.type === "user")).toHaveLength(2));
  await finishTurn(user, 2);
  expect(backend.voice.spoken).toHaveLength(1);
});
