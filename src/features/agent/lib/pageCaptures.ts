import type { Turn, TurnItem } from "../model";

/** Capture d’écran d’une page prise par l’agent avec `page_screenshot`, montrée en vignette dans le tour. */
export interface PageCapture {
  /** Identifiant de l’appel d’outil. */
  id: string;
  /** Chemin du fichier gardé par Alfred (dossier d’échange de la conversation), ou image en ligne. */
  image: string;
  /** Référence de la page capturée. */
  page: string;
  /** Nom de la page, pour la légende. */
  title: string;
  fullPage: boolean;
}

/** Au plus trois vignettes par page dans un tour : les plus récentes, les autres derrière « + N ». */
export const SHOWN_CAPTURES_PER_PAGE = 3;

type Details = { capture?: unknown; page?: unknown; title?: unknown; fullPage?: unknown };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Détails de la capture dans la sortie de la commande, quel que soit le harnais : le texte JSON rendu par
 * `alfred page_screenshot` (chemin du PNG gardé par Alfred dans `capture`), seul ou imbriqué dans la sortie du harnais.
 */
function captureDetails(value: unknown, depth = 0): Details | undefined {
  if (depth > 6) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
    try {
      return captureDetails(JSON.parse(text), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = captureDetails(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const object = record(value);
  if (!object) return undefined;
  if (typeof object.capture === "string" && object.capture.trim()) return object as Details;
  for (const key of ["text", "content", "structuredContent", "result"]) {
    const found = captureDetails(object[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Capture par la CLI (`alfred page_screenshot …`, dans une commande du shell) ou par un ancien outil. */
const isScreenshot = (item: TurnItem): item is Extract<TurnItem, { kind: "activity" }> =>
  item.kind === "activity" &&
  item.status === "completed" &&
  (/page_screenshot\b/.test(item.title) || /\balfred\s+page[_-]screenshot\b/.test(item.detail ?? ""));

/** Captures prises par l’agent dans un tour, dans l’ordre où il les a prises. */
export function pageCaptures(turn: Pick<Turn, "items">): PageCapture[] {
  return turn.items.flatMap((item) => {
    if (!isScreenshot(item)) return [];
    const details = captureDetails(item.content ?? "");
    const image = typeof details?.capture === "string" ? details.capture : item.images?.[0];
    if (!image) return [];
    const page = typeof details?.page === "string" ? details.page : "";
    const title = typeof details?.title === "string" && details.title.trim() ? details.title.trim() : page || "Page";
    return [{ id: item.id, image, page: page || title, title, fullPage: details?.fullPage === true }];
  });
}

/** Captures d’une même page, rangées par la plus récente : `shown` en vignettes, `hidden` derrière « + N ». */
export interface CaptureGroup {
  page: string;
  captures: PageCapture[];
  shown: PageCapture[];
  hidden: PageCapture[];
}

/** Regroupe les captures par page, dans l’ordre de leur dernière prise, pour ne pas encombrer le tour. */
export function captureGroups(captures: readonly PageCapture[]): CaptureGroup[] {
  const byPage = new Map<string, PageCapture[]>();
  for (const capture of captures) {
    // Une capture plus récente de la page la remonte en fin de rangée.
    const list = byPage.get(capture.page) ?? [];
    byPage.delete(capture.page);
    byPage.set(capture.page, [...list, capture]);
  }
  return [...byPage].map(([page, list]) => ({
    page,
    captures: list,
    shown: list.slice(-SHOWN_CAPTURES_PER_PAGE),
    hidden: list.slice(0, -SHOWN_CAPTURES_PER_PAGE),
  }));
}

/** Légende discrète d’une vignette : le nom de la page, et « page entière » le cas échéant. */
export function captureCaption(capture: Pick<PageCapture, "title" | "fullPage">): string {
  return capture.fullPage ? `${capture.title} · page entière` : capture.title;
}
