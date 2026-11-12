import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Menu } from "./Menu";
import { useContextMenuDismiss } from "./useContextMenuDismiss";

export const menuWidth = 252;
const gap = 4;
const margin = 8;

/**
 * Menu ouvert contre son bouton, rendu hors du flux. Il se place dessous (ou dessus si la place manque), aligné sur
 * le bord choisi du bouton et replié dans la fenêtre. Il se ferme sur Échap, Tab, un clic à côté, un défilement, et
 * après l’activation d’une entrée.
 *
 * La fermeture qui suit le choix d’une entrée a lieu pendant la remontée du clic, après le `onClick` de l’entrée :
 * fermer en phase de capture laisserait React démonter le menu avant que l’action ne s’exécute (un vrai clic laisse
 * passer les microtâches entre les deux phases).
 */
export function AnchoredMenu({
  id,
  anchor,
  label,
  placement,
  align,
  onClose,
  children,
}: {
  /** Valeur de `data-menu-anchor` partagée avec le bouton : un clic sur l’un ou l’autre n’est pas « à côté ». */
  id: string;
  anchor: HTMLElement;
  label: string;
  placement: "below" | "above";
  align: "start" | "end";
  /** `restoreFocus` : vrai quand le focus doit revenir au bouton (Échap, choix d’une entrée). */
  onClose: (restoreFocus: boolean) => void;
  children: ReactNode;
}) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const onCloseLatest = useRef(onClose);
  onCloseLatest.current = onClose;
  const [dismiss] = useState(() => () => onCloseLatest.current(false));
  useContextMenuDismiss(true, `[data-menu-anchor="${id}"]`, dismiss);

  useLayoutEffect(() => {
    const menu = wrapper.current?.querySelector<HTMLElement>('[role="menu"]');
    const rect = anchor.getBoundingClientRect();
    const height = menu?.offsetHeight ?? 0;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const below = rect.bottom + gap;
    const above = rect.top - gap - height;
    const fitsBelow = below + height <= viewportHeight - margin;
    const fitsAbove = above >= margin;
    let top =
      placement === "above" ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above;
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    const width = Math.min(menuWidth, viewportWidth - 2 * margin);
    const left = Math.max(
      margin,
      Math.min(align === "start" ? rect.left : rect.right - width, viewportWidth - width - margin),
    );
    setPosition({ top, left });
  }, [anchor, placement, align]);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: les entrées portent le clavier ; ce conteneur ne fait que fermer le menu.
    <span
      ref={wrapper}
      data-menu-anchor={id}
      onClick={(event) => {
        // Remontée : le `onClick` de l’entrée a déjà été appelé.
        if (event.target instanceof Element && event.target.closest('[role="menuitem"]:not(:disabled)')) {
          onCloseLatest.current(true);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCloseLatest.current(true);
        } else if (event.key === "Tab") {
          onCloseLatest.current(false);
        }
      }}
    >
      <Menu
        label={label}
        style={
          position
            ? { top: position.top, left: position.left, width: `min(${menuWidth}px, calc(100vw - 16px))` }
            : { visibility: "hidden", top: 0, left: 0 }
        }
      >
        {children}
      </Menu>
    </span>,
    anchor.closest("dialog") ?? document.body,
  );
}
