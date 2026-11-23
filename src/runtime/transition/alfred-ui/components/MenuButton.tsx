import { ChevronDown } from "lucide-react";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { AnchoredMenu } from "./AnchoredMenu";
import { Button, type ButtonVariant } from "./Button";

/**
 * Bouton texte qui ouvre un menu ancré (« Exporter ▾ », « Nouveau ▾ »). Le menu se place seul contre le bouton,
 * s’ouvre au clic ou avec les flèches, se ferme sur Échap, Tab, un clic à côté ou après l’action d’une entrée, et
 * rend alors le focus au bouton. Pour des actions secondaires en icône seule, `OverflowMenu`.
 */
export function MenuButton({
  label,
  menuLabel,
  variant = "secondary",
  disabled,
  placement = "below",
  align = "start",
  children,
}: {
  /** Texte visible du bouton. */
  label: string;
  /** Nom du menu s’il diffère du bouton, par exemple « Formats d’export ». */
  menuLabel?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  placement?: "below" | "above";
  align?: "start" | "end";
  /** Entrées `MenuItem`, éventuellement groupées par `MenuGroup`. */
  children: ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const close = useCallback((restoreFocus: boolean) => {
    setAnchor(undefined);
    if (restoreFocus) button.current?.focus();
  }, []);

  return (
    <span className="menu-button" data-menu-anchor={id}>
      <Button
        ref={button}
        variant={variant}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(anchor ? undefined : event.currentTarget)}
        onKeyDown={(event) => {
          if (!anchor && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setAnchor(event.currentTarget);
          }
        }}
      >
        {label}
        <ChevronDown className="menu-button__chevron" size={16} aria-hidden="true" />
      </Button>
      {anchor ? (
        <AnchoredMenu
          id={id}
          anchor={anchor}
          label={menuLabel ?? label}
          placement={placement}
          align={align}
          onClose={close}
        >
          {children}
        </AnchoredMenu>
      ) : null}
    </span>
  );
}
