import { describe, expect, it } from "vitest";
import { matchesSearch, searchTerms } from "./textSearch";

describe("recherche sans accents ni casse", () => {
  it("découpe la recherche en mots repliés", () => {
    expect(searchTerms("  Élève   PARIS ")).toEqual(["eleve", "paris"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("exige chaque mot, dans n’importe quel champ", () => {
    const fields = ["Élève inscrit", "à Paris", 2026];
    expect(matchesSearch("eleve paris", fields)).toBe(true);
    expect(matchesSearch("ÉLÈVE 2026", fields)).toBe(true);
    expect(matchesSearch("eleve lyon", fields)).toBe(false);
  });

  it("trouve tout pour une recherche vide et ignore les champs absents", () => {
    expect(matchesSearch("", [])).toBe(true);
    expect(matchesSearch("null", [null, undefined, false])).toBe(false);
    expect(matchesSearch(searchTerms("café"), [["thé", "Café crème"]])).toBe(true);
  });
});
