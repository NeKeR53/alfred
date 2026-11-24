import { expect, it, vi } from "vitest";

vi.mock("../lib/native");

vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

import { invoke, onNativeEvent } from "../lib/native";
import type { Snapshot } from "../lib/types";
import { BACKEND_WAIT, useShell } from "./store";

/**
 * Tauri crée la fenêtre avant d’enregistrer l’état du cœur. En debug, la page appelait le cœur trop tôt : le
 * démarrage échouait, aucun espace récent n’était lu, et l’accueil complet restait affiché au lieu de l’espace rouvert.
 */
it("attend que le cœur soit prêt, puis rouvre le dernier espace", async () => {
  BACKEND_WAIT.delayMs = 0;
  let refused = 0;
  const taff = { path: "/espaces/taff", name: "taff", sections: [], modules: [] } as unknown as Snapshot;
  vi.mocked(onNativeEvent).mockImplementation(() => () => undefined);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "app.info" && refused < 2) {
      refused++;
      throw new Error("state not managed for field `state` on command `alfred_invoke`. You must call `.manage()`");
    }
    if (command === "app.info") return { version: "test" };
    if (command === "space.restore") return taff;
    if (command === "settings.get") return null;
    return null;
  });

  await useShell.getState().start();

  expect(refused).toBe(2);
  expect(useShell.getState().startupError).toBeNull();
  expect(useShell.getState().snapshot?.path).toBe("/espaces/taff");
});

it("rend une autre erreur tout de suite, sans attendre", async () => {
  BACKEND_WAIT.delayMs = 0;
  let calls = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "app.info") {
      calls++;
      throw new Error("Base de données illisible.");
    }
    return null;
  });

  await useShell.getState().start();

  expect(calls).toBe(1);
  expect(useShell.getState().startupError).toBe("Base de données illisible.");
});
