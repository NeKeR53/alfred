
export type StatusDotTone = "success" | "warning" | "danger" | "neutral" | "pending";

/**
 * Pastille de couleur d’un état. Décorative : le texte voisin porte toujours le sens de l’état.
 * `pending` est une pastille creuse pour ce qui n’a pas encore commencé ou se prépare.
 */
export function StatusDot({ tone, className }: { tone: StatusDotTone; className?: string }) {
  return <span className={`status-dot status-dot--${tone}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
