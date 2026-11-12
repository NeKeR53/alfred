import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { AnchoredMenu } from "./AnchoredMenu";
import { IconButton } from "./Button";

/**
 * Bouton « ⋯ » qui regroupe les actions secondaires d’une barre d’outils. Le menu s’ouvre contre le bouton,
 * se ferme sur Échap, un clic à côté ou le choix d’une entrée (après son action), et rend le focus au bouton.
 */
export function OverflowMenu({
  label,
  disabled,
  placement = "below",
  align = "end",
  icon = <MoreHorizontal size={16} aria-hidden="true" />,
  tooltip = "Plus",
  size,
  children,
}: {
  /** Nom du bouton et du menu, par exemple « Autres actions des tâches ». */
  label: string;
  disabled?: boolean;
  /** « above » pour une barre posée en bas de fenêtre : le menu s’ouvre au-dessus du bouton. */
  placement?: "below" | "above";
  /** Bord du bouton contre lequel le menu s’aligne : « start » pour un bouton en début de ligne. */
  align?: "start" | "end";
  /** Icône du bouton, « ⋯ » par défaut ; « + » pour un menu d’ajout. */
  icon?: ReactNode;
  tooltip?: string;
  /** `small` : bouton de 24 px dans une ligne dense. `compact` est un ancien alias de la taille par défaut. */
  size?: "default" | "small" | "compact";
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
    <span className="overflow-menu" data-menu-anchor={id}>
      <IconButton
        buttonRef={button}
        label={label}
        size={size}
        tooltip={anchor ? false : tooltip}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        disabled={disabled}
        onClick={(event) => setAnchor(anchor ? undefined : event.currentTarget)}
      >
        {icon}
      </IconButton>
      {anchor ? (
        <AnchoredMenu id={id} anchor={anchor} label={label} placement={placement} align={align} onClose={close}>
          {children}
        </AnchoredMenu>
      ) : null}
    </span>
  );
}
