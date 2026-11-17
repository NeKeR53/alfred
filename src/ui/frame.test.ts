import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * Lit la feuille construite servie aux cadres (`pnpm build:runtime` → src-tauri/runtime/alfred.css), l’applique au
 * squelette du document hôte (src-tauri/src/pages.rs, `host_document`) et vérifie la cascade. jsdom ne calcule pas
 * la mise en page : on contrôle les valeurs déclarées qui la produisent.
 */
const built = resolve(process.cwd(), "src-tauri/runtime/alfred.css");
let style: HTMLStyleElement;

beforeAll(() => {
  if (!existsSync(built)) throw new Error("Feuille absente : lancer `pnpm build:runtime` avant ce test.");
  style = document.createElement("style");
  style.textContent = readFileSync(built, "utf8");
  document.head.append(style);
  document.body.className = "alfred-frame";
  document.body.innerHTML =
    '<div id="root"><div class="al-page"><div class="page-toolbar"></div><div class="al-page__body"></div></div></div>';
});

afterAll(() => {
  style.remove();
  document.body.className = "";
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.theme;
});

const computed = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`${selector} introuvable`);
  return getComputedStyle(element);
};

describe("feuille du cadre de page", () => {
  it("donne au cadre une hauteur de référence : html, body et #root à 100 %", () => {
    expect(computed("html").height).toBe("100%");
    expect(computed("body").height).toBe("100%");
    expect(computed("#root").height).toBe("100%");
    expect(computed("body").overflow).toBe("hidden");
  });

  it("fait défiler le corps de la page, pas la page entière", () => {
    expect(computed(".al-page").height).toBe("100%");
    expect(computed(".al-page").display).toBe("flex");
    expect(computed(".al-page__body").overflow).toBe("auto");
    expect(computed(".al-page__body").minHeight).toBe("0px");
  });

  it("habille l’écran d’erreur de compilation : centré, diagnostic à chasse fixe qui défile", () => {
    document.getElementById("root")!.innerHTML =
      '<div class="alfred-frame__failure"><div class="empty-state"><div class="empty-state__actions"><pre>ligne 3 : erreur</pre></div></div></div>';
    expect(computed(".alfred-frame__failure").justifyContent).toBe("center");
    const pre = computed(".alfred-frame__failure pre");
    expect(pre.fontFamily).toBe("var(--font-mono)");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--font-mono")).toContain("monospace");
    expect(pre.overflow).toBe("auto");
    expect(pre.whiteSpace).toBe("pre-wrap");
  });

  it("laisse #root faire défiler l’écran d’échec : aucun second conteneur défilant de hauteur fixe", () => {
    document.getElementById("root")!.innerHTML =
      '<div class="alfred-frame__failure"><div class="empty-state"><div class="empty-state__actions"><pre>ligne 3 : erreur</pre></div></div></div>';
    const failure = computed(".alfred-frame__failure");
    // WebKit ne peint pas un conteneur défilant de hauteur 100 % imbriqué dans #root, lui-même défilant.
    expect(failure.overflow).toBe("visible");
    expect(failure.height).not.toBe("100%");
    expect(failure.minHeight).toBe("100%");
    expect(computed("#root").overflow).toBe("auto");
  });

  it("n’impose pas la hauteur du cadre à la coquille", () => {
    document.body.className = "";
    expect(computed("html").height).not.toBe("100%");
    document.body.className = "alfred-frame";
  });
});

describe("couleurs d’accent", () => {
  const primary = () => getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim();

  it("redéfinit l’accent pour chaque valeur de data-accent, en clair et en sombre", () => {
    const sheet = readFileSync(built, "utf8");
    for (const accent of ["steel", "blue", "violet", "pink", "red", "orange", "green", "teal"]) {
      expect(sheet).toContain(`[data-accent=${accent}]`);
      expect(sheet).toMatch(new RegExp(`\\[data-theme=dark\\]\\[data-accent=${accent}\\]`));
      expect(sheet).toMatch(new RegExp(`:not\\(\\[data-theme\\]\\)\\[data-accent=${accent}\\]`));
    }
  });

  it("applique l’accent choisi à --color-primary", () => {
    const initial = primary();
    document.documentElement.dataset.accent = "blue";
    const blue = primary();
    expect(blue).not.toBe(initial);
    document.documentElement.dataset.theme = "dark";
    expect(primary()).not.toBe(blue);
    delete document.documentElement.dataset.accent;
    delete document.documentElement.dataset.theme;
    expect(primary()).toBe(initial);
  });
});

describe("surface des Réglages", () => {
  const page = (body: string) => {
    document.getElementById("root")!.innerHTML =
      `<div class="al-page"><div class="al-page__main"><div class="page-toolbar"></div>${body}</div></div>`;
  };

  beforeAll(() => {
    document.documentElement.dataset.surface = "settings";
  });
  afterAll(() => {
    delete document.documentElement.dataset.surface;
  });

  it('donne à une page des Réglages toute la largeur, même avec `width="text"`', () => {
    page(
      '<div class="al-page__body al-page__body--text"><section class="al-section"><div class="al-section__header"><div class="al-section__title"><h2>Lecture</h2></div></div><div class="setting-rows"></div></section><p class="libre">Texte</p></div>',
    );
    expect(computed(".al-page__body").paddingLeft).toBe("0px");
    expect(computed(".al-page__body").paddingRight).toBe("0px");
    expect(computed(".al-section").maxWidth).toBe("none");
    expect(computed(".libre").maxWidth).toBe("none");
    expect(computed(".setting-rows").width).toBe("auto");
  });

  it("reprend les marges et les titres des rubriques intégrées", () => {
    page(
      '<div class="al-page__body"><section class="al-section"><div class="al-section__header"><div class="al-section__title"><h2>Lecture</h2></div></div><div class="setting-rows"></div></section></div>',
    );
    expect(getComputedStyle(document.documentElement).getPropertyValue("--settings-inline").trim()).toBe("24px");
    expect(computed(".al-section__header").getPropertyValue("padding-inline")).toBe("var(--settings-inline)");
    // jsdom ne lit pas un raccourci `margin` qui contient `var()` : la règle est lue dans la feuille.
    expect(readFileSync(built, "utf8")).toContain(
      "[data-surface=settings] .al-page__body>.al-section>:not(.al-section__header,dialog){margin:16px var(--settings-inline) 0}",
    );
    expect(computed(".al-section").getPropertyValue("padding-block")).toBe("20px 12px");
    expect(computed(".al-section h2").fontWeight).toBe("500");
    expect(computed(".page-toolbar").getPropertyValue("padding-inline")).toBe("var(--settings-inline)");
  });
});
