/**
 * La voix dans l’application entière : une demande dictée part comme un message, et la réponse de l’agent est lue à
 * voix haute au fil de l’eau, phrase par phrase pendant qu’il écrit ; une demande tapée ne l’est pas.
 */
import "./support/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";

async function finishTurn(user: ReturnType<typeof userEvent.setup>) {
  const approval = await screen.findByRole("region", { name: "Autorisation demandée" });
  await user.click(within(approval).getByRole("button", { name: "Autoriser" }));
  const card = await screen.findByRole("form", { name: "Emplacement de la nouvelle page" });
  await user.click(within(card).getByRole("radio", { name: "Nouvelle entrée du menu de gauche" }));
  await user.click(within(card).getByRole("button", { name: "Placer la page" }));
  // Des messages qui s’enchaînent n’ont qu’un bilan, à la fin de la suite.
  await waitFor(() => expect(screen.getAllByRole("region", { name: "Bilan des modifications" })).toHaveLength(1));
}

it("dicter une demande l’envoie, et la réponse de l’agent est lue", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  backend.voice.configured = true;
  backend.voice.transcript = "Ajoute une page pour les recettes";
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "Dicter un message" }));
  const stop = await screen.findByRole("button", { name: "Terminer la dictée et envoyer" });
  expect(screen.getByRole("textbox", { name: /^Message à / })).toHaveAttribute("aria-placeholder", "Je vous écoute…");
  await user.click(stop);

  await waitFor(() => expect(backend.agent.written.some((message) => message.type === "user")).toBe(true));
  const sent = backend.agent.written.find((message) => message.type === "user") as {
    message: { content: Array<{ text: string }> };
  };
  expect(sent.message.content[0]?.text).toBe("Ajoute une page pour les recettes");

  await finishTurn(user);
  // Lue au fil de l’eau : ce qu’Alfred dit en cours de route, puis sa réponse finale, en une seule lecture.
  await waitFor(() =>
    expect(backend.voice.spoken).toEqual(["Je regarde ce que contient l’espace. La page recettes/recettes est prête."]),
  );

  // Une demande tapée ensuite n’est pas lue.
  await user.type(screen.getByRole("textbox", { name: /^Message à / }), "Et une page pour les courses");
  await user.click(screen.getByRole("button", { name: "Envoyer" }));
  await waitFor(() => expect(backend.agent.written.filter((message) => message.type === "user")).toHaveLength(2));
  await finishTurn(user);
  expect(backend.voice.spoken).toHaveLength(1);
});
