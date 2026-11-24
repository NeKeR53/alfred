import { describe, expect, it } from "vitest";
import { startScreen } from "./App";

describe("écran de départ", () => {
  it("n’affiche rien tant que le démarrage n’est pas fini, même sans espace récent lu", () => {
    expect(startScreen({ started: false, welcoming: false, snapshotOpen: false, firstRun: true })).toBe("loading");
  });

  it("rouvre l’espace le plus récent sans passer par l’accueil", () => {
    expect(startScreen({ started: true, welcoming: false, snapshotOpen: true, firstRun: false })).toBe("shell");
  });

  it("montre l’accueil complet au premier démarrage, une fois le démarrage fini", () => {
    expect(startScreen({ started: true, welcoming: false, snapshotOpen: false, firstRun: true })).toBe("welcome");
  });

  it("montre la version courte quand des espaces sont connus mais qu’aucun n’est ouvert", () => {
    expect(startScreen({ started: true, welcoming: false, snapshotOpen: false, firstRun: false })).toBe(
      "short-welcome",
    );
  });

  it("garde l’accueil lancé (premier démarrage ou Réglages) jusqu’à « Ouvrir Alfred »", () => {
    expect(startScreen({ started: true, welcoming: true, snapshotOpen: true, firstRun: false })).toBe("welcome");
  });
});
