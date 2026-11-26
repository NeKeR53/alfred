/**
 * Examen d’une page pour l’agent (outil `check`) : des mesures prises dans le cadre, sur le document rendu, sans
 * analyse d’image. Une image se lit mal (anticrénelage, ombres, traits fins) ; le document donne la place exacte de
 * chaque texte, de chaque contrôle et de chaque cadre. Ce qui se mesure de façon sûre :
 *
 * - la hauteur du contenu, et les titres, listes, alertes et boutons pleins qui commencent sous la ligne de
 *   flottaison ;
 * - la largeur occupée par le contenu et les bandes vides entre deux blocs ;
 * - les textes coupés (points de suspension, lignes bornées) et ce qui déborde en largeur ;
 * - les boutons pleins visibles ;
 * - le contraste des textes, en clair puis en sombre.
 *
 * Ce qui ne se mesure pas : le contenu d’un `canvas` ou d’une image (un graphique), une couleur venue d’un dégradé.
 * Les textes rapportés viennent de la page : ils sont bornés ici, et présentés à l’agent comme une donnée.
 */

export interface ReviewBlock {
  kind: "heading" | "collection" | "alert" | "action";
  text: string;
  /** Haut du bloc, en pixels depuis le haut du cadre (sans défilement). */
  top: number;
}

export interface ReviewGap {
  top: number;
  height: number;
  /** Dernier texte au-dessus de la bande, premier texte en dessous. */
  above: string;
  below: string;
}

export interface ReviewText {
  text: string;
  /** Part visible du texte, de 0 à 1. */
  shown: number;
}

export interface ReviewOverflow {
  kind: "page" | "table";
  text: string;
  /** Pixels cachés à droite. */
  hidden: number;
}

export interface LayoutMeasure {
  width: number;
  height: number;
  /** Un chargement est encore annoncé (`aria-busy`) : la mesure ne montre pas la page finie. */
  busy: boolean;
  /** Boîte du contenu de la zone qui défile (textes, contrôles, images, cadres, fonds). */
  contentTop: number;
  contentBottom: number;
  contentLeft: number;
  contentRight: number;
  belowFold: ReviewBlock[];
  gaps: ReviewGap[];
  truncated: ReviewText[];
  truncatedCount: number;
  overflow: ReviewOverflow[];
  /** Boutons pleins (fond `--primary`) : texte et haut. */
  filledButtons: { text: string; top: number }[];
}

export interface ReviewContrast {
  text: string;
  ratio: number;
}

export interface ContrastMeasure {
  theme: "light" | "dark";
  items: ReviewContrast[];
  count: number;
}

export interface PageReview {
  layout: LayoutMeasure;
  contrast: ContrastMeasure[];
}

/** Bandes vides rapportées : au-delà de l’écart de 24 px entre deux blocs et des marges d’un état vide. */
export const MIN_GAP = 64;
/** Contraste sous lequel un texte se lit mal (WCAG, gros texte et éléments d’interface). */
export const MIN_CONTRAST = 3;
/** Un bloc dont moins de 24 px dépassent dans le premier écran commence sous la ligne de flottaison. */
const FOLD_MARGIN = 24;
const MAX_ELEMENTS = 6000;
const MAX_INKS = 30_000;
const MAX_LABEL = 80;
const MAX_ITEMS = 8;

const BLOCKS =
  "h1,h2,h3,[role=heading],table,[role=table],[role=grid],[role=list],[role=listbox],[role=tree],ul,ol,[role=alert]";
const BUTTONS = "button,[role=button],a[href],[role=link]";
const TABLES = "table,[role=table],[role=grid]";
/** Un tableau posé dans l’élément, ou dans son seul enfant : l’élément est son enveloppe qui défile. */
const WRAPPED_TABLES =
  ":scope > table, :scope > [role=table], :scope > [role=grid], :scope > * > table, :scope > * > [role=table], :scope > * > [role=grid]";
const GRAPHICS = new Set(["IMG", "CANVAS", "VIDEO", "IFRAME", "INPUT", "TEXTAREA", "SELECT", "PROGRESS", "METER"]);
const SKIPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "LINK", "META"]);

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Ink extends Box {
  /** Texte de la trace, vide pour un contrôle, un cadre ou un fond. */
  label: string;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const UNBOUNDED: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

function bounded(text: string | null | undefined, limit = MAX_LABEL): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function intersect(box: Box, clip: Box): Box | null {
  const result = {
    left: Math.max(box.left, clip.left),
    top: Math.max(box.top, clip.top),
    right: Math.min(box.right, clip.right),
    bottom: Math.min(box.bottom, clip.bottom),
  };
  return result.right - result.left > 0.5 && result.bottom - result.top > 0.5 ? result : null;
}

/**
 * Couleur calculée par le navigateur : `rgb(…)`, `rgba(…)` ou `color(srgb …)`. Une autre écriture (`oklch`, `lab`)
 * rend `null` : le texte n’est alors pas jugé.
 */
export function parseColor(text: string): Rgba | null {
  const value = text.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const legacy = /^rgba?\(([^)]+)\)$/.exec(value);
  if (legacy) {
    const parts = legacy[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  const modern = /^color\(srgb\s+([^)]+)\)$/.exec(value);
  if (modern) {
    const parts = modern[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

/** `top` posé sur `bottom` (opaque) : la couleur vue. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function luminance(color: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Rapport de contraste WCAG de deux couleurs opaques, de 1 à 21. */
export function contrastRatio(first: Rgba, second: Rgba): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Bandes vides entre les traces du contenu : leurs projections verticales, fusionnées, et les écarts d’au moins
 * `minGap` pixels entre deux d’entre elles.
 */
export function emptyBands(inks: Ink[], minGap = MIN_GAP): ReviewGap[] {
  const sorted = inks.filter((ink) => ink.bottom > ink.top).sort((x, y) => x.top - y.top);
  interface Band {
    top: number;
    bottom: number;
    first: string;
    firstTop: number;
    last: string;
    lastBottom: number;
  }
  const bands: Band[] = [];
  for (const ink of sorted) {
    const current = bands[bands.length - 1];
    if (current && ink.top <= current.bottom + 1) {
      current.bottom = Math.max(current.bottom, ink.bottom);
      if (ink.label && ink.top < current.firstTop) {
        current.first = ink.label;
        current.firstTop = ink.top;
      }
      if (ink.label && ink.bottom >= current.lastBottom) {
        current.last = ink.label;
        current.lastBottom = ink.bottom;
      }
      continue;
    }
    bands.push({
      top: ink.top,
      bottom: ink.bottom,
      first: ink.label,
      firstTop: ink.label ? ink.top : Infinity,
      last: ink.label,
      lastBottom: ink.label ? ink.bottom : -Infinity,
    });
  }
  const gaps: ReviewGap[] = [];
  for (let index = 1; index < bands.length; index += 1) {
    const above = bands[index - 1];
    const below = bands[index];
    const height = below.top - above.bottom;
    if (height >= minGap) {
      gaps.push({ top: Math.round(above.bottom), height: Math.round(height), above: above.last, below: below.first });
    }
  }
  return gaps.sort((x, y) => y.height - x.height).slice(0, MAX_ITEMS);
}

function visible(style: CSSStyleDeclaration): boolean {
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
}

function clips(value: string): boolean {
  return value === "hidden" || value === "clip";
}

function scrolls(value: string): boolean {
  return value === "auto" || value === "scroll" || value === "overlay";
}

/** Fond de la page : celui de la racine, sinon du corps. */
function pageBackground(doc: Document): Rgba {
  const view = doc.defaultView;
  for (const element of [doc.body, doc.documentElement]) {
    if (!element || !view) continue;
    const color = parseColor(view.getComputedStyle(element).backgroundColor);
    if (color && color.a > 0.99) return color;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

/** Couleur d’un bouton plein : `--primary`, lu sur une sonde. */
function primaryColor(doc: Document): string | null {
  const view = doc.defaultView;
  if (!view || !doc.body) return null;
  const probe = doc.createElement("div");
  probe.style.setProperty("background-color", "var(--primary)");
  probe.style.setProperty("position", "absolute");
  probe.style.setProperty("visibility", "hidden");
  doc.body.appendChild(probe);
  const value = view.getComputedStyle(probe).backgroundColor;
  probe.remove();
  const color = parseColor(value);
  return color && color.a > 0.99 ? value : null;
}

/**
 * Zone qui défile du gabarit : parmi les grandes zones qui défilent en hauteur (la moitié au moins de la plus grande),
 * la plus intérieure. Le cadre défile lui aussi (`#root`) : il englobe la barre d’outils et le pied du gabarit, qui
 * ne sont pas le contenu. Sans zone qui défile, le corps.
 */
function mainScroller(doc: Document): Element | null {
  const view = doc.defaultView;
  if (!view || !doc.body) return null;
  const candidates: { element: Element; size: number }[] = [];
  let count = 0;
  for (const element of doc.body.querySelectorAll("*")) {
    count += 1;
    if (count > MAX_ELEMENTS) break;
    const style = view.getComputedStyle(element);
    if (!scrolls(style.overflowY) || element.clientHeight < 120) continue;
    candidates.push({ element, size: element.clientWidth * element.clientHeight });
  }
  const largest = Math.max(0, ...candidates.map((candidate) => candidate.size));
  const large = candidates.filter((candidate) => candidate.size >= largest / 2);
  const inner = large.filter(
    (candidate) => !large.some((other) => other !== candidate && candidate.element.contains(other.element)),
  );
  inner.sort((x, y) => y.size - x.size);
  return inner[0]?.element ?? doc.body;
}

function blockKind(element: Element): ReviewBlock["kind"] {
  const role = element.getAttribute("role");
  if (/^H[1-3]$/.test(element.tagName) || role === "heading") return "heading";
  if (role === "alert") return "alert";
  return "collection";
}

/** Nom d’un bloc : son texte (titre, alerte), son nom accessible, ou le titre de sa section. */
function blockLabel(element: Element, kind: ReviewBlock["kind"]): string {
  if (kind !== "collection") return bounded(element.textContent);
  const label = element.getAttribute("aria-label");
  if (label) return bounded(label);
  const heading = element.closest("section")?.querySelector("h1,h2,h3,[role=heading]");
  return bounded(heading?.textContent);
}

function borderInks(box: DOMRect, style: CSSStyleDeclaration): Box[] {
  const sides: Box[] = [];
  const side = (name: "top" | "right" | "bottom" | "left") => {
    const width = Number.parseFloat(style.getPropertyValue(`border-${name}-width`)) || 0;
    const kind = style.getPropertyValue(`border-${name}-style`);
    const color = parseColor(style.getPropertyValue(`border-${name}-color`));
    return width > 0.4 && kind !== "none" && kind !== "hidden" && (color?.a ?? 1) > 0.04 ? width : 0;
  };
  const top = side("top");
  const right = side("right");
  const bottom = side("bottom");
  const left = side("left");
  if (top) sides.push({ left: box.left, top: box.top, right: box.right, bottom: box.top + top });
  if (bottom) sides.push({ left: box.left, top: box.bottom - bottom, right: box.right, bottom: box.bottom });
  if (left) sides.push({ left: box.left, top: box.top, right: box.left + left, bottom: box.bottom });
  if (right) sides.push({ left: box.right - right, top: box.top, right: box.right, bottom: box.bottom });
  return sides;
}

/** Mesure la mise en page du document tel qu’il est rendu, dans la taille du cadre. */
export function measureLayout(doc: Document = document): LayoutMeasure {
  const view = doc.defaultView;
  const width = Math.round(view?.innerWidth ?? 0);
  const height = Math.round(view?.innerHeight ?? 0);
  const empty: LayoutMeasure = {
    width,
    height,
    busy: false,
    contentTop: 0,
    contentBottom: 0,
    contentLeft: 0,
    contentRight: 0,
    belowFold: [],
    gaps: [],
    truncated: [],
    truncatedCount: 0,
    overflow: [],
    filledButtons: [],
  };
  if (!view || !doc.body) return empty;
  const main = mainScroller(doc);
  const background = pageBackground(doc);
  const primary = primaryColor(doc);
  const inks: Ink[] = [];
  const belowFold: ReviewBlock[] = [];
  const truncated: ReviewText[] = [];
  const overflow: ReviewOverflow[] = [];
  const filledButtons: LayoutMeasure["filledButtons"] = [];
  let truncatedCount = 0;
  /** Pixels cachés à droite de la zone de la page (la plus grande valeur relevée). */
  let pageHidden = 0;
  let visited = 0;
  const range = doc.createRange();

  const visit = (element: Element, clip: Box, inMain: boolean) => {
    visited += 1;
    if (visited > MAX_ELEMENTS || SKIPPED.has(element.tagName.toUpperCase())) return;
    const style = view.getComputedStyle(element);
    if (!visible(style)) return;
    const here = inMain || element === main;
    const box = element.getBoundingClientRect();
    const shown = intersect(box, clip);
    const tag = element.tagName.toUpperCase();
    const graphic = GRAPHICS.has(tag) || (tag === "SVG" && element.parentElement?.tagName.toUpperCase() !== "SVG");

    if (shown && here && inks.length < MAX_INKS) {
      const label = graphic ? bounded(element.getAttribute("aria-label") ?? element.getAttribute("alt")) : "";
      const fill = parseColor(style.backgroundColor);
      const filled = fill !== null && fill.a > 0.04 && contrastRatio(composite(fill, background), background) > 1.02;
      const image = Boolean(style.backgroundImage) && style.backgroundImage !== "none";
      if (graphic || filled || image) inks.push({ ...shown, label });
      for (const side of borderInks(box, style)) {
        const part = intersect(side, clip);
        if (part) inks.push({ ...part, label: "" });
      }
    }

    if (shown && element.matches(BLOCKS) && box.width >= 4 && box.height >= 4 && box.top >= height - FOLD_MARGIN) {
      const kind = blockKind(element);
      belowFold.push({ kind, text: blockLabel(element, kind), top: Math.round(box.top) });
    }

    if (shown && element.matches(BUTTONS) && primary && style.backgroundColor === primary) {
      filledButtons.push({
        text: bounded(element.textContent || element.getAttribute("aria-label")),
        top: Math.round(box.top),
      });
      if (box.top >= height - FOLD_MARGIN) {
        belowFold.push({ kind: "action", text: bounded(element.textContent), top: Math.round(box.top) });
      }
    }

    // Texte coupé : points de suspension sur une ligne, ou nombre de lignes borné. Un texte réservé aux lecteurs
    // d’écran (boîte d’un pixel, « Information : » d’une alerte) n’est pas un texte coupé.
    if (shown && box.width >= 4 && box.height >= 4 && element.clientWidth > 0 && (element.textContent ?? "").trim()) {
      const clamp = style.getPropertyValue("-webkit-line-clamp");
      let part = 1;
      if (
        clips(style.overflowX) &&
        (style.textOverflow === "ellipsis" || style.whiteSpace === "nowrap" || style.whiteSpace === "pre") &&
        element.scrollWidth > element.clientWidth + 1
      ) {
        part = element.clientWidth / element.scrollWidth;
      } else if (clamp && clamp !== "none" && element.scrollHeight > element.clientHeight + 1) {
        part = element.clientHeight / element.scrollHeight;
      }
      if (part < 0.97) {
        truncatedCount += 1;
        truncated.push({ text: bounded(element.textContent, 100), shown: Math.round(part * 100) / 100 });
      }
    }

    // Ce qui défile en largeur : l’enveloppe d’un tableau (des colonnes hors de la vue), ou une zone de la page (un
    // bloc trop large). Une barre d’outils ou d’onglets défile par conception.
    const hiddenWidth = element.scrollWidth - element.clientWidth;
    if (shown && hiddenWidth > 1 && (element === main || scrolls(style.overflowX))) {
      const table = element.matches(TABLES) ? element : element.querySelector(WRAPPED_TABLES);
      if (table && element !== main) {
        if (!element.matches("[role=toolbar],[role=tablist]")) {
          overflow.push({ kind: "table", text: blockLabel(table, "collection"), hidden: Math.round(hiddenWidth) });
        }
      } else if (element === main || box.width >= width * 0.9) {
        pageHidden = Math.max(pageHidden, hiddenWidth);
      }
    }

    if (graphic) return;

    if (here && shown) {
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !(node.textContent ?? "").trim() || inks.length >= MAX_INKS) continue;
        range.selectNodeContents(node);
        const rects = typeof range.getClientRects === "function" ? [...range.getClientRects()] : [];
        for (const rect of rects) {
          const part = intersect(rect, clip);
          if (part) inks.push({ ...part, label: bounded(node.textContent) });
        }
      }
    }

    // Une zone qui cache son débordement coupe ses enfants ; une zone qui défile les laisse joignables.
    const next = { ...clip };
    if (clips(style.overflowX)) {
      next.left = Math.max(next.left, box.left);
      next.right = Math.min(next.right, box.right);
    } else if (scrolls(style.overflowX)) {
      next.left = -Infinity;
      next.right = Infinity;
    }
    if (clips(style.overflowY)) {
      next.top = Math.max(next.top, box.top);
      next.bottom = Math.min(next.bottom, box.bottom);
    } else if (scrolls(style.overflowY)) {
      next.top = -Infinity;
      next.bottom = Infinity;
    }
    for (const child of element.shadowRoot?.children ?? element.children) visit(child, next, here);
  };

  visit(doc.body, UNBOUNDED, main === doc.body);
  range.detach?.();

  const scroller = doc.scrollingElement ?? doc.documentElement;
  pageHidden = Math.max(pageHidden, scroller.scrollWidth - scroller.clientWidth);
  if (pageHidden > 1) overflow.unshift({ kind: "page", text: "", hidden: Math.round(pageHidden) });

  const content = inks.map((ink) => ({
    ...ink,
    left: Math.max(0, ink.left),
    right: Math.min(width, ink.right),
  }));
  const box = content.reduce(
    (all, ink) => ({
      left: Math.min(all.left, ink.left),
      top: Math.min(all.top, ink.top),
      right: Math.max(all.right, ink.right),
      bottom: Math.max(all.bottom, ink.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
  const found = content.length > 0;
  return {
    width,
    height,
    busy: doc.body.querySelector('[aria-busy="true"]') !== null,
    contentTop: found ? Math.round(box.top) : 0,
    contentBottom: found ? Math.round(box.bottom) : 0,
    contentLeft: found ? Math.round(box.left) : 0,
    contentRight: found ? Math.round(box.right) : 0,
    belowFold: belowFold.sort((x, y) => x.top - y.top).slice(0, MAX_ITEMS),
    gaps: emptyBands(content),
    truncated: truncated.sort((x, y) => x.shown - y.shown).slice(0, MAX_ITEMS),
    truncatedCount,
    overflow: overflow.slice(0, MAX_ITEMS),
    filledButtons: filledButtons.slice(0, MAX_ITEMS),
  };
}

/** Couleur vue derrière un élément : ses fonds et ceux de ses ancêtres, posés sur le fond de la page. */
function backgroundBehind(element: Element, view: Window, page: Rgba): Rgba | null {
  const layers: Rgba[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = view.getComputedStyle(current);
    // Un dégradé ou une image : la couleur vue ne se calcule pas.
    if (style.backgroundImage && style.backgroundImage !== "none") return null;
    // Sans fond calculé (valeur vide), l’élément est transparent.
    const color = style.backgroundColor ? parseColor(style.backgroundColor) : { r: 0, g: 0, b: 0, a: 0 };
    if (!color) return null;
    if (color.a > 0) layers.push(color);
    if (color.a > 0.99) break;
  }
  let result = page;
  for (const layer of layers.reverse()) result = composite(layer, result);
  return result;
}

/** Atténué par une opacité, désactivé ou caché aux lecteurs d’écran : le contraste ne se juge pas. */
function muted(element: Element, view: Window): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.matches("[disabled],[aria-disabled=true],[aria-hidden=true],[inert]")) return true;
    if (Number(view.getComputedStyle(current).opacity || "1") < 0.99) return true;
  }
  return false;
}

/** Textes dont le contraste avec leur fond est sous `MIN_CONTRAST`, dans le thème affiché. */
export function measureContrast(doc: Document = document): Omit<ContrastMeasure, "theme"> {
  const view = doc.defaultView;
  if (!view || !doc.body) return { items: [], count: 0 };
  const page = pageBackground(doc);
  const items: ReviewContrast[] = [];
  const seen = new Set<Element>();
  let count = 0;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let visited = 0;
  for (let node = walker.nextNode(); node && visited < MAX_INKS; node = walker.nextNode()) {
    visited += 1;
    const element = node.parentElement;
    if (!element || seen.has(element) || !(node.textContent ?? "").trim()) continue;
    seen.add(element);
    const style = view.getComputedStyle(element);
    if (!visible(style) || muted(element, view)) continue;
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const color = parseColor(style.color);
    const behind = backgroundBehind(element, view, page);
    if (!color || !behind) continue;
    const ratio = contrastRatio(composite(color, behind), behind);
    if (ratio < MIN_CONTRAST) {
      count += 1;
      if (items.length < MAX_ITEMS)
        items.push({ text: bounded(node.textContent), ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return { items, count };
}

/** Laisse aux observateurs de la page (thème de Socle) le temps de suivre un changement de thème. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** Examine la page : sa mise en page dans la taille du cadre, puis le contraste dans chaque thème demandé. */
export async function reviewPage(options: { themes?: ("light" | "dark")[] } = {}): Promise<PageReview> {
  const layout = measureLayout();
  const contrast: ContrastMeasure[] = [];
  const root = document.documentElement;
  const original = root.dataset.theme;
  try {
    for (const theme of options.themes ?? []) {
      root.dataset.theme = theme;
      await settle();
      contrast.push({ theme, ...measureContrast() });
    }
  } finally {
    if (original === undefined) delete root.dataset.theme;
    else root.dataset.theme = original;
  }
  return { layout, contrast };
}
