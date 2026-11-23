import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";

/**
 * Liste d’entrées d’un menu (rôle `menu`) : focus sur la première entrée à l’ouverture, flèches, Origine et Fin.
 * Elle ne se positionne pas seule : une page passe par `MenuButton` ou `OverflowMenu`, qui l’ancrent à leur bouton.
 */
export function Menu({
  label,
  title,
  style,
  className,
  children,
}: {
  label: string;
  title?: string;
  /** Position calculée par le bouton qui ouvre le menu (réservé à la bibliothèque). */
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Un menu ancré reste invisible jusqu’au calcul de sa position, et un navigateur refuse le focus à un élément
  // invisible : la première entrée le prend dès que le menu s’affiche, une seule fois.
  const positioning = style?.visibility === "hidden";
  const focused = useRef(false);
  useEffect(() => {
    if (positioning || focused.current) return;
    focused.current = true;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [positioning]);
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (!items.length) return;
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    event.preventDefault();
    items[nextIndex].focus();
  };
  return (
    <div
      ref={menuRef}
      className={`ui-menu${className ? ` ${className}` : ""}`}
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={moveFocus}
    >
      {title ? (
        <div className="ui-menu__title" title={title}>
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Groupe titré d’entrées, séparé du précédent par un filet. */
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: dans un menu, le groupe d’entrées est un `group` ARIA ; un `fieldset` y introduirait un groupe de formulaire.
    <div className="ui-menu__group" role="group" aria-label={label}>
      <span aria-hidden="true">{label}</span>
      {children}
    </div>
  );
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `danger` : suppression, révocation ; le libellé reste explicite. */
  tone?: "default" | "danger";
}

/** Entrée de menu : un bouton natif (`onClick`, `disabled`). Une icône Lucide placée en tête est affichée à 16 px. */
export function MenuItem({ children, type = "button", tone = "default", className, ...props }: MenuItemProps) {
  const classes = [tone === "danger" ? "ui-menu__item--danger" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button {...props} type={type} role="menuitem" className={classes || undefined}>
      {children}
    </button>
  );
}
