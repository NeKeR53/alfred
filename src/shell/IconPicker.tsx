/**
 * Choix d’une icône : une grille d’icônes Lucide courantes, une recherche dans toutes les autres, et « Par défaut »
 * (l’icône du modèle, ou le logo du service) pour revenir en arrière. La valeur est le nom Lucide (« list-checks »),
 * ou une chaîne vide pour l’icône par défaut. Sert à « Changer l’icône… » (menu de gauche, fiche d’un module) et à
 * « Ajouter une page ».
 */
import { icons } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { SearchField } from "socle-ui";
import { Text } from "../kit";
import { NamedIcon, SectionIcon } from "./icons";
import "./iconPicker.css";

/** Icônes proposées d’office : celles qui disent le sujet d’une page de travail. */
const COMMON = [
  "list-checks",
  "layout-dashboard",
  "inbox",
  "mail",
  "calendar",
  "users",
  "user",
  "folder",
  "file-text",
  "briefcase",
  "building-2",
  "chart-line",
  "chart-column",
  "chart-pie",
  "rocket",
  "flask-conical",
  "server",
  "database",
  "cloud",
  "git-branch",
  "git-pull-request",
  "bug",
  "ticket",
  "kanban",
  "clipboard-list",
  "book-open",
  "notebook",
  "receipt",
  "wallet",
  "credit-card",
  "shopping-cart",
  "package",
  "truck",
  "phone",
  "message-square",
  "headset",
  "bell",
  "star",
  "house",
  "settings",
  "wrench",
  "shield",
  "key-round",
  "globe",
  "map",
  "image",
  "code",
  "terminal",
  "cpu",
  "zap",
  "clock",
  "workflow",
  "boxes",
  "tags",
];

/** « ListChecks » → « list-checks », « Building2 » → « building-2 ». */
function kebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
    .toLowerCase();
}

/** Toutes les icônes Lucide, par leur nom ; celles dont le nom ne se relit pas à l’identique sont écartées. */
let allNames: string[] | undefined;
function everyIcon(): string[] {
  allNames ??= Object.keys(icons)
    .map(kebab)
    .filter((name) => {
      const key = name
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
      return key in icons;
    });
  return allNames;
}

const LIMIT = 60;

export function IconPicker({
  value,
  onChange,
  fallback,
  label = "Icône",
}: {
  /** Nom Lucide choisi ; vide pour l’icône par défaut. */
  value: string;
  onChange: (name: string) => void;
  /** Ce que montre « Par défaut » : l’icône du modèle (nom Lucide) ou le logo du service (adresse `data:`). */
  fallback?: { icon?: string | null; iconUrl?: string | null };
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const group = useId();
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().replace(/\s+/g, "-");
    const known = new Set(everyIcon());
    if (!words) return COMMON.filter((name) => known.has(name));
    const found = everyIcon().filter((name) => name.includes(words));
    return found.slice(0, LIMIT);
  }, [query]);
  const more =
    query.trim() !== "" && everyIcon().filter((name) => name.includes(query.trim().toLowerCase())).length > LIMIT;
  return (
    <div className="icon-picker">
      <SearchField
        label={`les icônes (en anglais : chart, mail, rocket…)`}
        onChange={(criteria) => setQuery(criteria.text)}
      />
      <fieldset className="icon-picker__grid">
        <legend className="sr-only">{label}</legend>
        <label className="icon-picker__tile icon-picker__tile--default" title="Par défaut">
          <input type="radio" className="sr-only" name={group} checked={value === ""} onChange={() => onChange("")} />
          <span className="icon-picker__glyph" aria-hidden="true">
            {fallback?.iconUrl ? (
              <SectionIcon section={fallback} size={18} />
            ) : (
              <NamedIcon name={fallback?.icon ?? "square"} size={18} />
            )}
          </span>
          <span className="icon-picker__name">Par défaut</span>
        </label>
        {shown.map((name) => (
          <label key={name} className="icon-picker__tile" title={name}>
            <input
              type="radio"
              className="sr-only"
              name={group}
              aria-label={name}
              checked={value === name}
              onChange={() => onChange(name)}
            />
            <NamedIcon name={name} size={18} />
          </label>
        ))}
      </fieldset>
      {shown.length === 0 ? (
        <Text size="meta" tone="muted">
          Aucune icône ne correspond. Essayez un mot anglais : chart, mail, user, file…
        </Text>
      ) : more ? (
        <Text size="meta" tone="muted">
          {`Les ${LIMIT} premières : précisez la recherche pour en voir d’autres.`}
        </Text>
      ) : null}
    </div>
  );
}
