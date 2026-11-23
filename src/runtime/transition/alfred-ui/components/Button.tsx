import { LoaderCircle } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button as DesktopButton } from "../primitives/button";
import {
  createTooltipInteractionState,
  isTooltipInteractionOpen,
  transitionTooltipInteraction,
} from "./tooltipInteraction";

/**
 * Hiérarchie des boutons texte, qui se voient tous comme des boutons : `primary` plein, l’action attendue de
 * l’endroit, une seule ; `secondary` (par défaut) à contour, toute autre action (« Ajouter un compte », « Annuler ») ;
 * `subtle` discret, sans contour, réservé à un retour (« Tous les modules ») ou à une action d’appoint dans une rangée
 * dense ; `danger` à contour rouge, pour une action destructrice. `outline` est l’ancien nom de `secondary`.
 */
export type ButtonVariant = "primary" | "secondary" | "outline" | "subtle" | "danger";
export type IconButtonAppearance = "default" | "table" | "navigation" | "marker";
export type IconButtonTone = "default" | "primary" | "danger";
/** `compact` est un ancien alias de `default` (28 px), gardé pour les appelants existants : ne plus l’employer. */
export type IconButtonSize = "default" | "small" | "compact";
let dismissVisibleTooltip: (() => void) | undefined;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  interaction?: "press" | "stable";
  loading?: boolean;
  loadingLabel?: ReactNode;
}

export function Button({
  variant = "secondary",
  loading = false,
  loadingLabel,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <DesktopButton
      {...props}
      type={type}
      variant={
        variant === "primary" ? "default" : variant === "danger" ? "danger" : variant === "subtle" ? "ghost" : "outline"
      }
      className={className}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : null}
      {loading && loadingLabel !== undefined ? loadingLabel : children}
    </DesktopButton>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> {
  label: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /** `false` désactive l’infobulle quand le libellé est déjà visible. */
  tooltip?: string | false;
  tooltipPlacement?: "auto" | "right";
  tooltipAppearance?: "default" | "preview";
  appearance?: IconButtonAppearance;
  tone?: IconButtonTone;
  loading?: boolean;
  loadingLabel?: string;
  /** 28 px par défaut ; `small` : 24 px, pour une ligne dense. */
  size?: IconButtonSize;
}

export function IconButton({
  label,
  buttonRef,
  tooltip = label,
  tooltipPlacement = "auto",
  tooltipAppearance = "default",
  appearance = "default",
  tone = "default",
  loading = false,
  loadingLabel,
  size = "default",
  className,
  children,
  disabled,
  type = "button",
  onBlur,
  onFocus,
  onKeyDown,
  onPointerEnter,
  onPointerLeave,
  ...props
}: IconButtonProps) {
  const tooltipId = useId();
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interaction = useRef(createTooltipInteractionState());
  const [tooltipAnchor, setTooltipAnchor] = useState<HTMLButtonElement>();
  const [tooltipPosition, setTooltipPosition] = useState<{
    left: number;
    top: number;
    placement: "bottom" | "top" | "left" | "right";
  }>();
  const baseClass =
    appearance === "table"
      ? "table-icon-action"
      : appearance === "navigation"
        ? "nav-icon"
        : appearance === "marker"
          ? "index-marker"
          : "icon-button";
  const toneClass = tone === "danger" ? "button--danger" : tone === "primary" ? "icon-button--primary" : "";
  const classes = [baseClass, size === "small" ? "icon-button--small" : "", toneClass, className ?? ""]
    .filter(Boolean)
    .join(" ");
  const showTooltip = (button: HTMLButtonElement) => {
    clearTimeout(tooltipTimer.current);
    if (tooltip === false) return;
    tooltipTimer.current = setTimeout(() => {
      if (isTooltipInteractionOpen(interaction.current)) setTooltipAnchor(button);
    }, 300);
  };
  const hideTooltip = useCallback(() => {
    clearTimeout(tooltipTimer.current);
    setTooltipAnchor(undefined);
    setTooltipPosition(undefined);
  }, []);
  useEffect(() => () => clearTimeout(tooltipTimer.current), []);
  // Une infobulle retirée pendant qu’elle est affichée (menu ouvert par ce bouton) se ferme au lieu de rester vide.
  useEffect(() => {
    if (tooltip === false) hideTooltip();
  }, [hideTooltip, tooltip]);
  useLayoutEffect(() => {
    const tooltipElement = tooltipRef.current;
    if (!tooltipAnchor || !tooltipElement) return;
    dismissVisibleTooltip?.();
    dismissVisibleTooltip = hideTooltip;
    // Le popover rejoint la couche native au-dessus des dialogues et de leur voile.
    tooltipElement.showPopover();
    const dialog = tooltipAnchor.closest("dialog");
    dialog?.addEventListener("close", hideTooltip);
    const update = () => {
      const bounds = tooltipAnchor.getBoundingClientRect();
      const tooltipBounds = tooltipElement.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const gap = 8;
      const fitsBottom = bounds.bottom + gap + tooltipBounds.height <= height - gap;
      const fitsTop = bounds.top - gap - tooltipBounds.height >= gap;
      const fitsRight = bounds.right + gap + tooltipBounds.width <= width - gap;
      const fitsLeft = bounds.left - gap - tooltipBounds.width >= gap;
      const placement =
        tooltipPlacement === "right" && fitsRight
          ? "right"
          : fitsBottom
            ? "bottom"
            : fitsTop
              ? "top"
              : fitsRight
                ? "right"
                : fitsLeft
                  ? "left"
                  : bounds.top > height - bounds.bottom
                    ? "top"
                    : "bottom";
      const horizontal = placement === "left" || placement === "right";
      const left =
        placement === "left"
          ? bounds.left - gap - tooltipBounds.width
          : placement === "right"
            ? bounds.right + gap
            : bounds.left + (bounds.width - tooltipBounds.width) / 2;
      const top = horizontal
        ? bounds.top + (bounds.height - tooltipBounds.height) / 2
        : placement === "top"
          ? bounds.top - gap - tooltipBounds.height
          : bounds.bottom + gap;
      const next: NonNullable<typeof tooltipPosition> = {
        placement,
        left: Math.max(gap, Math.min(left, width - tooltipBounds.width - gap)),
        top: Math.max(gap, Math.min(top, height - tooltipBounds.height - gap)),
      };
      setTooltipPosition((current) =>
        current?.left === next.left && current.top === next.top && current.placement === next.placement
          ? current
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tooltipElement);
    observer.observe(tooltipAnchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      if (dismissVisibleTooltip === hideTooltip) dismissVisibleTooltip = undefined;
      dialog?.removeEventListener("close", hideTooltip);
      if (tooltipElement.matches(":popover-open")) tooltipElement.hidePopover();
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [hideTooltip, tooltipAnchor, tooltipPlacement]);

  return (
    <>
      <button
        {...props}
        ref={buttonRef}
        type={type}
        className={classes}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        aria-label={loading ? (loadingLabel ?? label) : label}
        aria-describedby={tooltipAnchor ? tooltipId : undefined}
        onBlur={(event: FocusEvent<HTMLButtonElement>) => {
          interaction.current = transitionTooltipInteraction(interaction.current, { type: "blur" });
          if (!isTooltipInteractionOpen(interaction.current)) hideTooltip();
          onBlur?.(event);
        }}
        onFocus={(event: FocusEvent<HTMLButtonElement>) => {
          interaction.current = transitionTooltipInteraction(interaction.current, {
            type: "focus",
            visible: event.currentTarget.matches(":focus-visible"),
          });
          if (isTooltipInteractionOpen(interaction.current)) showTooltip(event.currentTarget);
          onFocus?.(event);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === "Escape") {
            interaction.current = transitionTooltipInteraction(interaction.current, { type: "escape" });
            dismissVisibleTooltip?.();
            hideTooltip();
          }
          onKeyDown?.(event);
        }}
        onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
          if (event.pointerType !== "touch") {
            interaction.current = transitionTooltipInteraction(interaction.current, { type: "pointer-enter" });
            if (isTooltipInteractionOpen(interaction.current)) showTooltip(event.currentTarget);
          }
          onPointerEnter?.(event);
        }}
        onPointerLeave={(event: PointerEvent<HTMLButtonElement>) => {
          interaction.current = transitionTooltipInteraction(interaction.current, { type: "pointer-leave" });
          if (!isTooltipInteractionOpen(interaction.current)) hideTooltip();
          onPointerLeave?.(event);
        }}
      >
        {loading ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : children}
      </button>
      {tooltipAnchor && tooltip !== false && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              className={`ui-tooltip${tooltipAppearance === "preview" ? " ui-tooltip--preview" : ""}`}
              data-placement={tooltipPosition?.placement}
              id={tooltipId}
              role="tooltip"
              popover="manual"
              style={{
                left: tooltipPosition?.left ?? 0,
                top: tooltipPosition?.top ?? 0,
                visibility: tooltipPosition ? "visible" : "hidden",
              }}
            >
              {tooltip}
            </span>,
            tooltipAnchor.closest("dialog") ?? document.body,
          )
        : null}
    </>
  );
}
