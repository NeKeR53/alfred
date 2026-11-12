import type { CSSProperties, ReactNode } from "react";
import "./page.css";

type Gap = "none" | "xs" | "sm" | "md" | "lg";

const gapClass = (gap: Gap) => `al-gap-${gap}`;

/**
 * Racine d’une page ou d’un panneau créé dans l’espace : occupe tout le cadre, fait défiler son contenu et fixe
 * les marges. Une page n’écrit ni marge extérieure ni couleur de fond elle-même.
 */
export function Page({
  children,
  toolbar,
  width = "full",
}: {
  children: ReactNode;
  /** Barre d’actions fixe au-dessus du contenu (`PageToolbar`). */
  toolbar?: ReactNode;
  /** `text` limite la largeur de lecture ; `full` sert aux tableaux et aux vues denses. */
  width?: "full" | "text";
}) {
  return (
    <div className="al-page">
      {toolbar}
      <div className={`al-page__body${width === "text" ? " al-page__body--text" : ""}`}>{children}</div>
    </div>
  );
}

/** Bloc titré d’une page : titre, description facultative, actions à droite, puis le contenu. */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="al-section">
      <header className="al-section__header">
        <div className="al-section__title">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="al-section__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Empile ses enfants verticalement avec un espacement de l’échelle. */
export function Stack({ children, gap = "md" }: { children: ReactNode; gap?: Gap }) {
  return <div className={`al-stack ${gapClass(gap)}`}>{children}</div>;
}

/** Aligne ses enfants horizontalement. */
export function Row({
  children,
  gap = "sm",
  align = "center",
  justify = "start",
  wrap = false,
}: {
  children: ReactNode;
  gap?: Gap;
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
}) {
  return (
    <div className={`al-row ${gapClass(gap)} al-align-${align} al-justify-${justify}${wrap ? " al-row--wrap" : ""}`}>
      {children}
    </div>
  );
}

/** Grille fluide : autant de colonnes d’au moins `minColumnWidth` pixels que la largeur le permet. */
export function Grid({
  children,
  minColumnWidth = 240,
  gap = "md",
}: {
  children: ReactNode;
  minColumnWidth?: number;
  gap?: Gap;
}) {
  return (
    <div className={`al-grid ${gapClass(gap)}`} style={{ "--al-grid-min": `${minColumnWidth}px` } as CSSProperties}>
      {children}
    </div>
  );
}

/** Surface délimitée pour regrouper un contenu autonome (formulaire, synthèse). À ne pas répéter en mur de cartes. */
export function Surface({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="al-surface">
      {title ? <h3 className="al-surface__title">{title}</h3> : null}
      {children}
    </div>
  );
}

export function Text({
  children,
  tone = "default",
  size = "body",
  weight = "normal",
  as: Tag = "p",
}: {
  children: ReactNode;
  tone?: "default" | "muted" | "success" | "warning" | "danger";
  size?: "meta" | "body" | "panel";
  weight?: "normal" | "medium" | "strong";
  as?: "p" | "span" | "div";
}) {
  return <Tag className={`al-text al-text--${tone} al-text--${size} al-text--${weight}`}>{children}</Tag>;
}

export function Heading({ children, level = 2 }: { children: ReactNode; level?: 1 | 2 | 3 }) {
  const Tag = `h${level}` as "h1" | "h2" | "h3";
  return <Tag className={`al-heading al-heading--${level}`}>{children}</Tag>;
}

/**
 * Liste « libellé : valeur » pour les fiches et les panneaux de détail. Deux libellés identiques sont admis : la
 * position sert de clé, sauf si l’élément fournit `id`.
 */
export function KeyValueList({
  items,
}: {
  items: ReadonlyArray<{ id?: string | number; label: string; value: ReactNode }>;
}) {
  return (
    <dl className="al-keyvalue">
      {items.map((item, index) => (
        <div key={item.id ?? index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Spinner({ label = "Chargement" }: { label?: string }) {
  return <span className="al-spinner" role="status" aria-label={label} />;
}
