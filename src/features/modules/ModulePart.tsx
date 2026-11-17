import { Section } from "@alfred/ui";
import type { ReactNode } from "react";

/**
 * Groupe de la fiche d’un module (Réglages → Modules) ou de sa fiche de marketplace : un titre de section, une
 * courte phrase qui dit ce qu’il contient, des actions éventuelles à droite, puis ses éléments. Dans les menus,
 * services, fonctions, webhooks, planifications, tâches de fond et dépendances d’un module s’affichent tous ainsi,
 * l’un sous l’autre, séparés par un trait : le titre se distingue nettement des éléments qu’il range.
 */
export function ModulePart({
  title,
  description,
  actions,
  part,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Nom stable de la partie (`data-part`), pour les tests et la capture. */
  part: string;
  children: ReactNode;
}) {
  return (
    <div className="module-part" data-part={part}>
      <Section title={title} description={description} actions={actions}>
        {children}
      </Section>
    </div>
  );
}
