import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

const icons = {
  error: CircleAlert,
  danger: CircleAlert,
  warning: TriangleAlert,
  info: Info,
};

export type FeedbackBannerTone = keyof typeof icons;

/**
 * Message persistant, visible tant que l’état qu’il décrit dure. `danger` et `error` sont synonymes (le vocabulaire
 * des autres composants est `danger`). `contained` (défaut) : cadre arrondi posé dans le contenu d’une page ;
 * `bar` : bandeau pleine largeur collé sous un en-tête, réservé à la coquille.
 */
export function FeedbackBanner({
  tone = "error",
  appearance = "contained",
  className,
  children,
  action,
}: {
  tone?: FeedbackBannerTone;
  appearance?: "bar" | "contained";
  className?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon = icons[tone];
  const severity = tone === "danger" ? "error" : tone;
  const classes = [
    "feedback-banner",
    `feedback-banner--${severity}`,
    appearance === "contained" ? "feedback-banner--contained" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role={severity === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" />
      <div className="feedback-banner__content">{children}</div>
      {action ? <span className="feedback-banner__action">{action}</span> : null}
    </div>
  );
}
