/**
 * Pastille « Exemple » de la barre du haut d’une page en mode « données d’exemple » : compacte, à côté des autres
 * outils de la page, elle rappelle le mode sans prendre de place à la page et ouvre un petit menu pour le quitter.
 * Hors de ce mode, elle ne montre rien.
 */
import { MenuItem } from "@alfred/ui";
import { FlaskConical } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import { AnchoredMenu } from "../ui/components/AnchoredMenu";
import { setExampleMode, useExampleMode } from "./examples";
import { notify } from "./notifications";

export const EXAMPLE_HINT = "Cette page affiche des données d’exemple";

export function ExampleIndicator({ module }: { module: string }) {
  const examples = useExampleMode(module);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const close = useCallback((restoreFocus: boolean) => {
    setAnchor(undefined);
    if (restoreFocus) button.current?.focus();
  }, []);
  if (!examples) return null;
  return (
    <span className="example-indicator" data-menu-anchor={id}>
      <button
        ref={button}
        type="button"
        className="example-indicator__pill"
        title={EXAMPLE_HINT}
        aria-label={`Exemple : ${EXAMPLE_HINT.toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(anchor ? undefined : event.currentTarget)}
      >
        <FlaskConical size={14} aria-hidden="true" />
        Exemple
      </button>
      {anchor ? (
        <AnchoredMenu id={id} anchor={anchor} label="Données d’exemple" placement="below" align="end" onClose={close}>
          <MenuItem
            onClick={() =>
              void setExampleMode(module, false).catch((error: unknown) =>
                notify({
                  title: "Les données d’exemple n’ont pas pu être quittées",
                  description: error instanceof Error ? error.message : String(error),
                  tone: "error",
                }),
              )
            }
          >
            Quitter les données d’exemple
          </MenuItem>
        </AnchoredMenu>
      ) : null}
    </span>
  );
}
