import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/native");
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke } from "../lib/native";
import { type RecentSpace, useShell } from "./store";

let stored: RecentSpace[] | null;

const space = (name: string): RecentSpace => ({ path: `/espaces/${name}`, name, openedAt: "2026-11-17T09:00:00Z" });

beforeEach(() => {
  stored = null;
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    if (command === "settings.get") return stored;
    if (command === "settings.set") stored = (args as { value: RecentSpace[] }).value;
    return null;
  });
});

it("relit la liste enregistrée avant de l’écrire : une autre interface ne voit pas son retrait annulé", async () => {
  // Cette interface garde une copie ancienne ; une autre a déjà retiré « Essai » de la liste enregistrée.
  useShell.setState({ recentSpaces: [space("Atelier"), space("Essai"), space("Perso")] });
  stored = [space("Atelier"), space("Perso")];

  useShell.getState().renameRecent("/espaces/Perso", "Perso 2");
  await vi.waitFor(() => expect(stored?.map((item) => item.name)).toEqual(["Atelier", "Perso 2"]));
  expect(useShell.getState().recentSpaces.map((item) => item.name)).toEqual(["Atelier", "Perso 2"]);

  useShell.getState().forgetSpace("/espaces/Atelier");
  await vi.waitFor(() => expect(stored?.map((item) => item.name)).toEqual(["Perso 2"]));
});

it("garde la copie de l’interface quand rien n’est encore enregistré", async () => {
  useShell.setState({ recentSpaces: [space("Atelier"), space("Perso")] });
  useShell.getState().forgetSpace("/espaces/Perso");
  expect(useShell.getState().recentSpaces.map((item) => item.name)).toEqual(["Atelier"]);
  await vi.waitFor(() => expect(stored?.map((item) => item.name)).toEqual(["Atelier"]));
});
