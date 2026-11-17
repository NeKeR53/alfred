import { type CSSProperties, isValidElement, type ReactNode } from "react";
import { type Action, ActionBar } from "../templates/actions";
import { TemplateDialogHost, useDialogOwner } from "../templates/dialogs";
import { PageHeaderBar, type PageHeaderSpec, SubpageLayer, useSubpage } from "../templates/subpages";
import { PageToolbar } from "./PageToolbar";
import { PageScope } from "./pageScope";
import { SearchField } from "./SearchField";
import "./page.css";

type Gap = "none" | "xs" | "sm" | "md" | "lg";

const gapClass = (gap: Gap) => `al-gap-${gap}`;

/**
 * Racine d’une page ou d’un panneau créé dans l’espace : occupe tout le cadre, fait défiler son contenu et fixe
 * les marges. Une page n’écrit ni marge extérieure ni couleur de fond elle-même. L’en-tête (`header`) et la barre
 * restent fixes au-dessus de la zone qui défile. La première `Page` montée héberge les modales et les sous-pages.
 */
export function Page({
  children,
  toolbar,
  actions,
  search,
  header,
  width = "full",
  fill = false,
}: {
  children: ReactNode;
  /** Barre fixe au-dessus du contenu, réservée à la coquille et aux gabarits : une page passe `actions` et `search`. */
  toolbar?: ReactNode;
  /** Actions de la page, disposées par Alfred dans la barre du haut (icônes, « ⋯ », action principale). */
  actions?: ReadonlyArray<Action>;
  /** Recherche de la page, à gauche de la barre. */
  search?: { label: string; value: string; onChange: (value: string) => void };
  /**
   * En-tête fixe de l’objet que montre la page (un panneau de droite composé, la fiche d’un objet) : nom, état,
   * ligne de contexte et actions en icônes. Jamais le titre de la section, que la coquille affiche déjà.
   */
  header?: PageHeaderSpec;
  /** `text` limite la largeur de lecture ; `full` sert aux tableaux et aux vues denses. */
  width?: "full" | "text";
  /**
   * Le contenu occupe la hauteur sans défiler : pour une page dont le bloc principal est un `DataTable fill` (ses
   * lignes défilent seules, sous leur en-tête) ou un éditeur.
   */
  fill?: boolean;
}) {
  const host = useDialogOwner();
  const subpage = useSubpage();
  const covered = host && subpage !== undefined;
  const bar =
    toolbar ??
    (actions?.length || search ? (
      <PageToolbar
        start={
          search ? (
            <SearchField
              label={search.label}
              placeholder="Rechercher…"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
            />
          ) : undefined
        }
      >
        {actions ? <ActionBar actions={actions} place="toolbar" /> : null}
      </PageToolbar>
    ) : undefined);
  const bodyClass = ["al-page__body", width === "text" ? "al-page__body--text" : "", fill ? "al-page__body--fill" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <PageScope.Provider value={true}>
      <div className="al-page">
        {host ? <TemplateDialogHost /> : null}
        <div className="al-page__main" inert={covered || undefined} aria-hidden={covered || undefined}>
          {header ? <PageHeaderBar header={header} /> : null}
          {bar}
          <div className={bodyClass}>{children}</div>
        </div>
        {covered ? <SubpageLayer entry={subpage} /> : null}
      </div>
    </PageScope.Provider>
  );
}

/**
 * Formulaire d’une page ou d’une modale : `<form noValidate>` dont l’envoi natif est bloqué, champs empilés à 12 px,
 * colonne de 560 px au plus (toute la largeur dans une modale). Entrée dans un champ appelle `onSubmit`. Les actions
 * se posent dessous (`actions`, une `FormActions`), ou dans le pied d’une `Modal` reliées par `id`.
 */
export function Form({
  id,
  onSubmit,
  children,
  actions,
  width = "default",
  "aria-label": ariaLabel,
}: {
  id?: string;
  onSubmit: () => void;
  children: ReactNode;
  /** `FormActions` posée sous les champs, alignée à droite de la colonne. Dans une `Modal`, la passer à `actions`. */
  actions?: ReactNode;
  /** `default` : 560 px au plus ; `full` : toute la largeur, pour un formulaire en deux colonnes (`Grid`). */
  width?: "default" | "full";
  "aria-label"?: string;
}) {
  return (
    <form
      id={id}
      noValidate
      aria-label={ariaLabel}
      className={`al-form${width === "full" ? " al-form--full" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
      {actions}
    </form>
  );
}

/**
 * En-tête d’un objet, en tête d’un panneau de droite ou d’une page de détail : son nom, son état, une ligne de
 * contexte, et ses actions en icônes calées en haut à droite (`IconButton`, puis `OverflowMenu` en dernier).
 */
export function ObjectHeader({
  title,
  description,
  badge,
  actions,
  level = 2,
}: {
  title: ReactNode;
  /** Une ligne de contexte sous le nom (« Créée le 3 mars par Léa »), en gris. */
  description?: ReactNode;
  /** `StatusBadge size="compact"` à côté du nom. */
  badge?: ReactNode;
  /** `IconButton` et `OverflowMenu`, au plus trois icônes visibles ; le reste dans le menu « ⋯ ». */
  actions?: ReactNode;
  /** `1` pour l’objet d’une page entière, `2` dans un panneau (défaut). */
  level?: 1 | 2;
}) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <header className={`al-object-header al-object-header--${level}`}>
      <div className="al-object-header__copy">
        <div className="al-object-header__title">
          <Tag className={`al-heading al-heading--${level}`}>{title}</Tag>
          {badge}
        </div>
        {description ? <p className="al-object-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="al-object-header__actions">{actions}</div> : null}
    </header>
  );
}

function isActionList(value: unknown): value is ReadonlyArray<Action> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item && typeof item === "object" && !isValidElement(item) && "onClick" in item)
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
  /** Actions du bloc : une liste d’`Action` (disposée par Alfred), ou des composants. */
  actions?: ReactNode | ReadonlyArray<Action>;
  children: ReactNode;
}) {
  const shown: ReactNode = isActionList(actions) ? (
    <ActionBar actions={actions} place="section" />
  ) : (
    (actions as ReactNode)
  );
  return (
    <section className="al-section">
      <header className="al-section__header">
        <div className="al-section__title">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {shown ? <div className="al-section__actions">{shown}</div> : null}
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
