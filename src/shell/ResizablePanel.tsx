import { IconButton } from "@alfred/ui";
import { Maximize2, Minimize2, X } from "lucide-react";
import { createContext, type PointerEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/native";

/** Agrandissement du panneau qui contient l’en-tête : le panneau prend alors toute la largeur de la page. */
const PanelSize = createContext<{ maximized: boolean; toggle: () => void } | null>(null);

/**
 * En-tête d’un panneau de droite, comme la barre du haut de la page et aligné sur elle (44 px) : à gauche, ce que montre
 * le panneau ; à droite, ses actions, puis Agrandir (dans un panneau redimensionnable) et Fermer.
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
          <IconButton label={size.maximized ? "Réduire le panneau" : "Agrandir le panneau"} onClick={size.toggle}>
            {size.maximized ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
          </IconButton>
        ) : null}
        <IconButton label={closeLabel} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  );
}

const MIN = 280;
const MAX = 900;

/**
 * Panneau de droite d’une page : posé à côté du contenu, sur toute la hauteur de la fenêtre, redimensionnable à la
 * souris et au clavier, et agrandi à toute la largeur de la page depuis son en-tête. Avec `title` et `onClose`, il
 * porte lui-même son en-tête ; sinon son contenu pose un `PanelBar`.
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
  const [width, setWidth] = useState(380);
  const [maximized, setMaximized] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    void invoke<number | null>("settings.get", { key: storageKey }).then((stored) => {
      if (typeof stored === "number") setWidth(Math.min(MAX, Math.max(MIN, stored)));
    });
  }, [storageKey]);

  const commit = (next: number) => {
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(next)));
    setWidth(clamped);
    return clamped;
  };
  const save = (value: number) => void invoke("settings.set", { key: storageKey, value });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) commit(drag.current.startWidth + drag.current.startX - event.clientX);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    save(commit(drag.current.startWidth + drag.current.startX - event.clientX));
    drag.current = null;
  };

  return (
    <aside
      className={`shell-panel${maximized ? " is-maximized" : ""}`}
      style={maximized ? undefined : { width }}
      aria-label={label}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: séparateur interactif, sans équivalent HTML natif. */}
      <div
        className="shell-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Largeur du panneau"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") save(commit(width + 24));
          else if (event.key === "ArrowRight") save(commit(width - 24));
        }}
      />
      {/* Pendant le glissement, le cadre ne doit pas capter le pointeur. */}
      <div className="shell-panel__content">
        <PanelSize.Provider value={{ maximized, toggle: () => setMaximized((current) => !current) }}>
          {title && onClose ? <PanelBar title={title} onClose={onClose} /> : null}
          {children}
        </PanelSize.Provider>
      </div>
    </aside>
  );
}
