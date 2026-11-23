import { RefreshCw } from "lucide-react";
import { IconButton, type IconButtonProps } from "./Button";

export interface RefreshButtonProps extends Omit<IconButtonProps, "label" | "children" | "aria-keyshortcuts"> {
  /** Nom accessible ; « Actualiser » par défaut. */
  label?: string;
  /** Raccourci déjà géré par la surface (ex. `F5`) : annoncé dans l’infobulle et `aria-keyshortcuts`. */
  shortcut?: string;
}

/** Action « Actualiser » : `IconButton` à icône unique, qui annonce son raccourci clavier éventuel. */
export function RefreshButton({ label = "Actualiser", shortcut, tooltip, ...props }: RefreshButtonProps) {
  return (
    <IconButton
      {...props}
      label={label}
      tooltip={tooltip ?? (shortcut ? `${label} · ${shortcut}` : label)}
      aria-keyshortcuts={shortcut}
    >
      <RefreshCw size={16} aria-hidden="true" />
    </IconButton>
  );
}
