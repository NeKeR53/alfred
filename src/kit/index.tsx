/**
 * Composants locaux d’Alfred, là où socle-ui 0.3.0 ne prévoit rien (voir docs/socle-propositions.md, « Manques vus
 * pendant la migration »). Ils ne remplacent aucun composant Socle : ils posent seulement l’écart entre des
 * composants Socle (`Stack`, `Row`), un texte courant hors gabarit (`Text`) et un encart dans une zone (`Notice`,
 * D-159 : « un message local reste un encart dans la zone concernée »). Uniquement des tokens Socle, aucune couleur
 * en dur, aucun rayon hors échelle.
 */
import type { ReactNode } from "react";
import { StatusDot, type StatusTone } from "socle-ui";

export type Gap = "none" | "xs" | "sm" | "md" | "lg";

const gapClass: Record<Gap, string> = { none: "gap-0", xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-6" };

/** Empile des blocs à la verticale, avec un écart de l’échelle Socle (4, 8, 12 ou 24 px). */
export function Stack({ gap = "md", children }: { gap?: Gap; children: ReactNode }) {
  return <div className={`flex min-w-0 flex-col ${gapClass[gap]}`}>{children}</div>;
}

/** Aligne des éléments sur une ligne, centrés, avec un écart de l’échelle Socle ; `wrap` passe à la ligne. */
export function Row({
  gap = "sm",
  wrap = false,
  justify = "start",
  children,
}: {
  gap?: Gap;
  wrap?: boolean;
  justify?: "start" | "between" | "end";
  children: ReactNode;
}) {
  const place = justify === "between" ? "justify-between" : justify === "end" ? "justify-end" : "justify-start";
  return (
    <div className={`flex min-w-0 items-center ${place} ${wrap ? "flex-wrap" : ""} ${gapClass[gap]}`}>{children}</div>
  );
}

export type TextTone = "default" | "muted" | "danger" | "warning" | "success";

const toneClass: Record<TextTone, string> = {
  default: "text-fg",
  muted: "text-fg-2",
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
};

/** Texte courant hors gabarit : une phrase d’aide, une valeur, une méta (`size="meta"`). */
export function Text({
  as: Tag = "p",
  tone = "default",
  size = "default",
  weight = "normal",
  children,
}: {
  as?: "p" | "span";
  tone?: TextTone;
  size?: "default" | "meta";
  weight?: "normal" | "medium" | "strong";
  children: ReactNode;
}) {
  const sizeClass = size === "meta" ? "text-sm" : "text-md";
  const weightClass = weight === "strong" ? "font-semibold" : weight === "medium" ? "font-medium" : "font-normal";
  return <Tag className={`m-0 min-w-0 ${toneClass[tone]} ${sizeClass} ${weightClass}`}>{children}</Tag>;
}

export type NoticeTone = "info" | "success" | "warning" | "danger";

const noticeLabel: Record<NoticeTone, string> = {
  info: "Information",
  success: "Succès",
  warning: "Avertissement",
  danger: "Erreur",
};

/**
 * Encart dans une zone : un message qui concerne cette zone seulement (une erreur de chargement, une précision). Ce
 * n’est jamais un bandeau pleine largeur sous la barre du haut (D-159) ; l’état durable d’une page passe par
 * `pageStatus`, le résultat d’une action par un toast.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** Un `Button` de Socle : « Réessayer », « Configurer ». */
  action?: ReactNode;
}) {
  const statusTone: StatusTone = tone;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className="flex min-w-0 items-start gap-3 rounded-md border border-line bg-surface-side p-3 text-md text-fg"
    >
      <span className="pt-1">
        <StatusDot tone={statusTone} label={noticeLabel[tone]} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="m-0 font-semibold">{title}</p> : null}
        {children ? <div className="min-w-0 text-fg-2">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
