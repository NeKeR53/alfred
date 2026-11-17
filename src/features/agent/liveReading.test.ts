import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  // La coquille lit le thème du système dès son chargement, et jsdom n’a pas `matchMedia`.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const { completeSentences } = await import("./liveReading");

it("ne garde que les phrases complètes, et jamais un bloc de code encore ouvert", () => {
  expect(completeSentences("Je regarde vos factures. Il y en a")).toBe("Je regarde vos factures.");
  expect(completeSentences("Bonjour")).toBe("");
  expect(completeSentences("Fini !\nEnsuite")).toBe("Fini !\n");
  expect(completeSentences("Voici le code. ```ts\nconst a = 1;")).toBe("Voici le code.");
  expect(completeSentences("Prix : 3.50 euros. Merci")).toBe("Prix : 3.50 euros.");
});
