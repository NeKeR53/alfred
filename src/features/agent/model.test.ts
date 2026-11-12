import { describe, expect, it } from "vitest";
import { pastedContextTitle, plainText, turnCommitMessage } from "./model";

describe("message du commit d’un tour", () => {
  it("ne répète pas la demande quand elle a donné son titre à la conversation", () => {
    const request = "Crée-moi une page Notes : une liste de notes enregistrées dans la base, avec un formulaire";
    const title = "Crée-moi une page Notes : une liste de notes enregistrées d…";
    expect(turnCommitMessage(title, request)).toBe(title);
  });

  it("ajoute la demande d’un tour suivant", () => {
    expect(turnCommitMessage("Page Notes", "Ajoute un tri par date")).toBe("Page Notes — Ajoute un tri par date");
  });
});

describe("aperçu sans Markdown", () => {
  it("retire l’emphase, le code et les titres, et garde le libellé des liens", () => {
    expect(plainText("La page **Notes** est créée dans le `menu`.")).toBe("La page Notes est créée dans le menu.");
    expect(plainText("## Fait\n- voir [la doc](https://exemple.fr) et _ceci_")).toBe("Fait voir la doc et ceci");
  });

  it("laisse intacts les soulignés d’un identifiant", () => {
    expect(plainText("Table notes_notes créée")).toBe("Table notes_notes créée");
  });
});

describe("titre d’un collage long", () => {
  it("ne compte pas le saut de ligne final comme une ligne", () => {
    expect(pastedContextTitle("a\nb\n", 1)).toBe("Contexte 1 · 2 lignes");
    expect(pastedContextTitle("seule", 2)).toBe("Contexte 2 · 1 ligne");
  });
});
