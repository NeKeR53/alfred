import { describe, expect, it } from "vitest";

window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;

const { subjectLabel, toResource } = await import("./services");
const { useShell } = await import("./store");

describe("demande d’accord", () => {
  it("nomme le demandeur par son titre et par sa référence, que l’agent ne choisit pas", () => {
    useShell.setState({
      snapshot: {
        sections: [{ pages: [{ reference: "notes/liste", title: "Paramètres de sécurité" }] }],
        settingsPages: [],
        modules: [{ id: "notes", name: "Banque" }],
      },
    } as never);
    const page = { subject: { kind: "page", module: "notes", reference: "notes/liste" } };
    expect(subjectLabel(page)).toBe("La page « Paramètres de sécurité » (notes/liste)");
    const functions = { subject: { kind: "function", module: "notes", reference: "notes/*" } };
    expect(subjectLabel(functions)).toBe("Les fonctions du module « Banque » (notes)");
  });
});

describe("ressource demandée", () => {
  it("contracte « à le » et « à les »", () => {
    expect(toResource("le client HTTPBin")).toBe("au client HTTPBin");
    expect(toResource("les fonctions du module")).toBe("aux fonctions du module");
    expect(toResource("la fonction notes/compter")).toBe("à la fonction notes/compter");
  });
});
