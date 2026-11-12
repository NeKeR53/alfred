import { describe, expect, it } from "vitest";
import { catalogAccesses } from "./api";

describe("accès demandés par un module", () => {
  it("annonce la lecture des données du module qu’un module d’ajouts complète", () => {
    const accesses = catalogAccesses({ id: "banque-ajouts", name: "Ajouts", extends: "banque" });
    expect(accesses).toEqual([{ kind: "tables", id: "banque", label: "lecture des données du module « banque »" }]);
    expect(catalogAccesses({ id: "banque", name: "Banque", extends: null })).toEqual([]);
  });
});
