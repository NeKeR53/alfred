import { IconButton } from "@alfred/ui";
import { Maximize2, Minimize2, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { invoke } from "../lib/native";

/** Largeur du panneau qui contient l’en-tête, que son bouton Agrandir fait passer à la suivante. */
const PanelSize = createContext<{ size: PanelWidth; toggle: () => void } | null>(null);

/**
 * En-tête d’un panneau de droite, comme la barre du haut de la page et aligné sur elle (44 px) : à gauche, ce que montre
 * le panneau ; à droite, ses actions, puis Agrandir (qui passe à la largeur suivante) et Fermer.
 */
export function PanelBar({
  title,
  context,
  actions,
  onClose,
  closeLabel = "Fermer le panneau",
}: {
  title: string;
  /** Rattachement du contenu (conversation de la page…), discret à droite du titre. */
  context?: string;
  actions?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
}) {
  const size = useContext(PanelSize);
  return (
    <header className="page-topbar shell-panel__header">
      <div className="page-topbar__title">
        <h2>{title}</h2>
        {context ? (
          <span className="page-topbar__context" title={context}>
            {context}
          </span>
        ) : null}
      </div>
      <div className="page-topbar__actions">
        {actions}
        {size ? (
          <IconButton label={size.size === "wide" ? "Réduire le panneau" : "Agrandir le panneau"} onClick={size.toggle}>
            {size.size === "wide" ? (
              <Minimize2 size={15} aria-hidden="true" />
            ) : (
              <Maximize2 size={15} aria-hidden="true" />
            )}
          </IconButton>
        ) : null}
        <IconButton label={closeLabel} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * Largeurs du panneau, reprises de OneApp (`RightPanel`) : sections (340 px), formulaire (460 px) et large. Agrandir
 * passe de l’une à la suivante, puis revient à la plus étroite.
 */
export const PANEL_SIZES = ["compact", "form", "wide"] as const;
export type PanelWidth = (typeof PANEL_SIZES)[number];

const isPanelWidth = (value: unknown): value is PanelWidth => PANEL_SIZES.includes(value as PanelWidth);

export function nextPanelWidth(size: PanelWidth): PanelWidth {
  return PANEL_SIZES[(PANEL_SIZES.indexOf(size) + 1) % PANEL_SIZES.length];
}

/**
 * Panneau de droite d’une page : posé à côté du contenu, sur toute la hauteur de la fenêtre, en l’une des trois
 * largeurs de OneApp, que le bouton Agrandir de son en-tête fait passer de l’une à l’autre. La largeur choisie est
 * retenue sur le poste (`storageKey`). Avec `title` et `onClose`, il porte lui-même son en-tête ; sinon son contenu
 * pose un `PanelBar`.
 */
export function ResizablePanel({
  children,
  storageKey,
  label,
  title,
  onClose,
}: {
  children: ReactNode;
  storageKey: string;
  label: string;
  title?: string;
  onClose?: () => void;
}) {
  const [size, setSize] = useState<PanelWidth>("compact");

  useEffect(() => {
    void invoke<unknown>("settings.get", { key: storageKey })
      .then((stored) => {
        if (isPanelWidth(stored)) setSize(stored);
      })
      .catch(() => undefined);
  }, [storageKey]);

  const toggle = () => {
    const next = nextPanelWidth(size);
    setSize(next);
    void invoke("settings.set", { key: storageKey, value: next }).catch(() => undefined);
  };

  return (
    <aside className={`shell-panel shell-panel--${size}`} aria-label={label} data-size={size}>
      <div className="shell-panel__content">
        <PanelSize.Provider value={{ size, toggle }}>
          {title && onClose ? <PanelBar title={title} onClose={onClose} /> : null}
          {children}
        </PanelSize.Provider>
      </div>
    </aside>
  );
}
