import { useEffect, useRef, useState } from "react";

/**
 * Contenu HTML venu de l’extérieur (le corps d’un courriel), affiché sans risque dans une page :
 * - le HTML est lu dans un document inerte (`DOMParser` : rien ne s’y exécute) puis recopié par liste blanche :
 *   balises de mise en forme, tableaux, images, liens ; aucun script, gestionnaire `on…`, formulaire, cadre, SVG,
 *   `<base>`, `<meta>` ni lien `javascript:` ;
 * - le résultat vit dans une racine fantôme (shadow DOM) : les styles du courriel ne débordent pas sur la page ;
 * - un lien s’ouvre dans le navigateur par `onLink` (une page passe `shell.openExternal`) ;
 * - une image jointe (`cid:…`) ou distante n’est affichée que si `resolveImage` rend son adresse (`data:` ou `blob:`) ;
 *   le cadre bloque de toute façon les images d’une autre origine.
 */
export interface HtmlContentProps {
  html: string;
  /** Lien cliqué (http, https ou mailto). */
  onLink?: (url: string) => void;
  /**
   * Adresse affichable d’une image : `cid:` (pièce jointe en ligne) ou distante. Rendre `null` la laisse masquée.
   * Une image sans résolution est remplacée par un cadre vide de même taille.
   */
  resolveImage?: (source: string) => Promise<string | null> | string | null;
  className?: string;
  /** Nom accessible de la zone, par exemple « Message de Paul ». */
  label?: string;
}

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
]);

/** Balises retirées avec tout leur contenu (le texte d’un script ou d’un formulaire n’a rien à faire à l’écran). */
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "select",
  "textarea",
  "button",
  "input",
  "svg",
  "math",
  "audio",
  "video",
  "canvas",
  "head",
  "title",
  "meta",
  "link",
  "base",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "align",
  "alt",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "color",
  "colspan",
  "dir",
  "face",
  "height",
  "href",
  "lang",
  "rowspan",
  "size",
  "span",
  "src",
  "start",
  "style",
  "summary",
  "title",
  "type",
  "valign",
  "width",
]);

/** Lien ouvrable : web ou courriel ; tout le reste (`javascript:`, `data:`, `file:`…) est retiré. */
export function safeLink(value: string): string | null {
  const url = value.trim();
  return /^(https?:|mailto:)/i.test(url) ? url : null;
}

/** Style en ligne sans chargement ni expression : `url(…)`, `expression(…)`, `@import`, `behavior` sont retirés. */
export function safeStyle(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .filter((rule) => !/url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding|javascript:/i.test(rule))
    .join(";");
}

/** Feuille de style d’un courriel, bornée à la racine fantôme ; mêmes retraits que pour un style en ligne. */
function safeSheet(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/behavior\s*:[^;}]*/gi, "")
    .replace(/-moz-binding\s*:[^;}]*/gi, "");
}

/**
 * Recopie un document inerte par liste blanche. Rend les nœuds à poser dans la racine fantôme et les images à
 * résoudre (leur source d’origine).
 */
export function sanitizeHtml(html: string): { nodes: Node[]; images: { element: HTMLImageElement; source: string }[] } {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const images: { element: HTMLImageElement; source: string }[] = [];

  const copy = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const source = node as Element;
    const tag = source.localName.toLowerCase();
    if (DROPPED_WITH_CONTENT.has(tag)) return null;
    const children = () => [...source.childNodes].map(copy).filter((child): child is Node => child !== null);
    if (!ALLOWED_TAGS.has(tag)) {
      // Balise inconnue (`<o:p>`, `<html>`, `<body>`…) : son contenu reste, pas elle.
      const fragment = document.createDocumentFragment();
      for (const child of children()) fragment.appendChild(child);
      return fragment;
    }
    if (tag === "style") {
      const style = document.createElement("style");
      style.textContent = safeSheet(source.textContent ?? "");
      return style;
    }
    const element = document.createElement(tag);
    for (const { name, value } of [...source.attributes]) {
      const attribute = name.toLowerCase();
      if (!ALLOWED_ATTRIBUTES.has(attribute)) continue;
      if (attribute === "href") {
        const link = tag === "a" ? safeLink(value) : null;
        if (link) element.setAttribute("data-href", link);
        continue;
      }
      if (attribute === "src") continue;
      element.setAttribute(attribute, attribute === "style" ? safeStyle(value) : value);
    }
    if (tag === "img") {
      const image = element as HTMLImageElement;
      const original = source.getAttribute("src")?.trim() ?? "";
      if (/^data:image\/(png|gif|jpe?g|webp|bmp);base64,/i.test(original)) image.src = original;
      else if (original) images.push({ element: image, source: original });
    }
    if (tag === "a") element.setAttribute("tabindex", "0");
    for (const child of children()) element.appendChild(child);
    return element;
  };

  const root = parsed.body ?? parsed.documentElement;
  // Les feuilles de style d’un courriel sont souvent dans <head> : elles viennent aussi, nettoyées.
  const sheets = [...parsed.querySelectorAll("head style")].map((style) => {
    const copyStyle = document.createElement("style");
    copyStyle.textContent = safeSheet(style.textContent ?? "");
    return copyStyle;
  });
  const nodes = [...sheets, ...[...root.childNodes].map(copy).filter((node): node is Node => node !== null)];
  return { nodes, images };
}

/** Styles de base de la racine fantôme : texte lisible, images bornées à la largeur, liens marqués. */
const BASE_STYLE = `
:host { display: block; overflow-wrap: anywhere; color: var(--color-ink, inherit); font: inherit; }
.html-content__body { max-width: 100%; overflow-x: auto; }
img { max-width: 100%; height: auto; }
img[data-hidden-image] { display: inline-block; min-width: 16px; min-height: 16px; background: var(--color-surface-2, rgba(127,127,127,.12)); }
a[data-href] { color: var(--color-primary, #4b6bfb); text-decoration: underline; cursor: pointer; }
table { border-collapse: collapse; max-width: 100%; }
pre { white-space: pre-wrap; }
`;

/** Affiche un HTML venu de l’extérieur (le corps d’un courriel) nettoyé et isolé ; voir `HtmlContentProps`. */
export function HtmlContent({ html, onLink, resolveImage, className, label }: HtmlContentProps) {
  const host = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  const resolveRef = useRef(resolveImage);
  resolveRef.current = resolveImage;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    const { nodes, images } = sanitizeHtml(html);
    const style = document.createElement("style");
    style.textContent = BASE_STYLE;
    const body = document.createElement("div");
    body.className = "html-content__body";
    for (const node of nodes) body.appendChild(node);
    shadow.replaceChildren(style, body);

    let alive = true;
    let missing = images.length;
    setHidden(missing);
    for (const { element: image, source } of images) {
      image.setAttribute("data-hidden-image", "");
      Promise.resolve(resolveRef.current?.(source) ?? null)
        .catch(() => null)
        .then((resolved) => {
          if (!alive || !resolved || !/^(data:image\/|blob:)/i.test(resolved)) return;
          image.src = resolved;
          image.removeAttribute("data-hidden-image");
          missing -= 1;
          setHidden(missing);
        });
    }

    const open = (event: Event) => {
      const link = (event.target as Element | null)?.closest?.("a[data-href]");
      if (!link) return;
      if (event instanceof KeyboardEvent && event.key !== "Enter") return;
      event.preventDefault();
      const url = link.getAttribute("data-href");
      if (url) onLinkRef.current?.(url);
    };
    shadow.addEventListener("click", open);
    shadow.addEventListener("keydown", open);
    return () => {
      alive = false;
      shadow.removeEventListener("click", open);
      shadow.removeEventListener("keydown", open);
    };
  }, [html]);

  return (
    <div className={["html-content", className].filter(Boolean).join(" ")}>
      {hidden > 0 ? (
        <p className="html-content__notice" role="status">
          {hidden === 1 ? "1 image masquée." : `${hidden} images masquées.`}
        </p>
      ) : null}
      <div ref={host} role="document" aria-label={label} />
    </div>
  );
}
