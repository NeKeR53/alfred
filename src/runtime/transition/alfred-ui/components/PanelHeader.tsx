import type { ReactNode } from "react";

/** En-tête d’un panneau ou d’une modale de la coquille : titre, sous-titre sur une ligne, actions à droite. */
export function PanelHeader({
  title,
  titleId,
  subtitle,
  trailing,
  level = 1,
  compact = false,
  variant = "panel",
  className,
}: {
  title: ReactNode;
  titleId?: string;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  level?: 1 | 2 | 3;
  compact?: boolean;
  /** `page` : en-tête d’une vue principale de la coquille, sans bordure, aux marges de la page. */
  variant?: "panel" | "page";
  className?: string;
}) {
  const classes = [
    "panel-header",
    compact ? "panel-header--compact" : "",
    variant === "page" ? "panel-header--page" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const heading =
    level === 1 ? (
      <h1 id={titleId}>{title}</h1>
    ) : level === 2 ? (
      <h2 id={titleId}>{title}</h2>
    ) : (
      <h3 id={titleId}>{title}</h3>
    );

  return (
    <header className={classes}>
      <div className="panel-header__copy">
        {heading}
        {subtitle ? <p title={typeof subtitle === "string" ? subtitle : undefined}>{subtitle}</p> : null}
      </div>
      {trailing ? <div className="panel-header__trailing">{trailing}</div> : null}
    </header>
  );
}
