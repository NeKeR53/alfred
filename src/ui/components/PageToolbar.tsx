import type { HTMLAttributes, ReactNode } from "react";

/**
 * Barre d’actions d’une page, fixe au-dessus du contenu : à gauche (`start`) la recherche puis les filtres, à droite
 * (`children`) les actions en icônes, l’`OverflowMenu`, puis l’action principale en texte, en dernier.
 */
export function PageToolbar({
  children,
  start,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children?: ReactNode; start?: ReactNode }) {
  return (
    <div {...props} className={["page-toolbar", className ?? ""].filter(Boolean).join(" ")}>
      <div className="page-toolbar__start">{start}</div>
      <div className="page-toolbar__actions">{children}</div>
    </div>
  );
}

/** Trait vertical entre deux groupes d’actions d’une barre d’outils (filtres | actions). */
export function ToolbarSeparator() {
  return <hr className="page-toolbar-separator" aria-orientation="vertical" />;
}
