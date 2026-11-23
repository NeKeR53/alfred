import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Placement = "below" | "right";

/** Clic à côté ou Échap refusés : un court rebond plutôt qu’une fermeture. */
function refuse(element: HTMLElement | null) {
  if (!element) return;
  element.classList.remove("anchored-panel--refused");
  void element.offsetWidth;
  element.classList.add("anchored-panel--refused");
}

/**
 * Volet flottant ouvert depuis un bouton, sans voile : la page reste visible et utilisable autour. Il se place
 * contre son bouton (dessous, ou à droite pour la navigation), se replie dans la fenêtre si la place manque, et suit
 * la même règle de fermeture que les modales : Échap, un clic à côté, sauf si une saisie a commencé ou si
 * `canClose` le refuse (opération en cours) ; il rebondit alors. Le focus revient au bouton à la fermeture.
 */
export function AnchoredPanel({
  anchor,
  label,
  placement = "below",
  width = 440,
  className,
  canClose,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  placement?: Placement;
  width?: number;
  className?: string;
  /** Faux pendant une opération en cours : ni Échap ni le clic à côté ne ferment le volet. */
  canClose?: () => boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const edited = useRef(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  const close = useCallback(() => {
    onClose();
    if (anchor.isConnected) anchor.focus();
  }, [anchor, onClose]);
  const closeLatest = useRef(close);
  closeLatest.current = close;
  const canCloseLatest = useRef(canClose);
  canCloseLatest.current = canClose;

  // Placé contre le bouton, puis replié dans la fenêtre ; recalculé si la fenêtre change ou si le contenu grandit.
  useLayoutEffect(() => {
    const place = () => {
      const element = panel.current;
      if (!element) return;
      const rect = anchor.getBoundingClientRect();
      const height = element.offsetHeight;
      const panelWidth = Math.min(width, window.innerWidth - 16);
      let top: number;
      let left: number;
      if (placement === "right") {
        left = rect.right + 8;
        top = rect.top - 6;
      } else {
        // Aligné sur le bord droit du bouton ; au-dessus si la place manque dessous.
        left = rect.right - panelWidth;
        top = rect.bottom + 6;
        if (top + height > window.innerHeight - 8 && rect.top - 6 - height >= 8) top = rect.top - 6 - height;
      }
      left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
      setPosition((current) => (current && current.top === top && current.left === left ? current : { top, left }));
    };
    place();
    // Absent de certains environnements (tests) : le placement initial et le redimensionnement suffisent.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, placement, width]);

  useEffect(() => {
    const element = panel.current;
    // Premier champ de saisie, une fois le contenu monté (zone de saisie riche comprise).
    const frame = requestAnimationFrame(() => {
      if (element?.contains(document.activeElement)) return;
      element
        ?.querySelector<HTMLElement>(
          "[role='textbox'], textarea, [contenteditable]:not([contenteditable='false']), input:not([type='hidden'])",
        )
        ?.focus();
    });
    // Une modale ouverte depuis le volet (confirmation, aperçu) garde la main.
    const modalOpen = () => Boolean(document.querySelector("dialog[open]"));
    const attempt = () => {
      if (edited.current || canCloseLatest.current?.() === false) refuse(panel.current);
      else closeLatest.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || event.button !== 0 || modalOpen()) return;
      if (panel.current?.contains(target) || anchor.contains(target)) return;
      // Menus, listes et infobulles rendus ailleurs appartiennent au volet.
      if (target.closest('[role="menu"], [role="listbox"], [role="tooltip"], [popover]')) return;
      attempt();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || modalOpen()) return;
      event.preventDefault();
      // Échap ferme même après une saisie : c’est un geste délibéré, comme pour les modales.
      if (canCloseLatest.current?.() === false) refuse(panel.current);
      else closeLatest.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={["anchored-panel", className ?? ""].filter(Boolean).join(" ")}
      style={
        position
          ? { top: position.top, left: position.left, width: `min(${width}px, calc(100vw - 16px))` }
          : { visibility: "hidden", width: `min(${width}px, calc(100vw - 16px))` }
      }
      onInputCapture={() => {
        edited.current = true;
      }}
      onChangeCapture={() => {
        edited.current = true;
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.classList.remove("anchored-panel--refused");
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
