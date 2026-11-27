/**
 * Rechargement des pages (`ModuleSummary.code`) : une page ne se recharge que quand le code de son module change. Le
 * menu réordonné, une section créée, une fonction ajoutée à un autre module ne rechargent aucune page.
 */
import "./support/dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";
import { findNavigation } from "./support/shell";

it("le menu qui change ne recharge aucune page ; le code d’un module recharge seulement ses pages", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  const user = userEvent.setup();
  render(<App />);
  const navigation = await findNavigation();
  await user.click(await within(navigation).findByRole("row", { name: "Notes" }));
  const carnet = (await screen.findByTitle("Carnet")) as HTMLIFrameElement;
  await user.click(within(navigation).getByRole("row", { name: "Suivi" }));
  const taches = (await screen.findByTitle("Tâches")) as HTMLIFrameElement;
  const before = { carnet: carnet.src, taches: taches.src };

  // Une écriture dans l’espace qui ne touche pas au code (menu, section créée) : les pages restent telles quelles.
  backend.withSpace("/Users/lea/Maison", "Maison", builtModules());
  act(() => backend.emit("space:changed"));
  // La relecture du snapshot attend que les écritures se calment (150 ms).
  await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  expect(screen.getByTitle("Tâches")).toBe(taches);
  expect(taches.src).toBe(before.taches);
  expect(carnet.src).toBe(before.carnet);

  // L’agent réécrit le code du module Suivi : ses pages se rechargent, celles de Notes non.
  backend.withSpace(
    "/Users/lea/Maison",
    "Maison",
    builtModules().map((module) => (module.id === "suivi" ? { ...module, code: "2" } : module)),
  );
  act(() => backend.emit("space:changed"));
  await waitFor(() => expect(taches.src).not.toBe(before.taches));
  expect(carnet.src).toBe(before.carnet);
});
