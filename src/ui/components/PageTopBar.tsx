import { PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./Button";
import "./page-top-bar.css";

/** Bascule du panneau de droite d’une page : même icône, même libellé et même état enfoncé partout. */
export function PanelToggleButton({
  hidden,
  onToggle,
  subject,
}: {
  hidden: boolean;
  onToggle: () => void;
  /** Ce que contient le panneau, par exemple « le détail de la tâche ». */
  subject: string;
}) {
  return (
    <IconButton
      className="panel-toggle"
      label={`${hidden ? "Afficher" : "Masquer"} ${subject}`}
      aria-pressed={!hidden}
      onClick={onToggle}
    >
      <PanelRight size={15} aria-hidden="true" />
    </IconButton>
  );
}

/**
 * Barre du haut de la coquille (section, Agent, Réglages) : 44 px sur toute la largeur, titre à gauche,
 * actions calées à droite, bascule du panneau en dernier. Hauteur, marges et typographie du titre sont fixées ici.
 */
export function PageTopBar({
  title,
  context,
  children,
  panelToggle,
  className,
}: {
  /** Une chaîne devient le `h1` de la page ; un nœud est rendu tel quel et porte lui-même son `h1`. */
  title: ReactNode;
  /** Rattachement de l’objet affiché (titre de la conversation…), discret à droite du titre, qui se réduit avant lui. */
  context?: string;
  children?: ReactNode;
  panelToggle?: { hidden: boolean; onToggle: () => void; subject: string };
  /** Classe propre à la page, pour ses seuls éléments internes et l’impression. */
  className?: string;
}) {
  return (
    <header className={`page-topbar${className ? ` ${className}` : ""}`}>
      <div className="page-topbar__title">
        {typeof title === "string" ? <h1>{title}</h1> : title}
        {context ? (
          <span className="page-topbar__context" title={context}>
            {context}
          </span>
        ) : null}
      </div>
      <div className="page-topbar__actions">
        {children}
        {panelToggle ? <PanelToggleButton {...panelToggle} /> : null}
      </div>
    </header>
  );
}
