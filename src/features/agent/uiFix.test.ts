import { describe, expect, it } from "vitest";
import { fixContext, rectBetween } from "./uiFixModel";

describe("rectBetween", () => {
  it("normalise un tracé fait de bas en haut et le borne à l’image", () => {
    expect(rectBetween({ x: 120, y: 90 }, { x: -10, y: 30 }, { width: 100, height: 200 })).toEqual({
      x: 0,
      y: 30,
      width: 100,
      height: 60,
    });
  });
});

describe("fixContext", () => {
  const page = { reference: "taches/liste", module: "taches", id: "liste", title: "Tâches" };

  it("situe l’élément encadré, son fichier et son contenu", () => {
    const text = fixContext(
      page,
      { width: 800, height: 600 },
      { x: 10, y: 20, width: 100, height: 40 },
      { path: ["main", "button.ui-button [button]"], text: 'button "Ajouter"', truncated: false },
      "/tmp/capture.png",
    );
    expect(text).toContain("ouvre et regarde cette capture : /tmp/capture.png");
    expect(text).toContain("modules/taches/pages/liste.tsx");
    expect(text).toContain("x=10, y=20, 100 × 40 px");
    expect(text).toContain("button.ui-button [button]");
    expect(text).toContain('button "Ajouter"');
  });

  it("décrit la page entière sans cadre", () => {
    expect(fixContext(page, { width: 800, height: 600 }, null, null, "/tmp/c.png")).toContain("toute la fenêtre");
  });
});
