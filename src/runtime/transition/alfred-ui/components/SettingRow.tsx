/**
 * Ligne de réglage, le gabarit des Réglages (onglets intégrés comme pages de l’espace placées dans les Réglages) :
 * titre et description à gauche, contrôle à droite, un trait fin entre deux lignes. Le contrôle porte son propre
 * libellé accessible (`aria-label`) : le titre est visuel. Voir DESIGN.md, « Onglet de Réglages ».
 */
import type { ReactNode } from "react";

export function SettingRow({
  title,
  description,
  badge,
  children,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Petite étiquette à côté du titre (« Lecture seule »…). */
  badge?: ReactNode;
  /** Contrôle à droite : interrupteur, liste, champ, bouton. */
  children?: ReactNode;
  /** Identifiant du titre, pour qu’un contrôle s’y rattache par `aria-labelledby`. */
  id?: string;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <div className="setting-row__title" id={id}>
          {title}
          {badge}
        </div>
        {description ? <div className="setting-row__description">{description}</div> : null}
      </div>
      {children ? <div className="setting-row__control">{children}</div> : null}
    </div>
  );
}

/** Groupe de lignes de réglage : la liste reçoit ses traits de séparation. */
export function SettingRows({ children, label }: { children: ReactNode; label?: string }) {
  return label ? (
    // biome-ignore lint/a11y/useSemanticElements: un groupe de réglages, pas un formulaire à légende.
    <div className="setting-rows" role="group" aria-label={label}>
      {children}
    </div>
  ) : (
    <div className="setting-rows">{children}</div>
  );
}
