/**
 * Capture de toute la fenêtre d’Alfred, pour « Corriger un élément » : la coquille (barre de gauche, en-tête, panneau
 * de droite) se dessine elle-même comme le fait une page, puis l’image de chaque cadre de page affiché est posée à
 * sa place. Un cadre qui ne répond pas reste vide plutôt que de faire échouer la capture.
 */
import { screenshotPage as drawDocument } from "../runtime/screenshotPage";
import { inspectFrameElement, type PageRegion, screenshotFrameElement } from "./pageSnapshot";

export interface AppScreenshot {
  /** PNG en base64, de `width × scale` sur `height × scale` pixels. */
  data: string;
  /** Taille de la fenêtre en pixels CSS : les coordonnées d’un cadre tracé sur la capture s’y rapportent. */
  width: number;
  height: number;
  /** Pixels de l’image par pixel CSS : la densité de l’écran (2 sur un Retina), 2 au plus. */
  scale: number;
}

export interface AppRegion extends PageRegion {
  /** Page sous le cadre tracé, ou `null` quand il porte sur l’interface d’Alfred elle-même. */
  page: string | null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Capture illisible."));
    image.src = source;
  });
}

/** Cadres de page visibles dans la fenêtre, avec leur place. */
function visibleFrames(): { frame: HTMLIFrameElement; box: DOMRect }[] {
  return [...document.querySelectorAll<HTMLIFrameElement>("iframe.page-frame")]
    .map((frame) => ({ frame, box: frame.getBoundingClientRect() }))
    .filter(({ box }) => box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth)
    .filter(({ box }) => box.top < innerHeight);
}

/** Image de toute la fenêtre, en pixels CSS : la coquille, et chaque page affichée à sa place. */
export async function screenshotApp(): Promise<AppScreenshot> {
  const frames = visibleFrames();
  // À la densité de l’écran : une capture à 1 pixel par pixel CSS est floue sur un Retina.
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  // L’infobulle du bouton qui lance la capture n’a rien à faire sur l’image.
  const hide = document.createElement("style");
  hide.textContent = '[role="tooltip"] { display: none !important; }';
  document.head.appendChild(hide);
  let shell: Awaited<ReturnType<typeof drawDocument>>;
  let pages: (Awaited<ReturnType<typeof screenshotFrameElement>> | null)[];
  try {
    [shell, ...pages] = await Promise.all([
      drawDocument({ scale }),
      ...frames.map(({ frame }) => screenshotFrameElement(frame, undefined, scale).catch(() => null)),
    ]);
  } finally {
    hide.remove();
  }
  const canvas = document.createElement("canvas");
  canvas.width = shell.width;
  canvas.height = shell.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canevas indisponible : capture impossible.");
  context.drawImage(await loadImage(`data:image/png;base64,${shell.data}`), 0, 0);
  for (const [index, shot] of pages.entries()) {
    if (!shot) continue;
    const { box } = frames[index];
    const image = await loadImage(`data:image/png;base64,${shot.data}`).catch(() => null);
    if (image) context.drawImage(image, box.left * scale, box.top * scale, box.width * scale, box.height * scale);
  }
  const url = canvas.toDataURL("image/png");
  return {
    data: url.slice(url.indexOf(",") + 1),
    width: Math.round(canvas.width / scale),
    height: Math.round(canvas.height / scale),
    scale,
  };
}

/** Nom lisible d’un élément de la coquille : son rôle ou sa balise, et son libellé. */
function describe(element: Element): string {
  const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
  const label = element.getAttribute("aria-label") ?? element.getAttribute("title");
  const classes = [...element.classList].slice(0, 2).join(".");
  return [role, classes ? `.${classes}` : "", label ? ` « ${label} »` : ""].join("");
}

/**
 * Décrit ce que l’utilisateur a encadré (coordonnées de la fenêtre) : dans une page, c’est elle qui le décrit ; sur
 * l’interface d’Alfred, le plus petit élément qui contient tout le cadre et son texte. `ignore` est le calque de
 * sélection, posé par-dessus.
 */
export async function inspectApp(rect: Rect, ignore?: Element | null): Promise<AppRegion> {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const inside = visibleFrames().find(
    ({ box }) => center.x >= box.left && center.x <= box.right && center.y >= box.top && center.y <= box.bottom,
  );
  if (inside) {
    const { box, frame } = inside;
    const region = await inspectFrameElement(frame, {
      x: Math.max(0, rect.x - box.left),
      y: Math.max(0, rect.y - box.top),
      width: Math.min(rect.width, box.width),
      height: Math.min(rect.height, box.height),
    });
    return { page: region.reference, path: region.path, text: region.text, truncated: region.truncated };
  }
  const under = document
    .elementsFromPoint(center.x, center.y)
    .find((element) => !(ignore && (element === ignore || ignore.contains(element))));
  let element: Element | null = under ?? null;
  while (element?.parentElement) {
    const box = element.getBoundingClientRect();
    if (
      box.left <= rect.x &&
      box.top <= rect.y &&
      box.right >= rect.x + rect.width &&
      box.bottom >= rect.y + rect.height
    )
      break;
    element = element.parentElement;
  }
  const path: string[] = [];
  for (let current = element; current && current !== document.body; current = current.parentElement)
    path.unshift(describe(current));
  // innerText et non textContent : seul ce que l’utilisateur voit, avec ses retours à la ligne.
  // biome-ignore lint/performance/useDomNodeTextContent: le texte visible est voulu.
  const text = (element as HTMLElement | null)?.innerText?.trim() ?? "";
  return { page: null, path: path.slice(-12), text: text.slice(0, 8000), truncated: text.length > 8000 };
}
