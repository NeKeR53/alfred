/**
 * Compteur d’une page (`badge` du SDK) : la page le règle par le pont des cadres, le menu de gauche en montre la
 * somme sur l’entrée de la section et l’onglet le sien ; un compteur gardé d’un lancement précédent s’affiche dès
 * l’ouverture.
 */
import "./support/dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { ALFRED_MESSAGE } from "../src/sdk/protocol";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";
import { findNavigation, getNavigation } from "./support/shell";

it("la pastille suit le compteur réglé par la page", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  backend.badges = { "notes/carnet": 2 };
  const user = userEvent.setup();
  render(<App />);
  const navigation = await findNavigation();

  // Gardé du lancement précédent : la section Notes l’affiche avant même d’être ouverte.
  expect(await within(navigation).findByRole("row", { name: "Notes" })).toHaveTextContent("2");

  await user.click(within(navigation).getByRole("row", { name: "Suivi" }));
  const frame = (await screen.findByTitle("Tâches")) as HTMLIFrameElement;
  const send = (id: string, method: string, params: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { alfred: ALFRED_MESSAGE, kind: "request", id, method, params },
          source: frame.contentWindow,
        }),
      );
    });

  await send("r1", "badge.update", { op: "set", value: 3 });
  await send("r2", "badge.update", { op: "increment", value: 1 });
  const suivi = within(navigation).getByRole("row", { name: "Suivi" });
  await waitFor(() => expect(within(suivi).getByText("4")).toBeInTheDocument());
  expect(backend.lastCall("frame.badges.update")).toMatchObject({
    subject: { kind: "page", module: "suivi", reference: "suivi/taches" },
    page: "suivi/taches",
  });
  expect(screen.getByRole("tab", { name: "Tâches (4)" })).toBeInTheDocument();

  // Remis à zéro : la pastille disparaît.
  await send("r3", "badge.update", { op: "set", value: 0 });
  await waitFor(() => expect(within(suivi).queryByText("4")).not.toBeInTheDocument());
  expect(screen.getByRole("tab", { name: "Tâches" })).toBeInTheDocument();
  expect(backend.unknown, "commandes absentes du faux backend").toEqual([]);
});
