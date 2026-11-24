import { describe, expect, it } from "vitest";
import { linkedWidths, xmlSafe } from "./screenshotPage";

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

describe("capture d’une page : XML valide", () => {
  it("retire le séparateur U+0000 d’un identifiant d’onglet, que XML interdit", () => {
    const markup = '<div data-key="view:atlassian/jira\u0000acme|ALF-12">Jira</div>';
    const safe = xmlSafe(markup);
    expect(safe).toBe('<div data-key="view:atlassian/jiraacme|ALF-12">Jira</div>');
    const parsed = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${safe}</svg>`,
      "image/svg+xml",
    );
    expect(parsed.querySelector("parsererror")).toBeNull();
  });

  it("garde la tabulation, les retours à la ligne et le texte accentué", () => {
    expect(xmlSafe("a\tb\nc\rd é")).toBe("a\tb\nc\rd é");
  });
});
