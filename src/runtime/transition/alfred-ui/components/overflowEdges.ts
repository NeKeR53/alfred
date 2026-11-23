import { useEffect, useState } from "react";

/** Côté où une rangée qui défile continue hors de vue. */
export type OverflowEdge = "start" | "end" | "both";

/** Mesure une rangée : `undefined` quand tout son contenu tient dans sa largeur. */
export function overflowEdge({
  scrollLeft,
  scrollWidth,
  clientWidth,
}: Pick<HTMLElement, "scrollLeft" | "scrollWidth" | "clientWidth">): OverflowEdge | undefined {
  // Un pixel de tolérance : les largeurs fractionnaires arrondies laissent parfois un reste.
  const before = scrollLeft > 1;
  const after = scrollLeft + clientWidth < scrollWidth - 1;
  return before && after ? "both" : before ? "start" : after ? "end" : undefined;
}

/**
 * Pose `data-overflow` (`start`, `end` ou `both`) sur une rangée qui défile horizontalement, à chaque défilement et
 * chaque changement de taille de la rangée ou de son contenu : la classe `overflow-fade` en fond le bord qui continue.
 * L’attribut s’écrit directement sur l’élément, sans rendu React. Rend la référence à poser sur la rangée, qui peut
 * apparaître après le premier rendu.
 */
export function useOverflowEdges<T extends HTMLElement>(): (row: T | null) => void {
  const [row, setRow] = useState<T | null>(null);
  useEffect(() => {
    if (!row) return;
    const update = () => {
      const edge = overflowEdge(row);
      if (edge) row.dataset.overflow = edge;
      else delete row.dataset.overflow;
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    const sizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    const observeChildren = () => {
      if (!sizes) return;
      sizes.disconnect();
      sizes.observe(row);
      for (const child of Array.from(row.children)) sizes.observe(child);
    };
    observeChildren();
    // Un onglet ou un filtre qui apparaît change la largeur du contenu sans changer celle de la rangée.
    const content =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            observeChildren();
            update();
          });
    content?.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      row.removeEventListener("scroll", update);
      sizes?.disconnect();
      content?.disconnect();
    };
  }, [row]);
  return setRow;
}
