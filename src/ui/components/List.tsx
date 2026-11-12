import { type ReactNode, useId } from "react";
import "./content.css";

/**
 * Liste simple et dense d’éléments hétérogènes ou courts (fichiers joints, derniers événements, comptes liés).
 * Dès que les éléments partagent des attributs à comparer ou trier, `DataTable`.
 */
export function List({ label, children }: { /** Nom accessible de la liste. */ label?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: `list-style: none` retire le rôle de liste dans WebKit ; il est rétabli explicitement.
    <ul className="ui-list" role="list" aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * Élément de `List` : titre, description facultative, élément de tête (icône, pastille) et de fin (badge, action).
 * Avec `onClick`, le titre et la description forment un bouton qui couvre la ligne ; l’élément de fin reste à part,
 * et peut donc contenir ses propres boutons.
 */
export function ListItem({
  title,
  description,
  leading,
  trailing,
  onClick,
  selected,
  disabled,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Icône Lucide (`size={16}`, `aria-hidden`) ou `StatusDot`. */
  leading?: ReactNode;
  /** `StatusBadge`, date, `IconButton`… */
  trailing?: ReactNode;
  onClick?: () => void;
  /** Élément actif (sélection affichée dans le panneau de droite) ; n’a de sens qu’avec `onClick`. */
  selected?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const content = (
    <>
      {leading ? <span className="ui-list__leading">{leading}</span> : null}
      <span className="ui-list__text">
        <span className="ui-list__title" id={`${id}-title`}>
          {title}
        </span>
        {description ? (
          <span className="ui-list__description" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <li className={`ui-list__item${selected ? " is-selected" : ""}`}>
      {onClick ? (
        <button
          type="button"
          className="ui-list__main ui-list__main--button"
          aria-labelledby={`${id}-title`}
          aria-describedby={descriptionId}
          aria-current={selected ? "true" : undefined}
          disabled={disabled}
          onClick={onClick}
        >
          {content}
        </button>
      ) : (
        <div className="ui-list__main">{content}</div>
      )}
      {trailing ? <div className="ui-list__trailing">{trailing}</div> : null}
    </li>
  );
}
