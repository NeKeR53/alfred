import { icons, type LucideIcon, Square } from "lucide-react";
import { useState } from "react";

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

/** Une icône de section qui désigne une image du module (`icons/jira.svg`) plutôt qu’un nom Lucide. */
export function isImageIcon(icon: string | null | undefined): boolean {
  return Boolean(icon && /[./]/.test(icon));
}

/**
 * Icône d’une entrée du menu : le logo posé dans le module (adresse `data:` fournie par Alfred), dans ses propres
 * couleurs, sinon l’icône Lucide nommée. Une image absente ou illisible retombe sur l’icône par défaut.
 */
export function SectionIcon({
  section,
  size = 15,
}: {
  section: { icon?: string | null; iconUrl?: string | null };
  size?: number;
}) {
  const [broken, setBroken] = useState<string>();
  const { icon, iconUrl } = section;
  if (iconUrl && broken !== iconUrl) {
    return (
      <img
        className="section-icon-image"
        src={iconUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setBroken(iconUrl)}
      />
    );
  }
  return <NamedIcon name={isImageIcon(icon) ? null : icon} size={size} />;
}
