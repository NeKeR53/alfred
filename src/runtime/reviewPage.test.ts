import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composite,
  contrastRatio,
  emptyBands,
  measureContrast,
  measureLayout,
  parseColor,
  type Rgba,
  reviewPage,
} from "./reviewPage";

// biome-ignore lint/plugin: couleur d’essai du calcul de contraste, pas un style de page.
const BLACK = "rgb(0, 0, 0)";
// biome-ignore lint/plugin: couleur d’essai du calcul de contraste, pas un style de page.
const WHITE = "rgb(255, 255, 255)";
// biome-ignore lint/plugin: couleur d’essai du calcul de contraste, pas un style de page.
const HALF = "rgba(255, 255, 255, 0.5)";
// biome-ignore lint/plugin: couleur d’essai du calcul de contraste, pas un style de page.
const DARK = "rgb(24, 24, 24)";
// biome-ignore lint/plugin: couleur d’essai du calcul de contraste, pas un style de page.
const DIM = "rgb(60, 60, 60)";
// biome-ignore lint/plugin: couleur d’essai du calcul de contraste, pas un style de page.
const LIGHT = "rgb(236, 236, 236)";
// biome-ignore lint/plugin: couleur d’essai du calcul de contraste, pas un style de page.
const OKLCH = "oklch(0.7 0.1 200)";

function color(text: string): Rgba {
  const parsed = parseColor(text);
  if (!parsed) throw new Error(`couleur illisible : ${text}`);
  return parsed;
}

describe("examen d’une page : calculs", () => {
  it("lit les couleurs calculées par le navigateur et leur contraste", () => {
    expect(parseColor(BLACK)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor(HALF)).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(parseColor("color(srgb 0.5 0.5 0.5 / 0.4)")).toMatchObject({ r: 127.5, a: 0.4 });
    expect(parseColor("transparent")?.a).toBe(0);
    expect(parseColor(OKLCH)).toBeNull();
    expect(contrastRatio(color(BLACK), color(WHITE))).toBeCloseTo(21);
    expect(composite(color(HALF), color(BLACK)).r).toBeCloseTo(127.5);
    expect(contrastRatio(color(DIM), color(DARK))).toBeLessThan(3);
    expect(contrastRatio(color(LIGHT), color(DARK))).toBeGreaterThan(10);
  });

  it("trouve les bandes vides entre deux blocs, avec le texte de chaque bord", () => {
    const gaps = emptyBands([
      { left: 0, top: 10, right: 100, bottom: 30, label: "Titre" },
      { left: 0, top: 30, right: 100, bottom: 60, label: "Ligne" },
      { left: 0, top: 250, right: 100, bottom: 270, label: "Bas" },
      { left: 0, top: 300, right: 100, bottom: 320, label: "" },
    ]);
    expect(gaps).toEqual([{ top: 60, height: 190, above: "Ligne", below: "Bas" }]);
  });
});

/** Boîtes posées à la main : jsdom ne calcule pas la mise en page. */
function place(boxes: Record<string, [number, number, number, number]>) {
  const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  const rect = (element: Element | null) => {
    const box = element?.id ? boxes[element.id] : undefined;
    if (!box) return { ...zero, toJSON: () => zero } as DOMRect;
    const [left, top, right, bottom] = box;
    const value = { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top };
    return { ...value, toJSON: () => value } as DOMRect;
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rect(this);
  });
  // Une ligne de texte occupe la boîte de son élément.
  const ranges = Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
  const original = ranges.getClientRects;
  ranges.getClientRects = function (this: Range) {
    return [rect(this.startContainer.parentElement)];
  };
  return () => {
    ranges.getClientRects = original;
  };
}

function size(id: string, values: Record<string, number>) {
  const element = document.getElementById(id);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(element, name, { value, configurable: true });
  }
}

describe("examen d’une page : mesures dans le document", () => {
  let restore = () => {};
  afterEach(() => {
    restore();
    document.body.innerHTML = "";
    delete document.documentElement.dataset.theme;
  });

  it("relève ce qui commence sous la ligne de flottaison, les textes coupés et les bandes vides", () => {
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 862, configurable: true });
    document.body.innerHTML = `
      <main id="contenu" style="overflow-x: auto; overflow-y: auto">
        <h2 id="haut">Poser une question</h2>
        <p id="coupe" style="overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap">Fiche technique Halo, révision de mars</p>
        <h2 id="bas">Documents indexés</h2>
        <ul id="liste" aria-label="Documents"><li id="ligne">Garantie.pdf</li></ul>
      </main>`;
    restore = place({
      contenu: [0, 0, 1200, 862],
      haut: [24, 24, 600, 48],
      coupe: [24, 60, 224, 80],
      bas: [24, 1184, 600, 1208],
      liste: [24, 1220, 600, 1300],
      ligne: [24, 1220, 600, 1250],
    });
    size("contenu", { clientWidth: 1200, clientHeight: 862, scrollHeight: 1300, scrollWidth: 1400 });
    size("coupe", { clientWidth: 200, scrollWidth: 400 });

    const layout = measureLayout();
    expect(layout).toMatchObject({ width: 1200, height: 862, busy: false, contentTop: 24, contentBottom: 1250 });
    expect(layout.belowFold).toEqual([
      { kind: "heading", text: "Documents indexés", top: 1184 },
      { kind: "collection", text: "Documents", top: 1220 },
    ]);
    // Un bloc trop large fait déborder la zone de la page, pas un tableau qu’elle contiendrait.
    expect(layout.overflow).toEqual([{ kind: "page", text: "", hidden: 200 }]);
    expect(layout.truncatedCount).toBe(1);
    expect(layout.truncated).toEqual([{ text: "Fiche technique Halo, révision de mars", shown: 0.5 }]);
    expect(layout.gaps[0]).toEqual({
      top: 80,
      height: 1104,
      above: "Fiche technique Halo, révision de mars",
      below: "Documents indexés",
    });
  });

  it("relève un texte peu lisible, sans juger un texte désactivé", async () => {
    document.body.innerHTML = `
      <div id="fond" style="background-color: ${DARK}">
        <span id="pale" style="color: ${DIM}">Indexé</span>
        <span id="net" style="color: ${LIGHT}">Documents</span>
        <span id="eteint" aria-disabled="true" style="color: ${DIM}">Désactivé</span>
      </div>`;
    restore = place({ fond: [0, 0, 400, 100], pale: [0, 0, 60, 20], net: [70, 0, 160, 20], eteint: [170, 0, 260, 20] });
    const measure = measureContrast();
    expect(measure.count).toBe(1);
    expect(measure.items[0].text).toBe("Indexé");
    expect(measure.items[0].ratio).toBeLessThan(3);

    // Chaque thème demandé est mesuré, puis le thème de la page revient.
    document.documentElement.dataset.theme = "light";
    const review = await reviewPage({ themes: ["light", "dark"] });
    expect(review.contrast.map((item) => item.theme)).toEqual(["light", "dark"]);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
