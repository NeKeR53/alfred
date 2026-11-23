import type { ReactNode } from "react";
import { StatusDot } from "./StatusDot";

/**
 * Pastille d’état. `neutral` pour un fait (« Désactivé »), `pending` pour un état d’attente (« À configurer »,
 * « À connecter ») : la même pastille neutre, avec un point creux. `success` et `danger` pour un résultat ;
 * `warning` (jaune) seulement pour un vrai avertissement, jamais pour ce qui reste simplement à faire.
 */
export function StatusBadge({
  children,
  tone = "neutral",
  size = "default",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "pending" | "success" | "warning" | "danger";
  /** `compact` : pastille dans une ligne dense (carte, liste), en petit texte. */
  size?: "default" | "compact";
  title?: string;
}) {
  const toneClass = tone === "neutral" || tone === "pending" ? "" : ` state-label--${tone}`;
  const sizeClass = size === "compact" ? " state-label--compact" : "";
  return (
    <span className={`state-label${toneClass}${sizeClass}`} title={title}>
      {tone === "pending" ? <StatusDot tone="pending" /> : null}
      {children}
    </span>
  );
}
