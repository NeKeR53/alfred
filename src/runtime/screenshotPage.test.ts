import { describe, expect, it } from "vitest";
import { linkedWidths } from "./screenshotPage";

describe("capture d’une page : épaisseurs liées à un style", () => {
  it("écrit l’épaisseur d’une bordure `solid` de 0 px, comme celles que pose Tailwind 4", () => {
    const styles: Record<string, string> = {
      "border-top-style": "solid",
      "border-right-style": "solid",
      "border-bottom-style": "solid",
      "border-left-style": "solid",
      "outline-style": "none",
      "column-rule-style": "none",
    };
    expect(linkedWidths((name) => styles[name] ?? "")).toEqual([
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
    ]);
  });

  it("n’ajoute rien quand les styles sont `none`", () => {
    expect(linkedWidths(() => "none")).toEqual([]);
  });

  it("garde l’épaisseur d’un contour visible", () => {
    expect(linkedWidths((name) => (name === "outline-style" ? "solid" : "none"))).toEqual(["outline-width"]);
  });
});
