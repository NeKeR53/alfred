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
let sheet = "";

beforeAll(() => {
  if (!existsSync(built)) throw new Error("Feuille absente : lancer `pnpm build:runtime` avant ce test.");
  sheet = readFileSync(built, "utf8");
  style = document.createElement("style");
  style.textContent = sheet;
  document.head.append(style);
  document.body.className = "alfred-frame";
  document.body.innerHTML = '<div id="root"><div class="page"></div></div>';
});

afterAll(() => {
  style.remove();
  document.body.className = "";
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

  it("laisse #root défiler et le gabarit de la page prendre la place", () => {
    expect(computed("#root").overflow).toBe("auto");
    expect(computed("#root").display).toBe("flex");
    expect(computed("#root").flexDirection).toBe("column");
    expect(computed(".page").minHeight).toBe("0px");
  });

  it("pose le fond et le texte de socle-ui, qui suivent le thème clair ou sombre", () => {
    expect(sheet).toMatch(/body\.alfred-frame\{[^}]*background:var\(--surface\)/);
    expect(sheet).toMatch(/body\.alfred-frame\{[^}]*color:var\(--fg\)/);
    expect(sheet).toContain("--surface:");
    expect(sheet).toMatch(/\[data-theme=("|)dark\1\]/);
  });

  it("ne garde aucun token de l’ancienne bibliothèque", () => {
    expect(sheet).not.toContain("--color-ink");
    expect(sheet).not.toContain("--color-primary");
    expect(sheet).not.toContain("data-accent");
  });

  it("n’impose pas la hauteur du cadre à la coquille", () => {
    document.body.className = "";
    expect(computed("html").height).not.toBe("100%");
    document.body.className = "alfred-frame";
  });
});
