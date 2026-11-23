import type { ReactNode } from "react";

/**
 * Collection vide ou résultat absent : ce qui manque et, si elle existe, l’action suivante.
 * `size="compact"` sert aux panneaux denses et listes imbriquées, où la hauteur minimale d’une page serait
 * disproportionnée.
 */
export function EmptyState({
  title,
  description,
  children,
  className,
  size = "default",
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
  size?: "default" | "compact";
}) {
  return (
    <div
      className={["empty-state", size === "compact" ? "empty-state--compact" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      role="status"
    >
      <strong>{title}</strong>
      {description ? <span className="empty-state__description">{description}</span> : null}
      {children ? <div className="empty-state__actions">{children}</div> : null}
    </div>
  );
}
