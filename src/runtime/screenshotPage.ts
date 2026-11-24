/**
 * Capture en image d’un document rendu, pour un agent qui voit les images (outil `page_screenshot`). Le cadre a une
 * origine opaque et aucun accès réseau : il se dessine lui-même. Le document est copié avec ses styles calculés
 * écrits sur chaque élément, placé dans un SVG (`foreignObject`), puis peint sur un canevas exporté en PNG.
 *
 * Ce que le dessin ne reproduit pas : les images chargées depuis une autre origine (remplacées par un cadre vide),
 * les vidéos, et les polices non installées sur le système (Alfred n’en charge aucune).
 */

export interface PageScreenshot {
  /** PNG encodé en base64, sans préfixe `data:`. */
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
  /** Hauteur coupée : la page dépasse la hauteur maximale capturée. */
  clipped: boolean;
}

export interface ScreenshotOptions {
  /** Toute la hauteur du document, et non la seule partie visible. */
  fullPage?: boolean;
}

const MAX_HEIGHT = 6000;
const SKIPPED = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE", "LINK", "META", "STYLE"]);
const XHTML = "http://www.w3.org/1999/xhtml";

/** Styles d’agent utilisateur d’une balise : ce que l’élément copié aurait sans aucune règle de la page. */
const baselines = new Map<string, CSSStyleDeclaration>();
let probeHost: HTMLElement | null = null;

function baseline(element: Element): CSSStyleDeclaration {
  const key = `${element.namespaceURI}|${element.localName}`;
  const known = baselines.get(key);
  if (known) return known;
  if (!probeHost) {
    probeHost = document.createElement("div");
    probeHost.setAttribute("aria-hidden", "true");
    probeHost.style.cssText = "all: revert; position: absolute; left: -99999px; top: 0; visibility: hidden;";
    document.documentElement.appendChild(probeHost);
  }
  const probe = document.createElementNS(element.namespaceURI ?? XHTML, element.localName) as HTMLElement;
  probe.setAttribute("style", "all: revert");
  probeHost.appendChild(probe);
  // Une copie figée : la sonde est retirée aussitôt.
  const computed = getComputedStyle(probe);
  const frozen = document.createElement("div").style;
  for (let index = 0; index < computed.length; index += 1) {
    const name = computed[index];
    frozen.setProperty(name, computed.getPropertyValue(name));
  }
  probe.remove();
  baselines.set(key, frozen);
  return frozen;
}

/**
 * Propriétés à écrire sur la copie : celles qui diffèrent de la sonde ou du parent. Une propriété égale aux deux est
 * retrouvée par la copie, qu’elle vienne d’une règle par défaut ou de l’héritage.
 */
function styleText(element: Element, parent: CSSStyleDeclaration | null, pseudo?: string): string {
  const computed = getComputedStyle(element, pseudo);
  const reference = baseline(element);
  const parts: string[] = [];
  for (let index = 0; index < computed.length; index += 1) {
    const name = computed[index];
    const value = computed.getPropertyValue(name);
    if (!value) continue;
    // Sans parent (racine de la copie, pseudo-élément), tout est écrit : la sonde hérite des styles du document.
    if (!parent || value !== reference.getPropertyValue(name) || value !== parent.getPropertyValue(name)) {
      parts.push(`${name}:${value}`);
    }
  }
  for (const name of linkedWidths((property) => computed.getPropertyValue(property))) {
    if (!parts.some((part) => part.startsWith(`${name}:`))) parts.push(`${name}:${computed.getPropertyValue(name)}`);
  }
  return parts.join(";");
}

/**
 * Épaisseurs à toujours écrire. Celle d’une bordure, d’un contour ou d’un filet de colonnes se calcule à 0 quand son
 * style est `none` : la sonde du navigateur donne donc 0 px, comme la plupart des éléments, et la copie ne l’écrivait
 * pas. Mais une feuille qui pose `border: 0 solid` partout (Tailwind 4, dont socle-ui) laisse un style `solid` : dans
 * la copie, sans cette feuille, l’épaisseur revenait à `medium` (3 px), et chaque élément de la capture avait un cadre
 * noir épais.
 */
export function linkedWidths(get: (property: string) => string): string[] {
  const names: string[] = [];
  for (const side of ["top", "right", "bottom", "left"]) {
    if (get(`border-${side}-style`) && get(`border-${side}-style`) !== "none") names.push(`border-${side}-width`);
  }
  if (get("outline-style") && get("outline-style") !== "none") names.push("outline-width");
  if (get("column-rule-style") && get("column-rule-style") !== "none") names.push("column-rule-width");
  return names;
}

function hasPseudo(element: Element, pseudo: "::before" | "::after"): boolean {
  const content = getComputedStyle(element, pseudo).content;
  return content !== "" && content !== "none" && content !== "normal";
}

/** Image d’un élément `img` ou `canvas` en adresse `data:`, si le navigateur la laisse lire. */
function pixels(source: HTMLImageElement | HTMLCanvasElement): string | null {
  try {
    if (source instanceof HTMLCanvasElement) return source.toDataURL("image/png");
    if (source.currentSrc.startsWith("data:")) return source.currentSrc;
    if (!source.complete || source.naturalWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = source.naturalWidth;
    canvas.height = source.naturalHeight;
    canvas.getContext("2d")?.drawImage(source, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

interface CloneState {
  pseudoRules: string[];
  sequence: number;
}

function cloneTree(node: Node, parent: CSSStyleDeclaration | null, state: CloneState): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  if (SKIPPED.has(element.tagName.toUpperCase()) || element === probeHost) return null;
  const computed = getComputedStyle(element);
  if (computed.display === "none") return null;

  let copy: Element;
  if (element instanceof HTMLCanvasElement || element instanceof HTMLImageElement) {
    copy = document.createElement("img");
    const source = pixels(element);
    if (source) copy.setAttribute("src", source);
  } else if (element instanceof HTMLIFrameElement || element instanceof HTMLVideoElement) {
    copy = document.createElement("div");
  } else {
    copy = element.cloneNode(false) as Element;
    copy.removeAttribute("id");
    for (const attribute of [...copy.attributes]) {
      if (attribute.name.startsWith("on") || attribute.name === "srcset") copy.removeAttribute(attribute.name);
    }
  }
  copy.setAttribute("style", styleText(element, parent));

  // Valeurs saisies : elles vivent dans les propriétés, pas dans les attributs que la copie emporte.
  if (element instanceof HTMLInputElement) {
    copy.setAttribute("value", element.value);
    if (element.checked) copy.setAttribute("checked", "");
    else copy.removeAttribute("checked");
  } else if (element instanceof HTMLTextAreaElement) {
    copy.textContent = element.value;
  } else if (element instanceof HTMLOptionElement) {
    if (element.selected) copy.setAttribute("selected", "");
    else copy.removeAttribute("selected");
  }

  for (const pseudo of ["::before", "::after"] as const) {
    if (!hasPseudo(element, pseudo)) continue;
    state.sequence += 1;
    const name = `alfred-shot-${state.sequence}`;
    copy.classList.add(name);
    state.pseudoRules.push(`.${name}${pseudo}{${styleText(element, null, pseudo)}}`);
  }

  if (!(element instanceof HTMLTextAreaElement) && !(copy instanceof HTMLImageElement)) {
    // Une racine fantôme (le corps d’un courriel dans `HtmlContent`) se dessine à la place des enfants de son hôte.
    for (const child of (element.shadowRoot ?? element).childNodes) {
      const cloned = cloneTree(child, computed, state);
      if (!cloned) continue;
      // Un conteneur défilé garde sa position : ses enfants sont décalés d’autant.
      if (cloned instanceof Element && (element.scrollTop || element.scrollLeft)) {
        const style = cloned.getAttribute("style") ?? "";
        cloned.setAttribute("style", `${style};translate:${-element.scrollLeft}px ${-element.scrollTop}px`);
      }
      copy.appendChild(cloned);
    }
  }
  return copy;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Le navigateur n’a pas pu dessiner la page."));
    image.src = source;
  });
}

/** Dessine le document du cadre et renvoie un PNG : la partie visible, ou toute la hauteur avec `fullPage`. */
export async function screenshotPage(options: ScreenshotOptions = {}): Promise<PageScreenshot> {
  await document.fonts?.ready;
  const root = document.documentElement;
  const width = Math.max(1, Math.round(window.innerWidth));
  const fullHeight = Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0);
  const wanted = options.fullPage ? fullHeight : window.innerHeight;
  const height = Math.max(1, Math.min(Math.round(wanted), MAX_HEIGHT));
  const offsetY = options.fullPage ? 0 : window.scrollY;

  const state: CloneState = { pseudoRules: [], sequence: 0 };
  const body = document.body ? cloneTree(document.body, getComputedStyle(root), state) : null;
  const page = document.createElementNS(XHTML, "div");
  page.setAttribute(
    "style",
    `${styleText(root, null)};width:${width}px;height:${options.fullPage ? height : fullHeight}px;overflow:hidden;` +
      `translate:${-window.scrollX}px ${-offsetY}px`,
  );
  if (body) page.appendChild(body);
  if (state.pseudoRules.length > 0) {
    const style = document.createElementNS(XHTML, "style");
    style.textContent = state.pseudoRules.join("\n");
    page.insertBefore(style, page.firstChild);
  }
  const markup = new XMLSerializer().serializeToString(page);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canevas indisponible : capture impossible.");
  const background = getComputedStyle(document.body ?? root).backgroundColor;
  // biome-ignore lint/plugin: valeurs calculées par le navigateur (fond transparent) et repli blanc du canevas, pas un style de page.
  const transparent = "rgba(0, 0, 0, 0)";
  // biome-ignore lint/plugin: repli blanc du canevas quand la page n’a aucun fond calculé.
  const white = "#fff";
  context.fillStyle =
    background && background !== transparent ? background : getComputedStyle(root).backgroundColor || white;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0);
  const url = canvas.toDataURL("image/png");
  return {
    data: url.slice(url.indexOf(",") + 1),
    mimeType: "image/png",
    width,
    height,
    clipped: options.fullPage === true && fullHeight > MAX_HEIGHT,
  };
}
