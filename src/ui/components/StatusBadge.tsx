import type { ReactNode } from "react";

export function StatusBadge({
  children,
  tone = "neutral",
  size = "default",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
  /** `compact` : pastille dans une ligne dense (carte, liste), en petit texte. */
  size?: "default" | "compact";
  title?: string;
}) {
  const toneClass = tone === "neutral" ? "" : ` state-label--${tone}`;
  const sizeClass = size === "compact" ? " state-label--compact" : "";
  return (
    <span className={`state-label${toneClass}${sizeClass}`} title={title}>
      {children}
    </span>
  );
}
