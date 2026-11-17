/**
 * Composants de base qu’une page emploie tels quels : pagination, barre de progression, avatar. Leur dessin est
 * fixé ici ; la page ne règle que leurs données.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "./Button";
import "./essentials.css";

/** Les lignes de la page `page` (à partir de 1) d’une liste découpée par `pageSize`. */
export function pageOf<Row>(rows: readonly Row[], page: number, pageSize: number): Row[] {
  const start = (Math.max(1, page) - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

const number = new Intl.NumberFormat("fr-FR");

/**
 * Pagination compacte : « 51–100 sur 312 » et les flèches précédente / suivante. Se place dans le pied de la page
 * (`Page footer`) ou sous un tableau. `page` commence à 1.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  label = "Pagination",
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(total, current * pageSize);
  return (
    <nav className="al-pagination" aria-label={label}>
      <span className="al-pagination__range" aria-live="polite">
        {total === 0 ? "Aucun résultat" : `${number.format(first)}–${number.format(last)} sur ${number.format(total)}`}
      </span>
      <IconButton label="Page précédente" size="small" disabled={current <= 1} onClick={() => onChange(current - 1)}>
        <ChevronLeft size={16} aria-hidden="true" />
      </IconButton>
      <IconButton label="Page suivante" size="small" disabled={current >= pages} onClick={() => onChange(current + 1)}>
        <ChevronRight size={16} aria-hidden="true" />
      </IconButton>
    </nav>
  );
}

/** Avancement d’une tâche ou part utilisée d’un quota : une barre et, au choix, sa valeur. */
export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = true,
  tone = "default",
}: {
  value: number;
  max?: number;
  /** Ce qui avance : « Import des contacts », « Espace utilisé ». Affiché au-dessus de la barre. */
  label: string;
  /** Affiche « 42 % » (ou « 42 / 120 » si `max` n’est pas 100) à droite du libellé. */
  showValue?: boolean;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const bounded = Math.min(Math.max(0, value), max);
  const ratio = max > 0 ? bounded / max : 0;
  const text = max === 100 ? `${Math.round(ratio * 100)} %` : `${number.format(bounded)} / ${number.format(max)}`;
  return (
    <div className="al-progress">
      <div className="al-progress__head">
        <span>{label}</span>
        {showValue ? <span className="al-progress__value">{text}</span> : null}
      </div>
      <div
        className={`al-progress__track al-progress--${tone}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={bounded}
        aria-valuetext={text}
      >
        <div className="al-progress__bar" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/** Initiales d’un nom : « Léa Martin » → « LM ». */
function initials(name: string): string {
  // Les mots sans lettre (« Martin 5 », « 2e ») ne donnent pas d’initiale.
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word));
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => [...word][0]?.toLocaleUpperCase("fr") ?? "").join("") || "?";
}

/** Pastille d’une personne : sa photo (`data:` ou `blob:`) ou ses initiales. À gauche d’un nom dans une liste. */
export function Avatar({ name, src, size = "md" }: { name: string; src?: string; size?: "sm" | "md" | "lg" }) {
  const image = src && /^(data|blob):/.test(src) ? src : undefined;
  return (
    <span className={`al-avatar al-avatar--${size}`} role="img" aria-label={name}>
      {image ? <img src={image} alt="" /> : <span aria-hidden="true">{initials(name)}</span>}
    </span>
  );
}
