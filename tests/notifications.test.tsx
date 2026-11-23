/**
 * Notification à actions (`shell.notify({ actions, persistent })`) : une page prévient l’utilisateur avec « Voir »,
 * qui ouvre une autre page du module ; la notification reste dans la cloche avec son bouton.
 */
import "./support/dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { ALFRED_MESSAGE } from "../src/sdk/protocol";
import { useShell } from "../src/shell/store";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";
import { findNavigation, getNavigation } from "./support/shell";

it("une notification persistante à action ouvre la page qu’elle nomme", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  const user = userEvent.setup();
  render(<App />);
  const navigation = await findNavigation();
  await user.click(within(navigation).getByRole("row", { name: "Suivi" }));
  const frame = (await screen.findByTitle("Tâches")) as HTMLIFrameElement;
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          alfred: ALFRED_MESSAGE,
          kind: "request",
          id: "n1",
          method: "shell.notify",
          params: {
            title: "Trois tâches en retard",
            tone: "warning",
            persistent: true,
            actions: [{ label: "Voir les échéances", navigate: "echeances" }],
          },
        },
        source: frame.contentWindow,
      }),
    );
  });

  const toast = await screen.findByRole("button", { name: "Voir les échéances" });
  await user.click(toast);
  await waitFor(() => expect(useShell.getState().activeTab["suivi/principal"]).toBe("suivi/echeances"));

  // Gardée dans le centre de notifications : la ligne rouvre ce que fait son action.
  await user.click(screen.getByRole("button", { name: /^Notifications/ }));
  expect((await screen.findAllByText("Trois tâches en retard")).length).toBeGreaterThan(0);
  // Les commandes d’autres chantiers en cours (agents, canaux) ne sont pas encore toutes dans le faux backend.
  expect(backend.unknown.filter((command) => /menuZones|badges|notify/.test(command))).toEqual([]);
});
