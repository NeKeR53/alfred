import type { ReactNode } from "react";

/**
 * Partie de la fiche d’un module (Réglages → Modules) : un titre, une phrase qui dit à quoi elle sert, des actions
 * éventuelles à droite, puis son contenu. Pages, fonctions, services, webhooks, planifications et tâches de fond d’un
 * module s’affichent tous ainsi, l’un sous l’autre.
 */
export function ModulePart({
  title,
  description,
  actions,
  part,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Nom stable de la partie (`data-part`), pour les tests et la capture. */
  part: string;
  children: ReactNode;
}) {
  return (
    <div className="module-part" data-part={part}>
      <div className={`module-part__head${actions ? " module-part__head--actions" : ""}`}>
        {actions ? (
          <>
            <div>
              <h3>{title}</h3>
              {description ? <p>{description}</p> : null}
            </div>
            {actions}
          </>
        ) : (
          <>
            <h3>{title}</h3>
            {description ? <p>{description}</p> : null}
          </>
        )}
      </div>
      {children}
    </div>
  );
}
