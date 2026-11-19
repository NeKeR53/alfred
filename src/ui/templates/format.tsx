import type { ReactNode } from "react";
import { Code } from "../components/Content";
import { Link } from "../components/Link";
import { StatusBadge } from "../components/StatusBadge";
import { useFrameServices } from "./services";

/**
 * Type d’une valeur affichée (colonne d’une liste, ligne d’une fiche). Il fixe le format français, l’alignement,
 * la largeur de colonne et le tri : la page n’écrit ni `Intl`, ni largeur, ni alignement.
 *
 * - `text` : texte (défaut) ; `longtext` : paragraphe (fiche seulement).
 * - `number` : nombre « 1 234,5 » ; `money` : montant en euros « 1 234,50 € » (ou `currency`) ; `percent` : 0,25 → « 25 % ».
 * - `date` : « 20 nov. 2026 » ; `datetime` : « 20 nov. 2026, 14:30 » ; `relative` : « il y a 3 jours ».
 * - `boolean` : « Oui » ou « Non ».
 * - `status` : badge coloré, d’après `statuses` (valeur → libellé et ton).
 * - `email`, `url` : lien qui s’ouvre hors d’Alfred ; `code` : identifiant à chasse fixe ; `tags` : liste « a, b, c ».
 */
export type ValueType =
  | "text"
  | "longtext"
  | "number"
  | "money"
  | "percent"
  | "date"
  | "datetime"
  | "relative"
  | "boolean"
  | "status"
  | "email"
  | "url"
  | "code"
  | "tags";

export type StatusTone = "neutral" | "pending" | "success" | "warning" | "danger";

/** Valeur d’état → libellé et ton : `{ a_faire: { label: "À faire", tone: "neutral" } }`. */
export type StatusMap = Readonly<Record<string, { label: string; tone: StatusTone }>>;

export interface ValueOptions {
  type?: ValueType;
  statuses?: StatusMap;
  /** Devise ISO d’un montant (`EUR` par défaut). */
  currency?: string;
}

const EMPTY = "—";

function toDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value === "string" && value) return new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return null;
}

const relative = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

function relativeText(date: Date) {
  const seconds = (date.getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "à l’instant";
}

/** Texte d’une valeur, pour l’affichage simple et la recherche. */
export function valueText(value: unknown, options: ValueOptions = {}): string {
  const type = options.type ?? "text";
  if (value == null || value === "") return EMPTY;
  switch (type) {
    case "number":
      return Number.isFinite(Number(value)) ? new Intl.NumberFormat("fr-FR").format(Number(value)) : String(value);
    case "money":
      return Number.isFinite(Number(value))
        ? new Intl.NumberFormat("fr-FR", { style: "currency", currency: options.currency ?? "EUR" }).format(
            Number(value),
          )
        : String(value);
    case "percent":
      return Number.isFinite(Number(value))
        ? new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 }).format(Number(value))
        : String(value);
    case "date":
    case "datetime":
    case "relative": {
      const date = toDate(value);
      if (!date || Number.isNaN(date.getTime())) return String(value);
      if (type === "relative") return relativeText(date);
      return new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "medium",
        timeStyle: type === "datetime" ? "short" : undefined,
      }).format(date);
    }
    case "boolean":
      return value === true || value === 1 || value === "1" || value === "true" ? "Oui" : "Non";
    case "status":
      return options.statuses?.[String(value)]?.label ?? String(value);
    case "tags":
      return Array.isArray(value) ? value.join(", ") : String(value);
    default:
      return String(value);
  }
}

/** Valeur de tri : le nombre ou la date eux-mêmes, sinon le texte affiché. */
export function sortValueOf(value: unknown, options: ValueOptions = {}): string | number | null {
  if (value == null || value === "") return null;
  const type = options.type ?? "text";
  if (type === "number" || type === "money" || type === "percent") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (type === "date" || type === "datetime" || type === "relative") return toDate(value)?.getTime() ?? null;
  return valueText(value, options);
}

/** Alignement et largeur d’une colonne selon son type. */
export function columnLayout(type: ValueType | undefined): { align: "start" | "end"; width?: string } {
  switch (type) {
    case "number":
    case "percent":
      return { align: "end", width: "110px" };
    case "money":
      return { align: "end", width: "130px" };
    case "date":
      return { align: "end", width: "130px" };
    case "datetime":
      return { align: "end", width: "170px" };
    case "relative":
      return { align: "end", width: "140px" };
    case "boolean":
      return { align: "start", width: "90px" };
    case "status":
      return { align: "start", width: "140px" };
    case "code":
      return { align: "start", width: "160px" };
    default:
      return { align: "start" };
  }
}

/** Affichage d’une valeur selon son type : badge, lien, code ou texte formaté. */
export function FormattedValue({ value, options = {} }: { value: unknown; options?: ValueOptions }): ReactNode {
  const services = useFrameServices();
  const type = options.type ?? "text";
  if (value == null || value === "") return EMPTY;
  if (type === "status") {
    const status = options.statuses?.[String(value)];
    return (
      <StatusBadge tone={status?.tone ?? "neutral"} size="compact">
        {status?.label ?? String(value)}
      </StatusBadge>
    );
  }
  if (type === "email" || type === "url") {
    const href = type === "email" ? `mailto:${String(value)}` : String(value);
    return (
      <Link href={href} onNavigate={(target) => services.openExternal(target)}>
        {String(value)}
      </Link>
    );
  }
  if (type === "code") return <Code>{String(value)}</Code>;
  return valueText(value, options);
}
