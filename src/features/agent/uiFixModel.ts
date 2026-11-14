/** Calcul du cadre tracé et du contexte joint par « Corriger un élément » (voir uiFix.tsx). */
import type { ResolvedPage } from "../../lib/types";
import type { PageRegion } from "../../shell/pageSnapshot";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rectangle normalisé entre deux points, borné à l’image. */
export function rectBetween(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: { width: number; height: number },
): Rect {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const x1 = clamp(Math.min(start.x, end.x), bounds.width);
  const y1 = clamp(Math.min(start.y, end.y), bounds.height);
  const x2 = clamp(Math.max(start.x, end.x), bounds.width);
  const y2 = clamp(Math.max(start.y, end.y), bounds.height);
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

/** Bloc de contexte joint au message : où est l’élément, dans quel fichier, et ce qu’il contient. */
export function fixContext(
  page: Pick<ResolvedPage, "reference" | "module" | "id" | "title">,
  shot: { width: number; height: number },
  rect: Rect | null,
  region: PageRegion | null,
  capture: string,
): string {
  // Claude Code et OpenCode ne reçoivent que le chemin de l’image : sans consigne, ils ne l’ouvrent pas.
  const lines = rect
    ? [
        "La demande de l’utilisateur porte sur un élément précis de la page, qu’il a encadré en rouge sur une capture.",
        `Avant toute chose, ouvre et regarde cette capture : ${capture}`,
        "Repère l’élément dans le cadre rouge et dans le code avant de modifier quoi que ce soit ; ne touche pas au reste de la page sans nécessité.",
        "",
        `Page : ${page.reference} (« ${page.title} »), fichier modules/${page.module}/pages/${page.id}.tsx (et les fichiers qu’il importe)`,
        `Cadre : x=${rect.x}, y=${rect.y}, ${rect.width} × ${rect.height} px, sur une vue de ${shot.width} × ${shot.height} px.`,
      ]
    : [
        "La demande de l’utilisateur porte sur la page telle qu’elle est affichée sur la capture jointe.",
        `Avant toute chose, ouvre et regarde cette capture : ${capture}`,
        "",
        `Page : ${page.reference} (« ${page.title} »), fichier modules/${page.module}/pages/${page.id}.tsx (et les fichiers qu’il importe)`,
        `Capture de la partie visible (${shot.width} × ${shot.height} px).`,
      ];
  if (region?.path.length)
    lines.push("", "Conteneur des éléments encadrés, du plus large au plus précis :", ...region.path);
  if (region?.text) {
    lines.push("", "Éléments sous le cadre, tels que l’utilisateur les voit :", region.text);
    if (region.truncated) lines.push("(liste tronquée)");
  }
  lines.push("", "Une fois la correction faite, vérifie le rendu avec page_screenshot.");
  return lines.join("\n");
}
