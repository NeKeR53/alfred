import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HtmlContent, safeLink, safeStyle, sanitizeHtml } from "./HtmlContent";

/** HTML produit par le nettoyage, pour l’inspecter. */
function cleaned(html: string): string {
  const container = document.createElement("div");
  for (const node of sanitizeHtml(html).nodes) container.appendChild(node);
  return container.innerHTML;
}

describe("HtmlContent · nettoyage d’un courriel", () => {
  it("retire scripts, gestionnaires, formulaires, cadres et SVG", () => {
    const html = cleaned(`
      <p onclick="steal()">Bonjour <b onmouseover="x()">Paul</b></p>
      <script>alert(1)</script>
      <img src="x" onerror="steal()">
      <iframe src="https://evil.example"></iframe>
      <form action="https://evil.example"><input name="pw"><button>Envoyer</button></form>
      <svg onload="steal()"><circle /></svg>
      <object data="x"></object><embed src="x"><base href="https://evil.example"><meta http-equiv="refresh">
    `);
    expect(html).toContain("Bonjour <b>Paul</b>");
    expect(html).not.toMatch(
      /onclick|onmouseover|onerror|onload|<script|<iframe|<form|<input|<button|<svg|<object|<embed|<base|<meta/i,
    );
    expect(html).not.toContain("alert(1)");
  });

  it("ne garde que les liens web et courriel, sans navigation directe", () => {
    const html = cleaned(`
      <a href="https://exemple.fr/facture">Facture</a>
      <a href="mailto:paul@exemple.fr">Écrire</a>
      <a href="javascript:steal()">Piège</a>
      <a href=" JaVaScRiPt:steal()">Piège 2</a>
      <a href="data:text/html,<script>x</script>">Piège 3</a>
    `);
    expect(html).toContain('data-href="https://exemple.fr/facture"');
    expect(html).toContain('data-href="mailto:paul@exemple.fr"');
    expect(html).not.toMatch(/javascript:|data:text|\shref=/i);
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://ok.fr")).toBe("https://ok.fr");
  });

  it("retire des styles ce qui charge ou exécute quelque chose", () => {
    expect(safeStyle("color: red; background: url(https://evil.example/t.png); width: expression(alert(1))")).toBe(
      "color: red",
    );
    const html = cleaned(
      `<html><head><style>@import "https://evil.example/a.css"; p { color: blue; background: url(https://evil.example/t.png) }</style></head><body><p>Texte</p></body></html>`,
    );
    expect(html).toContain("color: blue");
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).toContain("<p>Texte</p>");
  });

  it("garde le contenu des balises inconnues d’Outlook et masque les images non résolues", () => {
    const { nodes, images } = sanitizeHtml(
      '<o:p>Texte Word</o:p><img src="cid:logo@01"><img src="https://pixel.example/t.gif"><img src="data:image/png;base64,AAAA">',
    );
    const container = document.createElement("div");
    for (const node of nodes) container.appendChild(node);
    expect(container.textContent).toContain("Texte Word");
    expect(images.map((image) => image.source)).toEqual(["cid:logo@01", "https://pixel.example/t.gif"]);
    expect(container.querySelectorAll("img[src]")).toHaveLength(1);
  });
});

describe("HtmlContent · affichage", () => {
  it("rend le courriel dans une racine fantôme, ouvre les liens par onLink et résout les images jointes", async () => {
    const onLink = vi.fn();
    const resolveImage = vi.fn(async (source: string) =>
      source.startsWith("cid:") ? "data:image/png;base64,AAAA" : null,
    );
    const { container, getByRole } = render(
      <HtmlContent
        label="Message de Paul"
        html='<p>Bonjour</p><a href="https://exemple.fr">Lien</a><img src="cid:logo"><img src="https://pixel.example/t.gif">'
        onLink={onLink}
        resolveImage={resolveImage}
      />,
    );
    const host = getByRole("document", { name: "Message de Paul" });
    const shadow = host.shadowRoot;
    expect(shadow?.textContent).toContain("Bonjour");
    // Rien du courriel dans le document de la page lui-même.
    expect(container.querySelector("p")?.textContent ?? "").not.toContain("Bonjour");
    (shadow?.querySelector("a[data-href]") as HTMLElement | null)?.click();
    expect(onLink).toHaveBeenCalledWith("https://exemple.fr");
    await waitFor(() => expect(container.textContent).toContain("1 image masquée."));
    expect(shadow?.querySelector('img[src^="data:"]')).not.toBeNull();
  });
});
