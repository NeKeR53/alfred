import { describe, expect, it } from "vitest";
import { extractJson, validateSchema } from "./jsonSchema";

describe("réponse structurée d’un modèle", () => {
  const schema = {
    type: "object",
    required: ["titre", "priorite", "etapes"],
    additionalProperties: false,
    properties: {
      titre: { type: "string", minLength: 3 },
      priorite: { enum: ["basse", "normale", "haute"] },
      etapes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["texte"],
          properties: { texte: { type: "string" }, duree: { type: ["integer", "null"] } },
        },
      },
    },
  };

  it("retrouve le JSON dans la réponse, l’accepte s’il est conforme et nomme chaque écart sinon", () => {
    const answer =
      'Voici la fiche :\n```json\n{"titre":"Migrer la base","priorite":"haute","etapes":[{"texte":"Sauvegarder","duree":5}]}\n```';
    const value = extractJson(answer);
    expect(validateSchema(value, schema)).toEqual([]);

    const wrong = { titre: "ab", priorite: "urgente", etapes: [{ duree: 1.5 }], bonus: true };
    const errors = validateSchema(wrong, schema);
    expect(errors).toHaveLength(5);
    expect(errors.join("\n")).toMatch(/\$\.titre/);
    expect(errors.join("\n")).toMatch(/\$\.etapes\[0\]\.texte : champ requis absent/);
    expect(errors.join("\n")).toMatch(/\$\.bonus : champ non prévu/);

    expect(() => extractJson("Je ne peux pas répondre.")).toThrow(/JSON lisible/);
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
});
