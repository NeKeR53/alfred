import { icons, type LucideIcon, Square } from "lucide-react";

/** Icône Lucide désignée par son nom en minuscules et tirets (« list-checks »), tel qu’écrit dans un manifeste. */
export function iconByName(name: string | null | undefined): LucideIcon {
  if (!name) return Square;
  const key = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return (icons as Record<string, LucideIcon>)[key] ?? Square;
}

export function NamedIcon({ name, size = 15 }: { name: string | null | undefined; size?: number }) {
  const Icon = iconByName(name);
  return <Icon size={size} aria-hidden="true" />;
}
